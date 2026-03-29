/**
 * SkeletalAnimation — CPU-side bone matrix evaluation for skinned meshes.
 *
 * Evaluates animation clips by sampling keyframes, computing joint local transforms,
 * walking the hierarchy, and writing final bone matrices into a pre-allocated buffer.
 * Zero per-frame allocations.
 *
 * Usage:
 * ```ts
 * const anim = new SkeletalAnimation(skinData, clips);
 * const state = anim.createState('walk');
 *
 * // Each tick:
 * anim.update(state, deltaTime, outputMatrices);
 *
 * // outputMatrices is a Float32Array view into the bone matrix buffer
 * ```
 */
import type { SkinData, AnimationClipData, AnimationChannel } from './gltf-skin-parser';
import { getNodeTRS } from './gltf-skin-parser';
import { trsToMat4, mat4Mul } from '../core/math';

export interface SkeletalClip {
    readonly id: number;
    readonly name: string;
    readonly duration: number;
    readonly channels: AnimationChannel[];
    readonly loop: boolean;
}

export interface PlayOptions {
    speed?: number;
    /** Crossfade duration in seconds. 0 = instant switch (default). */
    crossfade?: number;
}

export interface SkeletalAnimState {
    clipId: number;
    time: number;
    speed: number;
    playing: boolean;
    // Crossfade state
    prevClipId: number;   // -1 if no crossfade active
    prevTime: number;
    prevSpeed: number;
    blendWeight: number;  // 0 = fully previous, 1 = fully current
    blendDuration: number;
}

export class SkeletalAnimation {
    private clips: SkeletalClip[] = [];
    private clipsByName = new Map<string, number>();
    readonly skinData: SkinData;

    // Pre-allocated scratch buffers (zero-GC)
    private readonly localMatrices: Float32Array;   // jointCount * 16
    private readonly worldMatrices: Float32Array;    // jointCount * 16
    private readonly blendScratch: Float32Array;    // jointCount * 16 (for crossfade previous clip)

    // Rest pose TRS per joint (10 floats each: tx,ty,tz,qx,qy,qz,qw,sx,sy,sz)
    // originalRestPoseTRS is never mutated; currentTRS is the scratch buffer for animation
    private readonly originalRestPoseTRS: Float32Array;
    private readonly currentTRS: Float32Array;

    // Topological order: indices into joint array, parent-before-child guaranteed
    private readonly topoOrder: Uint16Array;

    // World matrix of non-joint ancestors (armature root scale, etc.)
    // Pre-stored as 16 floats so it can be used with mat4Mul offset API
    private readonly skelRootMat: Float32Array; // 16 floats, identity if no non-joint ancestors

    constructor(skinData: SkinData, clips: AnimationClipData[], gltfNodes: any[]) {
        this.skinData = skinData;
        const jc = skinData.jointCount;

        this.localMatrices = new Float32Array(jc * 16);
        this.worldMatrices = new Float32Array(jc * 16);
        this.blendScratch = new Float32Array(jc * 16);

        // Extract rest pose TRS for each joint node
        this.originalRestPoseTRS = new Float32Array(jc * 10);
        this.currentTRS = new Float32Array(jc * 10);
        for (let j = 0; j < jc; j++) {
            const nodeTRS = getNodeTRS(gltfNodes[skinData.jointNodeIndices[j]]);
            this.originalRestPoseTRS.set(nodeTRS, j * 10);
        }

        // Skeleton root matrix (non-joint ancestors like armature scale)
        this.skelRootMat = new Float32Array(16);
        if (skinData.skeletonRootMatrix) {
            this.skelRootMat.set(skinData.skeletonRootMatrix);
        } else {
            this.skelRootMat[0] = 1; this.skelRootMat[5] = 1; this.skelRootMat[10] = 1; this.skelRootMat[15] = 1;
        }

        // Compute topological order (parent before child)
        this.topoOrder = new Uint16Array(jc);
        const visited = new Uint8Array(jc);
        let writeIdx = 0;
        const visit = (j: number) => {
            if (visited[j]) return;
            visited[j] = 1;
            const parent = skinData.parentJointIndices[j];
            if (parent !== -1) visit(parent);
            this.topoOrder[writeIdx++] = j;
        };
        for (let j = 0; j < jc; j++) visit(j);

        // Load clips
        for (const clip of clips) {
            this.loadClip(clip);
        }
    }

    loadClip(clip: AnimationClipData, loop: boolean = true): number {
        const id = this.clips.length;
        this.clips.push({
            id,
            name: clip.name,
            duration: clip.duration,
            channels: clip.channels,
            loop,
        });
        this.clipsByName.set(clip.name, id);
        return id;
    }

    getClipId(name: string): number {
        const id = this.clipsByName.get(name);
        if (id === undefined) throw new Error(`Skeletal clip "${name}" not found`);
        return id;
    }

    getClipNames(): string[] {
        return this.clips.map(c => c.name);
    }

    get clipCount(): number {
        return this.clips.length;
    }

    createState(clipIdOrName: number | string, speed: number = 1, playing: boolean = true): SkeletalAnimState {
        const clipId = typeof clipIdOrName === 'string' ? this.getClipId(clipIdOrName) : clipIdOrName;
        return { clipId, time: 0, speed, playing, prevClipId: -1, prevTime: 0, prevSpeed: 1, blendWeight: 1, blendDuration: 0 };
    }

    play(state: SkeletalAnimState, clipIdOrName: number | string, opts?: PlayOptions): void {
        const newClipId = typeof clipIdOrName === 'string' ? this.getClipId(clipIdOrName) : clipIdOrName;
        const crossfade = opts?.crossfade ?? 0;

        if (crossfade > 0 && state.playing) {
            // Start crossfade: current becomes previous
            state.prevClipId = state.clipId;
            state.prevTime = state.time;
            state.prevSpeed = state.speed;
            state.blendWeight = 0;
            state.blendDuration = crossfade;
        } else {
            state.prevClipId = -1;
            state.blendWeight = 1;
            state.blendDuration = 0;
        }

        state.clipId = newClipId;
        state.time = 0;
        state.playing = true;
        if (opts?.speed !== undefined) state.speed = opts.speed;
    }

    stop(state: SkeletalAnimState): void { state.playing = false; }
    resume(state: SkeletalAnimState): void { state.playing = true; }

    /**
     * Advance time and compute bone matrices.
     * Writes jointCount mat4s into `output` starting at float index `outputOffset`.
     * Handles crossfade blending automatically.
     */
    update(state: SkeletalAnimState, deltaTime: number, output: Float32Array, outputOffset: number = 0): void {
        const jc = this.skinData.jointCount;

        // Advance current clip time
        if (state.playing) {
            this.advanceTime(state, deltaTime);
        }

        // Advance crossfade blend weight
        const blending = state.prevClipId !== -1 && state.blendDuration > 0 && state.blendWeight < 1;
        if (blending) {
            state.blendWeight += deltaTime / state.blendDuration;
            if (state.blendWeight >= 1) {
                state.blendWeight = 1;
                state.prevClipId = -1;
                state.blendDuration = 0;
            }
        }

        if (blending && state.prevClipId !== -1) {
            // Advance previous clip time too
            const prevClip = this.clips[state.prevClipId];
            if (prevClip) {
                state.prevTime += deltaTime * state.prevSpeed;
                if (prevClip.loop && state.prevTime >= prevClip.duration) {
                    state.prevTime %= prevClip.duration;
                }
            }

            // Evaluate previous clip into scratch buffer
            this.evaluateClip(state.prevClipId, state.prevTime, this.blendScratch, 0);

            // Evaluate current clip into output
            this.evaluateClip(state.clipId, state.time, output, outputOffset);

            // Lerp: output = lerp(prev, current, blendWeight)
            const w = state.blendWeight;
            const oneMinusW = 1 - w;
            const scratch = this.blendScratch;
            const floatCount = jc * 16;
            for (let i = 0; i < floatCount; i++) {
                output[outputOffset + i] = scratch[i] * oneMinusW + output[outputOffset + i] * w;
            }
        } else {
            // No crossfade — evaluate current clip directly
            this.evaluateClip(state.clipId, state.time, output, outputOffset);
        }
    }

    /** Advance clip time with looping/clamping. */
    private advanceTime(state: SkeletalAnimState, deltaTime: number): void {
        const clip = this.clips[state.clipId];
        if (!clip || clip.duration <= 0) return;

        state.time += deltaTime * state.speed;
        if (state.time >= clip.duration) {
            if (clip.loop) state.time %= clip.duration;
            else { state.time = clip.duration - 0.0001; state.playing = false; }
        }
        if (state.time < 0) {
            if (clip.loop) state.time = clip.duration + (state.time % clip.duration);
            else { state.time = 0; state.playing = false; }
        }
    }

    /** Evaluate a clip at a specific time and write bone matrices. */
    private evaluateClip(clipId: number, time: number, output: Float32Array, outputOffset: number): void {
        const clip = this.clips[clipId];
        if (!clip) return;

        const skin = this.skinData;
        const jc = skin.jointCount;
        const local = this.localMatrices;
        const world = this.worldMatrices;
        const cur = this.currentTRS;

        // Copy rest pose fresh
        cur.set(this.originalRestPoseTRS);

        // Apply animation channels
        for (const ch of clip.channels) {
            const j = ch.jointIndex;
            if (j >= jc) continue;

            const ro = j * 10;
            const sampled = this.sampleChannel(ch, time);

            if (ch.path === 'translation') {
                cur[ro] = sampled[0]; cur[ro + 1] = sampled[1]; cur[ro + 2] = sampled[2];
            } else if (ch.path === 'rotation') {
                cur[ro + 3] = sampled[0]; cur[ro + 4] = sampled[1];
                cur[ro + 5] = sampled[2]; cur[ro + 6] = sampled[3];
            } else if (ch.path === 'scale') {
                cur[ro + 7] = sampled[0]; cur[ro + 8] = sampled[1]; cur[ro + 9] = sampled[2];
            }
        }

        // Build local matrices
        for (let j = 0; j < jc; j++) {
            const ro = j * 10;
            trsToMat4(cur[ro], cur[ro + 1], cur[ro + 2],
                cur[ro + 3], cur[ro + 4], cur[ro + 5], cur[ro + 6],
                cur[ro + 7], cur[ro + 8], cur[ro + 9], local, j * 16);
        }

        // Walk hierarchy in topological order
        const topo = this.topoOrder;
        const srm = this.skelRootMat;
        for (let i = 0; i < jc; i++) {
            const j = topo[i];
            const parentJ = skin.parentJointIndices[j];
            if (parentJ === -1) {
                mat4Mul(srm, 0, local, j * 16, world, j * 16);
            } else {
                mat4Mul(world, parentJ * 16, local, j * 16, world, j * 16);
            }
        }

        // Final: output[j] = world[j] * inverseBindMatrix[j]
        const ibm = skin.inverseBindMatrices;
        for (let j = 0; j < jc; j++) {
            mat4Mul(world, j * 16, ibm, j * 16, output, outputOffset + j * 16);
        }
    }

    /**
     * Compute bone matrices for the rest/bind pose (no animation).
     */
    computeRestPose(output: Float32Array, outputOffset: number = 0): void {
        const skin = this.skinData;
        const jc = skin.jointCount;
        const local = this.localMatrices;
        const world = this.worldMatrices;
        const rest = this.originalRestPoseTRS;

        for (let j = 0; j < jc; j++) {
            const ro = j * 10;
            trsToMat4(
                rest[ro], rest[ro + 1], rest[ro + 2],
                rest[ro + 3], rest[ro + 4], rest[ro + 5], rest[ro + 6],
                rest[ro + 7], rest[ro + 8], rest[ro + 9],
                local, j * 16,
            );
        }

        const topo = this.topoOrder;
        const srm = this.skelRootMat;
        for (let i = 0; i < jc; i++) {
            const j = topo[i];
            const parentJ = skin.parentJointIndices[j];
            if (parentJ === -1) {
                mat4Mul(srm, 0, local, j * 16, world, j * 16);
            } else {
                mat4Mul(world, parentJ * 16, local, j * 16, world, j * 16);
            }
        }

        const ibm = skin.inverseBindMatrices;
        for (let j = 0; j < jc; j++) {
            mat4Mul(world, j * 16, ibm, j * 16, output, outputOffset + j * 16);
        }
    }

    // --- Private helpers (zero-alloc, operate on Float32Array sub-regions) ---

    /** Sample an animation channel at time t. Returns 3 or 4 floats. */
    private sampleChannel(ch: AnimationChannel, t: number): Float32Array {
        const ts = ch.timestamps;
        const vals = ch.values;
        const compCount = ch.path === 'rotation' ? 4 : 3;

        // Clamp
        if (t <= ts[0]) return vals.subarray(0, compCount);
        if (t >= ts[ts.length - 1]) return vals.subarray((ts.length - 1) * compCount, ts.length * compCount);

        // Binary search for the keyframe pair
        let lo = 0, hi = ts.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (ts[mid] <= t) lo = mid;
            else hi = mid;
        }

        if (ch.interpolation === 'STEP') {
            return vals.subarray(lo * compCount, lo * compCount + compCount);
        }

        // LINEAR interpolation
        const t0 = ts[lo], t1 = ts[hi];
        const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        const a = lo * compCount;
        const b = hi * compCount;

        if (ch.path === 'rotation') {
            // Quaternion nlerp (sufficient for close keyframes)
            return this.nlerpQuat(vals, a, vals, b, f);
        }

        // Linear lerp for translation/scale
        // Reuse a scratch view
        const out = this._scratchVec3;
        out[0] = vals[a] + (vals[b] - vals[a]) * f;
        out[1] = vals[a + 1] + (vals[b + 1] - vals[a + 1]) * f;
        out[2] = vals[a + 2] + (vals[b + 2] - vals[a + 2]) * f;
        return out;
    }

    private readonly _scratchVec3 = new Float32Array(3);
    private readonly _scratchQuat = new Float32Array(4);

    /** Normalized lerp for quaternions (nlerp). */
    private nlerpQuat(a: Float32Array, ao: number, b: Float32Array, bo: number, t: number): Float32Array {
        const out = this._scratchQuat;
        // Check if quaternions are on the same hemisphere
        let dot = a[ao] * b[bo] + a[ao + 1] * b[bo + 1] + a[ao + 2] * b[bo + 2] + a[ao + 3] * b[bo + 3];
        const sign = dot < 0 ? -1 : 1;

        const oneMinusT = 1 - t;
        out[0] = oneMinusT * a[ao]     + t * b[bo]     * sign;
        out[1] = oneMinusT * a[ao + 1] + t * b[bo + 1] * sign;
        out[2] = oneMinusT * a[ao + 2] + t * b[bo + 2] * sign;
        out[3] = oneMinusT * a[ao + 3] + t * b[bo + 3] * sign;

        // Normalize
        const len = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2] + out[3] * out[3]);
        if (len > 0) {
            const inv = 1 / len;
            out[0] *= inv; out[1] *= inv; out[2] *= inv; out[3] *= inv;
        }

        return out;
    }

}

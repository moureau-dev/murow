/**
 * MorphAnimation — keyframe-based vertex animation for 3D meshes.
 *
 * Stores multiple vertex position snapshots (morph targets) per model.
 * Each instance has a float `morphTime` that determines which two keyframes
 * to blend and by how much. The blending happens CPU-side by writing
 * interpolated positions into the model's vertex buffer.
 *
 * This is simpler than GPU-side blending (no shader changes needed) and
 * works well for small-to-medium meshes with few keyframes.
 *
 * Usage:
 * ```ts
 * const morph = new MorphAnimation();
 *
 * // Load keyframes (each is a flat Float32Array of positions)
 * const clipId = morph.loadClip({
 *     name: 'walk',
 *     keyframes: [frame0Positions, frame1Positions, frame2Positions],
 *     durations: [100, 100, 100],
 *     loop: true,
 * });
 *
 * const state = morph.createState(clipId);
 *
 * // Each tick: advance time, get interpolated positions
 * morph.update(state, deltaTime, outputPositions);
 * ```
 */

export interface MorphClip {
    readonly id: number;
    readonly name: string;
    readonly keyframes: Float32Array[]; // each is vertexCount * 3 floats
    readonly durations: Float32Array;   // ms per frame transition
    readonly frameCount: number;
    readonly totalDuration: number;
    readonly loop: boolean;
    readonly vertexCount: number;
}

export interface MorphState {
    clipId: number;
    time: number;
    speed: number;
    playing: boolean;
}

export interface MorphClipConfig {
    name: string;
    keyframes: Float32Array[];
    durations: number[];
    loop: boolean;
}

export class MorphAnimation {
    private clips: MorphClip[] = [];
    private clipsByName = new Map<string, number>();

    loadClip(config: MorphClipConfig): number {
        if (config.keyframes.length < 2) {
            throw new Error('Morph clip needs at least 2 keyframes');
        }
        const vertexCount = config.keyframes[0].length / 3;
        const id = this.clips.length;
        this.clips.push({
            id,
            name: config.name,
            keyframes: config.keyframes,
            durations: new Float32Array(config.durations),
            frameCount: config.keyframes.length,
            totalDuration: config.durations.reduce((s, d) => s + d, 0),
            loop: config.loop,
            vertexCount,
        });
        this.clipsByName.set(config.name, id);
        return id;
    }

    getClipId(name: string): number {
        const id = this.clipsByName.get(name);
        if (id === undefined) throw new Error(`Morph clip "${name}" not found`);
        return id;
    }

    getClip(id: number): MorphClip {
        return this.clips[id];
    }

    createState(clipId: number, speed: number = 1, playing: boolean = true): MorphState {
        return { clipId, time: 0, speed, playing };
    }

    /**
     * Advance time and write interpolated vertex positions into `output`.
     * Output must be a Float32Array of vertexCount * 3 floats.
     * Zero allocations.
     */
    update(state: MorphState, deltaTime: number, output: Float32Array): void {
        const clip = this.clips[state.clipId];

        if (state.playing) {
            state.time += deltaTime * state.speed * 1000;

            if (state.time >= clip.totalDuration) {
                if (clip.loop) {
                    state.time %= clip.totalDuration;
                } else {
                    state.time = clip.totalDuration - 0.001;
                    state.playing = false;
                }
            }
            if (state.time < 0) state.time = 0;
        }

        // Find which two keyframes to blend
        let elapsed = 0;
        let frameA = 0;
        for (let i = 0; i < clip.frameCount - 1; i++) {
            if (elapsed + clip.durations[i] > state.time) {
                frameA = i;
                break;
            }
            elapsed += clip.durations[i];
            frameA = i;
        }

        const frameB = (frameA + 1) % clip.frameCount;
        const t = clip.durations[frameA] > 0
            ? (state.time - elapsed) / clip.durations[frameA]
            : 0;

        // Lerp positions
        const a = clip.keyframes[frameA];
        const b = clip.keyframes[frameB];
        const len = clip.vertexCount * 3;
        const oneMinusT = 1 - t;

        for (let i = 0; i < len; i++) {
            output[i] = a[i] * oneMinusT + b[i] * t;
        }
    }

    play(state: MorphState, clipId: number, speed?: number): void {
        state.clipId = clipId;
        state.time = 0;
        state.playing = true;
        if (speed !== undefined) state.speed = speed;
    }

    stop(state: MorphState): void {
        state.playing = false;
    }

    resume(state: MorphState): void {
        state.playing = true;
    }

    get clipCount(): number {
        return this.clips.length;
    }
}

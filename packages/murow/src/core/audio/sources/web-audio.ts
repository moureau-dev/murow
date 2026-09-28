/**
 * WebAudioOutput — the browser `AudioOutput`, backed by Web Audio.
 *
 * Fades are native `AudioParam` ramps on the audio clock. 3D sources use a
 * `PannerNode` (HRTF, distance model, cone); 2D sources use a
 * `StereoPannerNode` plus a dedicated distance gain.
 *
 * Each source has **separate** nodes so concerns never fight:
 *   source → volume (fades/level) → spatial (pan, + 3D distance) → distance (2D attenuation) → mute (culling) → bus → master → destination
 *
 * `volume` is only ever touched by fades/`setSourceVolume`; `distance` only by
 * listener/position updates. Neither cancels the other — except `mute`, which
 * only culls.
 *
 * Browser-only: safe to construct anywhere, but playback needs a Web Audio
 * context. Use `NullAudioOutput` on the server.
 */

import { SlotMap } from '../../slot-map';
import { clamp } from '../util';
import {
    AUDIO_CATEGORIES,
    type AudioCategory,
    type AudioDecoded,
    type AudioDimension,
    type AudioListenerState,
    type AudioOutput,
    type AudioSpec,
    type AudioVolumeOptions,
    type SourceSpec,
} from '../types';

/** Time constant for smoothed spatial updates (pan/attenuation/position). */
const SPATIAL_SMOOTHING = 0.02;

interface WebSource {
    source: AudioBufferSourceNode;
    /** Fades / intrinsic level. Never written by spatial updates. */
    volumeNode: GainNode;
    /** Pan (2D) or pan + distance (3D). */
    spatial: StereoPannerNode | PannerNode;
    /** 2D distance attenuation. Stays 1 in 3D. */
    distanceNode: GainNode;
    /** Culling pause. */
    mute: GainNode;
    spec: SourceSpec;
    logicalVolume: number;
    paused: boolean;
}

export interface WebAudioOutputOptions {
    dimension?: AudioDimension;
    /** Reuse an existing context (e.g. shared with the app). */
    context?: AudioContext;
    /** Max simultaneous sources. @default 256 */
    capacity?: number;
    /** 2D only: world-space offset along the listener's right axis that maps to a hard pan. @default 12 */
    panRange?: number;
}

type Ctor = new (options?: AudioContextOptions) => AudioContext;

function AudioContextCtor(): Ctor | null {
    const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
    return g.AudioContext ?? g.webkitAudioContext ?? null;
}

export class WebAudioOutput implements AudioOutput {
    readonly dimension: AudioDimension;

    private context: AudioContext | null;
    private readonly ownsContext: boolean;
    private master: GainNode | null = null;
    /** One bus per category; `master` is the final output gain. */
    private buses: Partial<Record<AudioCategory, GainNode>> = {};
    /** Source slots — id IS the slot (see core/slot-map). */
    private readonly slotMap: SlotMap;
    private readonly sources: (WebSource | null)[];
    private readonly panRange: number;
    private listener: AudioListenerState | null = null;

    constructor(opts: WebAudioOutputOptions = {}) {
        this.dimension = opts.dimension ?? '3d';
        this.context = opts.context ?? null;
        this.ownsContext = !opts.context;
        const capacity = opts.capacity ?? 256;
        this.panRange = opts.panRange ?? 12;
        this.slotMap = new SlotMap(capacity);
        this.sources = new Array<WebSource | null>(capacity).fill(null);
    }

    private get ctx(): AudioContext {
        if (!this.context) {
            const Ctor = AudioContextCtor();
            if (!Ctor) throw new Error('WebAudioOutput: no AudioContext in this environment');
            this.context = new Ctor();
        }
        return this.context;
    }

    /**
     * Build the bus graph on first use: `master` is the final gain, others feed
     * it. Also applies any listener pose set before the graph existed.
     */
    private ensureGraph(): void {
        if (this.master) return;
        const ctx = this.ctx;
        const master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);
        this.master = master;
        this.buses = { master };
        for (const category of AUDIO_CATEGORIES) {
            if (category === 'master') continue;
            const bus = ctx.createGain();
            bus.gain.value = 1;
            bus.connect(master);
            this.buses[category] = bus;
        }
        if (this.dimension === '3d') this.pushListener();
    }

    async resume(): Promise<void> {
        if (this.context?.state === 'suspended') await this.context.resume();
    }

    async suspend(): Promise<void> {
        if (this.context?.state === 'running') await this.context.suspend();
    }

    async decode(data: ArrayBuffer, _spec: AudioSpec): Promise<AudioDecoded> {
        const buffer = await this.ctx.decodeAudioData(data);
        return { buffer, duration: buffer.duration };
    }

    createSource(spec: SourceSpec, onEnded: () => void): number {
        this.ensureGraph();
        const id = this.slotMap.add();
        if (id === -1) throw new Error(`WebAudioOutput: source capacity (${this.sources.length}) reached`);

        const ctx = this.ctx;
        const source = ctx.createBufferSource();
        source.buffer = spec.buffer as AudioBuffer;
        source.loop = spec.loop;

        const volumeNode = ctx.createGain();
        volumeNode.gain.value = spec.volume;

        const spatial = this.dimension === '2d' ? ctx.createStereoPanner() : ctx.createPanner();
        if (this.dimension === '3d') this.configurePanner(spatial as PannerNode, spec);

        const distanceNode = ctx.createGain();
        distanceNode.gain.value = 1;

        const mute = ctx.createGain();
        mute.gain.value = 1;

        source.connect(volumeNode);
        volumeNode.connect(spatial);
        spatial.connect(distanceNode);
        distanceNode.connect(mute);
        mute.connect(this.bus(spec.category));

        source.onended = onEnded;
        source.start();

        const record: WebSource = {
            source, volumeNode, spatial, distanceNode, mute, spec,
            logicalVolume: spec.volume, paused: false,
        };
        this.sources[id] = record;
        this.applySpatial(record, true);
        return id;
    }

    /** Move a source. Mutates `record.spec` in place — no allocation. */
    setSourcePosition(sourceId: number, x: number, y: number, z: number): void {
        const record = this.sources[sourceId];
        if (!record) return;
        record.spec.x = x;
        record.spec.y = y;
        record.spec.z = z;
        this.applySpatial(record);
    }

    /** Change a live source's distance model; reconfigures the panner (3D) or attenuation (2D). */
    setSourceDistance(sourceId: number, refDistance: number, rolloffFactor: number, maxDistance: number): void {
        const record = this.sources[sourceId];
        if (!record) return;
        const s = record.spec;
        s.refDistance = refDistance;
        s.rolloffFactor = rolloffFactor;
        s.maxDistance = maxDistance;

        if (this.dimension === '3d') {
            const p = record.spatial as PannerNode;
            p.refDistance = refDistance;
            p.rolloffFactor = rolloffFactor;
            if (Number.isFinite(maxDistance)) p.maxDistance = maxDistance;
        } else {
            this.setParam(record.distanceNode.gain, this.attenuation(record), false);
        }
    }

    /** Change a live source's facing (3D cone orientation). */
    setSourceOrientation(sourceId: number, x: number, y: number, z: number): void {
        const record = this.sources[sourceId];
        if (!record) return;
        const s = record.spec;
        s.dirX = x;
        s.dirY = y;
        s.dirZ = z;
        if (this.dimension !== '3d') return;
        const p = record.spatial as PannerNode;
        if (p.orientationX) {
            this.setParam(p.orientationX, x, false);
            this.setParam(p.orientationY, y, false);
            this.setParam(p.orientationZ, z, false);
        }
    }

    setSourceVolume(sourceId: number, volume: number, seconds = 0): void {
        const record = this.sources[sourceId];
        if (!record) return;
        record.logicalVolume = volume;
        this.rampTo(record.volumeNode.gain, volume, seconds);
    }

    setSourcePaused(sourceId: number, paused: boolean): void {
        const record = this.sources[sourceId];
        if (!record) return;
        record.paused = paused;
        record.mute.gain.value = paused ? 0 : 1;
    }

    stopSource(sourceId: number): void {
        const record = this.sources[sourceId];
        if (!record) return;
        this.sources[sourceId] = null;
        this.slotMap.remove(sourceId);
        try { record.source.onended = null; record.source.stop(); } catch { /* already stopped */ }
        record.source.disconnect();
        record.volumeNode.disconnect();
        record.spatial.disconnect();
        record.distanceNode.disconnect();
        record.mute.disconnect();
    }

    /**
     * Set the listener pose. 3D drives the Web Audio listener; 2D re-applies
     * pan/attenuation to live sources, touching only the pan + distance nodes so
     * in-flight fades survive.
     */
    setListener(state: AudioListenerState): void {
        this.listener = state;

        if (this.dimension !== '3d') {
            for (let i = 0; i < this.slotMap.size; i++) {
                const record = this.sources[this.slotMap.activeSlots[i]];
                if (record) this.applySpatial(record);
            }
            return;
        }

        this.pushListener();
    }

    /** Push the stored pose into the Web Audio listener (3D). No-op before the graph exists. */
    private pushListener(): void {
        const state = this.listener;
        if (!this.context || !state) return;
        const l = this.ctx.listener as AudioListener & Record<string, any>;
        const fx = state.forwardX ?? 0, fy = state.forwardY ?? 0, fz = state.forwardZ ?? -1;
        const ux = state.upX ?? 0, uy = state.upY ?? 1, uz = state.upZ ?? 0;
        if (l.positionX) {
            l.positionX.value = state.x;
            l.positionY.value = state.y;
            l.positionZ.value = state.z ?? 0;
            l.forwardX.value = fx;
            l.forwardY.value = fy;
            l.forwardZ.value = fz;
            l.upX.value = ux;
            l.upY.value = uy;
            l.upZ.value = uz;
        } else {
            l.setPosition?.(state.x, state.y, state.z ?? 0);
            l.setOrientation?.(fx, fy, fz, ux, uy, uz);
        }
    }

    setCategoryVolume(category: AudioCategory, opts: AudioVolumeOptions): void {
        this.ensureGraph();
        const bus = this.buses[category];
        if (bus) this.rampTo(bus.gain, opts.volume, opts.seconds ?? 0);
    }

    /**
     * Stop every live source and release the context. Drains from the front
     * because `stopSource` frees slots (swap-remove).
     */
    destroy(): void {
        while (this.slotMap.size > 0) this.stopSource(this.slotMap.activeSlots[0]);
        this.buses = {};
        this.master = null;
        if (this.context && this.ownsContext) {
            void this.context.close();
            this.context = null;
        }
    }

    private bus(category: AudioCategory): AudioNode {
        return this.buses[category] ?? this.master ?? this.ctx.destination;
    }

    /**
     * Configure a 3D panner: HRTF, inverse distance model, optional cone.
     * Leaves Web Audio's default `maxDistance` when the range is unbounded.
     */
    private configurePanner(panner: PannerNode, spec: SourceSpec): void {
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = spec.refDistance;
        panner.rolloffFactor = spec.rolloffFactor;
        if (Number.isFinite(spec.maxDistance)) panner.maxDistance = spec.maxDistance;
        if (spec.coneInner !== undefined && spec.coneOuter !== undefined && spec.dirX !== undefined) {
            panner.coneInnerAngle = (spec.coneInner * 180) / Math.PI;
            panner.coneOuterAngle = (spec.coneOuter * 180) / Math.PI;
            panner.orientationX.value = spec.dirX;
            panner.orientationY.value = spec.dirY ?? 0;
            panner.orientationZ.value = spec.dirZ ?? 0;
        }
    }

    /**
     * Position/pan/attenuation only — never the volume node. Live updates are
     * smoothed (`setTargetAtTime`) to avoid zipper; spawn writes directly.
     */
    private applySpatial(record: WebSource, immediate = false): void {
        const s = record.spec;
        if (this.dimension === '3d') {
            const p = record.spatial as PannerNode & { setPosition?: (x: number, y: number, z: number) => void };
            if (p.positionX) {
                this.setParam(p.positionX, s.x, immediate);
                this.setParam(p.positionY, s.y, immediate);
                this.setParam(p.positionZ, s.z, immediate);
            } else {
                p.setPosition?.(s.x, s.y, s.z);
            }
            return;
        }
        this.setParam((record.spatial as StereoPannerNode).pan, this.panFor(record), immediate);
        this.setParam(record.distanceNode.gain, this.attenuation(record), immediate);
    }

    private setParam(param: AudioParam, value: number, immediate: boolean): void {
        if (immediate) param.value = value;
        else param.setTargetAtTime(value, this.ctx.currentTime, SPATIAL_SMOOTHING);
    }

    /**
     * 2D lateral pan in listener-relative space: the source offset projected
     * onto the listener's right axis (`forwardY, -forwardX`), scaled by
     * `panRange`. Without a forward vector the right axis is world +X.
     */
    private panFor(record: WebSource): number {
        const l = this.listener;
        if (!l) return 0;
        const s = record.spec;
        const dx = s.x - l.x;
        const dy = s.y - l.y;
        let rx = 1;
        let ry = 0;
        const fx = l.forwardX;
        const fy = l.forwardY;
        if (fx !== undefined && fy !== undefined && (fx !== 0 || fy !== 0)) {
            const len = Math.hypot(fx, fy);
            rx = fy / len;
            ry = -fx / len;
        }
        return clamp((dx * rx + dy * ry) / this.panRange, -1, 1);
    }

    /**
     * 2D distance gain — Web Audio's `inverse` model on the X/Y plane (z is
     * ignored in 2D), clamped to `[reference, max]` so it matches the 3D
     * `PannerNode`: `reference / (reference + rolloff × (d − reference))`.
     */
    private attenuation(record: WebSource): number {
        const l = this.listener;
        if (!l) return 1;
        const s = record.spec;
        const dx = s.x - l.x;
        const dy = s.y - l.y;
        const dist = Math.hypot(dx, dy);
        const ref = Math.max(0, s.refDistance);
        if (dist <= ref) return 1;
        const max = Number.isFinite(s.maxDistance) ? Math.max(s.maxDistance, ref) : Infinity;
        const d = Math.min(dist, max);
        return ref / (ref + s.rolloffFactor * (d - ref));
    }

    /** Retarget-safe ramp: `setTargetAtTime` needs no "from", so a new fade can retarget an in-flight one. */
    private rampTo(param: AudioParam, target: number, seconds: number): void {
        const now = this.ctx.currentTime;
        param.cancelScheduledValues(now);
        if (seconds > 0) {
            param.setTargetAtTime(target, now, seconds / 3);
        } else {
            param.value = target;
        }
    }
}

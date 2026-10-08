/**
 * AudioManager — engine-side audio runtime.
 *
 * Owns source bookkeeping (slots, budget, distance culling), the listener,
 * category buses and fades. Every platform operation is delegated to an
 * {@link AudioOutput}. Pure and allocation-light on the per-tick paths; safe to
 * construct where no audio device exists (mirrors `InputManager`).
 *
 * ```ts
 * const audio = new AudioManager({ clips: assets.audio });
 *
 * const waterfall = audio.play({
 *     clip: 'waterfall',
 *     position: [40, 0, 12],
 *     loop: true,
 *     distance: { max: 40 },
 * });
 * audio.setListenerPosition(0, 0, 0);
 * audio.setListenerOrientation(0, 0, -1);
 * loop.events.on('tick', () => audio.update(1 / 20));
 * ```
 */

import { GenerationAllocator } from '../collection';
import { EventSystem } from '../events';
import type { StringOr } from '../bucket/bucket';
import { NullAudioOutput } from './sources/null';
import { WebAudioOutput } from './sources/web-audio';
import type { AudioBucket } from './bucket';
import {
    AUDIO_CATEGORIES,
    type AudioPlayOptions,
    type DistanceOptions,
    type SetVolumeOptions,
    type AudioCategory,
    type AudioClip,
    type AudioClipSource,
    type AudioDimension,
    type AudioListenerState,
    type AudioManagerOptions,
    type AudioOutput,
    type FadeOptions,
    type SourceHandle,
    type SourceSpec,
} from './types';

interface SourceRecord {
    /** Packed handle id (slot + generation). */
    id: number;
    outputId: number;
    clip: AudioClip;
    category: AudioCategory;
    volume: number;
    loop: boolean;
    autoFree: boolean;
    playing: boolean;
    /** Manual pause (`handle.setPaused`). */
    paused: boolean;
    /** True while distance-culled. Combined with `paused` for the output state. */
    culled: boolean;
    /** Last pause state pushed to the output, so we only call it on change. */
    pausedApplied: boolean;
    /** Seconds left before a fade-out frees this source; 0 when none pending. */
    stopAfter: number;
    /** Placement (`x`..`coneOuter`), inlined to avoid a nested allocation per source. */
    x: number;
    y: number;
    z: number;
    dirX?: number;
    dirY?: number;
    dirZ?: number;
    refDistance: number;
    rolloffFactor: number;
    maxDistance: number;
    coneInner?: number;
    coneOuter?: number;
}

type AudioEvents = [
    ['source-started', { id: number; clipId: string; category: AudioCategory }],
    ['source-ended', { id: number; clipId: string }],
    ['source-stopped', { id: number; clipId: string }],
    ['source-evicted', { id: number; clipId: string }],
];

type FreeReason = 'ended' | 'stopped' | 'evicted';

/** True when the runtime exposes Web Audio. */
function hasWebAudio(): boolean {
    return typeof (globalThis as any).AudioContext !== 'undefined'
        || typeof (globalThis as any).webkitAudioContext !== 'undefined';
}

/** Default output: Web Audio when available, else a no-op null output. */
export function createDefaultAudioOutput(
    dimension: AudioDimension = '3d',
    capacity = 256,
    panRange?: number,
): AudioOutput {
    return hasWebAudio()
        ? new WebAudioOutput({ dimension, capacity, panRange })
        : new NullAudioOutput({ dimension, capacity });
}

/** Volume is a non-negative linear multiplier (values > 1 amplify). */
function nonNegative(v: number): number {
    return v < 0 ? 0 : v;
}

/** Known clip ids carried by a registry (an `AudioBucket`), else `string`. */
export type ClipIdsOf<C> = C extends AudioBucket<infer Specs> ? keyof Specs & string : string;

export class AudioManager<C extends AudioClipSource = AudioClipSource> {
    readonly dimension: AudioDimension;
    readonly events = new EventSystem<AudioEvents>({
        events: ['source-started', 'source-ended', 'source-stopped', 'source-evicted'],
    });

    private readonly output: AudioOutput;
    private clips: C | null;
    private readonly maxSources: number;
    private readonly defaultCategory: AudioCategory;
    private readonly defaultDistance: DistanceOptions;
    private destroyed = false;

    private readonly alloc: GenerationAllocator;
    private readonly records: (SourceRecord | null)[];

    /** Persistent listener pose, mutated in place by the setters below. */
    private readonly listener: AudioListenerState = { x: 0, y: 0 };
    private hasListener = false;
    private readonly categoryVolume: Partial<Record<AudioCategory, number>> = {};

    constructor(opts: AudioManagerOptions<C> = {}) {
        this.dimension = opts.dimension ?? '3d';
        this.clips = opts.clips ?? null;
        this.maxSources = opts.maxSources ?? 64;
        this.defaultCategory = opts.defaultCategory ?? 'sfx';
        this.defaultDistance = opts.distance ?? {};
        this.output = opts.output ?? createDefaultAudioOutput(this.dimension, this.maxSources, opts.panRange);

        this.alloc = new GenerationAllocator(this.maxSources);
        this.records = new Array<SourceRecord | null>(this.maxSources).fill(null);

        for (const c of AUDIO_CATEGORIES) this.categoryVolume[c] = 1;
    }

    /** Register the clip registry after construction. */
    attachClips(clips: C): this {
        this.clips = clips;
        return this;
    }

    /** Resume a suspended context. Call from a user gesture (autoplay policy). */
    resume(): Promise<void> {
        return this.output.resume();
    }

    suspend(): Promise<void> {
        return this.output.suspend();
    }

    /** Copy a listener pose. Copies fields; the caller's literal is the only allocation. */
    setListener(state: AudioListenerState): void {
        if (this.destroyed) return;
        const l = this.listener;
        l.x = state.x;
        l.y = state.y;
        l.z = state.z;
        l.forwardX = state.forwardX;
        l.forwardY = state.forwardY;
        l.forwardZ = state.forwardZ;
        l.upX = state.upX;
        l.upY = state.upY;
        l.upZ = state.upZ;
        this.commitListener();
    }

    /** Set the listener position. Zero-allocation — preferred for per-tick updates. */
    setListenerPosition(x: number, y: number, z?: number): void {
        if (this.destroyed) return;
        this.listener.x = x;
        this.listener.y = y;
        if (z !== undefined) this.listener.z = z;
        this.commitListener();
    }

    /** Set the listener facing (2D uses `forwardX`/`forwardY`). Zero-allocation. */
    setListenerOrientation(forwardX: number, forwardY: number, forwardZ?: number): void {
        if (this.destroyed) return;
        this.listener.forwardX = forwardX;
        this.listener.forwardY = forwardY;
        if (forwardZ !== undefined) this.listener.forwardZ = forwardZ;
        this.commitListener();
    }

    private commitListener(): void {
        this.hasListener = true;
        this.output.setListener(this.listener);
    }

    /**
     * Set/fade a category bus. `setVolume({ category: 'music', volume: 0.2, seconds: 0.3 })`.
     * `category` defaults to `'master'`. Volumes are non-negative linear multipliers.
     */
    setVolume(opts: SetVolumeOptions): void;
    /** Set/fade the master volume. `setVolume(0.5)`. */
    setVolume(volume: number): void;
    setVolume(arg: SetVolumeOptions | number): void {
        if (this.destroyed) return;
        const opts: SetVolumeOptions = typeof arg === 'number' ? { volume: arg } : arg;
        const category = opts.category ?? 'master';
        const volume = nonNegative(opts.volume);
        this.categoryVolume[category] = volume;
        this.output.setCategoryVolume(category, { volume, seconds: opts.seconds });
    }

    getVolume(category: AudioCategory = 'master'): number {
        return this.categoryVolume[category] ?? 1;
    }

    /**
     * Spawn a positioned source and return a handle. Pass `loop: true` to keep
     * it playing until `handle.stop()`. Release it with `handle.stop()`.
     */
    play(opts: AudioPlayOptions<ClipIdsOf<C>>): SourceHandle {
        if (this.destroyed) throw new Error('AudioManager: destroyed');
        return this.spawn(opts, opts.loop ?? false, false);
    }

    /** Fire-and-forget: play once and free the source when it ends. Ideal for SFX. */
    playOnce(opts: AudioPlayOptions<ClipIdsOf<C>>): SourceHandle {
        if (this.destroyed) throw new Error('AudioManager: destroyed');
        return this.spawn(opts, false, true);
    }

    /** Resolve options (`play` ?? clip ?? manager default) and create the source. */
    private spawn(opts: AudioPlayOptions<ClipIdsOf<C>>, loop: boolean, autoFree: boolean): SourceHandle {
        const clip = this.resolveClip(opts.clip);
        const category = opts.category ?? clip.category ?? this.defaultCategory;
        const volume = nonNegative(opts.volume ?? clip.volume ?? 1);

        const pos = opts.position as readonly number[];
        const x = pos[0]!;
        const y = pos[1]!;
        const z = pos.length > 2 ? pos[2]! : 0;

        const playDist = opts.distance ?? {};
        const clipDist = clip.distance ?? {};
        const defaultDist = this.defaultDistance;

        let id = this.alloc.allocate();
        if (id === -1) {
            this.evictFarthest();
            id = this.alloc.allocate();
            if (id === -1) throw new Error(`AudioManager: maxSources (${this.maxSources}) reached`);
        }
        const slot = this.alloc.slotOf(id);

        const record: SourceRecord = {
            id,
            outputId: -1,
            clip,
            category,
            volume,
            loop,
            autoFree,
            playing: true,
            paused: false,
            culled: false,
            pausedApplied: false,
            stopAfter: 0,
            x,
            y,
            z,
            dirX: opts.direction?.[0],
            dirY: opts.direction?.[1],
            dirZ: opts.direction?.[2],
            refDistance: playDist.reference ?? clipDist.reference ?? defaultDist.reference ?? 1,
            rolloffFactor: playDist.rolloff ?? clipDist.rolloff ?? defaultDist.rolloff ?? 1,
            maxDistance: playDist.max ?? clipDist.max ?? defaultDist.max ?? Infinity,
            coneInner: opts.coneInner,
            coneOuter: opts.coneOuter,
        };
        this.records[slot] = record;

        record.outputId = this.output.createSource(this.spec(record), () => this.onSourceEnded(id));

        this.events.emit('source-started', { id, clipId: clip.id, category });
        return new Handle(this, slot, id);
    }

    /** Stop and release a source. No-op for stale handles. */
    removeSource(handle: SourceHandle): void {
        const slot = this.slotOf(handle.id);
        if (slot !== -1) this.freeSlot(slot, 'stopped');
    }

    /**
     * Advance per-source lifecycle: fade-out completion and distance culling.
     * Call once per tick (or render). Iterates backwards because freeing a
     * source removes it from the SlotMap (swap-remove).
     */
    update(deltaTime: number): void {
        if (this.destroyed) return;
        for (let i = this.alloc.size - 1; i >= 0; i--) {
            const slot = this.alloc.activeSlots[i]!;
            const record = this.records[slot];
            if (!record) continue;

            if (record.stopAfter > 0) {
                record.stopAfter -= deltaTime;
                if (record.stopAfter <= 0) {
                    this.freeSlot(slot, 'ended');
                    continue;
                }
            }

            if (this.hasListener && record.playing) {
                const max = record.maxDistance;
                const beyond = max !== Infinity && this.distance(record) > max;
                if (beyond !== record.culled) {
                    record.culled = beyond;
                    this.syncPause(record);
                }
            }
        }
    }

    get activeCount(): number {
        return this.alloc.size;
    }

    /**
     * Stop every source and tear down the output. Idempotent; the manager is
     * unusable afterwards (`play` throws, other mutators no-op).
     */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        while (this.alloc.size > 0) this.freeSlot(this.alloc.activeSlots[0]!, 'stopped');
        this.output.destroy();
    }

    /** @internal Resolve a packed handle id to a slot, or -1 if stale. */
    slotOf(id: number): number {
        return this.alloc.isLive(id) ? this.alloc.slotOf(id) : -1;
    }

    /** @internal */ record(slot: number): SourceRecord | null {
        return this.records[slot];
    }

    /** @internal */ applyPosition(slot: number, x: number, y: number, z?: number): void {
        const record = this.records[slot];
        if (!record) return;
        record.x = x;
        record.y = y;
        if (z !== undefined) record.z = z;
        this.output.setSourcePosition(record.outputId, record.x, record.y, record.z);
    }

    /** @internal */ applyDistance(slot: number, opts: DistanceOptions): void {
        const record = this.records[slot];
        if (!record) return;
        if (opts.reference !== undefined) record.refDistance = opts.reference;
        if (opts.rolloff !== undefined) record.rolloffFactor = opts.rolloff;
        if (opts.max !== undefined) record.maxDistance = opts.max;
        this.output.setSourceDistance(
            record.outputId,
            record.refDistance,
            record.rolloffFactor,
            record.maxDistance,
        );
    }

    /** @internal */ applyDirection(slot: number, x: number, y: number, z: number): void {
        const record = this.records[slot];
        if (!record) return;
        record.dirX = x;
        record.dirY = y;
        record.dirZ = z;
        this.output.setSourceOrientation(record.outputId, x, y, z);
    }

    /** @internal */ applyVolume(slot: number, volume: number): void {
        const record = this.records[slot];
        if (!record) return;
        record.volume = nonNegative(volume);
        this.output.setSourceVolume(record.outputId, record.volume);
    }

    /** @internal */ applyPaused(slot: number, paused: boolean): void {
        const record = this.records[slot];
        if (!record) return;
        record.paused = paused;
        this.syncPause(record);
    }

    /** @internal */ applyFade(slot: number, opts: FadeOptions): void {
        const record = this.records[slot];
        if (!record) return;
        const to = nonNegative(opts.to);
        record.volume = to;
        this.output.setSourceVolume(record.outputId, to, opts.seconds);
        if (opts.stopAfter && to <= 0) {
            if (opts.seconds <= 0) this.freeSlot(slot, 'ended');
            else record.stopAfter = opts.seconds;
        }
    }

    /** Push the combined (manual pause OR distance cull) state, only on change. */
    private syncPause(record: SourceRecord): void {
        const effective = record.paused || record.culled;
        if (effective === record.pausedApplied) return;
        record.pausedApplied = effective;
        this.output.setSourcePaused(record.outputId, effective);
    }

    private resolveClip(clipOrId: StringOr<ClipIdsOf<C>> | AudioClip): AudioClip {
        if (typeof clipOrId !== 'string') return clipOrId;
        if (!this.clips) {
            throw new Error(`AudioManager: cannot resolve clip '${clipOrId}' — no clip registry attached`);
        }
        return this.clips.get(clipOrId);
    }

    private spec(record: SourceRecord): SourceSpec {
        return {
            buffer: record.clip.buffer,
            loop: record.loop,
            volume: record.volume,
            category: record.category,
            x: record.x,
            y: record.y,
            z: record.z,
            dirX: record.dirX,
            dirY: record.dirY,
            dirZ: record.dirZ,
            refDistance: record.refDistance,
            rolloffFactor: record.rolloffFactor,
            maxDistance: record.maxDistance,
            coneInner: record.coneInner,
            coneOuter: record.coneOuter,
        };
    }

    private distance(record: SourceRecord): number {
        const l = this.listener;
        const dx = record.x - l.x;
        const dy = record.y - l.y;
        if (this.dimension === '2d') return Math.hypot(dx, dy);
        const dz = record.z - (l.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /** Steal the farthest non-music source. Music is never dropped for SFX. */
    private evictFarthest(): void {
        let victim = -1;
        let far = -Infinity;
        for (let i = 0; i < this.alloc.size; i++) {
            const slot = this.alloc.activeSlots[i]!;
            const record = this.records[slot];
            if (!record || record.category === 'music') continue;
            const d = this.hasListener ? this.distance(record) : 0;
            if (d >= far) {
                far = d;
                victim = slot;
            }
        }
        if (victim !== -1) this.freeSlot(victim, 'evicted');
    }

    private freeSlot(slot: number, reason: FreeReason): void {
        const record = this.records[slot];
        if (!record) return;
        this.output.stopSource(record.outputId);
        const id = record.id;
        this.records[slot] = null;
        this.alloc.free(id);
        const payload = { id, clipId: record.clip.id };
        if (reason === 'ended') this.events.emit('source-ended', payload);
        else if (reason === 'stopped') this.events.emit('source-stopped', payload);
        else this.events.emit('source-evicted', payload);
    }

    private onSourceEnded(id: number): void {
        if (!this.alloc.isLive(id)) return;
        const slot = this.alloc.slotOf(id);
        const record = this.records[slot];
        if (!record) return;
        if (record.autoFree) {
            this.freeSlot(slot, 'ended');
            return;
        }
        record.playing = false;
        this.events.emit('source-ended', { id, clipId: record.clip.id });
    }
}

/** Live source handle. Mirrors the renderer's `InstanceHandle`. */
class Handle implements SourceHandle {
    constructor(
        private readonly manager: AudioManager,
        private readonly slot: number,
        readonly id: number,
    ) {}

    private get record(): SourceRecord | null {
        return this.manager.slotOf(this.id) !== -1 ? this.manager.record(this.slot) : null;
    }

    get clipId(): string { return this.record?.clip.id ?? ''; }
    get category(): AudioCategory { return this.record?.category ?? 'sfx'; }
    get playing(): boolean { return this.record?.playing ?? false; }
    get volume(): number { return this.record?.volume ?? 0; }

    setPosition(x: number, y: number, z?: number): void {
        if (this.record) this.manager.applyPosition(this.slot, x, y, z);
    }

    setDistance(opts: DistanceOptions): void {
        if (this.record) this.manager.applyDistance(this.slot, opts);
    }

    setDirection(x: number, y: number, z: number): void {
        if (this.record) this.manager.applyDirection(this.slot, x, y, z);
    }

    setVolume(volume: number): void {
        if (this.record) this.manager.applyVolume(this.slot, volume);
    }

    setPaused(paused: boolean): void {
        if (this.record) this.manager.applyPaused(this.slot, paused);
    }

    fade(opts: FadeOptions): void {
        if (this.record) this.manager.applyFade(this.slot, opts);
    }

    stop(): void {
        this.manager.removeSource(this);
    }
}

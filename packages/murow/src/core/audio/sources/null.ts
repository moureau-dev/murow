/**
 * NullAudioOutput — a no-op `AudioOutput` for the server/headless and tests.
 *
 * Records spawns, volumes, listener and category changes so behaviour can be
 * asserted without an audio device. `endSource(id)` simulates a clip ending so
 * one-shot auto-free paths can be exercised.
 */

import { SlotMap } from '../../slot-map';
import type {
    AudioCategory,
    AudioDecoded,
    AudioDimension,
    AudioListenerState,
    AudioOutput,
    AudioSpec,
    AudioVolumeOptions,
    SourceSpec,
} from '../types';

/** Recorded state for one spawned source. */
export interface NullSource {
    spec: SourceSpec;
    volume: number;
    paused: boolean;
    onEnded: () => void;
}

export interface NullAudioOutputOptions {
    dimension?: AudioDimension;
    /** Max simultaneous sources. Default 256. */
    capacity?: number;
}

export class NullAudioOutput implements AudioOutput {
    readonly dimension: AudioDimension;
    readonly categoryVolumes: Partial<Record<AudioCategory, number>> = {};
    listener: AudioListenerState | null = null;
    resumeCount = 0;
    suspendCount = 0;
    destroyed = false;

    private readonly slotMap: SlotMap;
    private readonly store: (NullSource | null)[];

    constructor(opts: NullAudioOutputOptions = {}) {
        this.dimension = opts.dimension ?? '3d';
        const capacity = opts.capacity ?? 256;
        this.slotMap = new SlotMap(capacity);
        this.store = new Array<NullSource | null>(capacity).fill(null);
    }

    /** Number of live sources. */
    get sourceCount(): number {
        return this.slotMap.size;
    }

    /** Live source ids, in packed order. */
    sourceIds(): number[] {
        return Array.from(this.slotMap.activeSlots.subarray(0, this.slotMap.size));
    }

    /** Recorded state for a source id, or undefined. */
    source(sourceId: number): NullSource | undefined {
        return this.store[sourceId] ?? undefined;
    }

    async resume(): Promise<void> {
        this.resumeCount++;
    }

    async suspend(): Promise<void> {
        this.suspendCount++;
    }

    decode(data: ArrayBuffer, _spec: AudioSpec): Promise<AudioDecoded> {
        return Promise.resolve({ buffer: { byteLength: data.byteLength }, duration: 0 });
    }

    createSource(spec: SourceSpec, onEnded: () => void): number {
        const id = this.slotMap.add();
        if (id === -1) throw new Error(`NullAudioOutput: source capacity (${this.store.length}) reached`);
        this.store[id] = { spec, volume: spec.volume, paused: false, onEnded };
        return id;
    }

    setSourcePosition(sourceId: number, x: number, y: number, z: number): void {
        const s = this.store[sourceId];
        if (!s) return;
        s.spec.x = x;
        s.spec.y = y;
        s.spec.z = z;
    }

    setSourceDistance(sourceId: number, refDistance: number, rolloffFactor: number, maxDistance: number): void {
        const s = this.store[sourceId];
        if (!s) return;
        s.spec.refDistance = refDistance;
        s.spec.rolloffFactor = rolloffFactor;
        s.spec.maxDistance = maxDistance;
    }

    setSourceOrientation(sourceId: number, x: number, y: number, z: number): void {
        const s = this.store[sourceId];
        if (!s) return;
        s.spec.dirX = x;
        s.spec.dirY = y;
        s.spec.dirZ = z;
    }

    setSourceVolume(sourceId: number, volume: number, _seconds?: number): void {
        const s = this.store[sourceId];
        if (s) s.volume = volume;
    }

    setSourcePaused(sourceId: number, paused: boolean): void {
        const s = this.store[sourceId];
        if (s) s.paused = paused;
    }

    stopSource(sourceId: number): void {
        if (!this.store[sourceId]) return;
        this.store[sourceId] = null;
        this.slotMap.remove(sourceId);
    }

    setListener(state: AudioListenerState): void {
        this.listener = state;
    }

    setCategoryVolume(category: AudioCategory, opts: AudioVolumeOptions): void {
        this.categoryVolumes[category] = opts.volume;
    }

    destroy(): void {
        for (let i = 0; i < this.slotMap.size; i++) this.store[this.slotMap.activeSlots[i]] = null;
        this.slotMap.clear();
        this.destroyed = true;
    }

    /** Test helper: simulate a source reaching the end of a non-looping clip. */
    endSource(sourceId: number): void {
        this.store[sourceId]?.onEnded();
    }
}

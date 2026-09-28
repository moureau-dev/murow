/**
 * Audio contracts.
 *
 * Same shape as input: a pure `AudioManager` talks to a swappable
 * `AudioOutput` — `WebAudioOutput` in the browser, `NullAudioOutput` on the
 * server/tests. The manager owns source bookkeeping, categories, fades and the
 * listener; the output owns the platform API and the 2D/3D panning model.
 *
 * `dimension` follows the simulation, not the renderer: a 2D game rendered in
 * 3D still uses 2D audio.
 */

import type { BucketPrefabBase, BucketSpecBase } from '../bucket';
import type { StringOr } from '../bucket/bucket';

/** Spatial model. `'2d'` pans on X/Y; `'3d'` spatializes with orientation. */
export type AudioDimension = '2d' | '3d';

/** Mixing bus a source routes through. `'master'` is the top of the chain. */
export type AudioCategory = 'master' | 'music' | 'sfx' | 'ambient' | 'voice' | 'ui';

/** Every category, in chain order (master first). */
export const AUDIO_CATEGORIES: readonly AudioCategory[] = [
    'master',
    'music',
    'sfx',
    'ambient',
    'voice',
    'ui',
];

/**
 * A bus volume change: target + optional fade duration.
 *
 * Volumes are absolute linear multipliers. A source's audible level is
 * `source.volume × category.volume × master.volume` (then distance
 * attenuation), each defaulting to 1. So `setVolume({ category: 'master', … })`
 * scales everything, `setVolume({ category: 'music', … })` scales only music,
 * and a source's own `volume` scales only itself.
 */
export interface AudioVolumeOptions {
    /** Target bus volume. @default 1 */
    volume: number;
    /** Fade duration in seconds. @default 0 (immediate) */
    seconds?: number;
}

/** Options for `AudioManager.setVolume`. */
export interface SetVolumeOptions extends AudioVolumeOptions {
    /** Bus to adjust: `'master'` scales everything; a group scales just that bus. @default 'master' */
    category?: AudioCategory;
}

/**
 * Distance attenuation. Full volume within `reference`, falling off by
 * `rolloff` up to `max`, past which the source is at its quietest / culled.
 * 3D uses Web Audio's `inverse` model; 2D does the same manually.
 */
export interface DistanceOptions {
    /** Full-volume radius, world units. @default 1 */
    reference?: number;
    /** Falloff steepness past `reference`; `0` = no falloff. @default 1 */
    rolloff?: number;
    /** Outer bound / cull distance. @default Infinity */
    max?: number;
}

/** A fade request — subsumes fade-in/out/to. Fades from the *current* volume. */
export interface FadeOptions {
    /** Target volume. Fade-out is `to: 0`. */
    to: number;
    /** Duration in seconds (real time, not ticks). */
    seconds: number;
    /** Free the source once a fade-out reaches 0. Default false. */
    stopAfter?: boolean;
}

/**
 * A clip spec's playback defaults. Each is overridden by the matching `play`
 * option, and falls back to the manager default / `1` when neither is set.
 */
export interface AudioClipDefaults {
    /** Default bus (see `PlayBase.category`). */
    readonly category?: AudioCategory;
    /** Default source volume (see `PlayBase.volume`). */
    readonly volume?: number;
    /** Default distance attenuation (see `PlayBase.distance`). */
    readonly distance?: DistanceOptions;
}

/** A declarative clip spec, loaded by `AudioBucket`. */
export interface AudioSpec extends BucketSpecBase, AudioClipDefaults {
    readonly type: 'audio';
    readonly id: string;
    /** URL to fetch and decode. */
    readonly src: string;
    /** Free-form data passed through to the clip. */
    readonly metadata?: Record<string, unknown>;
}

/** A decoded clip addressed by id. `buffer` is backend-specific. */
export interface AudioClip extends BucketPrefabBase, AudioClipDefaults {
    readonly type: 'audio';
    readonly id: string;
    readonly src: string;
    /** Decoded buffer — `AudioBuffer` on Web Audio, opaque elsewhere. */
    readonly buffer: unknown;
    /** Duration in seconds. */
    readonly duration: number;
    /** Resolved default bus for this clip. */
    readonly category: AudioCategory;
    readonly metadata: Record<string, unknown>;
}

/**
 * The read surface the manager needs from the clip registry.
 *
 * @typeParam Id Known clip ids. `get` accepts those literals plus any string,
 *               so a typo compiles but loses autocomplete/typing.
 */
export interface AudioClipSource<Id extends string = string> {
    get(id: StringOr<Id>): AudioClip;
}

/** Decoded playback data. */
export interface AudioDecoded {
    buffer: unknown;
    duration: number;
}

/**
 * Decodes encoded bytes. Supplied by the output. The buffer may be consumed
 * (detached) by the decoder, so don't reuse it afterwards.
 */
export type AudioDecoder = (data: ArrayBuffer, spec: AudioSpec) => Promise<AudioDecoded> | AudioDecoded;

/**
 * Spatial/playback fields shared by both play modes.
 *
 * @typeParam Id Known clip ids (from the registry) the `clip` field autocompletes.
 */
export interface PlayBase<Id extends string = string> {
    /** Clip id (autocompletes known ids), or a resolved `AudioClip`. */
    clip: StringOr<Id> | AudioClip;
    /** World position. `[x, y]` (2D) or `[x, y, z]` (3D). */
    position: readonly [number, number] | readonly [number, number, number];
    /** Facing vector for a 3D cone. `[x, y, z]`, optional. */
    direction?: readonly [number, number, number];
    /** This source's own volume — a linear multiplier of its category bus. @default 1 */
    volume?: number;
    /** Overrides the clip's default bus. */
    category?: AudioCategory;
    /** Distance attenuation. See {@link DistanceOptions}. */
    distance?: DistanceOptions;
    /** Directional cone half-angle, radians (3D only). */
    coneInner?: number;
    /** Directional cone outer half-angle, radians (3D only). */
    coneOuter?: number;
}

/**
 * Options for `AudioManager.play`. `loop: true` keeps the source playing until
 * `stop()`; otherwise it plays once and keeps its handle. Ignored by
 * `playOnce`, which always plays once and frees the source when it ends.
 */
export type AudioPlayOptions<Id extends string = string> = PlayBase<Id> & {
    /** Keep the source playing until `stop()`. @default false */
    loop?: boolean;
};

/** Listener pose. Usually fed from the camera. */
export interface AudioListenerState {
    x: number;
    y: number;
    z?: number;
    forwardX?: number;
    forwardY?: number;
    forwardZ?: number;
    upX?: number;
    upY?: number;
    upZ?: number;
}

/** Fully-resolved parameters handed to the output when spawning a source. */
export interface SourceSpec {
    /** Decoded buffer from the clip. */
    buffer: unknown;
    loop: boolean;
    volume: number;
    category: AudioCategory;
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

/** Platform adapter. One per dimension. */
export interface AudioOutput {
    readonly dimension: AudioDimension;

    /** Resume a suspended context (first user gesture). */
    resume(): Promise<void>;
    /** Suspend playback. */
    suspend(): Promise<void>;

    /** Decode encoded bytes into a playback buffer. */
    decode(data: ArrayBuffer, spec: AudioSpec): Promise<AudioDecoded>;

    /** Spawn a source; `onEnded` fires when a non-looping source finishes. Returns an output source id. */
    createSource(spec: SourceSpec, onEnded: () => void): number;
    /** Move a live source. Must update in place (no per-call allocation). */
    setSourcePosition(sourceId: number, x: number, y: number, z: number): void;
    /** Change a live source's distance model. Must update in place. */
    setSourceDistance(sourceId: number, refDistance: number, rolloffFactor: number, maxDistance: number): void;
    /** Change a live source's facing (3D cone orientation). Must update in place. */
    setSourceOrientation(sourceId: number, x: number, y: number, z: number): void;
    /** Set a source's volume, optionally ramping over `seconds`. */
    setSourceVolume(sourceId: number, volume: number, seconds?: number): void;
    /** Pause/resume a source (distance culling). */
    setSourcePaused(sourceId: number, paused: boolean): void;
    /** Stop and release a source. */
    stopSource(sourceId: number): void;

    /** Set the listener pose. */
    setListener(state: AudioListenerState): void;
    /** Set a category bus volume, optionally ramping. */
    setCategoryVolume(category: AudioCategory, opts: AudioVolumeOptions): void;

    /** Tear down the adapter. */
    destroy(): void;
}

/** Frame-thin handle to a playing source. Mirrors the renderer's `InstanceHandle`. */
export interface SourceHandle {
    readonly id: number;
    readonly clipId: string;
    readonly category: AudioCategory;
    readonly playing: boolean;
    /**
     * Target per-source volume (a linear multiplier of its category bus). While
     * a fade is in flight this is the destination, not the instantaneous level.
     */
    volume: number;
    setPosition(x: number, y: number, z?: number): void;
    /** Change this source's distance model at runtime (`reference`/`rolloff`/`max`). */
    setDistance(opts: DistanceOptions): void;
    /** Change this source's facing (3D cone orientation) at runtime. */
    setDirection(x: number, y: number, z: number): void;
    setVolume(volume: number): void;
    setPaused(paused: boolean): void;
    fade(opts: FadeOptions): void;
    stop(): void;
}

export interface AudioManagerOptions<C extends AudioClipSource = AudioClipSource> {
    /**
     * Output adapter. Defaults to `WebAudioOutput` when Web Audio is present,
     * otherwise `NullAudioOutput` — so construction is safe on the server.
     */
    output?: AudioOutput;
    /** Spatial model. @default '3d' */
    dimension?: AudioDimension;
    /**
     * Clip registry (`assets.audio`). Pass an `AudioBucket` to get typed ids in
     * `play({ clip })`. Required to play by id.
     */
    clips?: C;
    /** Simultaneous source cap. Default 64; beyond it the farthest non-music source is stolen. */
    maxSources?: number;
    /** Bus used when neither the source nor the clip declares one. @default 'sfx' */
    defaultCategory?: AudioCategory;
    /**
     * 2D only: world-space X offset that maps to a hard left/right pan.
     * Forwarded to the default output; ignored if `output` is supplied.
     * @default 12
     */
    panRange?: number;
    /** Default distance attenuation for sources that don't set one. */
    distance?: DistanceOptions;
}

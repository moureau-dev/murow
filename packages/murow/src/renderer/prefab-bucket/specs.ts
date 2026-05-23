/**
 * Prefab spec / prefab type unions.
 *
 * Specs describe what to load (URLs, sizes, options). Prefabs are the
 * parsed CPU-side result — the renderer reads these at init() to size
 * GPU buffers and uploads them; user code retrieves them by id and
 * passes them to `addInstance` / `addSprite`.
 *
 * These types are renderer-agnostic. The actual GPU upload lives in
 * specific backends (e.g. `@murow/webgpu`).
 */

import type { ParsedGltf } from '../gltf/parser';
import type { ParsedSpritesheet } from '../spritesheet/parser';

/**
 * Extracts the spec's `metadata` literal type for the parsed prefab.
 * Missing metadata defaults to `{}` at parse time, so the parsed prefab's
 * `metadata` field is always present — no `?.` needed.
 *
 * - Required field → exact literal type (e.g. `{ scale: 0.5 }`)
 * - Optional field → `NonNullable<M>` (you know the field is there at runtime,
 *                    but its shape isn't pinned because the spec didn't pin it)
 * - Absent         → `Record<string, unknown>` (default open shape)
 */
type MetadataOf<S> =
    S extends { readonly metadata: infer M } ? M :
    S extends { readonly metadata?: infer M } ? NonNullable<M> :
    Record<string, unknown>;

// ============================================================================
// 3D
// ============================================================================

export interface GltfSpec {
    readonly type: 'gltf';
    /** Unique identifier for the prefab. */
    readonly id: string;
    /** URL to the .gltf or .glb file. */
    readonly src: string;
    /** Optional whitelist of animation clip names to keep. Defaults to all. Filter them here and get type-safety and more performance. */
    readonly animations?: readonly string[];
    /**
     * Release the source glTF JSON + accessor reader after parse. Saves
     * memory but removes `loadAnimations` / `unloadAnimations` at runtime
     * and the type level.
     */
    readonly freezeAnimations?: boolean;
    /** Optional user-defined sidecar data (scale, speed, gameplay hints, etc). */
    readonly metadata?: Record<string, unknown>;
}

export interface GridSpec {
    readonly type: 'grid';
    /** Unique identifier for the prefab. */
    readonly id: string;
    readonly size: number;
    readonly step: number;
    readonly lineWidth: number;
    /** Optional user-defined sidecar data (scale, speed, gameplay hints, etc). */
    readonly metadata?: Record<string, unknown>;
}

export type Prefab3DSpec = GltfSpec | GridSpec;

/**
 * Map a spec's `animations` tuple to a record-keyed-by-name. Used to type
 * `GltfPrefab.animations` so `prefab.animations.Run` is a string literal
 * (and `prefab.animations.Typo` is a compile-time error).
 */
export type AnimationsRecord<A extends readonly string[]> = {
    readonly [K in A[number]]: K;
};

/** Animation fields for a spec with a non-empty literal `animations` tuple. */
type NarrowAnimations<S extends GltfSpec> = {
    readonly animations: AnimationsRecord<Extract<S['animations'], readonly string[]>>;
    readonly animationList: Extract<S['animations'], readonly string[]>;
};

/** Animation fields for a spec where `animations` was declared optional (default). */
type WideAnimations = {
    readonly animations?: Record<string, string>;
    readonly animationList?: readonly string[];
};

/** Lazy clip-management methods. Present when the spec didn't set `freezeAnimations: true`. */
export type UnfrozenAnimationMethods = {
    /** Decode and pack clips by name. Already-loaded names are no-ops; unknown names throw. */
    loadAnimations(names: readonly string[]): Promise<void>;
    /** Drop clips from the packed buffer. No-op for clips that aren't loaded. */
    unloadAnimations(names: readonly string[]): void;
    /** Restore the prefab to its spec-declared (parse-time) animation set. */
    resetAnimations(): void;
};

/** Optional-method version of `UnfrozenAnimationMethods`, used on the wide-union `GltfPrefab<GltfSpec>`. */
type OptionalAnimationMethods = {
    loadAnimations?: UnfrozenAnimationMethods['loadAnimations'];
    unloadAnimations?: UnfrozenAnimationMethods['unloadAnimations'];
    resetAnimations?: UnfrozenAnimationMethods['resetAnimations'];
};

/** Common (non-conditional) fields of every parsed glTF prefab. */
type GltfPrefabBase<S extends GltfSpec> = {
    readonly type: 'gltf';
    readonly id: S['id'];
    readonly parsed: ParsedGltf;
    readonly skinnedPartCount: number;
    readonly jointCount: number;
    /** Total vertices across all primitives. */
    readonly totalVertexCount: number;
    /** Passed through from the spec. */
    readonly metadata: MetadataOf<S>;
};

/**
 * Animation record/list fields, narrowed by what the spec declared:
 *   - literal `animations` tuple → narrow record + tuple
 *   - `animations?` (declared optional) → wide record + array
 *   - field absent → no animation fields
 */
type GltfPrefabAnimationFields<S extends GltfSpec> =
    S extends { animations: readonly [string, ...string[]] }
        ? NarrowAnimations<S>
    : S extends { animations?: readonly string[] | undefined }
        ? WideAnimations
        : {};

/** Pull out the `freezeAnimations` literal: `true`/`false` if pinned, `boolean` if wide, `never` if absent. */
type FreezeFlagOf<S> = S extends { freezeAnimations?: infer F } ? F : never;

/**
 * Lazy-method narrowing:
 *   - wide spec (`freezeAnimations?: boolean`) → optional methods, so the
 *     union `Prefab3D` doesn't re-add them to a narrowed-frozen variant
 *   - literal `true` → no methods
 *   - literal `false` or absent → required methods
 */
type GltfPrefabLazyMethods<S extends GltfSpec> =
    boolean extends FreezeFlagOf<S>
        ? OptionalAnimationMethods
    : S extends { freezeAnimations: true }
        ? {}
    : UnfrozenAnimationMethods;

/** Parsed glTF prefab, with `id`, `metadata`, `animations`, and `freezeAnimations` narrowed by the spec literal. */
export type GltfPrefab<S extends GltfSpec = GltfSpec> =
    & GltfPrefabBase<S>
    & GltfPrefabAnimationFields<S>
    & GltfPrefabLazyMethods<S>;

export interface GridPrefab<S extends GridSpec = GridSpec> {
    readonly type: 'grid';
    readonly id: S['id'];
    readonly size: number;
    readonly step: number;
    readonly lineWidth: number;
    readonly metadata: MetadataOf<S>;
}

export type Prefab3D = GltfPrefab | GridPrefab;

// ============================================================================
// 2D
// ============================================================================

export interface SpritesheetSpec {
    readonly type: 'spritesheet';
    readonly id: string;
    /** URL to the image. */
    readonly src: string;
    readonly frameWidth?: number;
    readonly frameHeight?: number;
    /** URL to a texture-packer JSON file. Mutually exclusive with frameWidth/frameHeight. */
    readonly data?: string;
    readonly metadata?: Record<string, unknown>;
}

export type Prefab2DSpec = SpritesheetSpec;

export interface SpritesheetPrefab<S extends SpritesheetSpec = SpritesheetSpec> {
    readonly type: 'spritesheet';
    readonly id: S['id'];
    readonly parsed: ParsedSpritesheet;
    readonly frameCount: number;
    readonly width: number;
    readonly height: number;
    readonly metadata: MetadataOf<S>;
}

export type Prefab2D = SpritesheetPrefab;

// ============================================================================
// Spec → prefab mapping
// ============================================================================

/**
 * Maps a spec variant to its concrete parsed prefab variant. Used by the
 * bucket's `get()` so `bucket.get('minion')` returns `GltfPrefab` directly,
 * not the discriminated union.
 */
export type PrefabFor<S> =
    S extends GltfSpec ? GltfPrefab<S> :
    S extends GridSpec ? GridPrefab<S> :
    S extends SpritesheetSpec ? SpritesheetPrefab<S> :
    never;

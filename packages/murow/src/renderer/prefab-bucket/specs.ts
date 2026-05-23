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

/**
 * GltfPrefab — generic over its source spec so the spec's literal `animations`
 * tuple, `id`, and `metadata` are preserved through `bucket.get('annie')`.
 *
 * Animation fields (`animations`, `animationList`) reflect what the spec declared:
 *   - Spec with `animations: ['Run', 'Idle1']` → narrow record `{ Run, Idle1 }` and tuple
 *   - Spec with `animations?` (default) → wide record/array
 *   - Spec without `animations` field at all → fields absent
 */
export type GltfPrefab<S extends GltfSpec = GltfSpec> = {
    readonly type: 'gltf';
    readonly id: S['id'];
    readonly parsed: ParsedGltf;
    readonly skinnedPartCount: number;
    readonly jointCount: number;
    /** Total vertices across all primitives. */
    readonly totalVertexCount: number;
    /** Passed through from the spec. */
    readonly metadata: MetadataOf<S>;
} & (
    // 1. Spec has a non-empty animations tuple → narrow record + tuple
    S extends { animations: readonly [string, ...string[]] }
        ? {
            readonly animations: AnimationsRecord<S['animations']>;
            readonly animationList: S['animations'];
        }
    // 2. Spec has `animations?` (declared optional) → wide record + array
    : S extends { animations?: readonly string[] | undefined }
        ? {
            readonly animations?: Record<string, string>;
            readonly animationList?: readonly string[];
        }
    // 3. Spec has no animations field → fields absent
    : {}
);

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

/**
 * Prefab spec / prefab type unions for the WebGPU renderers.
 *
 * Specs describe what to load (URLs, sizes, options). Prefabs are the
 * parsed CPU-side result — the renderer reads these at init() to size
 * GPU buffers and uploads them; user code retrieves them by id and
 * passes them to `addInstance` / `addSprite`.
 */

import type { ParsedGltf } from '../3d/gltf-parser';
import type { ParsedSpritesheet } from '../spritesheet/spritesheet-parser';

// ============================================================================
// 3D
// ============================================================================

export interface GltfSpec {
    readonly type: 'gltf';
    readonly id: string;
    readonly url: string;
    /** Optional whitelist of animation clip names to keep. Defaults to all. */
    readonly animations?: readonly string[];
}

export interface GridSpec {
    readonly type: 'grid';
    readonly id: string;
    readonly size: number;
    readonly step: number;
    readonly lineWidth: number;
}

export type Prefab3DSpec = GltfSpec | GridSpec;

/**
 * Map a spec's `animations` tuple to a record-keyed-by-name. Used to type
 * `GltfPrefab.animations` so `prefab.animations.Run` is a string literal
 * (and `prefab.animations.Typo` is a compile-time error).
 *
 * If the spec doesn't declare `animations`, the prefab gets the open-ended
 * `Record<string, string>` (whatever the loader finds at runtime).
 */
export type AnimationsRecord<A> =
    A extends readonly string[]
        ? { readonly [K in A[number]]: K }
        : Record<string, string>;

/**
 * GltfPrefab — generic over its source spec so the spec's literal `animations`
 * tuple and `id` are preserved through `bucket.get('annie').animations`.
 */
export interface GltfPrefab<S extends GltfSpec = GltfSpec> {
    readonly type: 'gltf';
    readonly id: S['id'];
    readonly parsed: ParsedGltf;
    /**
     * Animations declared on the spec, indexed by name.
     * `prefab.animations.Run` returns `'Run'` (typed as the literal).
     */
    readonly animations: AnimationsRecord<S['animations']>;
    /** All animation names declared on the spec, as a literal-typed tuple. */
    readonly animationList: S['animations'] extends readonly string[]
        ? S['animations']
        : readonly string[];
    readonly skinnedPartCount: number;
    readonly jointCount: number;
    /** Total vertices across all primitives. */
    readonly totalVertexCount: number;
}

export interface GridPrefab {
    readonly type: 'grid';
    readonly id: string;
    readonly size: number;
    readonly step: number;
    readonly lineWidth: number;
}

export type Prefab3D = GltfPrefab | GridPrefab;

// ============================================================================
// 2D
// ============================================================================

export interface SpritesheetSpec {
    readonly type: 'spritesheet';
    readonly id: string;
    readonly url: string;
    readonly frameWidth?: number;
    readonly frameHeight?: number;
    /** URL to a texture-packer JSON file. Mutually exclusive with frameWidth/frameHeight. */
    readonly data?: string;
}

export type Prefab2DSpec = SpritesheetSpec;

export interface SpritesheetPrefab {
    readonly type: 'spritesheet';
    readonly id: string;
    readonly parsed: ParsedSpritesheet;
    readonly frameCount: number;
    readonly width: number;
    readonly height: number;
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
    S extends GridSpec ? GridPrefab :
    S extends SpritesheetSpec ? SpritesheetPrefab :
    never;

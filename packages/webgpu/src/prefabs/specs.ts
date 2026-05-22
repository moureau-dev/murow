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

export interface GltfPrefab {
    readonly type: 'gltf';
    readonly id: string;
    readonly parsed: ParsedGltf;
    readonly animations: readonly string[];
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

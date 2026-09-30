/**
 * Every renderer handle, grouped under the `Handles` namespace.
 *
 * Handles are opaque references returned by the renderer: models/textures are
 * GPU resources, instance handles are live spawned objects. The individual
 * types are re-exported at the top level of the package for convenience.
 */
import type { PlayOptions, TexturePrefab } from 'murow/renderer';

export declare namespace Handles {
    /** A GPU mesh resource. */
    export interface ModelHandle {
        readonly id: number;
        readonly vertexCount: number;
        readonly indexCount: number;
        readonly skinned: boolean;
    }

    /** A loaded glTF model — may contain multiple mesh parts that share a skeleton. */
    export interface GltfModel {
        readonly parts: ModelHandle[];
        readonly totalVertexCount: number;
        readonly skinned: boolean;
        /** Animation clip names available on this model (empty if not skinned). */
        readonly animations: string[];
        /** Source URL this model was loaded from. */
        readonly src: string;
    }

    /** A single-part spawned instance. */
    export interface MeshInstanceHandle {
        readonly id: number;
        readonly slot: number;
        readonly modelId: number;
        readonly skinned: boolean;
        /** Source prefab id, or `null` if spawned from a raw model handle. */
        readonly prefabId: string | null;
        readonly textureId: string | null;
        setPosition(x: number, y: number, z: number): void;
        setRotation(x: number, y: number, z: number): void;
        setScale(x: number, y: number, z: number): void;
        /**
         * Set position WITHOUT GPU interpolation from the previous frame.
         * Writes both PREV and CURR to the same value, so the next render
         * produces no lerp slide. Use after teleports, network snapshot
         * snaps, or any time the entity should appear at the new location
         * immediately rather than smoothly moving toward it.
         */
        teleport(x: number, y: number, z: number): void;
        /**
         * Logical current position (what `setPosition` last wrote, not the interpolated render value).
         * Returns a per-handle reusable tuple — do not retain across subsequent gets on the same handle.
         */
        readonly position: readonly [number, number, number];
        /** Logical current rotation in radians. Reusable tuple; see `position`. */
        readonly rotation: readonly [number, number, number];
        /** Logical current scale. Reusable tuple; see `position`. */
        readonly scale: readonly [number, number, number];
        play?(name: string, opts?: PlayOptions): void;
        stop?(): void;
        setTexture?(texture: string | TexturePrefab | null): void;
        /** Free this instance's renderer slot. Safe to call once per handle. */
        destroy(): void;
    }

    /** A spawned instance (single primitive or multi-part glTF). */
    export interface InstanceHandle {
        readonly id: number;
        setPosition(x: number, y: number, z: number): void;
        setRotation(x: number, y: number, z: number): void;
        setScale(x: number, y: number, z: number): void;
        /**
         * Set position WITHOUT GPU interpolation from the previous frame.
         * Writes both PREV and CURR to the same value, so the next render
         * produces no lerp slide. Use after teleports, network snapshot
         * snaps, or any time the entity should appear at the new location
         * immediately.
         */
        teleport(x: number, y: number, z: number): void;
        /**
         * Logical current position (what `setPosition` last wrote, not the interpolated render value).
         * Returns a per-handle reusable tuple — do not retain across subsequent gets on the same handle.
         */
        readonly position: readonly [number, number, number];
        /** Logical current rotation in radians. Reusable tuple; see `position`. */
        readonly rotation: readonly [number, number, number];
        /** Logical current scale. Reusable tuple; see `position`. */
        readonly scale: readonly [number, number, number];
        play?(name: string, opts?: PlayOptions): void;
        stop?(): void;
        readonly skinned: boolean;
        /** Source prefab id, or `null` if spawned from a raw model handle. */
        readonly prefabId: string | null;
        /** Current texture override id, or `null` if using the model's default texture. */
        readonly textureId: string | null;
        /**
         * Swap the per-instance texture at runtime. Pass a texture ID or
         * TexturePrefab. Clears the override when called with `null` or `undefined`,
         * reverting to the model's default texture.
         */
        setTexture?(texture: string | TexturePrefab | null): void;
        /** Free this instance's renderer slot(s). Safe to call once per handle. */
        destroy(): void;
    }

    /** A dynamic light owned by the `LightSystem`. */
    export type LightHandle = import('../lights/lights').LightHandle;
}

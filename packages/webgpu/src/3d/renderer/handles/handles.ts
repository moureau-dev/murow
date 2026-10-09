/**
 * Every renderer handle, grouped under the `Handles` namespace.
 *
 * Handles are opaque references returned by the renderer: models/textures are
 * GPU resources, instance handles are live spawned objects. The individual
 * types are re-exported at the top level of the package for convenience.
 */
import type { PlayOptions, TexturePrefab } from 'murow/renderer';
import type { HandleBase } from '../../../handle-base';
import type { DecalId, EmitterId, InstanceId, LayerId, LightId } from '../ids';

export declare namespace Handles {
    /** A live reference to one material attached to an instance. */
    export interface MaterialRef {
        /** 1-based material id (0 = engine default). */
        readonly materialId: number;
        /** Registered name of the material ('' when unknown). */
        readonly name: string;
        /** Detach this material from the instance. */
        remove(): void;
    }

    /**
     * Addressable view over an instance's materials. Look up by name, 1-based
     * material id, or (for `add`) a material handle. Names resolve against the
     * renderer's material library.
     */
    export interface InstanceMaterials {
        get(idOrName: number | string): MaterialRef | undefined;
        has(idOrName: number | string): boolean;
        /** Attach a material handle (no-op if already present or at capacity). */
        add(material: { readonly slot: number }): void;
        remove(idOrName: number | string): void;
        readonly all: readonly MaterialRef[];
    }

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
    export interface MeshInstanceHandle extends HandleBase<InstanceId> {
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
        /** Swap the instance's material (0 = engine default). */
        setMaterial?(materialId: number): void;
        /** Per-instance floats available to materials as `statics[slot].custom0/1`. */
        setMaterialParams?(a: number, b: number): void;
        /** The instance's materials, addressable by name/id. */
        materials: InstanceMaterials;
        /** Free this instance's renderer slot. Safe to call once per handle. */
        destroy(): void;
    }

    /** A spawned instance (single primitive or multi-part glTF). */
    export interface InstanceHandle extends HandleBase<InstanceId> {
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
        /** The instance's materials, addressable by name/id. */
        materials: InstanceMaterials;
        /** Free this instance's renderer slot(s). Safe to call once per handle. */
        destroy(): void;
    }

    /**
     * Live handle to a dynamic light. All properties are readable and mutable
     * every frame, unlike a mesh instance's spawn-frozen color. `destroy()`
     * frees the slot.
     *
     * The `position` / `direction` / `color` getters return a per-handle reused
     * tuple (mutated on each read), matching `MeshInstanceHandle`. Copy the
     * values out if you need to retain them past the next read on the same handle.
     */
    export interface LightHandle extends HandleBase<LightId> {
        readonly slot: number;
        setPosition(x: number, y: number, z: number): void;
        setDirection(x: number, y: number, z: number): void;
        /** Snap to a position without interpolating from the previous one (use after a discontinuous move). */
        teleport(x: number, y: number, z: number): void;
        setColor(r: number, g: number, b: number): void;
        readonly position: readonly [number, number, number];
        readonly direction: readonly [number, number, number];
        readonly color: readonly [number, number, number];
        intensity: number;
        range: number;
        /** Cone half-angle in radians (spot only; `0` for point lights). Readable + settable. */
        angle: number;
        /** Edge softness 0..1 (spot only). `0` = hard edge, `1` = fades from center. Readable + settable. */
        smoothness: number;
        /** Whether the light contributes this frame. Toggling does not free the slot. */
        enabled: boolean;
        /** Per-light shadow override, when this light casts a shadow. */
        shadow?: LightShadow;
        destroy(): void;
    }

    /** Per-light shadow participation and overrides. */
    export interface LightShadow {
        enabled: boolean;
        bias?: number;
    }

    /** A decal layer: a pool of surface marks sharing one atlas material. */
    export interface DecalLayer {
        readonly id: LayerId;
        readonly alive: boolean;
        readonly capacity: number;
        readonly count: number;
        add(x: number, y: number, z: number, nx: number, ny: number, nz: number, opts?: unknown): DecalHandle | null;
        destroy(): void;
    }

    /** A spawned decal. */
    export interface DecalHandle extends HandleBase<DecalId> {
        readonly x: number;
        readonly y: number;
        readonly z: number;
    }

    /** A live particle emitter. */
    export interface ParticleEmitter extends HandleBase<EmitterId> {
        enabled: boolean;
        readonly position: [number, number, number];
        update(deltaTime: number): void;
        setPosition(x: number, y: number, z: number): void;
        setRotation(x: number, y: number, z: number): void;
    }
}

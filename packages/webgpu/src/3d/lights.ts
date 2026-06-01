/**
 * Dynamic lighting state for the 3D renderer.
 *
 * Owns the CPU side of lighting: the per-light SoA, slot allocation, live
 * handles, the dense pack for upload, and the global directional + ambient
 * terms. The renderer owns the GPU buffer + bind groups and drives this each
 * frame via `pack()` (dense light data to upload) and `writeUniforms()` (the
 * directional/ambient/count block of its uniform array).
 */
import { SlotMap } from 'murow/core/slot-map';
import { LIGHT_FLOATS, LIGHT_KIND_POINT, LIGHT_KIND_SPOT } from '../core/types';

/**
 * A dynamic point or spot light. Directional/ambient terms are global and set
 * via `setDirectionalLight` / `setAmbient`, not added here.
 */
export type LightSpec =
    | {
        type: 'point';
        position: readonly [x: number, y: number, z: number];
        /** Light color RGB. Defaults to `[1, 1, 1]`. */
        color?: readonly [r: number, g: number, b: number];
        /** Brightness multiplier. Defaults to `1`. */
        intensity?: number;
        /** World-unit radius past which the light contributes nothing. Defaults to `10`. */
        range?: number;
    }
    | {
        type: 'spot';
        position: readonly [x: number, y: number, z: number];
        /** Direction the cone points along. */
        direction: readonly [x: number, y: number, z: number];
        color?: readonly [r: number, g: number, b: number];
        intensity?: number;
        range?: number;
        /** Cone half-angle in radians (the outer edge). Defaults to `0.5`. */
        angle?: number;
        /**
         * Edge softness, 0..1. `0` = hard edge at `angle`; `1` = the cone fades
         * all the way from its center. The feathered band is `angle * smoothness`
         * wide, measured inward from the edge. Defaults to `0.5`.
         */
        smoothness?: number;
    };

/**
 * Live handle to a dynamic light. All properties are readable and mutable every
 * frame — unlike a mesh instance's spawn-frozen color. `destroy()` frees the slot.
 *
 * The `position` / `direction` / `color` getters return a per-handle reused
 * tuple (mutated on each read), matching `MeshInstanceHandle`. Copy the values
 * out if you need to retain them past the next read on the same handle.
 */
export interface LightHandle {
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
    destroy(): void;
}

/** Light field offsets within a record (see the `Light` struct in core/types). */
const KIND = 0;
const CURR_POS_X = 1, CURR_POS_Y = 2, CURR_POS_Z = 3;
const PREV_POS_X = 4, PREV_POS_Y = 5, PREV_POS_Z = 6;
const CURR_DIR_X = 7, CURR_DIR_Y = 8, CURR_DIR_Z = 9;
const PREV_DIR_X = 10, PREV_DIR_Y = 11, PREV_DIR_Z = 12;
const COL_R = 13, COL_G = 14, COL_B = 15, INTENSITY = 16, RANGE = 17;
const INNER_COS = 18, OUTER_COS = 19, CASTS_SHADOW = 20, SHADOW_INDEX = 21;

export class LightSystem {
    private readonly data: Float32Array;
    private readonly slots: SlotMap;
    private readonly enabled: Uint8Array;
    private readonly handles: (LightHandle | null)[];
    /** Dense scratch buffer of enabled lights, packed each frame for upload. */
    private readonly uploadData: Float32Array;
    /** CPU-side spot cone params per slot (the GPU only needs the derived cosines). */
    private readonly angle: Float32Array;
    private readonly smoothness: Float32Array;

    // Global directional + ambient terms (the classic fixed look; now configurable).
    private dirDir: [number, number, number] = [0.3, 0.8, 0.5];
    private dirColor: [number, number, number] = [1, 1, 1];
    private dirIntensity = 1;
    private ambient: [number, number, number] = [0.3, 0.3, 0.3];

    constructor(private readonly maxLights: number) {
        this.data = new Float32Array(maxLights * LIGHT_FLOATS);
        this.slots = new SlotMap(maxLights);
        this.enabled = new Uint8Array(maxLights).fill(1);
        this.handles = new Array(maxLights).fill(null);
        this.uploadData = new Float32Array(maxLights * LIGHT_FLOATS);
        this.angle = new Float32Array(maxLights);
        this.smoothness = new Float32Array(maxLights);
    }

    /** Add a dynamic point or spot light. Throws past `maxLights`. */
    add(spec: LightSpec): LightHandle {
        const slot = this.slots.add();
        if (slot === -1) throw new Error(`Max lights (${this.maxLights}) reached`);

        this.enabled[slot] = 1;
        this.writeSlot(slot, spec);

        const data = this.data;
        const enabledArr = this.enabled;
        const slots = this.slots;
        const handles = this.handles;
        const angleArr = this.angle;
        const smoothArr = this.smoothness;
        const base = slot * LIGHT_FLOATS;
        let destroyed = false;

        // Reused tuples for the readonly getters; mutated on each read.
        const posOut: [number, number, number] = [0, 0, 0];
        const dirOut: [number, number, number] = [0, 0, 0];
        const colOut: [number, number, number] = [0, 0, 0];

        const handle: LightHandle = {
            slot,
            setPosition(x, y, z) { data[base + CURR_POS_X] = x; data[base + CURR_POS_Y] = y; data[base + CURR_POS_Z] = z; },
            setDirection(x, y, z) { data[base + CURR_DIR_X] = x; data[base + CURR_DIR_Y] = y; data[base + CURR_DIR_Z] = z; },
            teleport(x, y, z) {
                data[base + CURR_POS_X] = x; data[base + CURR_POS_Y] = y; data[base + CURR_POS_Z] = z;
                data[base + PREV_POS_X] = x; data[base + PREV_POS_Y] = y; data[base + PREV_POS_Z] = z;
            },
            setColor(r, g, b) { data[base + COL_R] = r; data[base + COL_G] = g; data[base + COL_B] = b; },
            get position(): readonly [number, number, number] {
                posOut[0] = data[base + CURR_POS_X]; posOut[1] = data[base + CURR_POS_Y]; posOut[2] = data[base + CURR_POS_Z];
                return posOut;
            },
            get direction(): readonly [number, number, number] {
                dirOut[0] = data[base + CURR_DIR_X]; dirOut[1] = data[base + CURR_DIR_Y]; dirOut[2] = data[base + CURR_DIR_Z];
                return dirOut;
            },
            get color(): readonly [number, number, number] {
                colOut[0] = data[base + COL_R]; colOut[1] = data[base + COL_G]; colOut[2] = data[base + COL_B];
                return colOut;
            },
            get intensity() { return data[base + INTENSITY]; },
            set intensity(v) { data[base + INTENSITY] = v; },
            get range() { return data[base + RANGE]; },
            set range(v) { data[base + RANGE] = v; },
            get angle() { return angleArr[slot]; },
            set angle(v) {
                angleArr[slot] = v;
                const { innerCos, outerCos } = coneCosines(v, smoothArr[slot]);
                data[base + INNER_COS] = innerCos; data[base + OUTER_COS] = outerCos;
            },
            get smoothness() { return smoothArr[slot]; },
            set smoothness(v) {
                const s = v < 0 ? 0 : v > 1 ? 1 : v;
                smoothArr[slot] = s;
                const { innerCos, outerCos } = coneCosines(angleArr[slot], s);
                data[base + INNER_COS] = innerCos; data[base + OUTER_COS] = outerCos;
            },
            get enabled() { return enabledArr[slot] === 1; },
            set enabled(v) { enabledArr[slot] = v ? 1 : 0; },
            destroy() {
                if (destroyed) return;
                destroyed = true;
                data.fill(0, base, base + LIGHT_FLOATS);
                handles[slot] = null;
                slots.remove(slot);
            },
        };
        this.handles[slot] = handle;
        return handle;
    }

    /**
     * Set the global directional light (the "sun"). `direction` points from the
     * surface toward the light. Defaults to `(0.3, 0.8, 0.5)`, white, intensity 1.
     */
    setDirectional(
        direction: readonly [number, number, number],
        color: readonly [number, number, number] = [1, 1, 1],
        intensity = 1,
    ): void {
        this.dirDir = [direction[0], direction[1], direction[2]];
        this.dirColor = [color[0], color[1], color[2]];
        this.dirIntensity = intensity;
    }

    /** Set the global ambient term. Defaults to `(0.3, 0.3, 0.3)`. */
    setAmbient(color: readonly [number, number, number]): void {
        this.ambient = [color[0], color[1], color[2]];
    }

    /** Number of live dynamic lights. */
    get count(): number {
        return this.slots.size;
    }

    /**
     * Pack enabled lights into a dense run for upload. Disabled lights are
     * skipped so the shader loop only walks contributing lights. Returns the
     * shared scratch buffer, the light count, and the byte length to upload
     * (so the caller never needs the record layout).
     */
    pack(): { data: Float32Array; count: number; byteLength: number } {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        const src = this.data;
        const dst = this.uploadData;
        let count = 0;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            if (this.enabled[slot] === 0) continue;
            const sBase = slot * LIGHT_FLOATS;
            dst.set(src.subarray(sBase, sBase + LIGHT_FLOATS), count * LIGHT_FLOATS);
            count++;
        }
        return { data: dst, count, byteLength: count * LIGHT_FLOATS * 4 };
    }

    /**
     * Stamp the directional + ambient terms and the light count into the
     * renderer's uniform array, starting at `offset` (the float index after the
     * VP matrix + alpha). Layout: lightDir(3), dirColor(3), dirIntensity(1),
     * ambient(3), then lightCount as a u32 reinterpret at `offset + 10`.
     */
    writeUniforms(uniformData: Float32Array, offset: number, count: number): void {
        uniformData[offset + 0] = this.dirDir[0];
        uniformData[offset + 1] = this.dirDir[1];
        uniformData[offset + 2] = this.dirDir[2];
        uniformData[offset + 3] = this.dirColor[0];
        uniformData[offset + 4] = this.dirColor[1];
        uniformData[offset + 5] = this.dirColor[2];
        uniformData[offset + 6] = this.dirIntensity;
        uniformData[offset + 7] = this.ambient[0];
        uniformData[offset + 8] = this.ambient[1];
        uniformData[offset + 9] = this.ambient[2];
        new Uint32Array(uniformData.buffer)[offset + 10] = count;
    }

    /**
     * Snapshot every live light's current position/direction into its prev
     * slot. Called from the renderer's `storePreviousState()` in `pre-tick`, so
     * the shader can `mix(prev, curr, alpha)` and moving lights interpolate at
     * render rate instead of snapping at the tick boundary.
     */
    storePrevious(): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        const data = this.data;
        for (let i = 0; i < size; i++) {
            const base = active[i]! * LIGHT_FLOATS;
            data[base + PREV_POS_X] = data[base + CURR_POS_X];
            data[base + PREV_POS_Y] = data[base + CURR_POS_Y];
            data[base + PREV_POS_Z] = data[base + CURR_POS_Z];
            data[base + PREV_DIR_X] = data[base + CURR_DIR_X];
            data[base + PREV_DIR_Y] = data[base + CURR_DIR_Y];
            data[base + PREV_DIR_Z] = data[base + CURR_DIR_Z];
        }
    }

    /** Write a light spec into its CPU slot. Prev is seeded to curr (no spawn lerp). */
    private writeSlot(slot: number, spec: LightSpec): void {
        const base = slot * LIGHT_FLOATS;
        const data = this.data;
        const color = spec.color ?? [1, 1, 1];
        const [px, py, pz] = spec.position;
        data[base + KIND] = spec.type === 'spot' ? LIGHT_KIND_SPOT : LIGHT_KIND_POINT;
        data[base + CURR_POS_X] = px; data[base + PREV_POS_X] = px;
        data[base + CURR_POS_Y] = py; data[base + PREV_POS_Y] = py;
        data[base + CURR_POS_Z] = pz; data[base + PREV_POS_Z] = pz;
        data[base + COL_R] = color[0];
        data[base + COL_G] = color[1];
        data[base + COL_B] = color[2];
        data[base + INTENSITY] = spec.intensity ?? 1;
        data[base + RANGE] = spec.range ?? 10;
        data[base + CASTS_SHADOW] = 0;   // reserved
        data[base + SHADOW_INDEX] = -1;  // reserved
        if (spec.type === 'spot') {
            const [dx, dy, dz] = spec.direction;
            data[base + CURR_DIR_X] = dx; data[base + PREV_DIR_X] = dx;
            data[base + CURR_DIR_Y] = dy; data[base + PREV_DIR_Y] = dy;
            data[base + CURR_DIR_Z] = dz; data[base + PREV_DIR_Z] = dz;
            const angle = spec.angle ?? 0.5;
            const smoothness = Math.min(1, Math.max(0, spec.smoothness ?? 0.5));
            this.angle[slot] = angle;
            this.smoothness[slot] = smoothness;
            const { innerCos, outerCos } = coneCosines(angle, smoothness);
            data[base + INNER_COS] = innerCos;
            data[base + OUTER_COS] = outerCos;
        } else {
            data[base + CURR_DIR_X] = 0; data[base + PREV_DIR_X] = 0;
            data[base + CURR_DIR_Y] = 0; data[base + PREV_DIR_Y] = 0;
            data[base + CURR_DIR_Z] = 0; data[base + PREV_DIR_Z] = 0;
            this.angle[slot] = 0;
            this.smoothness[slot] = 0;
            // Point lights disable the cone term (zero axis -> cone = 1 in the shader).
            data[base + INNER_COS] = 1;
            data[base + OUTER_COS] = -1;
        }
    }
}

/**
 * Derive the inner/outer cone cosines the shader reads from a high-level cone
 * `angle` (half-extent, radians) and `smoothness` (0..1). The feathered band is
 * `angle * smoothness` wide, measured inward from the edge: smoothness 0 makes
 * inner == outer (hard edge), 1 makes the inner angle 0 (fades from center).
 */
function coneCosines(angle: number, smoothness: number): { innerCos: number; outerCos: number } {
    const outerCos = Math.cos(angle);
    const innerCos = Math.cos(angle * (1 - smoothness));
    return { innerCos, outerCos };
}

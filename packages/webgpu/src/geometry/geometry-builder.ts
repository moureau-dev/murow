/**
 * GeometryBuilder — fluent builder for custom instanced geometries.
 * Uses TypeGPU for type-safe GPU resource management.
 * Fully generic — field names and types are inferred through the builder chain.
 *
 * Usage:
 * ```ts
 * const geom = renderer
 *     .createGeometry('particles', { maxInstances: 5000, geometry: 'quad' })
 *     .instanceLayout({ dynamic: { position: d.vec2f }, static: { color: d.vec4f } })
 *     .uniforms({ time: d.f32 })
 *     .shaders((layout) => ({
 *         vertex: tgpu.vertexFn({...})(function(input) {
 *             const pos = layout.$.dynamicInstances[input.instanceIndex].position;
 *             return { pos: d.vec4f(pos.x, pos.y, 0, 1) };
 *         }),
 *         fragment: tgpu.fragmentFn({...})(function(input) { ... }),
 *     }))
 *     .build();
 *
 * geom.addInstance({ position: [1, 2], color: [1, 0, 0, 1] }); // ← typed field names
 * geom.updateUniforms({ time: 1.5 });                           // ← typed uniform names
 * ```
 */
import tgpu from 'typegpu';
import type { TgpuRoot, TgpuBuffer, TgpuRenderPipeline, TgpuBindGroup, TgpuBindGroupLayout, TgpuVertexFn, TgpuFragmentFn } from 'typegpu';
import * as d from 'typegpu/data';
import type { AnyData } from 'typegpu/data';
import type { BuiltInGeometry, GeometryData } from './built-in';
import { resolveBuiltInGeometry } from './built-in';
import { FreeList } from 'murow';
import * as std from 'typegpu/std';
import { attachShaderMetadata } from '../shaders/runtime-transpile';

// =============================================================================
// Type utilities
// =============================================================================

/** Map a TypeGPU data type to its JS value representation. */
type DataToValue<T> =
    T extends typeof d.f32 ? number :
    T extends typeof d.vec2f ? [number, number] | number[] :
    T extends typeof d.vec3f ? [number, number, number] | number[] :
    T extends typeof d.vec4f ? [number, number, number, number] | number[] :
    number | number[];

/** Partial record mapping field names to their JS values. */
type FieldValues<T extends Record<string, AnyData>> = {
    [K in keyof T]?: DataToValue<T[K]>;
};

/** All instance field names (dynamic + static). */
type AllFields<D extends Record<string, AnyData>, S extends Record<string, AnyData>> =
    keyof D | keyof S;

// =============================================================================
// Public types
// =============================================================================

export interface CustomGeometryLayout {
    layout?: Record<string, { type: string; size: number }>;
    vertices?: Array<Record<string, number | number[]>>;
    indices?: number[];
}

export interface GeometryOptions {
    maxInstances: number;
    geometry: BuiltInGeometry | CustomGeometryLayout;
}

/** Typed instance layout config with inferred field types. */
export interface InstanceLayoutConfig<
    D extends Record<string, AnyData> = Record<string, AnyData>,
    S extends Record<string, AnyData> = Record<string, AnyData>,
> {
    dynamic: D;
    static: S;
}

export interface GeometryDataLayout<
    D extends Record<string, AnyData> = Record<string, AnyData>,
    S extends Record<string, AnyData> = Record<string, AnyData>,
    U extends Record<string, AnyData> = Record<string, AnyData>,
> {
    dataLayout: TgpuBindGroupLayout;
    instanceLayout: InstanceLayoutConfig<D, S>;
    uniformDefs: U;
}

// =============================================================================
// Helpers
// =============================================================================

export function getFieldFloats(desc: AnyData | unknown): number {
    if (desc === d.f32) return 1;
    if (desc === d.vec2f) return 2;
    if (desc === d.vec3f) return 3;
    if (desc === d.vec4f) return 4;
    if (desc === d.mat3x3f) return 9;
    if (desc === d.mat4x4f) return 16;
    if (typeof desc === 'object' && desc !== null) {
        try { return d.sizeOf(desc) / 4; } catch { /* fallthrough */ }
    }
    return 1;
}

function buildStructFromLayout(fields: Record<string, AnyData>) {
    return d.struct(fields);
}

function buildCustomGeometryData(config: CustomGeometryLayout): GeometryData {
    if (!config.layout || !config.vertices) {
        throw new Error('Custom geometry requires layout and vertices');
    }
    const fieldNames = Object.keys(config.layout);
    let floatsPerVertex = 0;
    for (const name of fieldNames) floatsPerVertex += config.layout[name].size;
    const verts: number[] = [];
    for (const vertex of config.vertices) {
        for (const name of fieldNames) {
            const val = vertex[name];
            if (typeof val === 'number') verts.push(val);
            else if (Array.isArray(val)) verts.push(...val);
        }
    }
    const result: GeometryData = {
        vertices: new Float32Array(verts),
        vertexCount: config.vertices.length,
        floatsPerVertex,
        is3D: floatsPerVertex >= 6,
    };
    if (config.indices) result.indices = new Uint16Array(config.indices);
    return result;
}

// =============================================================================
// createGeometryDataLayout
// =============================================================================

export function createGeometryDataLayout<
    D extends Record<string, AnyData>,
    S extends Record<string, AnyData>,
    U extends Record<string, AnyData>,
>(
    instanceLayout: InstanceLayoutConfig<D, S>,
    uniformDefs: U,
    maxInstances: number,
): GeometryDataLayout<D, S, U> {
    const DynStruct = buildStructFromLayout(instanceLayout.dynamic);
    const StatStruct = buildStructFromLayout(instanceLayout.static);

    const parsedUniformDefs: Record<string, AnyData> = {};
    for (const [key, val] of Object.entries(uniformDefs)) {
        if (val === d.f32 || val === d.vec2f || val === d.vec3f || val === d.vec4f) {
            parsedUniformDefs[key] = val;
        } else {
            parsedUniformDefs[key] = d.f32;
        }
    }
    const UniformStruct = Object.keys(parsedUniformDefs).length > 0
        ? buildStructFromLayout(parsedUniformDefs)
        : d.struct({ _pad: d.f32 });

    const dataLayout = tgpu.bindGroupLayout({
        uniforms: { uniform: UniformStruct },
        dynamic: { storage: d.arrayOf(DynStruct, maxInstances) },
        statics: { storage: d.arrayOf(StatStruct, maxInstances) },
    });

    return { dataLayout, instanceLayout, uniformDefs };
}

// =============================================================================
// CustomGeometry
// =============================================================================

export class CustomGeometry<
    TDynamic extends Record<string, AnyData> = Record<string, AnyData>,
    TStatic extends Record<string, AnyData> = Record<string, AnyData>,
    TUniforms extends Record<string, AnyData> = Record<string, AnyData>,
> {
    readonly name: string;
    readonly maxInstances: number;
    readonly geometryData: GeometryData;

    private root: TgpuRoot;
    private freeList: FreeList;
    private layoutConfig: InstanceLayoutConfig<TDynamic, TStatic>;

    private dynamicFieldNames: string[];
    private staticFieldNames: string[];
    private dynamicFloatsPerInstance: number;
    private staticFloatsPerInstance: number;
    private dynamicData: Float32Array;
    private staticData: Float32Array;
    private uniformValues: Record<string, unknown>;

    private _dynamicDirty = true;
    private _staticDirty = true;
    private _uniformDirty = true;

    private activeSlots: Uint32Array;
    private activeCount = 0;
    private slotToActive: Int32Array;
    private _ctx: InstanceContext<TDynamic, TStatic>;

    private dynamicBuffer: TgpuBuffer<unknown>;
    private staticBuffer: TgpuBuffer<unknown>;
    private uniformBuffer: TgpuBuffer<unknown>;
    private pipeline: TgpuRenderPipeline;
    private dataBindGroup: TgpuBindGroup;

    /** @internal — use GeometryBuilder to create instances. */
    constructor(
        name: string, root: TgpuRoot, maxInstances: number, geometryData: GeometryData,
        layoutConfig: InstanceLayoutConfig<TDynamic, TStatic>,
        uniformValues: Record<string, unknown>,
        dynamicBuffer: TgpuBuffer<unknown>, staticBuffer: TgpuBuffer<unknown>,
        uniformBuffer: TgpuBuffer<unknown>,
        pipeline: TgpuRenderPipeline, dataBindGroup: TgpuBindGroup,
    ) {
        this.name = name;
        this.root = root;
        this.maxInstances = maxInstances;
        this.geometryData = geometryData;
        this.layoutConfig = layoutConfig;

        this.dynamicFieldNames = Object.keys(layoutConfig.dynamic);
        this.staticFieldNames = Object.keys(layoutConfig.static);

        this.dynamicFloatsPerInstance = 0;
        for (const n of this.dynamicFieldNames) this.dynamicFloatsPerInstance += getFieldFloats(layoutConfig.dynamic[n]);
        this.staticFloatsPerInstance = 0;
        for (const n of this.staticFieldNames) this.staticFloatsPerInstance += getFieldFloats(layoutConfig.static[n]);

        this.freeList = new FreeList(maxInstances);
        this.dynamicData = new Float32Array(maxInstances * this.dynamicFloatsPerInstance);
        this.staticData = new Float32Array(maxInstances * this.staticFloatsPerInstance);
        this.uniformValues = { ...uniformValues };

        this.dynamicBuffer = dynamicBuffer;
        this.staticBuffer = staticBuffer;
        this.uniformBuffer = uniformBuffer;
        this.pipeline = pipeline;
        this.dataBindGroup = dataBindGroup;

        this.activeSlots = new Uint32Array(maxInstances);
        this.slotToActive = new Int32Array(maxInstances).fill(-1);
        this._ctx = new InstanceContext<TDynamic, TStatic>();
    }

    addInstance(data: FieldValues<TDynamic> & FieldValues<TStatic>): number {
        const slot = this.freeList.allocate();
        if (slot === -1) throw new Error(`Max instances (${this.maxInstances}) reached for "${this.name}"`);
        this.setInstanceData(slot, data);

        this.activeSlots[this.activeCount] = slot;
        this.slotToActive[slot] = this.activeCount;
        this.activeCount++;

        return slot;
    }

    removeInstance(slot: number): void {
        this.freeList.free(slot);
        const dynBase = slot * this.dynamicFloatsPerInstance;
        const statBase = slot * this.staticFloatsPerInstance;
        this.dynamicData.fill(0, dynBase, dynBase + this.dynamicFloatsPerInstance);
        this.staticData.fill(0, statBase, statBase + this.staticFloatsPerInstance);
        this._dynamicDirty = true;
        this._staticDirty = true;

        const activeIdx = this.slotToActive[slot];
        if (activeIdx !== -1) {
            const lastIdx = this.activeCount - 1;
            if (activeIdx !== lastIdx) {
                const lastSlot = this.activeSlots[lastIdx];
                this.activeSlots[activeIdx] = lastSlot;
                this.slotToActive[lastSlot] = activeIdx;
            }
            this.slotToActive[slot] = -1;
            this.activeCount--;
        }
    }

    setInstanceData(slot: number, data: FieldValues<TDynamic> & FieldValues<TStatic>): void {
        const rawData = data as Record<string, number | number[] | undefined>;
        let dynOffset = slot * this.dynamicFloatsPerInstance;
        for (const field of this.dynamicFieldNames) {
            const size = getFieldFloats(this.layoutConfig.dynamic[field]);
            const val = rawData[field];
            if (val !== undefined) {
                if (typeof val === 'number') this.dynamicData[dynOffset] = val;
                else for (let i = 0; i < val.length; i++) this.dynamicData[dynOffset + i] = val[i];
            }
            dynOffset += size;
        }
        let statOffset = slot * this.staticFloatsPerInstance;
        for (const field of this.staticFieldNames) {
            const size = getFieldFloats(this.layoutConfig.static[field]);
            const val = rawData[field];
            if (val !== undefined) {
                if (typeof val === 'number') this.staticData[statOffset] = val;
                else for (let i = 0; i < val.length; i++) this.staticData[statOffset + i] = val[i];
            }
            statOffset += size;
        }
        this._dynamicDirty = true;
        this._staticDirty = true;
    }

    getInstance(slot: number): InstanceAccessor<TDynamic, TStatic> {
        return new InstanceAccessor<TDynamic, TStatic>(
            this.dynamicData, this.staticData, slot,
            this.dynamicFloatsPerInstance, this.staticFloatsPerInstance,
            this.dynamicFieldNames, this.staticFieldNames, this.layoutConfig,
            () => { this._dynamicDirty = true; },
            () => { this._staticDirty = true; },
        );
    }

    updateUniforms(values: Partial<FieldValues<TUniforms>>): void {
        for (const [key, val] of Object.entries(values)) {
            if (val === undefined) continue;
            if (typeof val === 'number') {
                this.uniformValues[key] = val;
            } else if (Array.isArray(val)) {
                if (val.length === 2) this.uniformValues[key] = d.vec2f(val[0], val[1]);
                else if (val.length === 3) this.uniformValues[key] = d.vec3f(val[0], val[1], val[2]);
                else if (val.length === 4) this.uniformValues[key] = d.vec4f(val[0], val[1], val[2], val[3]);
                else this.uniformValues[key] = val;
            } else {
                this.uniformValues[key] = val;
            }
        }
        this._uniformDirty = true;
    }

    getActiveCount(): number {
        return this.freeList.getAllocatedCount();
    }

    updateAll(callback: (ctx: InstanceContext<TDynamic, TStatic>, slot: number) => void): void {
        this._ctx._bind(this.dynamicData, this.staticData,
            this.dynamicFloatsPerInstance, this.staticFloatsPerInstance,
            this.dynamicFieldNames, this.staticFieldNames, this.layoutConfig);

        const count = this.activeCount;
        const slots = this.activeSlots;
        for (let i = 0; i < count; i++) {
            const slot = slots[i];
            this._ctx._setSlot(slot);
            callback(this._ctx, slot);
        }

        this._dynamicDirty = true;
        this._staticDirty = true;
    }

    render(canvasView: GPUTextureView, clearColor?: [number, number, number, number]): void {
        const device = this.root.device;
        const count = this.freeList.getAllocatedCount();
        if (count === 0) return;

        if (this._dynamicDirty) {
            device.queue.writeBuffer(this.root.unwrap(this.dynamicBuffer) as GPUBuffer, 0,
                this.dynamicData.buffer, this.dynamicData.byteOffset, this.dynamicData.byteLength);
            this._dynamicDirty = false;
        }
        if (this._staticDirty) {
            device.queue.writeBuffer(this.root.unwrap(this.staticBuffer) as GPUBuffer, 0,
                this.staticData.buffer, this.staticData.byteOffset, this.staticData.byteLength);
            this._staticDirty = false;
        }
        if (this._uniformDirty) {
            (this.uniformBuffer as TgpuBuffer<unknown>).write(this.uniformValues);
            this._uniformDirty = false;
        }

        // TypeGPU pipeline API — types are internal, cast required
        (this.pipeline as unknown as { with(bg: TgpuBindGroup): { withColorAttachment(opts: Record<string, unknown>): { draw(v: number, i: number): void } } })
            .with(this.dataBindGroup)
            .withColorAttachment({
                view: canvasView,
                loadOp: clearColor ? 'clear' : 'load',
                storeOp: 'store',
                ...(clearColor ? { clearValue: clearColor } : {}),
            })
            .draw(this.geometryData.vertexCount, count);
    }

    destroy(): void {
        this.dynamicBuffer.destroy();
        this.staticBuffer.destroy();
        this.uniformBuffer.destroy();
    }
}

// =============================================================================
// InstanceContext (reusable, zero-alloc for updateAll)
// =============================================================================

export class InstanceContext<
    TDynamic extends Record<string, AnyData> = Record<string, AnyData>,
    TStatic extends Record<string, AnyData> = Record<string, AnyData>,
> {
    private dynamicData!: Float32Array;
    private staticData!: Float32Array;
    private dynamicStride = 0;
    private staticStride = 0;
    private dynamicFieldNames!: string[];
    private staticFieldNames!: string[];
    private layout!: InstanceLayoutConfig<TDynamic, TStatic>;
    private dynBase = 0;
    private statBase = 0;

    /** @internal */
    _bind(
        dynamicData: Float32Array, staticData: Float32Array,
        dynamicStride: number, staticStride: number,
        dynamicFieldNames: string[], staticFieldNames: string[],
        layout: InstanceLayoutConfig<TDynamic, TStatic>,
    ): void {
        this.dynamicData = dynamicData;
        this.staticData = staticData;
        this.dynamicStride = dynamicStride;
        this.staticStride = staticStride;
        this.dynamicFieldNames = dynamicFieldNames;
        this.staticFieldNames = staticFieldNames;
        this.layout = layout;
    }

    /** @internal */
    _setSlot(slot: number): void {
        this.dynBase = slot * this.dynamicStride;
        this.statBase = slot * this.staticStride;
    }

    get(field: AllFields<TDynamic, TStatic> & string): number | number[] {
        const dynIdx = this.fieldOffset(field, this.dynamicFieldNames, this.layout.dynamic);
        if (dynIdx !== null) {
            const size = getFieldFloats(this.layout.dynamic[field]);
            if (size === 1) return this.dynamicData[this.dynBase + dynIdx];
            const result: number[] = [];
            for (let i = 0; i < size; i++) result.push(this.dynamicData[this.dynBase + dynIdx + i]);
            return result;
        }
        const statIdx = this.fieldOffset(field, this.staticFieldNames, this.layout.static);
        if (statIdx !== null) {
            const size = getFieldFloats(this.layout.static[field]);
            if (size === 1) return this.staticData[this.statBase + statIdx];
            const result: number[] = [];
            for (let i = 0; i < size; i++) result.push(this.staticData[this.statBase + statIdx + i]);
            return result;
        }
        throw new Error(`Field "${field}" not found`);
    }

    set(field: AllFields<TDynamic, TStatic> & string, value: number | number[]): void {
        const dynIdx = this.fieldOffset(field, this.dynamicFieldNames, this.layout.dynamic);
        if (dynIdx !== null) {
            if (typeof value === 'number') this.dynamicData[this.dynBase + dynIdx] = value;
            else for (let i = 0; i < value.length; i++) this.dynamicData[this.dynBase + dynIdx + i] = value[i];
            return;
        }
        const statIdx = this.fieldOffset(field, this.staticFieldNames, this.layout.static);
        if (statIdx !== null) {
            if (typeof value === 'number') this.staticData[this.statBase + statIdx] = value;
            else for (let i = 0; i < value.length; i++) this.staticData[this.statBase + statIdx + i] = value[i];
            return;
        }
        throw new Error(`Field "${field}" not found`);
    }

    private fieldOffset(field: string, names: string[], layoutFields: Record<string, AnyData | unknown>): number | null {
        let offset = 0;
        for (const name of names) {
            if (name === field) return offset;
            offset += getFieldFloats(layoutFields[name]);
        }
        return null;
    }
}

// =============================================================================
// InstanceAccessor
// =============================================================================

export class InstanceAccessor<
    TDynamic extends Record<string, AnyData> = Record<string, AnyData>,
    TStatic extends Record<string, AnyData> = Record<string, AnyData>,
> {
    private dynamicData: Float32Array;
    private staticData: Float32Array;
    private dynBase: number;
    private statBase: number;
    private dynamicFieldNames: string[];
    private staticFieldNames: string[];
    private layout: InstanceLayoutConfig<TDynamic, TStatic>;
    private _onDynDirty: () => void;
    private _onStatDirty: () => void;

    constructor(
        dynamicData: Float32Array, staticData: Float32Array,
        slot: number, dynamicStride: number, staticStride: number,
        dynamicFieldNames: string[], staticFieldNames: string[],
        layout: InstanceLayoutConfig<TDynamic, TStatic>,
        onDynDirty: () => void, onStatDirty: () => void,
    ) {
        this.dynamicData = dynamicData;
        this.staticData = staticData;
        this.dynBase = slot * dynamicStride;
        this.statBase = slot * staticStride;
        this.dynamicFieldNames = dynamicFieldNames;
        this.staticFieldNames = staticFieldNames;
        this.layout = layout;
        this._onDynDirty = onDynDirty;
        this._onStatDirty = onStatDirty;
    }

    get(field: AllFields<TDynamic, TStatic> & string): number | number[] {
        const dynIdx = this.fieldOffset(field, this.dynamicFieldNames, this.layout.dynamic);
        if (dynIdx !== null) {
            const size = getFieldFloats(this.layout.dynamic[field]);
            if (size === 1) return this.dynamicData[this.dynBase + dynIdx];
            const result: number[] = [];
            for (let i = 0; i < size; i++) result.push(this.dynamicData[this.dynBase + dynIdx + i]);
            return result;
        }
        const statIdx = this.fieldOffset(field, this.staticFieldNames, this.layout.static);
        if (statIdx !== null) {
            const size = getFieldFloats(this.layout.static[field]);
            if (size === 1) return this.staticData[this.statBase + statIdx];
            const result: number[] = [];
            for (let i = 0; i < size; i++) result.push(this.staticData[this.statBase + statIdx + i]);
            return result;
        }
        throw new Error(`Field "${field}" not found`);
    }

    set(field: AllFields<TDynamic, TStatic> & string, value: number | number[]): void {
        const dynIdx = this.fieldOffset(field, this.dynamicFieldNames, this.layout.dynamic);
        if (dynIdx !== null) {
            if (typeof value === 'number') this.dynamicData[this.dynBase + dynIdx] = value;
            else for (let i = 0; i < value.length; i++) this.dynamicData[this.dynBase + dynIdx + i] = value[i];
            this._onDynDirty();
            return;
        }
        const statIdx = this.fieldOffset(field, this.staticFieldNames, this.layout.static);
        if (statIdx !== null) {
            if (typeof value === 'number') this.staticData[this.statBase + statIdx] = value;
            else for (let i = 0; i < value.length; i++) this.staticData[this.statBase + statIdx + i] = value[i];
            this._onStatDirty();
            return;
        }
        throw new Error(`Field "${field}" not found`);
    }

    private fieldOffset(field: string, names: string[], layoutFields: Record<string, AnyData | unknown>): number | null {
        let offset = 0;
        for (const name of names) {
            if (name === field) return offset;
            offset += getFieldFloats(layoutFields[name]);
        }
        return null;
    }
}

// =============================================================================
// GeometryBuilder
// =============================================================================

type ShaderResult = {
    vertex: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>;
    fragment: TgpuFragmentFn<Record<string, unknown>, unknown>;
};

/** Vertex input builtins available in shader functions. */
export interface VertexInput {
    /** The vertex index within the current draw call (0-5 for a quad). */
    vertexIndex: number;
    /** The instance index within the current draw call. */
    instanceIndex: number;
}

/**
 * Declarative shader config — no `tgpu.vertexFn`, no `'use gpu'`.
 * The builder handles all TypeGPU wiring internally.
 */
export interface DeclarativeShaders<
    TDynamic extends Record<string, AnyData> = Record<string, AnyData>,
    TStatic extends Record<string, AnyData> = Record<string, AnyData>,
    TUniforms extends Record<string, AnyData> = Record<string, AnyData>,
> {
    vertex: {
        /** Varyings output from vertex to fragment (position is always included). */
        out: Record<string, AnyData>;
        /** Vertex shader body. Receives typed context and vertex input. */
        fn: (
            ctx: ShaderContext<TDynamic, TStatic, TUniforms>,
            input: VertexInput,
        ) => Record<string, unknown>;
    };
    fragment: {
        /** Fragment shader body. Receives varyings from vertex shader. */
        fn: (input: Record<string, unknown>) => unknown;
    };
}

/**
 * Context passed to the shader factory callback.
 * Provides `dynamic`, `statics`, and `uniforms` accessors with typed field names.
 *
 * **These accessors are lazy** — they only resolve when accessed inside a `'use gpu'` body.
 * Capture them in the closure and use inside shader functions:
 *
 * ```ts
 * .shaders(({ dynamic, statics, uniforms }) => ({
 *     vertex: tgpu.vertexFn({...})(function(input) {
 *         'use gpu';
 *         const pos = dynamic[input.instanceIndex].position;
 *         const time = uniforms.time;
 *     }),
 * }))
 * ```
 */
export interface ShaderContext<
    TDynamic extends Record<string, AnyData> = Record<string, AnyData>,
    TStatic extends Record<string, AnyData> = Record<string, AnyData>,
    TUniforms extends Record<string, AnyData> = Record<string, AnyData>,
> {
    /** Per-instance dynamic data (updated every frame). Access: `dynamic[instanceIndex].fieldName` */
    readonly dynamic: { readonly [index: number]: { readonly [K in keyof TDynamic]: unknown } };
    /** Per-instance static data (set once). Access: `statics[instanceIndex].fieldName` */
    readonly statics: { readonly [index: number]: { readonly [K in keyof TStatic]: unknown } };
    /** Shared uniforms. Access: `uniforms.fieldName` */
    readonly uniforms: { readonly [K in keyof TUniforms]: unknown };
    /** Raw TypeGPU bind group layout — escape hatch for advanced usage. */
    readonly layout: TgpuBindGroupLayout;
}

type ShaderFactory<
    TDynamic extends Record<string, AnyData> = Record<string, AnyData>,
    TStatic extends Record<string, AnyData> = Record<string, AnyData>,
    TUniforms extends Record<string, AnyData> = Record<string, AnyData>,
> = (ctx: ShaderContext<TDynamic, TStatic, TUniforms>) => ShaderResult;

export class GeometryBuilder<
    TDynamic extends Record<string, AnyData> = Record<string, never>,
    TStatic extends Record<string, AnyData> = Record<string, never>,
    TUniforms extends Record<string, AnyData> = Record<string, never>,
> {
    private _name: string;
    private _options: GeometryOptions;
    private _root: TgpuRoot;
    private _format: GPUTextureFormat;
    private _layoutConfig: InstanceLayoutConfig<TDynamic, TStatic> | null = null;
    private _uniformDefs: TUniforms = {} as TUniforms;
    private _vertexFn: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>> | null = null;
    private _fragmentFn: TgpuFragmentFn<Record<string, unknown>, unknown> | null = null;
    private _shaderFactory: ShaderFactory<TDynamic, TStatic, TUniforms> | null = null;
    private _vertexVaryings: Record<string, AnyData> | null = null;
    private _vertexFactory: ((ctx: ShaderContext<TDynamic, TStatic, TUniforms>) => Function) | null = null;
    private _fragmentFactory: Function | null = null;
    private _declarativeShaders: DeclarativeShaders<TDynamic, TStatic, TUniforms> | null = null;
    private _dataLayout: GeometryDataLayout<TDynamic, TStatic, TUniforms> | null = null;

    constructor(name: string, options: GeometryOptions, root: TgpuRoot, format: GPUTextureFormat) {
        this._name = name;
        this._options = options;
        this._root = root;
        this._format = format;
    }

    instanceLayout<
        D extends Record<string, AnyData>,
        S extends Record<string, AnyData>,
    >(layout: InstanceLayoutConfig<D, S> | GeometryDataLayout<D, S, TUniforms>): GeometryBuilder<D, S, TUniforms> {
        const next = this as unknown as GeometryBuilder<D, S, TUniforms>;
        if ('dataLayout' in layout) {
            next._dataLayout = layout;
            next._layoutConfig = layout.instanceLayout;
            next._uniformDefs = layout.uniformDefs as unknown as TUniforms;
        } else {
            next._layoutConfig = layout;
        }
        return next;
    }

    uniforms<U extends Record<string, AnyData>>(defs: U): GeometryBuilder<TDynamic, TStatic, U> {
        const next = this as unknown as GeometryBuilder<TDynamic, TStatic, U>;
        next._uniformDefs = defs;
        return next;
    }

    /**
     * Provide shaders as a callback that receives the bind group layout.
     *
     * ```ts
     * .shaders((layout) => ({
     *     vertex: tgpu.vertexFn({...})(function(input) {
     *         const pos = layout.$.dynamicInstances[input.instanceIndex].position;
     *     }),
     *     fragment: tgpu.fragmentFn({...})(function(input) { ... }),
     * }))
     * ```
     *
     * Or provide pre-built shaders directly:
     * ```ts
     * .shaders(vertexFn, fragmentFn)
     * ```
     */
    /**
     * Provide shaders via a factory callback that receives a typed context.
     *
     * ```ts
     * .shaders(({ dynamic, statics, uniforms }) => ({
     *     vertex: tgpu.vertexFn({...})(function(input) { ... }),
     *     fragment: tgpu.fragmentFn({...})(function(input) { ... }),
     * }))
     * ```
     *
     * Or provide pre-built shaders directly:
     * ```ts
     * .shaders(vertexFn, fragmentFn)
     * ```
     */
    shaders(
        vertexOrFactoryOrConfig:
            | TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>
            | ShaderFactory<TDynamic, TStatic, TUniforms>
            | DeclarativeShaders<TDynamic, TStatic, TUniforms>,
        fragment?: TgpuFragmentFn<Record<string, unknown>, unknown>,
    ): this {
        if (fragment !== undefined) {
            // .shaders(vertexFn, fragmentFn)
            this._vertexFn = vertexOrFactoryOrConfig as TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>;
            this._fragmentFn = fragment;
        } else if (typeof vertexOrFactoryOrConfig === 'function') {
            // .shaders((ctx) => ({ vertex, fragment }))
            this._shaderFactory = vertexOrFactoryOrConfig as ShaderFactory<TDynamic, TStatic, TUniforms>;
        } else {
            // .shaders({ vertex: { out, fn }, fragment: { fn } })
            this._declarativeShaders = vertexOrFactoryOrConfig as DeclarativeShaders<TDynamic, TStatic, TUniforms>;
        }
        return this;
    }

    /**
     * Set the vertex shader with typed context.
     * The builder handles `tgpu.vertexFn` wrapping and builtin inputs.
     *
     * ```ts
     * .vertex(
     *     { brightness: d.f32, localUV: d.vec2f },  // varyings
     *     (ctx) => function(input) {
     *         'use gpu';
     *         const pos = ctx.dynamic[input.instanceIndex].position;
     *         return { pos: d.vec4f(...), brightness, localUV };
     *     }
     * )
     * ```
     */
    vertexShader<V extends Record<string, AnyData>>(
        varyings: V,
        factory: (ctx: ShaderContext<TDynamic, TStatic, TUniforms>) => (input: { vertexIndex: number; instanceIndex: number }) => Record<string, unknown>,
    ): this {
        this._vertexVaryings = varyings;
        this._vertexFactory = factory;
        return this;
    }

    /**
     * Set the fragment shader.
     *
     * ```ts
     * .fragmentShader(function(input) {
     *     'use gpu';
     *     return d.vec4f(1, 1, 1, 1);
     * })
     * ```
     */
    fragmentShader(
        fn: (input: Record<string, unknown>) => unknown,
    ): this {
        this._fragmentFactory = fn;
        return this;
    }

    build(): CustomGeometry<TDynamic, TStatic, TUniforms> {
        if (!this._layoutConfig) throw new Error(`Geometry "${this._name}": instanceLayout() is required`);

        const root = this._root;
        const maxInstances = this._options.maxInstances;

        const geometryData = typeof this._options.geometry === 'string'
            ? resolveBuiltInGeometry(this._options.geometry)
            : buildCustomGeometryData(this._options.geometry);

        const geoLayout = this._dataLayout ?? createGeometryDataLayout(
            this._layoutConfig, this._uniformDefs, maxInstances,
        );

        // Build the lazy shader context (getters defer layout.$ access to GPU evaluation time)
        const layout = geoLayout.dataLayout;
        const lazyCtx = Object.create(null) as ShaderContext<TDynamic, TStatic, TUniforms>;
        Object.defineProperties(lazyCtx, {
            dynamic: { get: () => layout.$.dynamic },
            statics: { get: () => layout.$.statics },
            uniforms: { get: () => layout.$.uniforms },
            layout: { value: layout },
        });

        // Resolve shaders
        if (this._shaderFactory) {
            // Callback: .shaders((ctx) => ({ vertex, fragment }))
            const shaders = this._shaderFactory(lazyCtx);
            this._vertexFn = shaders.vertex;
            this._fragmentFn = shaders.fragment;
        } else if (this._declarativeShaders) {
            // Declarative: .shaders({ vertex: { out, fn }, fragment: { fn } })
            const decl = this._declarativeShaders;
            const varyings = decl.vertex.out;

            const vertexOut: Record<string, unknown> = { pos: d.builtin.position };
            const fragmentIn: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(varyings)) {
                vertexOut[k] = v;
                fragmentIn[k] = v;
            }

            // Build the externals resolver — maps free variable names in the shader body
            // to their runtime values. Called lazily by TypeGPU during pipeline resolution
            // (inside GPU context, so layout.$ is valid).
            const resolveExternals = (knownExternals: Record<string, unknown>) => () => {
                // Provide layout accessors + typegpu data module
                return {
                    dynamic: layout.$.dynamic,
                    statics: layout.$.statics,
                    uniforms: layout.$.uniforms,
                    d,
                    std,
                    ...knownExternals,
                };
            };

            // Attach runtime metadata — parses function source with Acorn + tinyest-for-wgsl
            // Vertex fn has (ctx, input) — strip the first param, its destructured names become externals
            attachShaderMetadata(decl.vertex.fn, resolveExternals({}), true);
            attachShaderMetadata(decl.fragment.fn, resolveExternals({}));

            this._vertexFn = tgpu.vertexFn({
                in: { vertexIndex: d.builtin.vertexIndex, instanceIndex: d.builtin.instanceIndex },
                out: vertexOut,
            } as Parameters<typeof tgpu.vertexFn>[0])(decl.vertex.fn as unknown as Parameters<ReturnType<typeof tgpu.vertexFn>>[0]) as TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>;

            this._fragmentFn = tgpu.fragmentFn({
                in: fragmentIn,
                out: d.vec4f,
            } as Parameters<typeof tgpu.fragmentFn>[0])(decl.fragment.fn as unknown as Parameters<ReturnType<typeof tgpu.fragmentFn>>[0]) as TgpuFragmentFn<Record<string, unknown>, unknown>;
        } else if (this._vertexFactory && this._fragmentFactory) {
            // Builder methods: .vertexShader().fragmentShader()
            const varyings = this._vertexVaryings ?? {};
            const vertexOut: Record<string, unknown> = { pos: d.builtin.position };
            const fragmentIn: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(varyings)) {
                vertexOut[k] = v;
                fragmentIn[k] = v;
            }

            const vertexBody = this._vertexFactory(lazyCtx);
            this._vertexFn = tgpu.vertexFn({
                in: { vertexIndex: d.builtin.vertexIndex, instanceIndex: d.builtin.instanceIndex },
                out: vertexOut,
            } as Parameters<typeof tgpu.vertexFn>[0])(vertexBody as Parameters<ReturnType<typeof tgpu.vertexFn>>[0]) as TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>;

            this._fragmentFn = tgpu.fragmentFn({
                in: fragmentIn,
                out: d.vec4f,
            } as Parameters<typeof tgpu.fragmentFn>[0])(this._fragmentFactory as Parameters<ReturnType<typeof tgpu.fragmentFn>>[0]) as TgpuFragmentFn<Record<string, unknown>, unknown>;
        }

        if (!this._vertexFn) throw new Error(`Geometry "${this._name}": vertex shader is required`);
        if (!this._fragmentFn) throw new Error(`Geometry "${this._name}": fragment shader is required`);
        const dataLayout = geoLayout.dataLayout;

        // Uniform initial values
        const uniformInitial: Record<string, unknown> = {};
        for (const key of Object.keys(this._uniformDefs)) {
            uniformInitial[key] = 0;
        }

        // TypeGPU structs
        const DynStruct = buildStructFromLayout(this._layoutConfig.dynamic);
        const StatStruct = buildStructFromLayout(this._layoutConfig.static);
        const parsedUniformDefs: Record<string, AnyData> = {};
        for (const [key, val] of Object.entries(this._uniformDefs)) {
            parsedUniformDefs[key] = (val === d.f32 || val === d.vec2f || val === d.vec3f || val === d.vec4f) ? val : d.f32;
        }
        const UniformStruct = Object.keys(parsedUniformDefs).length > 0
            ? buildStructFromLayout(parsedUniformDefs)
            : d.struct({ _pad: d.f32 });

        // Buffers
        const dynamicBuffer = root.createBuffer(d.arrayOf(DynStruct, maxInstances)).$usage('storage');
        const staticBuffer = root.createBuffer(d.arrayOf(StatStruct, maxInstances)).$usage('storage');
        const uniformBuffer = root.createBuffer(UniformStruct).$usage('uniform');

        // Bind group — TypeGPU's createBindGroup has complex generics, cast required
        const dataBindGroup = (root as unknown as { createBindGroup(layout: TgpuBindGroupLayout, entries: Record<string, unknown>): TgpuBindGroup })
            .createBindGroup(dataLayout, {
                uniforms: uniformBuffer,
                dynamic: dynamicBuffer,
                statics: staticBuffer,
            });

        // Pipeline — TypeGPU's createRenderPipeline has complex generics, cast required
        const pipeline = (root as unknown as { createRenderPipeline(opts: Record<string, unknown>): TgpuRenderPipeline })
            .createRenderPipeline({
                vertex: this._vertexFn,
                fragment: this._fragmentFn,
                targets: {
                    format: this._format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                },
                primitive: { topology: 'triangle-list' },
            });

        return new CustomGeometry<TDynamic, TStatic, TUniforms>(
            this._name, root, maxInstances, geometryData,
            this._layoutConfig, uniformInitial,
            dynamicBuffer as TgpuBuffer<unknown>, staticBuffer as TgpuBuffer<unknown>,
            uniformBuffer as TgpuBuffer<unknown>,
            pipeline, dataBindGroup,
        );
    }
}

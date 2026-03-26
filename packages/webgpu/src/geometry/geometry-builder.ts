/**
 * GeometryBuilder — fluent builder for custom instanced geometries.
 * Uses TypeGPU for type-safe GPU resource management.
 *
 * The user provides pre-built tgpu.vertexFn / tgpu.fragmentFn shaders.
 * The builder creates the bind group layout, buffers, pipeline, and
 * wires everything together.
 *
 * Usage:
 * ```ts
 * const layout = renderer.createGeometryLayout({
 *     dynamic: { position: d.vec2f },
 *     static: { color: d.vec4f },
 *     uniforms: { time: d.f32 },
 * });
 *
 * const vertex = tgpu.vertexFn({ in: {...}, out: {...} })(function(input) {
 *     const pos = layout.dataLayout.$.dynamicInstances[input.instanceIndex].position;
 *     return { pos: d.vec4f(pos.x, pos.y, 0, 1) };
 * });
 *
 * const geom = renderer
 *     .createGeometry('particles', { maxInstances: 5000, geometry: 'quad' })
 *     .instanceLayout(layout)
 *     .shaders(vertex, fragment)
 *     .build();
 * ```
 */
import tgpu from 'typegpu';
import type { TgpuRoot, TgpuBuffer, TgpuRenderPipeline, TgpuBindGroup, TgpuBindGroupLayout, TgpuVertexFn, TgpuFragmentFn } from 'typegpu';
import * as d from 'typegpu/data';
import type { AnyData } from 'typegpu/data';
import type { BuiltInGeometry, GeometryData } from './built-in';
import { resolveBuiltInGeometry } from './built-in';
import { FreeList } from 'murow';

// --- Types ---

export interface CustomGeometryLayout {
    layout?: Record<string, { type: string; size: number }>;
    vertices?: Array<Record<string, number | number[]>>;
    indices?: number[];
}

export interface InstanceLayoutConfig {
    dynamic: Record<string, AnyData>;
    static: Record<string, AnyData>;
}

export interface GeometryOptions {
    maxInstances: number;
    geometry: BuiltInGeometry | CustomGeometryLayout;
}

// --- Helpers ---

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

// --- GeometryDataLayout ---

/**
 * Returned by createGeometryLayout(). Holds the TypeGPU bind group layout
 * so the user can reference layout.$ in their TGSL shaders.
 */
export interface GeometryDataLayout {
    dataLayout: TgpuBindGroupLayout;
    instanceLayout: InstanceLayoutConfig;
    uniformDefs: Record<string, AnyData>;
}

export function createGeometryDataLayout(
    instanceLayout: InstanceLayoutConfig,
    uniformDefs: Record<string, AnyData>,
    maxInstances: number,
): GeometryDataLayout {
    const DynStruct = buildStructFromLayout(instanceLayout.dynamic);
    const StatStruct = buildStructFromLayout(instanceLayout.static);

    const parsedUniformDefs: Record<string, AnyData> = {};
    for (const [key, val] of Object.entries(uniformDefs)) {
        if (val === d.f32 || val === d.vec2f || val === d.vec3f || val === d.vec4f) {
            parsedUniformDefs[key] = val;
        } else if (typeof val === 'number') {
            parsedUniformDefs[key] = d.f32;
        } else {
            parsedUniformDefs[key] = d.f32;
        }
    }
    const UniformStruct = Object.keys(parsedUniformDefs).length > 0
        ? buildStructFromLayout(parsedUniformDefs)
        : d.struct({ _pad: d.f32 });

    const dataLayout = tgpu.bindGroupLayout({
        uniforms: { uniform: UniformStruct },
        dynamicInstances: { storage: d.arrayOf(DynStruct, maxInstances) },
        staticInstances: { storage: d.arrayOf(StatStruct, maxInstances) },
    });

    return { dataLayout, instanceLayout, uniformDefs: parsedUniformDefs };
}

// --- CustomGeometry ---

export class CustomGeometry {
    readonly name: string;
    readonly maxInstances: number;
    readonly geometryData: GeometryData;

    private root: TgpuRoot;
    private freeList: FreeList;
    private layoutConfig: InstanceLayoutConfig;

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

    /** Dense list of active slot indices for iteration */
    private activeSlots: Uint32Array;
    private activeCount = 0;
    private slotToActive: Int32Array; // maps slot → index in activeSlots (-1 if free)

    /** Reusable context for updateAll */
    private _ctx: InstanceContext;

    private dynamicBuffer: TgpuBuffer<any>;
    private staticBuffer: TgpuBuffer<any>;
    private uniformBuffer: TgpuBuffer<any>;
    private pipeline: TgpuRenderPipeline;
    private dataBindGroup: TgpuBindGroup;

    constructor(
        name: string, root: TgpuRoot, maxInstances: number, geometryData: GeometryData,
        layoutConfig: InstanceLayoutConfig, uniformValues: Record<string, unknown>,
        dynamicBuffer: TgpuBuffer<any>, staticBuffer: TgpuBuffer<any>, uniformBuffer: TgpuBuffer<any>,
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
        this._ctx = new InstanceContext();
    }

    addInstance(data: Record<string, number | number[]>): number {
        const slot = this.freeList.allocate();
        if (slot === -1) throw new Error(`Max instances (${this.maxInstances}) reached for "${this.name}"`);
        this.setInstanceData(slot, data);

        // Track in dense active list
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

        // Remove from dense active list (swap-remove)
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

    setInstanceData(slot: number, data: Record<string, number | number[]>): void {
        let dynOffset = slot * this.dynamicFloatsPerInstance;
        for (const field of this.dynamicFieldNames) {
            const size = getFieldFloats(this.layoutConfig.dynamic[field]);
            if (field in data) {
                const val = data[field];
                if (typeof val === 'number') this.dynamicData[dynOffset] = val;
                else for (let i = 0; i < val.length; i++) this.dynamicData[dynOffset + i] = val[i];
            }
            dynOffset += size;
        }
        let statOffset = slot * this.staticFloatsPerInstance;
        for (const field of this.staticFieldNames) {
            const size = getFieldFloats(this.layoutConfig.static[field]);
            if (field in data) {
                const val = data[field];
                if (typeof val === 'number') this.staticData[statOffset] = val;
                else for (let i = 0; i < val.length; i++) this.staticData[statOffset + i] = val[i];
            }
            statOffset += size;
        }
        this._dynamicDirty = true;
        this._staticDirty = true;
    }

    getInstance(slot: number): InstanceAccessor {
        return new InstanceAccessor(
            this.dynamicData, this.staticData, slot,
            this.dynamicFloatsPerInstance, this.staticFloatsPerInstance,
            this.dynamicFieldNames, this.staticFieldNames, this.layoutConfig,
            () => { this._dynamicDirty = true; },
            () => { this._staticDirty = true; },
        );
    }

    updateUniforms(values: Record<string, number | number[] | d.v2f | d.v3f | d.v4f>): void {
        for (const [key, val] of Object.entries(values)) {
            if (typeof val === 'number') {
                this.uniformValues[key] = val;
            } else if (Array.isArray(val)) {
                // Convert plain arrays to TypeGPU vector types for .write() compatibility
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

    /**
     * Iterate all active instances with a reusable context object.
     * The context provides direct get/set access to each instance's fields
     * without allocating any objects. Marks buffers dirty once after the full loop.
     *
     * Usage:
     * ```ts
     * geometry.updateAll((ctx, slot) => {
     *     ctx.set('position', [particles[slot].x, particles[slot].y]);
     *     ctx.set('velocity', [particles[slot].vx, particles[slot].vy]);
     * });
     * ```
     */
    updateAll(callback: (ctx: InstanceContext, slot: number) => void): void {
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
            // TypeGPU's .write() expects exact struct schema — cast unavoidable for dynamic uniforms
            (this.uniformBuffer as TgpuBuffer<unknown>).write(this.uniformValues);
            this._uniformDirty = false;
        }

        (this.pipeline as any)
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

// --- InstanceContext (reusable, zero-alloc for updateAll) ---

/**
 * Reusable context object for updateAll() iteration.
 * A single instance is created per CustomGeometry and re-bound to
 * different slots on each iteration — zero allocations per loop.
 */
export class InstanceContext {
    private dynamicData!: Float32Array;
    private staticData!: Float32Array;
    private dynamicStride = 0;
    private staticStride = 0;
    private dynamicFieldNames!: string[];
    private staticFieldNames!: string[];
    private layout!: InstanceLayoutConfig;
    private dynBase = 0;
    private statBase = 0;

    /** @internal */
    _bind(
        dynamicData: Float32Array, staticData: Float32Array,
        dynamicStride: number, staticStride: number,
        dynamicFieldNames: string[], staticFieldNames: string[],
        layout: InstanceLayoutConfig,
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

    get(field: string): number | number[] {
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

    set(field: string, value: number | number[]): void {
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

    private fieldOffset(field: string, names: string[], layoutFields: Record<string, any>): number | null {
        let offset = 0;
        for (const name of names) {
            if (name === field) return offset;
            offset += getFieldFloats(layoutFields[name]);
        }
        return null;
    }
}

// --- InstanceAccessor ---

export class InstanceAccessor {
    private dynamicData: Float32Array;
    private staticData: Float32Array;
    private dynBase: number;
    private statBase: number;
    private dynamicFieldNames: string[];
    private staticFieldNames: string[];
    private layout: InstanceLayoutConfig;
    private _onDynDirty: () => void;
    private _onStatDirty: () => void;

    constructor(
        dynamicData: Float32Array, staticData: Float32Array,
        slot: number, dynamicStride: number, staticStride: number,
        dynamicFieldNames: string[], staticFieldNames: string[],
        layout: InstanceLayoutConfig,
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

    get(field: string): number | number[] {
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

    set(field: string, value: number | number[]): void {
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

    private fieldOffset(field: string, names: string[], layoutFields: Record<string, any>): number | null {
        let offset = 0;
        for (const name of names) {
            if (name === field) return offset;
            offset += getFieldFloats(layoutFields[name]);
        }
        return null;
    }
}

// --- GeometryBuilder ---

export class GeometryBuilder {
    private _name: string;
    private _options: GeometryOptions;
    private _root: TgpuRoot;
    private _format: GPUTextureFormat;
    private _layoutConfig: InstanceLayoutConfig | null = null;
    private _uniformDefs: Record<string, AnyData> = {};
    private _vertexFn: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>> | null = null;
    private _fragmentFn: TgpuFragmentFn<Record<string, unknown>, unknown> | null = null;
    private _shaderFactory: ((layout: TgpuBindGroupLayout) => { vertex: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>; fragment: TgpuFragmentFn<Record<string, unknown>, unknown> }) | null = null;
    private _dataLayout: GeometryDataLayout | null = null;

    constructor(name: string, options: GeometryOptions, root: TgpuRoot, format: GPUTextureFormat) {
        this._name = name;
        this._options = options;
        this._root = root;
        this._format = format;
    }

    instanceLayout(layout: InstanceLayoutConfig | GeometryDataLayout): this {
        if ('dataLayout' in layout) {
            this._dataLayout = layout;
            this._layoutConfig = layout.instanceLayout;
            this._uniformDefs = layout.uniformDefs;
        } else {
            this._layoutConfig = layout;
        }
        return this;
    }

    uniforms(defs: Record<string, AnyData>): this {
        this._uniformDefs = defs;
        return this;
    }

    /**
     * Provide shaders as a callback that receives the bind group layout.
     * The layout is created internally from instanceLayout() + uniforms().
     *
     * Usage:
     * ```ts
     * .shaders((layout) => ({
     *     vertex: tgpu.vertexFn({...})(function(input) {
     *         const pos = layout.$.dynamicInstances[input.instanceIndex].position;
     *         ...
     *     }),
     *     fragment: tgpu.fragmentFn({...})(function(input) { ... }),
     * }))
     * ```
     *
     * Or provide pre-built shaders directly (if you already have the layout):
     * ```ts
     * .shaders(vertexFn, fragmentFn)
     * ```
     */
    shaders(
        vertexOrFactory: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>> | ((layout: TgpuBindGroupLayout) => { vertex: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>; fragment: TgpuFragmentFn<Record<string, unknown>, unknown> }),
        fragment?: TgpuFragmentFn<Record<string, unknown>, unknown>,
    ): this {
        if (typeof fragment !== 'undefined') {
            this._vertexFn = vertexOrFactory as TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>;
            this._fragmentFn = fragment;
        } else {
            this._shaderFactory = vertexOrFactory as (layout: TgpuBindGroupLayout) => { vertex: TgpuVertexFn<Record<string, unknown>, Record<string, unknown>>; fragment: TgpuFragmentFn<Record<string, unknown>, unknown> };
        }
        return this;
    }

    build(): CustomGeometry {
        if (!this._layoutConfig) throw new Error(`Geometry "${this._name}": instanceLayout() is required`);

        const root = this._root;
        const maxInstances = this._options.maxInstances;

        const geometryData = typeof this._options.geometry === 'string'
            ? resolveBuiltInGeometry(this._options.geometry)
            : buildCustomGeometryData(this._options.geometry);

        // Build or reuse the data layout
        const geoLayout = this._dataLayout ?? createGeometryDataLayout(
            this._layoutConfig, this._uniformDefs, maxInstances,
        );

        // Resolve shader factory if used
        if (this._shaderFactory) {
            const shaders = this._shaderFactory(geoLayout.dataLayout);
            this._vertexFn = shaders.vertex;
            this._fragmentFn = shaders.fragment;
        }

        if (!this._vertexFn) throw new Error(`Geometry "${this._name}": vertex shader is required`);
        if (!this._fragmentFn) throw new Error(`Geometry "${this._name}": fragment shader is required`);
        const dataLayout = geoLayout.dataLayout;

        // Build uniform initial values
        const uniformInitial: Record<string, any> = {};
        for (const [key, val] of Object.entries(this._uniformDefs)) {
            if (typeof val === 'number') uniformInitial[key] = val;
            else uniformInitial[key] = 0;
        }

        // Create TypeGPU structs matching the layout
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

        // Bind group
        const dataBindGroup = (root as any).createBindGroup(dataLayout, {
            uniforms: uniformBuffer,
            dynamicInstances: dynamicBuffer,
            staticInstances: staticBuffer,
        });

        // Pipeline
        const pipeline = (root as any).createRenderPipeline({
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

        return new CustomGeometry(
            this._name, root, maxInstances, geometryData,
            this._layoutConfig, uniformInitial,
            dynamicBuffer, staticBuffer, uniformBuffer,
            pipeline, dataBindGroup,
        );
    }
}

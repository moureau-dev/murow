/**
 * Render pipeline descriptors as plain data.
 *
 * A {@link PipelineDescriptor} assembles shader sources, vertex layouts, bind
 * group layouts, and render state. It optionally validates vertex attributes
 * against a known attribute list.
 */

import { BindGroupLayout } from './bind-group';
import { RenderState, type RenderStateOptions } from './render-state';
import { VertexBufferLayout, type VertexAttribute } from './vertex-layout';

/** Shader source: inline code or a reference to a compiled source handle. */
export type ShaderSource = string | { readonly handle: string };

/** Primitive topology. */
export type PrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';

/** Front face winding order. */
export type FrontFace = 'ccw' | 'cw';

/** Primitive assembly state. */
export interface PrimitiveState {
    /** Default `'triangle-list'`. */
    readonly topology?: PrimitiveTopology;
    /** Cull override. Falls back to the render state's cull. */
    readonly cull?: 'back' | 'front' | 'none';
    /** Default `'ccw'`. */
    readonly frontFace?: FrontFace;
    /** Strip index format for strip topologies. */
    readonly stripIndexFormat?: 'uint16' | 'uint32';
}

/** Primitive state with resolved defaults. */
export interface ResolvedPrimitiveState {
    readonly topology: PrimitiveTopology;
    readonly frontFace: FrontFace;
    readonly cull?: 'back' | 'front' | 'none';
    readonly stripIndexFormat?: 'uint16' | 'uint32';
}

/** Depth attachment state. */
export interface DepthState {
    /** Default `'depth24plus'`. */
    readonly format?: string;
    /** Default `true`. */
    readonly depthWriteEnabled?: boolean;
    /** Default `'less'`. */
    readonly depthCompare?: 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';
}

/** Multisample state. */
export interface MultisampleState {
    /** Sample count. Default `1`. */
    readonly count?: number;
    /** Default `false`. */
    readonly alphaToCoverageEnabled?: boolean;
}

/** Options for {@link PipelineDescriptor}. */
export interface PipelineDescriptorOptions {
    readonly label?: string;
    readonly vertex: ShaderSource;
    readonly fragment?: ShaderSource;
    readonly vertexLayout: VertexBufferLayout | readonly VertexBufferLayout[];
    readonly bindGroupLayouts?: readonly BindGroupLayout[];
    readonly renderState?: RenderState | RenderStateOptions;
    readonly primitive?: PrimitiveState;
    /** `false` disables the depth attachment. */
    readonly depth?: DepthState | boolean;
    readonly multisample?: MultisampleState;
    /** Color target format. Required for a render pipeline. */
    readonly colorFormat?: string;
    /** Depth target format. Defaults to the depth state's format. */
    readonly depthFormat?: string;
    /** Vertex entry point name. Default `vs_main`. */
    readonly vertexEntry?: string;
    /** Fragment entry point name. Default `fs_main`. */
    readonly fragmentEntry?: string;
    /** Compute entry point name. Default `cs_main`. */
    readonly computeEntry?: string;
}

/**
 * A backend-agnostic pipeline description. The constructor normalizes shader
 * sources, layouts, and render state into plain fields.
 */
export class PipelineDescriptor {
    readonly label: string | undefined;
    readonly vertex: ShaderSource;
    readonly fragment: ShaderSource | undefined;
    readonly vertexLayout: readonly VertexBufferLayout[];
    readonly bindGroupLayouts: readonly BindGroupLayout[];
    readonly renderState: RenderState;
    readonly primitive: ResolvedPrimitiveState;
    readonly depth: DepthState | undefined;
    readonly multisample: Required<MultisampleState>;
    readonly colorFormat: string | undefined;
    readonly depthFormat: string | undefined;
    readonly vertexEntry: string;
    readonly fragmentEntry: string;
    readonly computeEntry: string;

    constructor(options: PipelineDescriptorOptions) {
        this.label = options.label;
        this.vertex = options.vertex;
        this.fragment = options.fragment;
        this.vertexLayout = Array.isArray(options.vertexLayout)
            ? options.vertexLayout
            : [options.vertexLayout as VertexBufferLayout];
        this.bindGroupLayouts = options.bindGroupLayouts ?? [];
        this.renderState = options.renderState instanceof RenderState
            ? options.renderState
            : RenderState.resolve(options.renderState ?? {});
        this.primitive = {
            topology: options.primitive?.topology ?? 'triangle-list',
            frontFace: options.primitive?.frontFace ?? 'ccw',
            ...options.primitive,
        };
        this.depth = options.depth === false ? undefined : resolveDepth(options.depth) ?? undefined;
        this.multisample = {
            count: options.multisample?.count ?? 1,
            alphaToCoverageEnabled: options.multisample?.alphaToCoverageEnabled ?? false,
        };
        this.colorFormat = options.colorFormat;
        this.depthFormat = options.depthFormat;
        this.vertexEntry = options.vertexEntry ?? 'vs_main';
        this.fragmentEntry = options.fragmentEntry ?? 'fs_main';
        this.computeEntry = options.computeEntry ?? 'cs_main';
    }

    /**
     * Validate the vertex layouts against a known attribute list when given.
     * Every layout attribute must match a known location and format.
     */
    validate(attributes?: readonly VertexAttribute[]): void {
        validatePipeline(this, attributes);
    }
}

/**
 * Throw when a pipeline's vertex layouts disagree with `attributes`. When
 * `attributes` is omitted only the layouts themselves are checked.
 */
export function validatePipeline(pipeline: PipelineDescriptor, attributes?: readonly VertexAttribute[]): void {
    let known: (VertexAttribute | undefined)[] | undefined;
    if (attributes) {
        let max = -1;
        for (const attribute of attributes) {
            if (attribute.location > max) max = attribute.location;
        }
        known = new Array(max + 1);
        for (const attribute of attributes) known[attribute.location] = attribute;
    }

    for (const layout of pipeline.vertexLayout) {
        for (const attribute of layout.attributes) {
            const match = known?.[attribute.location];
            if (attributes && !match) {
                throw new Error(`PipelineDescriptor: unknown vertex attribute location ${attribute.location}`);
            }
            if (match && match.format !== attribute.format) {
                throw new Error(
                    `PipelineDescriptor: vertex attribute ${attribute.location} format '${attribute.format}' ` +
                        `does not match '${match.format}'`,
                );
            }
        }
    }
}

/** Resolve the inline code of a shader source, or undefined for a handle. */
export function shaderSourceCode(source: ShaderSource | undefined): string | undefined {
    return typeof source === 'string' ? source : undefined;
}

/** Resolve the handle name of a shader source, or undefined for inline code. */
export function shaderSourceHandle(source: ShaderSource | undefined): string | undefined {
    return typeof source === 'string' || source === undefined ? undefined : source.handle;
}

function resolveDepth(depth: DepthState | boolean | undefined): DepthState | undefined {
    if (depth === undefined || depth === true) {
        return { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
    }
    return depth === false ? undefined : depth;
}

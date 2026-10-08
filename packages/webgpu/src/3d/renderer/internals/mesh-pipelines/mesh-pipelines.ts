import type { TgpuRoot, TgpuBuffer, TgpuVertexFn, TgpuFragmentFn, TgpuBindGroupLayout } from 'typegpu';
import { tgpu, d } from '../../../../shaders/typegpu';
import {
    DynamicMesh,
    StaticMesh,
    SkinnedStaticMesh,
    MeshUniforms,
    Light,
} from '../../../../core/types';
import { MAX_LIGHTS } from '../../../shader';
import {
    createMeshLayout,
    createMeshVertex,
    createMeshFragment,
    createTextureBindGroupLayout,
    createTexturedMeshVertex,
    createTexturedMeshFragment,
    createSkinnedMeshLayout,
    createSkinnedMeshVertex,
    createSkinnedMeshFragment,
    createSkinnedTexturedMeshFragment,
    type MeshDataLayout,
    type SkinnedMeshDataLayout,
} from '../../../shader';

export interface MeshPipelinesOptions {
    root: TgpuRoot;
    device: GPUDevice;
    format: GPUTextureFormat;
    maxInstances: number;
    maxSkinnedInstances: number;
    maxTotalBones: number;
    /** Max dynamic lights the light buffer and layouts hold. Defaults to `MAX_LIGHTS`. */
    maxLights?: number;
    width: number;
    height: number;
}

/**
 * MeshPipelines — owns every raw GPU resource for the 3D mesh passes:
 * layouts, buffers, bind groups, the four render pipelines and the depth
 * texture. The bone-matrix buffer is replaced when the animation compute
 * kernel rebuilds, via `setBoneBuffer`.
 */
export class MeshPipelines {
    meshLayout!: MeshDataLayout;
    skinnedMeshLayout!: SkinnedMeshDataLayout;

    depthTexture!: GPUTexture;
    depthSampler!: GPUSampler;

    dynamicBuffer!: TgpuBuffer<any>;
    staticBuffer!: TgpuBuffer<any>;
    uniformBuffer!: TgpuBuffer<any>;
    slotIndexBuffer!: TgpuBuffer<any>;
    lightBuffer!: TgpuBuffer<any>;

    rawDynamicBuffer!: GPUBuffer;
    rawStaticBuffer!: GPUBuffer;
    rawUniformBuffer!: GPUBuffer;
    rawSlotIndexBuffer!: GPUBuffer;
    rawLightBuffer!: GPUBuffer;

    rawSkinnedDynamicBuffer!: GPUBuffer;
    rawSkinnedStaticBuffer!: GPUBuffer;
    rawSkinnedSlotIndexBuffer!: GPUBuffer;
    rawBoneMatrixBuffer!: GPUBuffer;

    rawPipeline!: GPURenderPipeline;
    rawTexturedPipeline!: GPURenderPipeline;
    rawSkinnedPipeline!: GPURenderPipeline;
    rawSkinnedTexturedPipeline!: GPURenderPipeline;

    rawBindGroup!: GPUBindGroup;
    rawSkinnedBindGroup!: GPUBindGroup;
    rawSkinnedBGL!: GPUBindGroupLayout;

    private device!: GPUDevice;
    private root!: TgpuRoot;
    private format!: GPUTextureFormat;
    private vertexBufferLayout!: GPUVertexBufferLayout;
    skinnedVertexBufferLayout!: GPUVertexBufferLayout;
    private rawMeshBGL!: GPUBindGroupLayout;

    build(opts: MeshPipelinesOptions): void {
        const { root, device, format, maxInstances, maxSkinnedInstances, maxTotalBones } = opts;
        const maxLights = opts.maxLights ?? MAX_LIGHTS;
        this.root = root;
        this.device = device;
        this.format = format;

        this.depthTexture = device.createTexture({
            size: [opts.width, opts.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.depthSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

        this.meshLayout = createMeshLayout(maxInstances, maxLights);

        const depthStencil: GPUDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less',
        };
        const primitive: GPUPrimitiveState = {
            topology: 'triangle-list',
            cullMode: 'none',
        };

        // Vertex buffer layout: position(3f) + normal(3f) + uv(2f) = 32 bytes
        const vertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 32,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32x2' },
            ],
        };
        this.vertexBufferLayout = vertexBufferLayout;

        // --- Untextured pipeline (color only) ---
        const vertex = createMeshVertex(this.meshLayout);
        const fragment = createMeshFragment(this.meshLayout);
        const { code: wgslCode } = tgpu.resolveWithContext([vertex, fragment]);
        const shaderModule = device.createShaderModule({ code: wgslCode });
        const rawBGL = root.unwrap(this.meshLayout);
        this.rawMeshBGL = rawBGL;

        this.rawPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [rawBGL] }),
            vertex: { module: shaderModule, buffers: [vertexBufferLayout] },
            fragment: { module: shaderModule, targets: [{ format }] },
            primitive,
            depthStencil,
        });

        // --- Textured pipeline (texture + color tint) ---
        const texLayout = createTextureBindGroupLayout();
        const texVertex = createTexturedMeshVertex(this.meshLayout);
        const texFragment = createTexturedMeshFragment(this.meshLayout, texLayout);
        const { code: texWgslCode } = tgpu.resolveWithContext([texVertex, texFragment]);
        const texShaderModule = device.createShaderModule({ code: texWgslCode });
        const rawTexBGL = root.unwrap(texLayout);

        this.rawTexturedPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [rawBGL, rawTexBGL] }),
            vertex: { module: texShaderModule, buffers: [vertexBufferLayout] },
            fragment: {
                module: texShaderModule,
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive,
            depthStencil,
        });

        // Buffers
        this.dynamicBuffer = root.createBuffer(d.arrayOf(DynamicMesh, maxInstances)).$usage('storage');
        this.staticBuffer = root.createBuffer(d.arrayOf(StaticMesh, maxInstances)).$usage('storage');
        this.uniformBuffer = root.createBuffer(MeshUniforms).$usage('uniform');
        this.slotIndexBuffer = root.createBuffer(d.arrayOf(d.u32, maxInstances)).$usage('storage');
        this.lightBuffer = root.createBuffer(d.arrayOf(Light, maxLights)).$usage('storage');

        this.rawDynamicBuffer = root.unwrap(this.dynamicBuffer) as any;
        this.rawStaticBuffer = root.unwrap(this.staticBuffer) as any;
        this.rawUniformBuffer = root.unwrap(this.uniformBuffer) as any;
        this.rawSlotIndexBuffer = root.unwrap(this.slotIndexBuffer) as any;
        this.rawLightBuffer = root.unwrap(this.lightBuffer) as any;

        this.rawBindGroup = device.createBindGroup({
            layout: rawBGL,
            entries: [
                { binding: 0, resource: { buffer: this.rawUniformBuffer } },
                { binding: 1, resource: { buffer: this.rawDynamicBuffer } },
                { binding: 2, resource: { buffer: this.rawStaticBuffer } },
                { binding: 3, resource: { buffer: this.rawSlotIndexBuffer } },
                { binding: 4, resource: { buffer: this.rawLightBuffer } },
            ],
        });

        // --- Skinned pipelines ---
        const msi = maxSkinnedInstances;
        this.skinnedMeshLayout = createSkinnedMeshLayout(msi, maxTotalBones, maxLights);

        const skinnedVertexBufferLayout: GPUVertexBufferLayout = {
            arrayStride: 56,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'float32x3' },
                { shaderLocation: 2, offset: 24, format: 'float32x2' },
                { shaderLocation: 3, offset: 32, format: 'uint16x4' },
                { shaderLocation: 4, offset: 40, format: 'float32x4' },
            ],
        };

        const skinnedVertex = createSkinnedMeshVertex(this.skinnedMeshLayout);
        const skinnedFragment = createSkinnedMeshFragment(this.skinnedMeshLayout);
        const { code: skinnedWgsl } = tgpu.resolveWithContext([skinnedVertex, skinnedFragment]);
        const skinnedShaderModule = device.createShaderModule({ code: skinnedWgsl });
        const rawSkinnedBGL = root.unwrap(this.skinnedMeshLayout);
        this.rawSkinnedBGL = rawSkinnedBGL;

        this.skinnedVertexBufferLayout = skinnedVertexBufferLayout;
        this.rawSkinnedPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [rawSkinnedBGL] }),
            vertex: { module: skinnedShaderModule, buffers: [skinnedVertexBufferLayout] },
            fragment: { module: skinnedShaderModule, targets: [{ format }] },
            primitive,
            depthStencil,
        });

        const skinnedTexVertex = createSkinnedMeshVertex(this.skinnedMeshLayout);
        const skinnedTexFragment = createSkinnedTexturedMeshFragment(this.skinnedMeshLayout, texLayout);
        const { code: skinnedTexWgsl } = tgpu.resolveWithContext([skinnedTexVertex, skinnedTexFragment]);
        const skinnedTexShaderModule = device.createShaderModule({ code: skinnedTexWgsl });

        this.rawSkinnedTexturedPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [rawSkinnedBGL, rawTexBGL] }),
            vertex: { module: skinnedTexShaderModule, buffers: [skinnedVertexBufferLayout] },
            fragment: {
                module: skinnedTexShaderModule,
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive,
            depthStencil,
        });

        // Skinned GPU buffers
        const skinnedDynBuf = root.createBuffer(d.arrayOf(DynamicMesh, msi)).$usage('storage');
        const skinnedStatBuf = root.createBuffer(d.arrayOf(SkinnedStaticMesh, msi)).$usage('storage');
        const skinnedSlotBuf = root.createBuffer(d.arrayOf(d.u32, msi)).$usage('storage');
        const boneBuf = root.createBuffer(d.arrayOf(d.mat4x4f, maxTotalBones)).$usage('storage');

        this.rawSkinnedDynamicBuffer = root.unwrap(skinnedDynBuf) as any;
        this.rawSkinnedStaticBuffer = root.unwrap(skinnedStatBuf) as any;
        this.rawSkinnedSlotIndexBuffer = root.unwrap(skinnedSlotBuf) as any;
        this.rawBoneMatrixBuffer = root.unwrap(boneBuf) as any;

        this.rebuildSkinnedBindGroup();
    }

    /** Point the skinned bind group at a new bone-matrix buffer (kernel rebuild). */
    setBoneBuffer(rawBoneBuffer: GPUBuffer): void {
        this.rawBoneMatrixBuffer = rawBoneBuffer;
        this.rebuildSkinnedBindGroup();
    }

    /**
     * Build a non-skinned material pipeline: group 0 is the shared mesh bind
     * group, group 1 is the material's (uniforms + textures).
     */
    buildMaterialPipeline(opts: {
        vertex: any;
        fragment: any;
        materialLayout: TgpuBindGroupLayout;
        blendState: { color?: GPUBlendComponent; alpha?: GPUBlendComponent } | null;
        depthWrite: boolean;
        depthTest: boolean;
        cull: 'back' | 'front' | 'none';
        buffers?: GPUVertexBufferLayout[];
        meshBGL?: GPUBindGroupLayout;
        colorWrite?: number;
        depthBias?: number;
        depthBiasSlopeScale?: number;
        depthBiasClamp?: number;
        label?: string;
    }): GPURenderPipeline {
        const { code } = tgpu.resolveWithContext([opts.vertex as any, opts.fragment as any]);
        const module = this.device.createShaderModule({ code, label: opts.label });
        const rawMaterialBGL = this.root.unwrap(opts.materialLayout) as unknown as GPUBindGroupLayout;

        const depthStencil: GPUDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: opts.depthWrite,
            depthCompare: opts.depthTest ? 'less' : 'always',
            depthBias: opts.depthBias ?? 0,
            depthBiasSlopeScale: opts.depthBiasSlopeScale ?? 0,
            depthBiasClamp: opts.depthBiasClamp ?? 0,
        };
        const target: GPUColorTargetState = {
            format: this.format,
            writeMask: opts.colorWrite ?? 0xf,
        };
        if (opts.blendState) {
            target.blend = {
                color: opts.blendState.color ?? { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: opts.blendState.alpha ?? { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            };
        }

        return this.device.createRenderPipeline({
            label: opts.label,
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [opts.meshBGL ?? this.rawMeshBGL, rawMaterialBGL] }),
            vertex: { module, buffers: opts.buffers ?? [this.vertexBufferLayout] },
            fragment: { module, targets: [target] },
            primitive: { topology: 'triangle-list', cullMode: opts.cull },
            depthStencil,
        });
    }

    resizeDepth(width: number, height: number): void {
        this.depthTexture.destroy();
        this.depthTexture = this.device.createTexture({
            size: [width, height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
    }

    private rebuildSkinnedBindGroup(): void {
        const rawSkinnedBGL = this.root.unwrap(this.skinnedMeshLayout);
        this.rawSkinnedBindGroup = this.device.createBindGroup({
            layout: rawSkinnedBGL as GPUBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.rawUniformBuffer } },
                { binding: 1, resource: { buffer: this.rawSkinnedDynamicBuffer } },
                { binding: 2, resource: { buffer: this.rawSkinnedStaticBuffer } },
                { binding: 3, resource: { buffer: this.rawSkinnedSlotIndexBuffer } },
                { binding: 4, resource: { buffer: this.rawBoneMatrixBuffer } },
                { binding: 5, resource: { buffer: this.rawLightBuffer } },
            ],
        });
    }

    destroy(): void {
        this.depthTexture?.destroy();
        this.dynamicBuffer?.destroy();
        this.staticBuffer?.destroy();
        this.uniformBuffer?.destroy();
        this.slotIndexBuffer?.destroy();
        this.lightBuffer?.destroy();
        this.rawSkinnedDynamicBuffer?.destroy();
        this.rawSkinnedStaticBuffer?.destroy();
        this.rawSkinnedSlotIndexBuffer?.destroy();
        this.rawBoneMatrixBuffer?.destroy();
    }
}

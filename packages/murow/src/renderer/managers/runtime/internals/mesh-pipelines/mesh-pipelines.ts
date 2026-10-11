import { RawBindGroup, RawBindGroupEntry, RawBindGroupLayout, RawBlendComponent, RawBlendState, RawBuffer, RawBufferSource, RawBufferUsage, RawCanvasContext, RawColorTargetState, RawCommandEncoder, RawComputePipeline, RawDepthStencilState, RawDevice, RawIndexFormat, RawPipelineLayout, RawPrimitiveState, RawRenderPassEncoder, RawRenderPipeline, RawSampler, RawShaderModule, RawShaderStage, RawTexture, RawTextureFormat, RawTextureUsage, RawTextureView, RawVertexBufferLayout } from 'murow/gpu';
import { d, type GpuBindGroupLayout } from 'murow/gpu';
import { compileProgram, createGpuBindGroupLayout, createRawBuffer } from '../../backend';

// Stable local name: shader bodies are parsed from their source, so bundlers
// must not rename `d` inside them.
import {
    DynamicMesh,
    StaticMesh,
    SkinnedStaticMesh,
    MeshUniforms,
    Light,
} from '../../engine-core/types';
import { MAX_LIGHTS } from '../../shader';
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
} from '../../shader';


export interface MeshPipelinesOptions {
    root?: unknown;
    device: RawDevice;
    format: RawTextureFormat;
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

    depthTexture!: RawTexture;
    depthSampler!: RawSampler;

    rawDynamicBuffer!: RawBuffer;
    rawStaticBuffer!: RawBuffer;
    rawUniformBuffer!: RawBuffer;
    rawSlotIndexBuffer!: RawBuffer;
    rawLightBuffer!: RawBuffer;

    rawSkinnedDynamicBuffer!: RawBuffer;
    rawSkinnedStaticBuffer!: RawBuffer;
    rawSkinnedSlotIndexBuffer!: RawBuffer;
    rawBoneMatrixBuffer!: RawBuffer;

    rawPipeline!: RawRenderPipeline;
    rawTexturedPipeline!: RawRenderPipeline;
    rawSkinnedPipeline!: RawRenderPipeline;
    rawSkinnedTexturedPipeline!: RawRenderPipeline;

    rawBindGroup!: RawBindGroup;
    rawSkinnedBindGroup!: RawBindGroup;
    rawSkinnedBGL!: RawBindGroupLayout;

    private device!: RawDevice;
    private format!: RawTextureFormat;
    private vertexBufferLayout!: RawVertexBufferLayout;
    skinnedVertexBufferLayout!: RawVertexBufferLayout;
    private rawMeshBGL!: RawBindGroupLayout;

    build(opts: MeshPipelinesOptions): void {
        const { device, format, maxInstances, maxSkinnedInstances, maxTotalBones } = opts;
        const maxLights = opts.maxLights ?? MAX_LIGHTS;
        this.device = device;
        this.format = format;

        this.depthTexture = device.createTexture({
            size: [opts.width, opts.height],
            format: 'depth24plus',
            usage: RawTextureUsage.RENDER_ATTACHMENT | RawTextureUsage.TEXTURE_BINDING,
        });
        this.depthSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

        this.meshLayout = createMeshLayout(maxInstances, maxLights);

        const depthStencil: RawDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: true,
            depthCompare: 'less',
        };
        const primitive: RawPrimitiveState = {
            topology: 'triangle-list',
            cullMode: 'none',
        };

        // Vertex buffer layout: position(3f) + normal(3f) + uv(2f) = 32 bytes
        const vertexBufferLayout: RawVertexBufferLayout = {
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
        const { code: wgslCode } = compileProgram([vertex, fragment]);
        const shaderModule = device.createShaderModule({ code: wgslCode });
        const rawBGL = createGpuBindGroupLayout(device, this.meshLayout.toDescriptor());
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
        const { code: texWgslCode } = compileProgram([texVertex, texFragment]);
        const texShaderModule = device.createShaderModule({ code: texWgslCode });
        const rawTexBGL = createGpuBindGroupLayout(device, texLayout.toDescriptor());

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
        this.rawDynamicBuffer = createRawBuffer(device, d.arrayOf(DynamicMesh, maxInstances), 'storage');
        this.rawStaticBuffer = createRawBuffer(device, d.arrayOf(StaticMesh, maxInstances), 'storage');
        this.rawUniformBuffer = createRawBuffer(device, MeshUniforms, 'uniform');
        this.rawSlotIndexBuffer = createRawBuffer(device, d.arrayOf(d.u32, maxInstances), 'storage');
        this.rawLightBuffer = createRawBuffer(device, d.arrayOf(Light, maxLights), 'storage');

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

        const skinnedVertexBufferLayout: RawVertexBufferLayout = {
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
        const { code: skinnedWgsl } = compileProgram([skinnedVertex, skinnedFragment]);
        const skinnedShaderModule = device.createShaderModule({ code: skinnedWgsl });
        const rawSkinnedBGL = createGpuBindGroupLayout(device, this.skinnedMeshLayout.toDescriptor());
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
        const { code: skinnedTexWgsl } = compileProgram([skinnedTexVertex, skinnedTexFragment]);
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
        this.rawSkinnedDynamicBuffer = createRawBuffer(device, d.arrayOf(DynamicMesh, msi), 'storage');
        this.rawSkinnedStaticBuffer = createRawBuffer(device, d.arrayOf(SkinnedStaticMesh, msi), 'storage');
        this.rawSkinnedSlotIndexBuffer = createRawBuffer(device, d.arrayOf(d.u32, msi), 'storage');
        this.rawBoneMatrixBuffer = createRawBuffer(device, d.arrayOf(d.mat4x4f, maxTotalBones), 'storage');

        this.rebuildSkinnedBindGroup();
    }

    /** Point the skinned bind group at a new bone-matrix buffer (kernel rebuild). */
    setBoneBuffer(rawBoneBuffer: RawBuffer): void {
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
        materialLayout: GpuBindGroupLayout;
        blendState: { color?: RawBlendComponent; alpha?: RawBlendComponent } | null;
        depthWrite: boolean;
        depthTest: boolean;
        cull: 'back' | 'front' | 'none';
        buffers?: RawVertexBufferLayout[];
        meshBGL?: RawBindGroupLayout;
        colorWrite?: number;
        depthBias?: number;
        depthBiasSlopeScale?: number;
        depthBiasClamp?: number;
        label?: string;
    }): RawRenderPipeline {
        const { code } = compileProgram([opts.vertex as any, opts.fragment as any]);
        const module = this.device.createShaderModule({ code, label: opts.label });
        const rawMaterialBGL = createGpuBindGroupLayout(this.device, opts.materialLayout.toDescriptor());

        const depthStencil: RawDepthStencilState = {
            format: 'depth24plus',
            depthWriteEnabled: opts.depthWrite,
            depthCompare: opts.depthTest ? 'less' : 'always',
            depthBias: opts.depthBias ?? 0,
            depthBiasSlopeScale: opts.depthBiasSlopeScale ?? 0,
            depthBiasClamp: opts.depthBiasClamp ?? 0,
        };
        const target: RawColorTargetState = {
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
            usage: RawTextureUsage.RENDER_ATTACHMENT | RawTextureUsage.TEXTURE_BINDING,
        });
    }

    private rebuildSkinnedBindGroup(): void {
        const rawSkinnedBGL = createGpuBindGroupLayout(this.device, this.skinnedMeshLayout.toDescriptor());
        this.rawSkinnedBindGroup = this.device.createBindGroup({
            layout: rawSkinnedBGL as RawBindGroupLayout,
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
        this.rawDynamicBuffer?.destroy();
        this.rawStaticBuffer?.destroy();
        this.rawUniformBuffer?.destroy();
        this.rawSlotIndexBuffer?.destroy();
        this.rawLightBuffer?.destroy();
        this.rawSkinnedDynamicBuffer?.destroy();
        this.rawSkinnedStaticBuffer?.destroy();
        this.rawSkinnedSlotIndexBuffer?.destroy();
        this.rawBoneMatrixBuffer?.destroy();
    }
}

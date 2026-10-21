import {
    RawBindGroup,
    RawBindGroupLayout,
    RawBuffer,
    RawBufferUsage,
    RawDevice,
    RawRenderPassEncoder,
    RawRenderPipeline,
    RawTextureFormat,
    GpuBindGroupLayout,
    GpuShader,
} from 'murow/gpu';

import { d, std } from '../gpu-ns';
import { tonemap } from '../shaders/utils';
import type { Camera3D } from '../cameras/camera-3d';
import type { IblManager } from '../ibl';
import type { RendererRuntime } from '../backend';

/** Per-frame skybox uniforms. f32-contiguous so the upload is one write. */
export const SkyboxUniforms = d.struct({
    rightX: d.f32,
    rightY: d.f32,
    rightZ: d.f32,
    upX: d.f32,
    upY: d.f32,
    upZ: d.f32,
    forwardX: d.f32,
    forwardY: d.f32,
    forwardZ: d.f32,
    tanHalfFov: d.f32,
    aspect: d.f32,
    rotation: d.f32,
    intensity: d.f32,
    enabled: d.f32,
    tintR: d.f32,
    tintG: d.f32,
    tintB: d.f32,
    prevTintR: d.f32,
    prevTintG: d.f32,
    prevTintB: d.f32,
    alpha: d.f32,
});

/** Dependencies for {@link SkyboxManager}. */
export interface SkyboxManagerDeps {
    runtime: RendererRuntime;
    device: RawDevice;
    format: RawTextureFormat;
    ibl: IblManager;
}

/** Draws the active environment cubemap as a fullscreen background. */
export class SkyboxManager {
    /** Whether the background is drawn. Default true when an environment is active. */
    enabled = true;
    /** RGB multiplier applied to the background. */
    tint: [number, number, number] = [1, 1, 1];
    private prevTint: [number, number, number] = [1, 1, 1];

    private readonly runtime: RendererRuntime;
    private readonly device: RawDevice;
    private readonly ibl: IblManager;
    private readonly pipeline: RawRenderPipeline;
    private bindGroup: RawBindGroup;
    private readonly bgl: RawBindGroupLayout;
    private bindGroupVersion = -1;
    private readonly uniformBuffer: RawBuffer;
    private readonly uniformData = new Float32Array(SkyboxUniforms.size / 4);

    constructor(deps: SkyboxManagerDeps) {
        this.runtime = deps.runtime;
        this.device = deps.device;
        this.ibl = deps.ibl;

        const layout = new GpuBindGroupLayout({
            params: { uniform: SkyboxUniforms },
            envMap: { texture: 'float' },
            envSampler: { sampler: 'filtering' },
        });

        const vertex = GpuShader.vertex(
            {
                in: { vertexIndex: d.builtin.vertexIndex },
                out: { pos: d.builtin.position, vNdc: d.vec2f },
            },
            (input) => {
                const one = d.u32(1);
                const two = d.u32(2);
                const x = std.select(d.f32(-1.0), d.f32(3.0), std.eq(input.vertexIndex, one));
                const y = std.select(d.f32(-1.0), d.f32(3.0), std.eq(input.vertexIndex, two));
                return { pos: d.vec4f(x, y, 0.0, 1.0), vNdc: d.vec2f(x, y) };
            },
        );

        const fragment = GpuShader.fragment(
            {
                in: { vNdc: d.vec2f },
                out: d.vec4f,
                bindings: { sky: layout },
                helpers: { std, tonemap },
            },
            (input, { sky }) => {
                const u = sky.params;
                const dir = std.normalize(d.vec3f(
                    std.add(
                        std.add(u.forwardX, std.mul(std.mul(u.rightX, input.vNdc.x), std.mul(u.tanHalfFov, u.aspect))),
                        std.mul(std.mul(u.upX, input.vNdc.y), u.tanHalfFov),
                    ),
                    std.add(
                        std.add(u.forwardY, std.mul(std.mul(u.rightY, input.vNdc.x), std.mul(u.tanHalfFov, u.aspect))),
                        std.mul(std.mul(u.upY, input.vNdc.y), u.tanHalfFov),
                    ),
                    std.add(
                        std.add(u.forwardZ, std.mul(std.mul(u.rightZ, input.vNdc.x), std.mul(u.tanHalfFov, u.aspect))),
                        std.mul(std.mul(u.upZ, input.vNdc.y), u.tanHalfFov),
                    ),
                ));
                const cosR = std.cos(u.rotation);
                const sinR = std.sin(u.rotation);
                const rotated = d.vec3f(
                    std.sub(std.mul(dir.x, cosR), std.mul(dir.z, sinR)),
                    dir.y,
                    std.add(std.mul(dir.x, sinR), std.mul(dir.z, cosR)),
                );
                const uCoord = std.add(std.div(std.atan2(rotated.z, rotated.x), d.f32(6.283185307)), d.f32(0.5));
                const vCoord = std.div(std.acos(std.clamp(rotated.y, d.f32(-1.0), d.f32(1.0))), d.f32(3.141592653));
                const tex = std.textureSampleLevel(sky.envMap, sky.envSampler, d.vec2f(uCoord, vCoord), 0.0);
                const tr = std.mix(u.prevTintR, u.tintR, u.alpha);
                const tg = std.mix(u.prevTintG, u.tintG, u.alpha);
                const tb = std.mix(u.prevTintB, u.tintB, u.alpha);
                const mapped = std.tonemap(d.vec3f(
                    std.mul(std.mul(tex.x, u.intensity), tr),
                    std.mul(std.mul(tex.y, u.intensity), tg),
                    std.mul(std.mul(tex.z, u.intensity), tb),
                ));
                return d.vec4f(mapped.x, mapped.y, mapped.z, 1.0);
            },
        );

        const { code } = this.runtime.compile([vertex, fragment]);
        const module = this.device.createShaderModule({ code, label: 'skybox' });
        this.bgl = this.runtime.createBindGroupLayout(layout.toDescriptor());
        this.uniformBuffer = this.device.createBuffer({
            size: SkyboxUniforms.size,
            usage: RawBufferUsage.UNIFORM | RawBufferUsage.COPY_DST,
        });
        this.pipeline = this.device.createRenderPipeline({
            label: 'skybox',
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgl] }),
            vertex: { module },
            fragment: { module, targets: [{ format: deps.format }] },
            primitive: { topology: 'triangle-list', cullMode: 'none' },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'always',
            },
        });
        this.bindGroup = this.createBindGroup();
    }

    /** Skybox equirect width. Height is width / 2. */
    get resolution(): number {
        return this.ibl.skyboxResolution;
    }

    set resolution(width: number) {
        this.ibl.skyboxResolution = width;
    }

    private createBindGroup(): RawBindGroup {
        this.bindGroupVersion = this.ibl.equirectVersion;
        return this.device.createBindGroup({
            layout: this.bgl,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: this.ibl.equirectView },
                { binding: 2, resource: this.ibl.equirectSampler },
            ],
        });
    }

    /** Snapshot the tint before a tick, for frame interpolation. */
    storePrevious(): void {
        this.prevTint[0] = this.tint[0];
        this.prevTint[1] = this.tint[1];
        this.prevTint[2] = this.tint[2];
    }

    /** Record the background draw. No-op without an active environment. */
    render(pass: RawRenderPassEncoder, camera: Camera3D, alpha: number): void {
        if (!this.enabled || !this.ibl.active) return;
        if (this.bindGroupVersion !== this.ibl.equirectVersion) this.bindGroup = this.createBindGroup();
        this.writeUniforms(camera, alpha);
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(3, 1, 0, 0);
    }

    private writeUniforms(camera: Camera3D, alpha: number): void {
        const m = camera.getViewMatrix();
        const data = this.uniformData;
        data[0] = m[0]!; data[1] = m[4]!; data[2] = m[8]!;
        data[3] = m[1]!; data[4] = m[5]!; data[5] = m[9]!;
        data[6] = -m[2]!; data[7] = -m[6]!; data[8] = -m[10]!;
        data[9] = Math.tan((camera.fov * Math.PI) / 360);
        data[10] = camera.aspect;
        data[11] = this.ibl.rotation;
        data[12] = this.ibl.intensity;
        data[13] = 1;
        data[14] = this.tint[0];
        data[15] = this.tint[1];
        data[16] = this.tint[2];
        data[17] = this.prevTint[0];
        data[18] = this.prevTint[1];
        data[19] = this.prevTint[2];
        data[20] = alpha;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
    }
}

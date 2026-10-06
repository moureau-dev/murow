import type { TgpuRoot, TgpuBuffer, TgpuBindGroupLayout } from 'typegpu';
import { tgpu, d, std } from '../../shaders/typegpu';
import { attachShaderMetadata } from '../../shaders/runtime-transpile';
import { ComputeBuilder, type ComputeKernel } from '../../compute/compute-builder';
import { SimpleRNG } from 'murow/core/simple-rng';
import { PARTICLE_3D_STRIDE, PARTICLE_3D_FRAME_FLOATS } from './shaders';

/** Per-particle GPU record. Must match the raw WGSL `Particle` layout exactly. */
const Particle3D = d.struct({
    px: d.f32, py: d.f32, pz: d.f32,
    vx: d.f32, vy: d.f32, vz: d.f32,
    age: d.f32, life: d.f32, size: d.f32,
    r: d.f32, g: d.f32, b: d.f32, a: d.f32,
    gx: d.f32, gy: d.f32, gz: d.f32,
    mat: d.f32,
    grow: d.f32,
    rot: d.f32,
    spin: d.f32,
});

/** Frame data shared by the spawn + integrate compute kernels. */
const ComputeFrame = d.struct({
    /** x = dt, y = time, z = drag, w = unused. */
    params: d.vec4f,
    /** x = ring head, y = spawn count, z = unused, w = ring mask (power-of-two - 1). */
    counts: d.vec4u,
});

/** Render-time frame data, read by the billboard vertex shader. */
const FrameUniforms = d.struct({
    viewProj: d.mat4x4f,
    right: d.vec4f,
    up: d.vec4f,
    params: d.vec4f,
    counts: d.vec4f,
});

/** Per-material constants: which id this draw owns, and whether it uses a texture. */
const MaterialUniforms = d.struct({
    matId: d.f32,
    useTexture: d.f32,
    atlasCols: d.f32,
    atlasRows: d.f32,
});

export type ParticleBlend = 'additive' | 'alpha';

/** A particle material: an optional texture (from the asset bucket) + blend mode. */
export interface ParticleMaterialSpec {
    /** Texture id from the asset bucket. Omit for a soft procedural disc. */
    readonly texture?: string;
    /** Blend mode. Default `'additive'`. */
    readonly blend?: ParticleBlend;
}

export interface ParticleEmitter3DOptions {
    /** World-space origin. Default `[0, 0, 0]`. */
    position?: [number, number, number];
    /** Spawns per second. Default 50. */
    rate?: number;
    /** Particle lifetime range in seconds. Default `[0.5, 1.0]`. */
    lifetime?: [number, number];
    /** Launch speed range. Default `[1, 3]`. */
    speed?: [number, number];
    /** Cone half-angle in radians around `direction`. Default 0.35. */
    spread?: number;
    /** Base launch direction. Default `[0, 1, 0]`. */
    direction?: [number, number, number];
    /** Per-particle gravity (acceleration). Default `[0, -9.8, 0]`. */
    gravity?: [number, number, number];
    /** Particle size range. Default `[0.1, 0.2]`. */
    size?: [number, number];
    /** RGBA color. Default `[1, 1, 1, 1]`. */
    color?: [number, number, number, number];
    /** Random spawn offset radius (world units) around `position`. Default 0. */
    spawnRadius?: number;
    /** Size multiplier at end of life; `1` = constant, `>1` grows. Default 1. */
    grow?: number;
    /** Sprite spin in radians/second (randomised direction). Default 0. */
    spin?: number;
    /** Particle material (texture + blend). Defaults to a soft additive disc. */
    material?: ParticleMaterialSpec;
    /** Deterministic RNG seed. Default 1. */
    seed?: number;
}

/**
 * Live emitter handle. Mutate fields (e.g. `position`, `rate`) to steer it; the
 * next `update` reads them. `emitter.update(deltaTime)` advances only this emitter.
 */
export interface ParticleEmitter3D {
    /** When false the emitter spawns nothing (its live particles still finish). */
    enabled: boolean;
    position: [number, number, number];
    /** Spawn from this emitter for `deltaTime` and run one GPU simulate pass. */
    update(deltaTime: number): void;
    rate: number;
    lifetime: [number, number];
    speed: [number, number];
    spread: number;
    direction: [number, number, number];
    gravity: [number, number, number];
    size: [number, number];
    color: [number, number, number, number];
    spawnRadius: number;
    grow: number;
    spin: number;
    /** @internal Material index into the system's material table. */
    material: number;
    /** @internal Fractional spawn budget carried between updates. */
    budget: number;
}

export interface ParticleSystem3DOptions {
    root: TgpuRoot;
    /** Target color format. */
    format: GPUTextureFormat;
    /** Max live particles (rounded up to a power of two). Default 4096. */
    maxParticles?: number;
    /** Max particles spawned per frame. Default 512. */
    maxSpawnsPerFrame?: number;
    /** Resolves a material texture id to a GPU view + sampler. */
    resolveTexture?: (id: string) => { view: GPUTextureView; sampler: GPUSampler } | undefined;
}

interface ParticleMaterial {
    key: string;
    bindGroup: GPUBindGroup;
    pipeline: GPURenderPipeline;
    buffer: GPUBuffer;
}

function nextPowerOfTwo(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

/**
 * GPU-first 3D particle system. The CPU only prepares spawn records (one ring
 * buffer upload per update) and emitter state; the GPU spawns into a power-of-two
 * ring pool, integrates every particle in compute, then rasterises instanced
 * camera-facing quads batched by material.
 */
export class ParticleSystem3D {
    private readonly root: TgpuRoot;
    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly max: number;
    private readonly mask: number;
    private readonly maxSpawns: number;
    private readonly resolveTexture: ((id: string) => { view: GPUTextureView; sampler: GPUSampler } | undefined) | undefined;
    private readonly pool: TgpuBuffer<any>;
    private readonly spawns: TgpuBuffer<any>;
    private readonly computeFrame: TgpuBuffer<any>;
    private readonly renderFrame: GPUBuffer;
    private readonly spawnKernel: ComputeKernel<any>;
    private readonly integrateKernel: ComputeKernel<any>;
    private readonly layout: TgpuBindGroupLayout;
    private readonly whiteTexture: GPUTexture;
    private readonly whiteView: GPUTextureView;
    private readonly sampler: GPUSampler;
    private readonly additivePipeline: GPURenderPipeline;
    private readonly alphaPipeline: GPURenderPipeline;
    private readonly materials: ParticleMaterial[] = [];
    private readonly spawnStaging: Float32Array;
    private readonly frameData = new Float32Array(PARTICLE_3D_FRAME_FLOATS);
    private readonly computeFrameData = new ArrayBuffer(32);
    private readonly computeFrameF32 = new Float32Array(this.computeFrameData);
    private readonly computeFrameU32 = new Uint32Array(this.computeFrameData);
    private readonly emitters: ParticleEmitter3D[] = [];
    private readonly rng = new SimpleRNG(1);
    private head = 0;
    private totalSpawned = 0;
    private pending = 0;
    /** Coalesces multiple `emitter.update` calls into one simulate per frame. */
    private simulatedThisFrame = false;

    constructor(options: ParticleSystem3DOptions) {
        const { root, format } = options;
        this.root = root;
        this.device = root.device;
        this.format = format;
        this.max = nextPowerOfTwo(options.maxParticles ?? 4096);
        this.mask = this.max - 1;
        this.maxSpawns = options.maxSpawnsPerFrame ?? 512;
        this.resolveTexture = options.resolveTexture;

        this.pool = root.createBuffer(d.arrayOf(Particle3D, this.max)).$usage('storage');
        this.spawns = root.createBuffer(d.arrayOf(Particle3D, this.maxSpawns)).$usage('storage');
        this.computeFrame = root.createBuffer(ComputeFrame).$usage('uniform');
        this.spawnStaging = new Float32Array(this.maxSpawns * PARTICLE_3D_STRIDE);

        const spawns = this.spawns;
        const pool = this.pool;
        const frame = this.computeFrame;

        this.spawnKernel = new ComputeBuilder('particles-spawn', { workgroupSize: 64 }, root)
            .buffers({
                particles: { storage: d.arrayOf(Particle3D, this.max), readwrite: true, external: pool },
                spawnRecords: { storage: d.arrayOf(Particle3D, this.maxSpawns), external: spawns },
                frame: { uniform: ComputeFrame, external: frame },
            })
            .shader(({ particles, spawnRecords, frame }, { globalId }) => {
                'use gpu';
                const i = globalId.x;
                // @ts-ignore — TGSL uniform struct access
                if (i >= frame.counts.y) { return; }
                // @ts-ignore — TGSL uniform struct access
                const slot = (frame.counts.x + i) & frame.counts.w;
                const src = spawnRecords[i];
                particles[slot].px = src.px;
                particles[slot].py = src.py;
                particles[slot].pz = src.pz;
                particles[slot].vx = src.vx;
                particles[slot].vy = src.vy;
                particles[slot].vz = src.vz;
                particles[slot].age = src.age;
                particles[slot].life = src.life;
                particles[slot].size = src.size;
                particles[slot].r = src.r;
                particles[slot].g = src.g;
                particles[slot].b = src.b;
                particles[slot].a = src.a;
                particles[slot].gx = src.gx;
                particles[slot].gy = src.gy;
                particles[slot].gz = src.gz;
                particles[slot].mat = src.mat;
                particles[slot].grow = src.grow;
                particles[slot].rot = src.rot;
                particles[slot].spin = src.spin;
            })
            .build();

        this.integrateKernel = new ComputeBuilder('particles-integrate', { workgroupSize: 64 }, root)
            .buffers({
                particles: { storage: d.arrayOf(Particle3D, this.max), readwrite: true, external: pool },
                frame: { uniform: ComputeFrame, external: frame },
            })
            .shader(({ particles, frame }, { globalId }) => {
                'use gpu';
                const i = globalId.x;
                const p = particles[i];
                if (p.life <= 0.0) { return; }
                // @ts-ignore — TGSL uniform struct access
                const dt = frame.params.x;
                // @ts-ignore — TGSL uniform struct access
                const drag = frame.params.z;
                const vx = (p.vx + p.gx * dt) * drag;
                const vy = (p.vy + p.gy * dt) * drag;
                const vz = (p.vz + p.gz * dt) * drag;
                const age = p.age + dt;
                particles[i].px = p.px + vx * dt;
                particles[i].py = p.py + vy * dt;
                particles[i].pz = p.pz + vz * dt;
                particles[i].vx = vx;
                particles[i].vy = vy;
                particles[i].vz = vz;
                particles[i].age = age;
                if (age >= p.life) { particles[i].life = -1.0; }
            })
            .build();

        // 1x1 white fallback.
        this.whiteTexture = this.device.createTexture({
            size: [1, 1, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture({ texture: this.whiteTexture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
        this.whiteView = this.whiteTexture.createView();
        this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

        const layout = tgpu.bindGroupLayout({
            frame: { uniform: FrameUniforms },
            particles: { storage: d.arrayOf(Particle3D, this.max) },
            tex: { texture: 'float' },
            sampler: { sampler: 'filtering' },
            material: { uniform: MaterialUniforms },
        });
        this.layout = layout;

        const vfn = function(input: { vertexIndex: number; instanceIndex: number }) {
            const vi = d.f32(input.vertexIndex);
            const x = (vi - 2.0 * std.floor(vi * 0.5)) * 2.0 - 1.0;
            const y = std.floor(vi * 0.5) * 2.0 - 1.0;
            const p = layout.$.particles[input.instanceIndex];
            if (p.life <= 0.0 || p.mat != layout.$.material.matId) {
                return { pos: d.vec4f(0.0, 0.0, 0.0, 0.0), uv: d.vec2f(0.0, 0.0), color: d.vec4f(0.0, 0.0, 0.0, 0.0) };
            }
            const frac = p.age / p.life;
            const size = p.size * std.mix(1.0, p.grow, frac) * layout.$.frame.params.w;
            const ang = p.rot + p.spin * p.age;
            const cs = std.cos(ang);
            const sn = std.sin(ang);
            const cx = x * cs - y * sn;
            const cy = x * sn + y * cs;
            const rx = layout.$.frame.right;
            const uy = layout.$.frame.up;
            const world = d.vec3f(
                p.px + rx.x * (cx * size) + uy.x * (cy * size),
                p.py + rx.y * (cx * size) + uy.y * (cy * size),
                p.pz + rx.z * (cx * size) + uy.z * (cy * size),
            );
            return {
                pos: std.mul(layout.$.frame.viewProj, d.vec4f(world.x, world.y, world.z, 1.0)),
                uv: d.vec2f(cx * 0.5 + 0.5, cy * 0.5 + 0.5),
                color: d.vec4f(p.r, p.g, p.b, p.a * (1.0 - frac)),
            };
        };
        attachShaderMetadata(vfn, () => ({ d, std }), false, { d, std, layout });
        const vertex = tgpu.vertexFn({
            in: { vertexIndex: d.builtin.vertexIndex, instanceIndex: d.builtin.instanceIndex },
            out: { pos: d.builtin.position, uv: d.vec2f, color: d.vec4f },
        })(vfn);

        const ffn = function(input: { uv: { x: number; y: number }; color: { x: number; y: number; z: number; w: number } }) {
            const sampled = std.textureSample(layout.$.tex, layout.$.sampler, d.vec2f(input.uv.x, input.uv.y));
            const dd = std.length(d.vec2f(input.uv.x * 2.0 - 1.0, input.uv.y * 2.0 - 1.0));
            const disc = d.vec4f(1.0, 1.0, 1.0, std.smoothstep(1.0, 0.15, dd));
            const base = std.mix(disc, sampled, layout.$.material.useTexture);
            const a = base.w * input.color.w;
            return d.vec4f(input.color.x * base.x * a, input.color.y * base.y * a, input.color.z * base.z * a, a);
        };
        attachShaderMetadata(ffn, () => ({ d, std }), false, { d, std, layout });
        const fragment = tgpu.fragmentFn({ in: { uv: d.vec2f, color: d.vec4f }, out: d.vec4f })(ffn);

        const { code } = tgpu.resolveWithContext([vertex, fragment]);
        const module = this.device.createShaderModule({ code, label: 'particles-3d' });
        const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.root.unwrap(layout) as unknown as GPUBindGroupLayout] });
        const target = (blend: GPUBlendState | undefined): GPUColorTargetState => ({ format, blend });
        this.additivePipeline = this.device.createRenderPipeline({
            label: 'particles-3d-additive',
            layout: pipelineLayout,
            vertex: { module },
            fragment: { module, targets: [target({
                color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            })] },
            primitive: { topology: 'triangle-strip' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        });
        this.alphaPipeline = this.device.createRenderPipeline({
            label: 'particles-3d-alpha',
            layout: pipelineLayout,
            vertex: { module },
            fragment: { module, targets: [target({
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            })] },
            primitive: { topology: 'triangle-strip' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        });

        this.renderFrame = this.device.createBuffer({
            size: PARTICLE_3D_FRAME_FLOATS * 4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Material 0 is the default soft additive disc.
        this.createMaterial({ blend: 'additive' });
    }

    get count(): number {
        return this.totalSpawned;
    }

    get emitterCount(): number {
        return this.emitters.length;
    }

    /** Register an emitter and return its live handle. */
    addEmitter(options: ParticleEmitter3DOptions = {}): ParticleEmitter3D {
        const emitter: ParticleEmitter3D = {
            enabled: true,
            position: options.position ?? [0, 0, 0],
            rate: options.rate ?? 50,
            lifetime: options.lifetime ?? [0.5, 1.0],
            speed: options.speed ?? [1, 3],
            spread: options.spread ?? 0.35,
            direction: options.direction ?? [0, 1, 0],
            gravity: options.gravity ?? [0, -9.8, 0],
            size: options.size ?? [0.1, 0.2],
            color: options.color ?? [1, 1, 1, 1],
            spawnRadius: options.spawnRadius ?? 0,
            grow: options.grow ?? 1,
            spin: options.spin ?? 0,
            material: this.materialIndex(options.material),
            budget: 0,
            update: (deltaTime: number) => this.updateEmitter(emitter, deltaTime),
        };
        this.emitters.push(emitter);
        return emitter;
    }

    removeEmitter(emitter: ParticleEmitter3D): void {
        const i = this.emitters.indexOf(emitter);
        if (i >= 0) this.emitters.splice(i, 1);
    }

    /**
     * Spawn from one emitter. The GPU simulate pass runs at most once per frame
     * (coalesced across emitters, reset in `draw`), so calling `update` on
     * several emitters is safe.
     */
    updateEmitter(emitter: ParticleEmitter3D, deltaTime: number): void {
        if (emitter.enabled) this.emitFrom(emitter, deltaTime);
        if (!this.simulatedThisFrame) {
            this.simulate(deltaTime);
            this.simulatedThisFrame = true;
        }
    }

    /** Spawn from every enabled emitter and run one GPU simulate pass. */
    update(deltaTime: number): void {
        for (let e = 0; e < this.emitters.length; e++) {
            const em = this.emitters[e]!;
            if (em.enabled) this.emitFrom(em, deltaTime);
        }
        this.simulate(deltaTime);
        this.simulatedThisFrame = true;
    }

    /** Draw every material batch into the current render pass. */
    draw(pass: GPURenderPassEncoder, viewProj: Float32Array, right: ArrayLike<number>, up: ArrayLike<number>): void {
        // A draw marks the frame boundary: next frame's first update simulates.
        this.simulatedThisFrame = false;
        if (this.totalSpawned === 0) return;

        const f = this.frameData;
        f.set(viewProj, 0);
        f[16] = right[0]!; f[17] = right[1]!; f[18] = right[2]!; f[19] = 1;
        f[20] = up[0]!; f[21] = up[1]!; f[22] = up[2]!; f[23] = 0;
        f[24] = 0; f[25] = 0; f[26] = 0; f[27] = 1.1;   // sizeScale
        f[28] = this.totalSpawned; f[29] = 0; f[30] = 0; f[31] = 0;
        this.device.queue.writeBuffer(this.renderFrame, 0, f);

        for (let m = 0; m < this.materials.length; m++) {
            const material = this.materials[m]!;
            pass.setPipeline(material.pipeline);
            pass.setBindGroup(0, material.bindGroup);
            pass.draw(4, this.totalSpawned);
        }
    }

    destroy(): void {
        this.pool.destroy();
        this.spawns.destroy();
        this.computeFrame.destroy();
        this.renderFrame.destroy();
        for (let m = 0; m < this.materials.length; m++) this.materials[m]!.buffer.destroy();
        this.spawnKernel.destroy();
        this.integrateKernel.destroy();
        this.whiteTexture.destroy();
    }

    // --- internals ---

    private materialIndex(spec: ParticleMaterialSpec | undefined): number {
        const key = `${spec?.texture ?? ''}|${spec?.blend ?? 'additive'}`;
        for (let m = 0; m < this.materials.length; m++) {
            if (this.materials[m]!.key === key) return m;
        }
        return this.createMaterial(spec ?? {});
    }

    private createMaterial(spec: ParticleMaterialSpec): number {
        const blend: ParticleBlend = spec.blend ?? 'additive';
        const resolved = spec.texture ? this.resolveTexture?.(spec.texture) : undefined;
        const useTexture = resolved ? 1 : 0;
        const view = resolved?.view ?? this.whiteView;
        const sampler = resolved?.sampler ?? this.sampler;
        const id = this.materials.length;

        const buffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.device.queue.writeBuffer(buffer, 0, new Float32Array([id, useTexture, 1, 1]));
        const bindGroup = this.device.createBindGroup({
            layout: this.root.unwrap(this.layout) as unknown as GPUBindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.renderFrame } },
                { binding: 1, resource: { buffer: this.root.unwrap(this.pool) as unknown as GPUBuffer } },
                { binding: 2, resource: view },
                { binding: 3, resource: sampler },
                { binding: 4, resource: { buffer } },
            ],
        });
        this.materials.push({
            key: `${spec.texture ?? ''}|${blend}`,
            bindGroup,
            pipeline: blend === 'alpha' ? this.alphaPipeline : this.additivePipeline,
            buffer,
        });
        return id;
    }

    private emitFrom(emitter: ParticleEmitter3D, deltaTime: number): void {
        emitter.budget += emitter.rate * deltaTime;
        let n = Math.floor(emitter.budget);
        if (n <= 0) return;
        if (this.pending + n > this.maxSpawns) n = this.maxSpawns - this.pending;
        if (n <= 0) return;
        emitter.budget -= n;
        for (let k = 0; k < n; k++) this.writeSpawn(emitter, this.pending + k);
        this.pending += n;
    }

    private simulate(deltaTime: number): void {
        const spawnCount = this.pending;
        if (spawnCount === 0 && this.totalSpawned === 0) return;

        if (spawnCount > 0) {
            this.device.queue.writeBuffer(
                this.root.unwrap(this.spawns) as unknown as GPUBuffer, 0,
                this.spawnStaging.buffer, 0, spawnCount * PARTICLE_3D_STRIDE * 4,
            );
        }
        this.computeFrameF32[0] = deltaTime;
        this.computeFrameF32[1] = 0;
        this.computeFrameF32[2] = 0.985;
        this.computeFrameF32[3] = 0;
        this.computeFrameU32[4] = this.head;
        this.computeFrameU32[5] = spawnCount;
        this.computeFrameU32[6] = 0;
        this.computeFrameU32[7] = this.mask;
        this.device.queue.writeBuffer(
            this.root.unwrap(this.computeFrame) as unknown as GPUBuffer, 0, this.computeFrameData,
        );

        const encoder = this.device.createCommandEncoder();
        if (spawnCount > 0) this.spawnKernel.encode(encoder, spawnCount);
        this.integrateKernel.encode(encoder, this.max);
        this.device.queue.submit([encoder.finish()]);

        this.head = (this.head + spawnCount) & this.mask;
        this.totalSpawned = Math.min(this.max, this.totalSpawned + spawnCount);
        this.pending = 0;
    }

    private writeSpawn(em: ParticleEmitter3D, index: number): void {
        const rng = this.rng;
        const base = index * PARTICLE_3D_STRIDE;
        const s = this.spawnStaging;
        const life = rng.range(em.lifetime[0], em.lifetime[1]);
        const speed = rng.range(em.speed[0], em.speed[1]);
        const size = rng.range(em.size[0], em.size[1]);
        const [dx, dy, dz] = randomDirectionInCone(rng, em.direction, em.spread);
        let ox = 0, oy = 0, oz = 0;
        if (em.spawnRadius > 0) {
            const [jx, jy, jz] = randomDirectionInCone(rng, [0, 1, 0], Math.PI);
            const r = em.spawnRadius * Math.cbrt(rng.rand());
            ox = jx * r; oy = jy * r; oz = jz * r;
        }
        s[base + 0] = em.position[0] + ox;
        s[base + 1] = em.position[1] + oy;
        s[base + 2] = em.position[2] + oz;
        s[base + 3] = dx * speed;
        s[base + 4] = dy * speed;
        s[base + 5] = dz * speed;
        s[base + 6] = 0;
        s[base + 7] = life;
        s[base + 8] = size;
        s[base + 9] = em.color[0];
        s[base + 10] = em.color[1];
        s[base + 11] = em.color[2];
        s[base + 12] = em.color[3];
        s[base + 13] = em.gravity[0];
        s[base + 14] = em.gravity[1];
        s[base + 15] = em.gravity[2];
        s[base + 16] = em.material;
        s[base + 17] = em.grow;
        s[base + 18] = rng.rand() * Math.PI * 2;
        s[base + 19] = em.spin * (rng.rand() * 2 - 1);
    }
}

/** Random unit vector within `spread` radians of `axis`. */
function randomDirectionInCone(rng: SimpleRNG, axis: readonly number[], spread: number): [number, number, number] {
    let [ax, ay, az] = axis as [number, number, number];
    const len = Math.hypot(ax, ay, az) || 1;
    ax /= len; ay /= len; az /= len;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ay) > 0.99) { ux = 1; uy = 0; }
    let rx = uy * az - uz * ay;
    let ry = uz * ax - ux * az;
    let rz = ux * ay - uy * ax;
    const rl = Math.hypot(rx, ry, rz) || 1;
    rx /= rl; ry /= rl; rz /= rl;
    const bx = ay * rz - az * ry;
    const by = az * rx - ax * rz;
    const bz = ax * ry - ay * rx;
    const cosSpread = Math.cos(spread);
    const cosTheta = rng.range(cosSpread, 1);
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = rng.rand() * Math.PI * 2;
    const cp = Math.cos(phi) * sinTheta;
    const sp = Math.sin(phi) * sinTheta;
    return [ax * cosTheta + rx * cp + bx * sp, ay * cosTheta + ry * cp + by * sp, az * cosTheta + rz * cp + bz * sp];
}

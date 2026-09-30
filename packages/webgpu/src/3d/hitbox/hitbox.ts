import { placePart3D, type HitboxPart } from 'murow/core/hitbox';

function buildUnitSphereWireframe(segments = 16): Float32Array {
    const out: number[] = [];
    const step = (Math.PI * 2) / segments;
    for (let axis = 0; axis < 3; axis++) {
        for (let i = 0; i < segments; i++) {
            const a = i * step;
            const b = (i + 1) * step;
            const ca = Math.cos(a), sa = Math.sin(a);
            const cb = Math.cos(b), sb = Math.sin(b);
            if (axis === 0) {
                out.push(0, ca, sa, 0, cb, sb);
            } else if (axis === 1) {
                out.push(ca, 0, sa, cb, 0, sb);
            } else {
                out.push(ca, sa, 0, cb, sb, 0);
            }
        }
    }
    return new Float32Array(out);
}

function buildUnitBoxWireframe(): Float32Array {
    const h = 0.5;
    const corners: [number, number, number][] = [
        [-h, -h, -h], [ h, -h, -h], [ h,  h, -h], [-h,  h, -h],
        [-h, -h,  h], [ h, -h,  h], [ h,  h,  h], [-h,  h,  h],
    ];
    const edges: [number, number][] = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    const out: number[] = [];
    for (const [a, b] of edges) {
        out.push(...corners[a], ...corners[b]);
    }
    return new Float32Array(out);
}

function buildUnitCylinderWireframe(segments = 24): Float32Array {
    const h = 0.5;
    const step = (Math.PI * 2) / segments;
    const out: number[] = [];
    for (let i = 0; i < segments; i++) {
        const a = i * step, b = (i + 1) * step;
        const ca = Math.cos(a), sa = Math.sin(a);
        const cb = Math.cos(b), sb = Math.sin(b);
        out.push(ca, -h, sa, cb, -h, sb);
        out.push(ca,  h, sa, cb,  h, sb);
    }
    for (let i = 0; i < 4; i++) {
        const a = i * (Math.PI * 0.5);
        const ca = Math.cos(a), sa = Math.sin(a);
        out.push(ca, -h, sa, ca, h, sa);
    }
    return new Float32Array(out);
}

type Color = readonly [number, number, number, number];

const IDLE: Color = [1, 0, 1, 1];
const HOVERED: Color = [0.2, 1, 0.4, 1];

// Per-entry uniform payload is 80 bytes (mat4 + vec4). WebGPU requires
// dynamic-offset uniform binds to be 256-byte aligned, so each entry
// occupies a 256-byte stride within the shared uniform buffer.
const UNIFORM_STRIDE = 256;
const MIN_BINDING_SIZE = 80;
const CAPACITY = 4096;

/**
 * Line-list wireframe renderer for instance hitboxes. Owns its pipeline,
 * the three unit-shape vertex buffers, and a dynamic-offset uniform buffer
 * (one MVP + color per entry). The caller walks instances and feeds each
 * hitbox into `emit`; `flush` issues the per-entry draws.
 */
export class HitboxDebugRenderer {
    private device: GPUDevice | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private bindGroup: GPUBindGroup | null = null;
    private uniformBuffer: GPUBuffer | null = null;

    private sphereBuffer: GPUBuffer | null = null;
    private sphereVertexCount = 0;
    private boxBuffer: GPUBuffer | null = null;
    private boxVertexCount = 0;
    private cylinderBuffer: GPUBuffer | null = null;
    private cylinderVertexCount = 0;

    private stage = new Float32Array(0);
    private entries: { vbo: GPUBuffer; vertexCount: number; offset: number }[] = [];
    private vp: Float32Array = new Float32Array(16);

    init(device: GPUDevice, format: GPUTextureFormat): void {
        this.device = device;

        const upload = (data: Float32Array): GPUBuffer => {
            const buf = device.createBuffer({
                size: data.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
            return buf;
        };

        const sphereData = buildUnitSphereWireframe();
        const boxData = buildUnitBoxWireframe();
        const cylinderData = buildUnitCylinderWireframe();
        this.sphereBuffer = upload(sphereData);
        this.sphereVertexCount = sphereData.length / 3;
        this.boxBuffer = upload(boxData);
        this.boxVertexCount = boxData.length / 3;
        this.cylinderBuffer = upload(cylinderData);
        this.cylinderVertexCount = cylinderData.length / 3;

        this.uniformBuffer = device.createBuffer({
            size: UNIFORM_STRIDE * CAPACITY,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.stage = new Float32Array((UNIFORM_STRIDE * CAPACITY) / 4);

        const bindGroupLayout = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: MIN_BINDING_SIZE },
            }],
        });

        this.bindGroup = device.createBindGroup({
            layout: bindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: MIN_BINDING_SIZE } }],
        });

        const shaderModule = device.createShaderModule({
            code: `
                struct Uniforms {
                    mvp: mat4x4<f32>,
                    color: vec4<f32>,
                };
                @group(0) @binding(0) var<uniform> u: Uniforms;
                @vertex
                fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
                    return u.mvp * vec4<f32>(p, 1.0);
                }
                @fragment
                fn fs() -> @location(0) vec4<f32> {
                    return u.color;
                }
            `,
        });

        this.pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
            vertex: {
                module: shaderModule, entryPoint: 'vs',
                buffers: [{
                    arrayStride: 12,
                    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
                }],
            },
            fragment: { module: shaderModule, entryPoint: 'fs', targets: [{ format }] },
            primitive: { topology: 'line-list' },
            depthStencil: {
                format: 'depth24plus',
                depthWriteEnabled: false,
                depthCompare: 'less-equal',
            },
        });
    }

    begin(vp: Float32Array): void {
        this.entries.length = 0;
        this.vp = vp;
    }

    emit(
        hb: HitboxPart<'3d'>,
        hovered: boolean,
        px: number, py: number, pz: number,
        sx: number, sy: number, sz: number,
    ): void {
        const p = placePart3D(hb, px, py, pz, sx, sy, sz);
        const color = hovered ? HOVERED : IDLE;

        // Unit wireframes span the full extent (sphere/cylinder radius 1, box +-0.5),
        // so they scale by full dimensions: radius from a half-extent, full size from a half.
        if (hb.shape === 'sphere') {
            this.collect(this.sphereBuffer, this.sphereVertexCount, p.cx, p.cy, p.cz, p.hx, p.hx, p.hx, color);
        } else if (hb.shape === 'box') {
            this.collect(this.boxBuffer, this.boxVertexCount, p.cx, p.cy, p.cz, p.hx * 2, p.hy * 2, p.hz * 2, color);
        } else {
            this.collect(this.cylinderBuffer, this.cylinderVertexCount, p.cx, p.cy, p.cz, p.hx, p.hy * 2, p.hz, color);
        }
    }

    flush(pass: GPURenderPassEncoder): void {
        const { pipeline, bindGroup, uniformBuffer, entries } = this;
        if (!pipeline || !bindGroup || !uniformBuffer || entries.length === 0) return;

        this.device!.queue.writeBuffer(
            uniformBuffer, 0,
            this.stage.buffer, 0,
            entries.length * UNIFORM_STRIDE,
        );

        pass.setPipeline(pipeline);
        let currentVbo: GPUBuffer | null = null;
        for (const e of entries) {
            if (e.vbo !== currentVbo) {
                pass.setVertexBuffer(0, e.vbo);
                currentVbo = e.vbo;
            }
            pass.setBindGroup(0, bindGroup, [e.offset]);
            pass.draw(e.vertexCount, 1, 0, 0);
        }
    }

    /**
     * The model matrix is pure scale-then-translate, so `MVP = VP * M`
     * collapses to scaling VP's first three columns by the extents and
     * replacing the fourth with `VP * (center, 1)` -- no matrix multiply.
     */
    private collect(
        vbo: GPUBuffer | null, vertexCount: number,
        cx: number, cy: number, cz: number,
        ex: number, ey: number, ez: number,
        color: Color,
    ): void {
        if (!vbo || vertexCount === 0) return;
        if (this.entries.length >= CAPACITY) return;
        const idx = this.entries.length;
        const base = (idx * UNIFORM_STRIDE) >>> 2;
        const f32 = this.stage;
        const vp = this.vp;

        f32[base + 0]  = vp[0]  * ex;
        f32[base + 1]  = vp[1]  * ex;
        f32[base + 2]  = vp[2]  * ex;
        f32[base + 3]  = vp[3]  * ex;
        f32[base + 4]  = vp[4]  * ey;
        f32[base + 5]  = vp[5]  * ey;
        f32[base + 6]  = vp[6]  * ey;
        f32[base + 7]  = vp[7]  * ey;
        f32[base + 8]  = vp[8]  * ez;
        f32[base + 9]  = vp[9]  * ez;
        f32[base + 10] = vp[10] * ez;
        f32[base + 11] = vp[11] * ez;
        f32[base + 12] = vp[0] * cx + vp[4] * cy + vp[8]  * cz + vp[12];
        f32[base + 13] = vp[1] * cx + vp[5] * cy + vp[9]  * cz + vp[13];
        f32[base + 14] = vp[2] * cx + vp[6] * cy + vp[10] * cz + vp[14];
        f32[base + 15] = vp[3] * cx + vp[7] * cy + vp[11] * cz + vp[15];
        f32[base + 16] = color[0];
        f32[base + 17] = color[1];
        f32[base + 18] = color[2];
        f32[base + 19] = color[3];

        this.entries.push({ vbo, vertexCount, offset: idx * UNIFORM_STRIDE });
    }
}

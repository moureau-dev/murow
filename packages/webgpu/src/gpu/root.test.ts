import { describe, expect, test } from 'bun:test';
import { d } from './data';
import {
    BUFFER_USAGE,
    createLayoutHandle,
    GpuRoot,
} from './root';

function createMockDevice() {
    const writes: Array<{ buffer: any; offset: number; data: any }> = [];
    const buffers: any[] = [];
    const layouts: any[] = [];
    const device = {
        createBuffer(descriptor: any) {
            const buffer = {
                descriptor,
                destroy() {
                    buffer.destroyed = true;
                },
                destroyed: false,
            };
            buffers.push(buffer);
            return buffer;
        },
        createBindGroupLayout(descriptor: any) {
            const layout = { descriptor };
            layouts.push(layout);
            return layout;
        },
        createBindGroup(descriptor: any) {
            return { descriptor };
        },
        createRenderPipeline(descriptor: any) {
            return { descriptor };
        },
        createComputePipeline(descriptor: any) {
            return { descriptor };
        },
        queue: {
            writeBuffer(buffer: any, offset: number, data: any) {
                writes.push({ buffer, offset, data });
            },
        },
    };
    return { device: device as unknown as GPUDevice, writes, buffers, layouts };
}

describe('GpuRoot', () => {
    test('fromDevice wraps the device', () => {
        const { device } = createMockDevice();
        const root = GpuRoot.fromDevice(device);
        expect(root.device).toBe(device);
        expect(root.createBuffer(d.f32)).toBeInstanceOf(Object);
    });

    test('createBuffer computes sizes from the schema', () => {
        const { device } = createMockDevice();
        const root = new GpuRoot({ device });
        expect(root.createBuffer(d.f32).byteSize).toBe(4);
        expect(root.createBuffer(d.arrayOf(d.u32, 4)).byteSize).toBe(16);
        const S = d.struct({ a: d.f32, b: d.vec3f });
        expect(root.createBuffer(S).byteSize).toBe(32);
        expect(root.createBuffer(d.arrayOf(S, 2)).byteSize).toBe(64);
    });

    test('$usage is chainable and creates a buffer with COPY_DST plus usage', () => {
        const { device, buffers } = createMockDevice();
        const root = new GpuRoot({ device });
        const buffer = root.createBuffer(d.arrayOf(d.u32, 4));
        const same = buffer.$usage('storage');
        expect(same).toBe(buffer);
        expect(buffers).toHaveLength(1);
        expect(buffers[0].descriptor.size).toBe(16);
        expect(buffers[0].descriptor.usage).toBe(BUFFER_USAGE.COPY_DST | BUFFER_USAGE.STORAGE);
    });

    test('write uploads through queue.writeBuffer', () => {
        const { device, writes } = createMockDevice();
        const root = new GpuRoot({ device });
        const buffer = root.createBuffer(d.arrayOf(d.f32, 4)).$usage('uniform');
        const data = new Float32Array([1, 2, 3, 4]);
        buffer.write(data);
        expect(writes).toHaveLength(1);
        expect(writes[0].buffer).toBe(buffer.__raw);
        expect(writes[0].offset).toBe(0);
        expect(writes[0].data).toBe(data);
    });

    test('unwrap returns the raw buffer behind a handle', () => {
        const { device } = createMockDevice();
        const root = new GpuRoot({ device });
        const buffer = root.createBuffer(d.f32).$usage('uniform');
        expect(root.unwrap(buffer)).toBe(buffer.__raw);
    });

    test('destroy destroys the raw buffer', () => {
        const { device } = createMockDevice();
        const root = new GpuRoot({ device });
        const buffer = root.createBuffer(d.f32).$usage('uniform');
        const raw: any = buffer.__raw;
        buffer.destroy();
        expect(raw.destroyed).toBe(true);
    });

    test('bindGroupLayout builds a raw layout with $ accessors', () => {
        const { device, layouts } = createMockDevice();
        const root = new GpuRoot({ device });
        const layout = root.bindGroupLayout({
            entries: [
                {
                    name: 'uniforms',
                    binding: 0,
                    visibility: { vertex: true, fragment: true },
                    resource: { uniform: d.struct({ a: d.f32 }) },
                },
            ],
        });
        expect(layouts).toHaveLength(1);
        expect(root.unwrap(layout)).toBe(layout.__raw);
        const accessor: any = layout.$.uniforms;
        expect(accessor.node.kind).toBe('binding');
        expect(accessor.node.group).toBe(0);
        expect(accessor.node.binding).toBe(0);
    });

    test('a pure layout handle materializes lazily via unwrap', () => {
        const { device, layouts } = createMockDevice();
        const root = new GpuRoot({ device });
        const descriptor = {
            group: 0,
            entries: [{ name: 'data', binding: 2, resource: { storage: d.arrayOf(d.u32, 2) } }],
        };
        const handle = createLayoutHandle({ descriptor, group: 0 });
        expect(handle.__raw).toBeUndefined();
        const raw = root.unwrap(handle);
        expect(layouts).toHaveLength(1);
        expect(raw).toBe(handle.__raw);
    });

    test('pipeline factories pass through to the device', () => {
        const { device } = createMockDevice();
        const root = new GpuRoot({ device });
        const module = {} as GPUShaderModule;
        expect((root.createRenderPipeline({ vertex: { module }, fragment: { module } } as any) as any).descriptor)
            .toBeDefined();
        expect((root.createComputePipeline({ compute: { module } } as any) as any).descriptor).toBeDefined();
        expect((root.createBindGroup({} as any) as any).descriptor).toEqual({});
    });
});

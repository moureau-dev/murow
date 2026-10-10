import { describe, expect, test } from 'bun:test';
import { ALL_CAPABILITIES } from '../codegen';
import { TestWgslSyntax } from '../codegen/test-syntax';
import { RecordingDevice } from '../device/recording-device';
import { vec4f } from '../schema/primitives';
import { gpuStruct } from '../schema/struct';
import { GpuBackend } from './gpu-backend';
import { GpuContext } from './gpu-context';

function makeContext(): { context: GpuContext; device: RecordingDevice } {
    const device = new RecordingDevice();
    const backend = new GpuBackend({ name: 'test', capabilities: ALL_CAPABILITIES, syntax: new TestWgslSyntax() });
    return { context: new GpuContext({ backend, device }), device };
}

describe('GpuContext', () => {
    test('allocates a schema-sized buffer and writes packed bytes', () => {
        const { context, device } = makeContext();
        const Material = gpuStruct({ name: 'Material', fields: { tint: vec4f } });
        const buffer = context.createBuffer(Material);

        expect(buffer.size).toBe(Material.size);
        buffer.write({ tint: [1, 0, 0, 1] });

        const written = device.calls.filter((call) => call.kind === 'write-buffer');
        expect(written.length).toBe(1);
    });

    test('declares a layout and binds resources by slot name', () => {
        const { context, device } = makeContext();
        const Material = gpuStruct({ name: 'Material', fields: { tint: vec4f } });
        const layout = context.createBindGroupLayout({ material: { uniform: Material } });
        const buffer = context.createBuffer(Material);

        context.createBindGroup(layout, { material: buffer.asHandle() });

        const group = device.calls.find((call) => call.kind === 'create-bind-group');
        expect(group).toBeDefined();
        expect(layout.toDescriptor().entries[0]!.name).toBe('material');
    });
});

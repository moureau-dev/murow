import { describe, expect, test } from 'bun:test';
import { GpuStruct } from '../schema/struct';
import { f32, vec3f } from '../schema/primitives';
import { BindGroupLayout, binding } from '../descriptors/bind-group';
import { PipelineDescriptor } from '../descriptors/pipeline';
import { VertexBufferLayout } from '../descriptors/vertex-layout';
import { NO_CAPABILITIES } from '../codegen/backend';
import { RecordingDevice } from './recording-device';

const uniform = new GpuStruct({
    name: 'Uniforms',
    fields: { tint: vec3f, alpha: f32 },
});

const layout = new BindGroupLayout({
    entries: [binding({ name: 'uniforms', binding: 0, type: 'uniform' })],
});

const pipelineDescriptor = new PipelineDescriptor({
    vertex: 'vs_main',
    fragment: 'fs_main',
    vertexLayout: new VertexBufferLayout({ attributes: [] }),
    bindGroupLayouts: [layout],
});

describe('RecordingDevice buffers', () => {
    test('creates a buffer from a struct', () => {
        const device = new RecordingDevice();
        const buffer = device.createBuffer({ struct: uniform });
        expect(device.buffers).toHaveLength(1);
        expect(device.buffers[0].size).toBe(uniform.size);
        expect(device.buffers[0].usage).toBe('uniform');
        expect(device.buffers[0].struct).toBe(uniform);
        expect(device.buffers[0].handle).toBe(buffer);
    });

    test('creates a raw buffer with an explicit usage', () => {
        const device = new RecordingDevice();
        const buffer = device.createBuffer({ size: 256, usage: 'storage' });
        expect(device.buffers[0].size).toBe(256);
        expect(device.buffers[0].usage).toBe('storage');
        expect(device.calls[0].kind).toBe('create-buffer');
        expect((device.calls[0] as any).buffer).toBe(buffer);
    });

    test('assigns incrementing handles', () => {
        const device = new RecordingDevice();
        const a = device.createBuffer({ size: 4, usage: 'vertex' });
        const b = device.createBuffer({ size: 8, usage: 'index' });
        expect(a).toBe(1);
        expect(b).toBe(2);
    });

    test('records writes and destroys', () => {
        const device = new RecordingDevice();
        const buffer = device.createBuffer({ size: 16, usage: 'uniform' });
        const data = new Float32Array([1, 2, 3, 4]);
        device.writeBuffer(buffer, 4, data);
        const write = device.calls[1];
        expect(write.kind).toBe('write-buffer');
        expect((write as any).offset).toBe(4);
        expect((write as any).data).toBe(data);

        device.destroyBuffer(buffer);
        expect(device.buffers[0].destroyed).toBe(true);
        expect(device.calls[2].kind).toBe('destroy-buffer');
    });
});

describe('RecordingDevice resources', () => {
    test('creates textures', () => {
        const device = new RecordingDevice();
        const texture = device.createTexture({
            width: 64,
            height: 32,
            format: 'rgba8unorm',
            usage: 'render-target',
        });
        expect(texture).toBe(1);
        expect(device.textures[0].width).toBe(64);
        expect(device.textures[0].height).toBe(32);
        expect(device.textures[0].format).toBe('rgba8unorm');
        expect(device.textures[0].usage).toBe('render-target');
    });

    test('creates bind groups', () => {
        const device = new RecordingDevice();
        const entries = [{ name: 'uniforms', resource: { buffer: 1 } }];
        const group = device.createBindGroup(layout, entries);
        expect(group).toBe(1);
        expect(device.bindGroups[0].layout).toBe(layout);
        expect(device.bindGroups[0].entries).toBe(entries);
    });

    test('creates pipelines', () => {
        const device = new RecordingDevice();
        const pipeline = device.createPipeline(pipelineDescriptor);
        expect(pipeline).toBe(1);
        expect(device.pipelineCount()).toBe(1);
        expect(device.pipelines[0].descriptor).toBe(pipelineDescriptor);
    });
});

describe('RecordingDevice commands', () => {
    test('records a full render pass', () => {
        const device = new RecordingDevice();
        const texture = device.createTexture({
            width: 8,
            height: 8,
            format: 'rgba8unorm',
            usage: 'render-target',
        });
        const pipeline = device.createPipeline(pipelineDescriptor);
        const group = device.createBindGroup(layout, []);

        device.beginRenderPass({
            colorAttachments: [{ texture, clear: [0, 0, 0, 1] }],
        });
        device.setPipeline(pipeline);
        device.setBindGroup(0, group);
        device.draw(36, 0, 4);
        device.endRenderPass();

        expect(device.lastPipeline()).toBe(pipeline);
        expect(device.boundBindGroup(0)).toBe(group);
        expect(device.drawCount()).toBe(1);
        expect(device.lastDraw()).toEqual({ count: 36, firstInstance: 0, instanceCount: 4 });

        const kinds = device.calls.map((call) => call.kind);
        expect(kinds).toEqual([
            'create-texture',
            'create-pipeline',
            'create-bind-group',
            'begin-render-pass',
            'set-pipeline',
            'set-bind-group',
            'draw',
            'end-render-pass',
        ]);
    });

    test('records compute dispatches', () => {
        const device = new RecordingDevice();
        device.dispatch(4, 2, 1);
        expect(device.dispatchCount()).toBe(1);
        expect(device.lastDispatch()).toEqual({ workgroupsX: 4, workgroupsY: 2, workgroupsZ: 1 });
        expect(device.calls[0].kind).toBe('dispatch');
    });

    test('tracks destroy state and capabilities', () => {
        const device = new RecordingDevice();
        expect(device.destroyed).toBe(false);
        expect(device.capabilities.compute).toBe(true);
        device.destroy();
        expect(device.destroyed).toBe(true);
        expect(device.calls[0].kind).toBe('destroy');
    });

    test('accepts custom capabilities', () => {
        const device = new RecordingDevice({ capabilities: NO_CAPABILITIES });
        expect(device.capabilities).toEqual(NO_CAPABILITIES);
    });
});

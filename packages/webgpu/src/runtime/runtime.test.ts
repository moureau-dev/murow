import { describe, expect, test } from 'bun:test';
import { webgpuRuntime } from '../webgpu-runtime';

describe('webgpu runtime', () => {
    test('builds a RendererRuntime with every port', () => {
        const runtime = webgpuRuntime();
        expect(typeof runtime.compile).toBe('function');
        expect(typeof runtime.createRawBuffer).toBe('function');
        expect(typeof runtime.createBindGroupLayout).toBe('function');
        expect(typeof runtime.shaderSource).toBe('function');
        expect(typeof runtime.createPresentation).toBe('function');
        expect(typeof runtime.compute.ComputeBuilder).toBe('function');
    });
});

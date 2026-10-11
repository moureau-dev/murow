import { describe, expect, test } from 'bun:test';
import { webgpuRuntime } from '../webgpu-runtime';
import { WebGPU3DRenderer } from './runtime-3d';
import { WebGPU2DRenderer } from './runtime-2d';

describe('webgpu runtime', () => {
    test('builds a RendererRuntime with every port', () => {
        const runtime = webgpuRuntime();
        expect(typeof runtime.compile).toBe('function');
        expect(typeof runtime.createRawBuffer).toBe('function');
        expect(typeof runtime.createBindGroupLayout).toBe('function');
        expect(typeof runtime.shaderSource).toBe('function');
        expect(typeof runtime.createPresentation).toBe('function');
        expect(typeof runtime.compute.ComputeBuilder).toBe('function');
        expect(typeof runtime.compute.buildAnimationKernel).toBe('function');
    });

    test('exposes the 3D and 2D runtime renderers', () => {
        expect(typeof WebGPU3DRenderer).toBe('function');
        expect(typeof WebGPU2DRenderer).toBe('function');
    });
});

import { describe, expect, test } from 'bun:test';
import { runtime } from './runtime';

describe('webgpu runtime', () => {
    test('builds a RendererRuntime with every port', () => {
        const rt = runtime();
        expect(typeof rt.compile).toBe('function');
        expect(typeof rt.createRawBuffer).toBe('function');
        expect(typeof rt.createBindGroupLayout).toBe('function');
        expect(typeof rt.shaderSource).toBe('function');
        expect(typeof rt.createPresentation).toBe('function');
        expect(typeof rt.skinning.build).toBe('function');
        expect(typeof rt.particles.createSimulation).toBe('function');
    });
});

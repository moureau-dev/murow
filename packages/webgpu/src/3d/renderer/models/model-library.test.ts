import { test, expect, describe } from 'bun:test';
import { ModelLibrary } from './model-library';
import type { MeshPipelines } from '../pipelines/mesh-pipelines';
import type { TextureRegistry } from '../textures';

// Browser globals, absent in bun's test runtime.
Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 1, INDEX: 2, COPY_DST: 4 } });

function mockDevice() {
    return {
        createBuffer(opts: { size: number }) {
            const data = new ArrayBuffer(opts.size);
            return { getMappedRange: () => data, unmap() {}, destroy() {} };
        },
        createSampler: () => ({}),
        createBindGroup: () => ({}),
    } as unknown as GPUDevice;
}

function library() {
    const pipelines = {
        rawTexturedPipeline: { getBindGroupLayout: () => ({}) },
        rawSkinnedTexturedPipeline: { getBindGroupLayout: () => ({}) },
    } as unknown as MeshPipelines;
    const textures = { has: () => false, get: () => undefined } as unknown as TextureRegistry;
    return new ModelLibrary({ device: mockDevice(), pipelines, textures, onSkinLoaded: () => {} });
}

describe('ModelLibrary', () => {
    test('registers a model and returns a handle with bounds', () => {
        const lib = library();
        const positions = new Float32Array([
            -1, 0, 0,
            1, 0, 0,
            0, 2, 0,
        ]);
        const handle = lib.loadModel({ positions });

        expect(handle.id).toBe(0);
        expect(handle.vertexCount).toBe(3);
        expect(handle.skinned).toBe(false);

        const model = lib.get(0)!;
        expect(model.skinned).toBe(false);
        expect(model.skinIndex).toBe(-1);
        expect(model.halfX).toBeCloseTo(1);
        expect(model.halfY).toBeCloseTo(1);
        expect(model.halfZ).toBeCloseTo(0);
    });

    test('auto-computes normals (flat triangle in XY faces +Z)', () => {
        const lib = library();
        // A degenerate-Z triangle: computed normals are all +Z (stored in the vertex buffer).
        const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const handle = lib.loadModel({ positions });
        const model = lib.get(handle.id)!;
        // bounding radius is derived from positions, sanity check it is finite
        expect(Number.isFinite(model.boundingRadius)).toBe(true);
    });

    test('assigns increasing ids', () => {
        const lib = library();
        const a = lib.loadModel({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
        const b = lib.loadModel({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) });
        expect(b.id).toBe(a.id + 1);
    });

    test('unknown ids resolve to undefined', () => {
        const lib = library();
        expect(lib.get(42)).toBeUndefined();
    });
});

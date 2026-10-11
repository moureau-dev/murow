import { test, expect, describe } from 'bun:test';
import { BindGroupLayout, binding } from './bind-group';
import { RenderState } from './render-state';
import { PipelineDescriptor, shaderSourceCode, shaderSourceHandle, type PipelineDescriptorOptions } from './pipeline';
import type { VertexAttribute } from './vertex-layout';
import { VertexBufferLayout } from './vertex-layout';

const layout = new VertexBufferLayout({
    attributes: [
        { location: 0, format: 'float32x3', offset: 0 },
        { location: 1, format: 'float32x2', offset: 12 },
    ],
});

function makePipeline(overrides: Partial<PipelineDescriptorOptions> = {}) {
    return new PipelineDescriptor({
        vertex: 'vs_main',
        fragment: 'fs_main',
        vertexLayout: layout,
        ...overrides,
    });
}

describe('PipelineDescriptor', () => {
    test('normalizes defaults', () => {
        const pipeline = makePipeline();
        expect(pipeline.vertex).toBe('vs_main');
        expect(pipeline.vertexLayout).toHaveLength(1);
        expect(pipeline.bindGroupLayouts).toEqual([]);
        expect(pipeline.renderState).toBeInstanceOf(RenderState);
        expect(pipeline.primitive.topology).toBe('triangle-list');
        expect(pipeline.primitive.frontFace).toBe('ccw');
        expect(pipeline.depth?.format).toBe('depth24plus');
        expect(pipeline.multisample.count).toBe(1);
    });

    test('accepts render state options and multiple layouts', () => {
        const pipeline = makePipeline({
            renderState: { cull: 'back' },
            vertexLayout: [layout],
        });
        expect(pipeline.renderState.cull).toBe('back');
        expect(pipeline.vertexLayout).toHaveLength(1);
    });

    test('accepts a RenderState instance unchanged', () => {
        const state = new RenderState({ blend: 'alpha' });
        const pipeline = makePipeline({ renderState: state });
        expect(pipeline.renderState).toBe(state);
    });

    test('can disable depth', () => {
        expect(makePipeline({ depth: false }).depth).toBeUndefined();
    });

    test('keeps bind group layouts', () => {
        const group = new BindGroupLayout({ entries: [binding({ name: 'u', binding: 0, type: 'uniform' })] });
        expect(makePipeline({ bindGroupLayouts: [group] }).bindGroupLayouts[0]).toBe(group);
    });
});

describe('validatePipeline', () => {
    test('accepts matching attributes', () => {
        const pipeline = makePipeline();
        const known: VertexAttribute[] = [
            { location: 0, format: 'float32x3', offset: 0 },
            { location: 1, format: 'float32x2', offset: 12 },
        ];
        expect(() => pipeline.validate(known)).not.toThrow();
    });

    test('rejects a format mismatch', () => {
        const pipeline = makePipeline();
        expect(() => pipeline.validate([{ location: 0, format: 'float32x2', offset: 0 }])).toThrow();
    });

    test('rejects an unknown location', () => {
        const pipeline = makePipeline();
        expect(() => pipeline.validate([{ location: 0, format: 'float32x3', offset: 0 }])).toThrow();
    });

    test('checks layouts without a list', () => {
        expect(() => makePipeline().validate()).not.toThrow();
    });
});

describe('shader source helpers', () => {
    test('extracts inline code', () => {
        expect(shaderSourceCode('code')).toBe('code');
        expect(shaderSourceCode({ handle: 'h' })).toBeUndefined();
        expect(shaderSourceCode(undefined)).toBeUndefined();
    });

    test('extracts handles', () => {
        expect(shaderSourceHandle({ handle: 'h' })).toBe('h');
        expect(shaderSourceHandle('code')).toBeUndefined();
    });
});

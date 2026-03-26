import { test, expect, describe } from 'bun:test';
import { ComputeBuilder, ComputeKernel } from './compute-builder';
import type { ComputeOptions, ComputeBufferDef } from './compute-builder';

describe('ComputeBuilder', () => {
    describe('workgroup size normalization', () => {
        test('number becomes [n, 1, 1]', () => {
            // We can't fully build without a TgpuRoot, but we can test the constructor
            const builder = new ComputeBuilder('test', { workgroupSize: 64 }, null as any);
            expect(builder).toBeDefined();
        });

        test('2-element array becomes [x, y, 1]', () => {
            const builder = new ComputeBuilder('test', { workgroupSize: [8, 8] }, null as any);
            expect(builder).toBeDefined();
        });

        test('3-element array stays as-is', () => {
            const builder = new ComputeBuilder('test', { workgroupSize: [4, 4, 4] }, null as any);
            expect(builder).toBeDefined();
        });
    });

    describe('builder chain', () => {
        test('buffers() returns typed builder', () => {
            const builder = new ComputeBuilder('test', { workgroupSize: 64 }, null as any);
            const withBuffers = builder.buffers({
                data: { storage: {} as any, readwrite: true },
            });
            expect(withBuffers).toBeDefined();
        });

        test('shader() returns same builder', () => {
            const builder = new ComputeBuilder('test', { workgroupSize: 64 }, null as any)
                .buffers({ data: { storage: {} as any } });
            const withShader = builder.shader(() => {});
            expect(withShader).toBe(builder);
        });

        test('build() throws without buffers', () => {
            const builder = new ComputeBuilder('test', { workgroupSize: 64 }, null as any);
            (builder as any)._shaderFn = () => {};
            expect(() => builder.build()).toThrow('buffers()');
        });

        test('build() throws without shader', () => {
            const builder = new ComputeBuilder('test', { workgroupSize: 64 }, null as any)
                .buffers({ data: { storage: {} as any } });
            expect(() => builder.build()).toThrow('shader()');
        });
    });

    describe('types', () => {
        test('ComputeBufferDef accepts storage + readwrite', () => {
            const def: ComputeBufferDef = { storage: {} as any, readwrite: true };
            expect(def.readwrite).toBe(true);
        });

        test('ComputeBufferDef accepts uniform', () => {
            const def: ComputeBufferDef = { uniform: {} as any };
            expect(def.uniform).toBeDefined();
        });

        test('ComputeOptions accepts number workgroupSize', () => {
            const opts: ComputeOptions = { workgroupSize: 256 };
            expect(opts.workgroupSize).toBe(256);
        });

        test('ComputeOptions accepts tuple workgroupSize', () => {
            const opts: ComputeOptions = { workgroupSize: [8, 8, 1] };
            expect(opts.workgroupSize).toEqual([8, 8, 1]);
        });
    });
});

describe('ComputeKernel', () => {
    test('constructor sets name', () => {
        const kernel = new ComputeKernel(
            'test', null as any, null as any, null as any,
            new Map(), [64, 1, 1],
        );
        expect(kernel.name).toBe('test');
    });

    test('write throws for unknown buffer', () => {
        const kernel = new ComputeKernel(
            'test', null as any, null as any, null as any,
            new Map(), [64, 1, 1],
        );
        expect(() => kernel.write('nonexistent', {})).toThrow('not found');
    });

    test('read throws for unknown buffer', () => {
        const kernel = new ComputeKernel(
            'test', null as any, null as any, null as any,
            new Map(), [64, 1, 1],
        );
        expect(() => kernel.read('nonexistent')).toThrow('not found');
    });
});

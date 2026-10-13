import { test, expect, describe } from 'bun:test';
import { compileProgram, d, std, GpuShader, GpuBindGroupLayout } from './index';

describe('texture compute codegen', () => {
    test('depth load, storage store, atomic store and i32 vectors compile', () => {
        const layout = new GpuBindGroupLayout({
            depth: { depthTexture: true },
            hzb: { storageTexture: { format: 'rgba16float' } },
            slots: { storage: d.arrayOf(d.u32, 64), readwrite: true },
            counter: { storage: d.arrayOf(d.atomic(d.u32), 4), readwrite: true },
        });

        const shader = GpuShader.compute(
            {
                in: { globalId: d.builtin.globalInvocationId },
                workgroup: [8, 8, 1],
                bindings: { res: layout },
            },
            ({ globalId }, { res }: any) => {
                const coord = d.vec2i(d.i32(globalId.x), d.i32(globalId.y));
                const z = std.textureLoad(res.depth, coord, d.i32(0));
                std.textureStore(res.hzb, coord, d.vec4f(z, 0, 0, 1));
                const i = globalId.x;
                if (i >= d.u32(64)) { return; }
                res.slots[i] = i;
                std.atomicStore(res.counter[0], d.u32(1));
            },
        );

        const { code } = compileProgram([shader]);
        expect(code).toContain('var binding_0_0: texture_depth_2d;');
        expect(code).toContain('texture_storage_2d<rgba16float, write>');
        expect(code).toContain('textureLoad(');
        expect(code).toContain('textureStore(');
        expect(code).toContain('atomicStore(&');
        expect(code).toContain('vec2<i32>');
    });
});

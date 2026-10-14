import { test, expect, describe } from 'bun:test';
import { GpuShader, compileProgram, d } from '../gpu';
import {
    BUILD_WORKGROUP,
    CULL_LAYOUT,
    DOWN_LAYOUT,
    FROM_DEPTH_LAYOUT,
    RESET_LAYOUT,
    WORKGROUP,
    cullBody,
    hzbDownBody,
    hzbFromDepthBody,
    resetBody,
} from './occlusion-kernels';

function compileKernel(body: unknown, layout: unknown, workgroup: readonly [number, number, number]): string {
    const shader = GpuShader.compute(
        {
            in: { globalId: d.builtin.globalInvocationId },
            workgroup,
            bindings: { res: layout as never },
        },
        body as never,
    );
    return compileProgram([shader]).code;
}

describe('occlusion kernels', () => {
    test('HZB from depth reads the depth texture and writes a storage texture', () => {
        const code = compileKernel(hzbFromDepthBody, FROM_DEPTH_LAYOUT, [BUILD_WORKGROUP, BUILD_WORKGROUP, 1]);
        expect(code).toContain('texture_depth_2d');
        expect(code).toContain('texture_storage_2d<r32float, write>');
        expect(code).toContain('textureLoad(');
        expect(code).toContain('textureStore(');
        expect(code).toContain('@workgroup_size(16, 16, 1)');
    });

    test('HZB down reads one storage mip and writes the next', () => {
        const code = compileKernel(hzbDownBody, DOWN_LAYOUT, [BUILD_WORKGROUP, BUILD_WORKGROUP, 1]);
        expect(code).toContain('texture_storage_2d<r32float, read>');
        expect(code).toContain('texture_storage_2d<r32float, write>');
    });

    test('reset stores indirect args through atomics', () => {
        const code = compileKernel(resetBody, RESET_LAYOUT, [WORKGROUP, 1, 1]);
        expect(code).toContain('array<atomic<u32>>');
        expect(code).toContain('atomicStore(&');
    });

    test('cull reads the pyramid, the projectiles buffers and compacts', () => {
        const code = compileKernel(cullBody, CULL_LAYOUT, [WORKGROUP, 1, 1]);
        expect(code).toContain('texture_2d<f32>');
        expect(code).toContain('textureLoad(');
        expect(code).toContain('atomicAdd(&');
        expect(code).toContain('viewProjection');
        expect(code).toContain('select(f32(');
        expect(code).toContain('loop {');
    });
});

import { describe, expect, test } from 'bun:test';
import {
    createMeshLayout,
    createPbrMaterialFragment,
    createPbrMaterialLayout,
} from 'murow/renderer/managers/runtime';
import { compileProgram } from './gpu';

describe('pbr material shader', () => {
    test('compiles with every PBR map bound', () => {
        const mesh = createMeshLayout(4, 1);
        const material = createPbrMaterialLayout();
        const fragment = createPbrMaterialFragment(mesh, material);
        const { code } = compileProgram([fragment]);

        expect(code).toContain('textureSample(');
        expect(code).toContain('hasMetallicRoughness');
        expect(code).toContain('smoothstep(');
        expect(code).toContain('@fragment');
        expect(code).toContain('texture_cube_array<f32>');
    });
});

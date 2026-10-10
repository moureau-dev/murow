import { test, expect, describe } from 'bun:test';
import { tgpu } from '../../../../shaders/typegpu';
import { createMeshLayout } from '../../../shader';
import {
    createEngineMaterialLayout,
    createStandardMaterialFragment,
    createUnlitMaterialFragment,
    createEmissiveMaterialFragment,
} from './built-in';

describe('engine material shaders lower through the gpu facade', () => {
    test('standard fragment resolves mesh and material layouts', () => {
        const meshLayout = createMeshLayout(4);
        const matLayout = createEngineMaterialLayout();
        const fragment = createStandardMaterialFragment(meshLayout, matLayout);
        const { code } = tgpu.resolveWithContext([fragment]);
        expect(code).toContain('@fragment');
        expect(code).toContain('fn fs_main(');
        expect(code).toContain('textureSample(');
        expect(code).toContain('fn lightContribution(');
        expect(code).toContain('fn tonemap(');
    });

    test('unlit and emissive fragments resolve the material layout', () => {
        const meshLayout = createMeshLayout(4);
        const matLayout = createEngineMaterialLayout();
        for (const fragment of [
            createUnlitMaterialFragment(meshLayout, matLayout),
            createEmissiveMaterialFragment(meshLayout, matLayout),
        ]) {
            const { code } = tgpu.resolveWithContext([fragment]);
            expect(code).toContain('fn fs_main(');
        }
    });
});

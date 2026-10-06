import { test, expect, describe } from 'bun:test';
import { tgpu } from '../../../shaders/typegpu';
import { createMeshLayout } from '../../shader';
import { createEngineMaterialLayout, createStandardMaterialFragment } from './built-in';

describe('standard fragment shadow receive', () => {
    test('resolves the PCF taps as f32 without implicit conversions', () => {
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        let code = '';
        try {
            const meshLayout = createMeshLayout(4);
            const matLayout = createEngineMaterialLayout();
            const fragment = createStandardMaterialFragment(meshLayout, matLayout);
            code = tgpu.resolveWithContext([fragment]).code;
        } finally {
            console.warn = originalWarn;
        }

        expect(warnings).toEqual([]);
        expect(code).toContain('let occ =');
        // Regression: integer selects made `occ` an i32 and forced `f32(occ)`.
        expect(code).not.toContain('f32(occ)');
        // Regression: select(false, true, cond). `occ` must count OCCLUDED taps.
        expect(code).not.toContain('select(one, zero, (sDepth');
    });
});

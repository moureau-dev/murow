import { test, expect, describe } from 'bun:test';
import { tgpu } from '../../../../shaders/typegpu';
import { createMeshLayout } from '../../../shader';
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
        expect(code).toContain('fn fs_main');

        // Regression: integer selects made the occluded-tap count an i32 and
        // forced an `f32(...)` conversion. The count must stay f32.
        const pcf = code
            .split('\n')
            .find((line) => (line.match(/select\(/g)?.length ?? 0) === 4 && line.includes('+'));
        expect(pcf).toBeDefined();
        expect(pcf!).toContain(': f32 =');

        // Regression: select(falseValue, trueValue, cond). The false branch must
        // be the zero literal and the true branch the one literal, so the count
        // tracks occluded taps.
        const branches = pcf!.match(/select\((\w+), (\w+),/);
        expect(branches).not.toBeNull();
        const literals: Record<string, string> = {};
        for (const line of code.split('\n')) {
            const match = line.match(/let (\w+): f32 = f32\(([\d.]+)\)/);
            if (match) literals[match[1]!] = match[2]!;
        }
        expect(literals[branches![1]!]).toBe('0');
        expect(literals[branches![2]!]).toBe('1');
    });
});

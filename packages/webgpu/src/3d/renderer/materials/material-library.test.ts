import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { build, type BuildOptions } from 'esbuild';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdnBundleOptions } from '../../../cdn-bundle-options';
import { attachShaderMetadata } from '../../../shaders/runtime-transpile';
import { d, std } from '../../../shaders/typegpu';

// =============================================================================
// Recovery unit tests: minified free variables and namespace disambiguation.
// =============================================================================

describe('material externals recovery', () => {
    test('disambiguates two layout namespaces that both expose `$`', () => {
        const meshLayout = { $: { uniforms: {}, lights: [] } };
        const matLayout = { $: { material: {}, map: {}, mapSampler: {} } };
        const fn = function () {};

        attachShaderMetadata(
            fn,
            () => ({ d, std, meshLayout, matLayout }),
            false,
            { d, std, meshLayout, matLayout },
            undefined,
            `function(input) { return d.vec4f(e.$.uniforms, t.$.material, 0.0, 1.0); }`,
        );

        const ext = (globalThis as any).__TYPEGPU_META__.get(fn).externals();
        expect(ext.e).toBe(meshLayout);
        expect(ext.t).toBe(matLayout);
    });

    test('recovers renamed externals from a block-bodied getter', () => {
        const meshLayout = { $: { uniforms: {}, lights: [] } };
        const matLayout = { $: { material: {}, map: {}, mapSampler: {} } };
        const LC = () => {};
        const TM = () => {};

        const getExternals = () => {
            const ext: Record<string, unknown> = {
                d,
                std,
                meshLayout,
                matLayout,
                lightContribution: LC,
                tonemap: TM,
            };
            return ext;
        };

        const fn = function () {};
        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);
        try {
            attachShaderMetadata(
                fn,
                getExternals,
                false,
                { d, std, meshLayout, matLayout },
                undefined,
                `function(input) { return d.vec4f(LC(t.$.material), TM(e.$.uniforms), 0.0, 1.0); }`,
            );
        } finally {
            console.warn = originalWarn;
        }

        const meta = (globalThis as any).__TYPEGPU_META__.get(fn);
        const ext = meta.externals();
        expect(warnings).toEqual([]);
        expect(meta.ast.externalNames.filter((n: string) => !(n in ext))).toEqual([]);
        expect(ext.LC).toBe(LC);
        expect(ext.TM).toBe(TM);
        expect(ext.e).toBe(meshLayout);
        expect(ext.t).toBe(matLayout);
    });
});

// =============================================================================
// The shipped artifact: build the real minified CDN bundle and run the engine
// material factories against it.
// =============================================================================

const ENTRY_DIR = new URL('.', import.meta.url).pathname;

const ENTRY = `
export {
    createStandardMaterialFragment,
    createUnlitMaterialFragment,
    createEmissiveMaterialFragment,
} from './built-in.ts';
`;

class CaptureMap extends WeakMap<object, unknown> {
    readonly captured: Array<{ fn: object; meta: any }> = [];
    set(key: object, value: unknown): this {
        this.captured.push({ fn: key, meta: value });
        return super.set(key, value);
    }
}

/** Run `run` with a fresh metadata map so the attachments it makes are visible. */
function capture(run: () => void): Array<{ fn: object; meta: any }> {
    const previous = (globalThis as any).__TYPEGPU_META__;
    const map = new CaptureMap();
    (globalThis as any).__TYPEGPU_META__ = map;
    try {
        run();
        return map.captured;
    } finally {
        (globalThis as any).__TYPEGPU_META__ = previous;
    }
}

/** Run `run`, collecting `console.warn` output. */
function collectWarnings(run: () => void): unknown[][] {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
        run();
    } finally {
        console.warn = originalWarn;
    }
    return warnings;
}

function assertHealthy(fragment: { fn: object; meta: any }, layouts: object[]) {
    const meta = fragment.meta;
    expect(meta).toBeDefined();
    const names: string[] = meta.ast.externalNames;
    const externals = meta.externals();
    expect(names.filter((name) => !(name in externals))).toEqual([]);
    for (const layout of layouts) {
        expect(names.map((name) => externals[name])).toContain(layout);
    }
}

describe('engine material shaders survive minification', () => {
    let materials: Record<string, (mesh: unknown, mat: unknown) => void> = {};
    const outfile = join(tmpdir(), `murow-materials-${process.pid}.mjs`);

    const meshLayout = { $: { uniforms: {}, lights: [], dynamicInstances: {}, staticInstances: {}, slotIndices: {} } };
    const matLayout = { $: { material: {}, map: {}, mapSampler: {} } };

    beforeAll(async () => {
        const { entryPoints: _entryPoints, ...options } = cdnBundleOptions;
        await build({
            ...options,
            stdin: { contents: ENTRY, resolveDir: ENTRY_DIR, loader: 'ts' },
            outfile,
            logLevel: 'silent',
        } as BuildOptions);
        materials = (await import(`${outfile}?v=${Date.now()}`)) as typeof materials;
    });

    afterAll(() => {
        rmSync(outfile, { force: true });
    });

    test('standard fragment resolves mesh and material layouts', () => {
        let captured: Array<{ fn: object; meta: any }> = [];
        const warnings = collectWarnings(() => {
            captured = capture(() => materials.createStandardMaterialFragment!(meshLayout, matLayout));
        });
        expect(warnings).toEqual([]);
        assertHealthy(captured[captured.length - 1]!, [meshLayout, matLayout]);
    });

    test('unlit and emissive fragments resolve the material layout', () => {
        for (const name of ['createUnlitMaterialFragment', 'createEmissiveMaterialFragment']) {
            let captured: Array<{ fn: object; meta: any }> = [];
            const warnings = collectWarnings(() => {
                captured = capture(() => materials[name]!(meshLayout, matLayout));
            });
            expect(warnings).toEqual([]);
            assertHealthy(captured[captured.length - 1]!, [matLayout]);
        }
    });
});

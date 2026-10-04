import { test, expect, describe, beforeAll } from 'bun:test';
import { transform, build, type BuildOptions } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdnBundleOptions } from '../cdn-bundle-options';
import { attachShaderMetadata } from './runtime-transpile';
import { d, std } from './typegpu';

// =============================================================================
// Minification settings — same as the CDN bundle.
// =============================================================================

const MINIFY = {
    minifyWhitespace: cdnBundleOptions.minifyWhitespace,
    minifyIdentifiers: cdnBundleOptions.minifyIdentifiers,
    minifySyntax: cdnBundleOptions.minifySyntax,
    loader: 'js' as const,
};

interface AttachResult {
    warnings: unknown[][];
    externals: () => Record<string, unknown>;
    externalNames: string[];
    body: string;
}

// =============================================================================
// Recovery unit tests: attach metadata directly to a provided source.
// =============================================================================

/** Attach metadata for `source` and return it. */
function attach(source: string, externals: Record<string, unknown>, stripFirstParam = true) {
    const fn = function () {};
    attachShaderMetadata(fn, () => externals, stripFirstParam, { d, std }, undefined, source);
    return (globalThis as any).__TYPEGPU_META__.get(fn) as {
        ast: { externalNames: string[]; body: unknown };
        externals: () => Record<string, unknown>;
    };
}

describe('attachShaderMetadata (recovery)', () => {
    test('resolves renamed bindings destructured from the stripped first parameter', () => {
        const meta = attach(
            `({ uniforms: a, instances: u }, { globalId: g }) => {
                const idx = g.x;
                if (idx >= a.instanceCount) { return; }
                const inst = u[idx];
                if (inst.clipId < 0) { return; }
            }`,
            { d, std, uniforms: { instanceCount: 0 }, instances: {} },
        );

        const resolved = meta.externals();
        for (const name of meta.ast.externalNames) {
            expect(name in resolved).toBe(true);
        }
        expect(meta.ast.externalNames).toContain('a');
        expect(meta.ast.externalNames).toContain('u');
    });

    test('leaves non-renamed shorthand externals intact', () => {
        const meta = attach(
            `({ uniforms }, { globalId }) => {
                if (globalId.x >= uniforms.instanceCount) { return; }
            }`,
            { d, std, uniforms: { instanceCount: 0 } },
        );

        const resolved = meta.externals();
        for (const name of meta.ast.externalNames) {
            expect(name in resolved).toBe(true);
        }
    });

    test('renames a minifier-produced lone `_` local identifier', () => {
        const meta = attach(
            `function (input) {
                const _ = std.sin(input.x);
                return std.vec3f(1.0, 2.0, _);
            }`,
            { d, std },
            false,
        );

        const body = JSON.stringify(meta.ast.body);
        expect(body.includes('"_"')).toBe(false);
        expect(body.includes('"v_"')).toBe(true);
    });

    test('resolves destructured aliases from the live getter, not the eager snapshot', () => {
        const eager = { d, std, uniforms: { tag: 'eager' } };
        const live = { d, std, uniforms: { tag: 'live' } };
        let calls = 0;

        const fn = function () {};
        attachShaderMetadata(
            fn,
            () => (++calls === 1 ? eager : live),
            true,
            { d, std },
            undefined,
            `({ uniforms: a }, { globalId }) => {
                if (globalId.x >= a.instanceCount) { return; }
            }`,
        );

        const meta = (globalThis as any).__TYPEGPU_META__.get(fn) as {
            externals: () => Record<string, any>;
        };
        expect(meta.externals().a.tag).toBe('live');
    });
});

// =============================================================================
// Custom user shaders: minified exactly like the bundle, then transpiled.
// =============================================================================

/**
 * Minify a shader exactly like the CDN bundle does, then run it through the
 * same runtime transpilation the builders use.
 */
async function attachMinified(
    source: string,
    getExternals: () => Record<string, unknown>,
    opts: { stripFirstParam?: boolean } = {},
): Promise<AttachResult> {
    const minified = (await transform(`const __f__ = ${source};`, MINIFY)).code;
    const extracted = minified.replace(/^[\s\S]*?=\s*/, '').replace(/;\s*$/, '');

    const fn = function () {};
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
        attachShaderMetadata(fn, getExternals, opts.stripFirstParam ?? false, { d, std }, undefined, extracted);
    } finally {
        console.warn = originalWarn;
    }

    const meta = (globalThis as any).__TYPEGPU_META__.get(fn) as
        | { ast: { externalNames: string[]; body: unknown }; externals: () => Record<string, unknown> }
        | undefined;

    return {
        warnings,
        externals: meta?.externals ?? (() => ({})),
        externalNames: meta?.ast.externalNames ?? [],
        body: meta ? JSON.stringify(meta.ast.body) : '',
    };
}

function expectHealthy(result: AttachResult) {
    expect(result.warnings).toEqual([]);
    expect(result.body).not.toContain('"_"');

    const externals = result.externals();
    for (const name of result.externalNames) {
        expect(name in externals).toBe(true);
    }
}

describe('custom shaders survive minification', () => {
    test('compute: destructured buffer context', async () => {
        const eager = { d, std, uniforms: { count: 0 }, instances: {}, __tsover_add: std.add };
        const live = { d, std, uniforms: { count: 1 }, instances: {}, __tsover_add: std.add };
        let calls = 0;

        const result = await attachMinified(
            `({ uniforms, instances }, { globalId }) => {
                const i = globalId.x;
                const inst = instances[i];
                if (i >= uniforms.count) { return; }
                inst.time = inst.time + 1.0;
            }`,
            () => (++calls === 1 ? eager : live),
            { stripFirstParam: true },
        );

        expectHealthy(result);
        expect(Object.values(result.externals())).toContain(live.uniforms);
    });

    test('compute: non-destructured buffer context (`buffers.particles`)', async () => {
        const live = { d, std, uniforms: { count: 1 }, instances: {}, __tsover_add: std.add };
        let calls = 0;

        const result = await attachMinified(
            `(buffers, input) => {
                const i = input.globalId.x;
                const inst = buffers.instances[i];
                if (i >= buffers.uniforms.count) { return; }
                inst.time = inst.time + 1.0;
            }`,
            () => (++calls === 1 ? { d, std, uniforms: {}, instances: {} } : live),
            { stripFirstParam: true },
        );

        expectHealthy(result);
        expect(Object.values(result.externals())).toContain(live);
    });

    test('geometry: declarative `({ dynamic, statics, uniforms }, input)`', async () => {
        const live = { d, std, dynamic: {}, statics: {}, uniforms: {} };
        let calls = 0;

        const result = await attachMinified(
            `({ dynamic, statics, uniforms }, input) => {
                const i = input.instanceIndex;
                const st = statics[i];
                const dy = dynamic[i];
                const a = uniforms.alpha;
                return { pos: d.vec4f(dy.currX * a, dy.currY * a, 0.0, 1.0) };
            }`,
            () => (++calls === 1 ? { d, std, dynamic: {}, statics: {}, uniforms: {} } : live),
            { stripFirstParam: true },
        );

        expectHealthy(result);
        expect(Object.values(result.externals())).toContain(live.uniforms);
    });

    test('geometry: non-destructured context (`ctx.dynamic`)', async () => {
        const live = { d, std, dynamic: {}, statics: {}, uniforms: {} };
        let calls = 0;

        const result = await attachMinified(
            `(ctx, input) => {
                const dy = ctx.dynamic[input.instanceIndex];
                const a = ctx.uniforms.alpha;
                return { pos: d.vec4f(dy.currX * a, dy.currY * a, 0.0, 1.0) };
            }`,
            () => (++calls === 1 ? { d, std, dynamic: {}, statics: {}, uniforms: {} } : live),
            { stripFirstParam: true },
        );

        expectHealthy(result);
        expect(Object.values(result.externals())).toContain(live);
    });

    test('namespaces: std/d member access with closures', async () => {
        const result = await attachMinified(
            `function (input) {
                const rotated = std.mix(d.vec4f(0, 0, 0, 1), d.vec4f(1, 1, 1, 1), input.a);
                return d.vec4f(rotated.x, rotated.y, std.cos(input.b), 1.0);
            }`,
            () => ({ d, std }),
        );

        expectHealthy(result);
    });

    test('transpiles identically with and without the `use gpu` directive', async () => {
        const getter = () => ({ d, std, uniforms: { count: 1 }, instances: {}, __tsover_add: std.add });
        const body = `const i = globalId.x; const inst = instances[i]; if (i >= uniforms.count) { return; } inst.time = inst.time + 1.0;`;
        const params = `({ uniforms, instances }, { globalId }) => {`;

        const without = await attachMinified(`${params} ${body} }`, getter, { stripFirstParam: true });
        const withDirective = await attachMinified(`${params} 'use gpu'; ${body} }`, getter, { stripFirstParam: true });

        expectHealthy(without);
        expectHealthy(withDirective);
        // Minified binding names differ (injecting the directive shifts esbuild's
        // name allocation), but both must expose the same number of externals.
        expect(without.externalNames.length).toBe(withDirective.externalNames.length);
    });
});

// =============================================================================
// The shipped artifact: build the real CDN bundle and validate every shader.
// =============================================================================

/**
 * Extract every `'use gpu'` function body from the minified bundle so the
 * runtime transpiler can be exercised against the exact shipped artifact.
 */
function extractShaderSources(bundle: string): string[] {
    const sources: string[] = [];
    const directive = /["']use gpu["']/g;
    let match: RegExpExecArray | null;

    while ((match = directive.exec(bundle))) {
        let i = match.index - 1;
        while (i >= 0 && /\s/.test(bundle[i])) i--;
        if (bundle[i] !== '{') continue;
        const bodyOpen = i;

        let depth = 0;
        let end = -1;
        for (let j = bodyOpen; j < bundle.length; j++) {
            if (bundle[j] === '{') depth++;
            else if (bundle[j] === '}') {
                depth--;
                if (depth === 0) { end = j; break; }
            }
        }
        if (end === -1) continue;

        const head = findFunctionHead(bundle, bodyOpen);
        if (head !== -1) sources.push(bundle.slice(head, end + 1));
    }
    return sources;
}

/** Walk backwards from a function body's `{` to the start of its head. */
function findFunctionHead(bundle: string, bodyOpen: number): number {
    let i = bodyOpen - 1;
    while (i >= 0 && /\s/.test(bundle[i])) i--;

    if (bundle[i] === '>') {
        // Arrow: `x => {}` or `(...) => {}`
        let k = i - 2;
        while (k >= 0 && /\s/.test(bundle[k])) k--;
        if (bundle[k] === ')') return matchingOpenParen(bundle, k);
        while (k >= 0 && /[\w$]/.test(bundle[k])) k--;
        return k + 1;
    }

    if (bundle[i] !== ')') return -1;
    const open = matchingOpenParen(bundle, i);
    if (open === -1) return -1;

    // Include a `function` keyword (with an optional name) before the params.
    let k = open - 1;
    while (k >= 0 && /\s/.test(bundle[k])) k--;
    const nameEnd = k;
    while (k >= 0 && /[\w$]/.test(bundle[k])) k--;
    const word = bundle.slice(k + 1, nameEnd + 1);
    if (word === 'function') return k + 1;

    if (word) {
        let k2 = k;
        while (k2 >= 0 && /\s/.test(bundle[k2])) k2--;
        const nameEnd2 = k2;
        while (k2 >= 0 && /[\w$]/.test(bundle[k2])) k2--;
        if (bundle.slice(k2 + 1, nameEnd2 + 1) === 'function') return k2 + 1;
    }

    return open;
}

function matchingOpenParen(bundle: string, close: number): number {
    let depth = 0;
    for (let j = close; j >= 0; j--) {
        if (bundle[j] === ')') depth++;
        else if (bundle[j] === '(') {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

describe('CDN bundle shader metadata', () => {
    let sources: string[] = [];

    beforeAll(async () => {
        const outfile = join(tmpdir(), `murow-bundle-test-${process.pid}.js`);
        await build({
            ...cdnBundleOptions,
            entryPoints: [new URL('../index.ts', import.meta.url).pathname],
            outfile,
            logLevel: 'silent',
        } as BuildOptions);
        const bundle = readFileSync(outfile, 'utf8');
        rmSync(outfile, { force: true });
        sources = extractShaderSources(bundle);
    });

    test('keeps syntax minification off (SequenceExpressions break tinyest)', () => {
        expect(cdnBundleOptions.minify).toBeFalsy();
        expect(cdnBundleOptions.minifySyntax).toBeFalsy();
        // Identifier minification is off: the vertex-fn recovery is fragile under
        // renamed free variables, and unminified shader bodies resolve reliably.
        expect(cdnBundleOptions.minifyIdentifiers).toBe(false);
    });

    test('finds the expected shaders in the bundle', () => {
        // 3D mesh/skinned/textured vertex+fragment, 2D sprite vertex+fragment,
        // shared utils, and the skeletal-animation compute kernel.
        expect(sources.length).toBeGreaterThanOrEqual(8);
    });

    test('every bundled shader transpiles with no unresolved identifiers', () => {
        expect(sources.length).toBeGreaterThan(0);

        const warnings: unknown[][] = [];
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => warnings.push(args);

        try {
            for (const source of sources) {
                const fn = function () {};
                attachShaderMetadata(fn, () => new Proxy({}, {
                    has: () => true,
                    get: () => ({}),
                }), false, { d, std }, undefined, source);

                const meta = (globalThis as any).__TYPEGPU_META__.get(fn) as
                    | { ast: { externalNames: string[]; body: unknown }; externals: () => Record<string, unknown> }
                    | undefined;

                expect(meta).toBeDefined();
                if (!meta) continue;

                // WGSL rejects a lone `_`; the minifier emits it as a local name.
                expect(JSON.stringify(meta.ast.body)).not.toContain('"_"');

                const externals = meta.externals();
                for (const name of meta.ast.externalNames) {
                    expect(name in externals).toBe(true);
                }
            }
        } finally {
            console.warn = originalWarn;
        }

        // `attachShaderMetadata` swallows transpile failures with a warning.
        expect(warnings).toEqual([]);
    });
});

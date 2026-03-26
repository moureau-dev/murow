/**
 * Runtime shader transpilation — eliminates the need for `unplugin-typegpu`
 * and `'use gpu'` directives in geometry builder shaders.
 *
 * Parses the user's function source at runtime using Acorn, transpiles it
 * with tinyest-for-wgsl, and attaches metadata to the function so TypeGPU
 * can generate WGSL from it.
 *
 * This only works in browser environments where Function.toString() returns
 * the original source (not optimized by the runtime like Bun does).
 */
import * as acorn from 'acorn';
import { transpileFn } from 'tinyest-for-wgsl';
import { FORMAT_VERSION } from 'tinyest';

declare const globalThis: {
    __TYPEGPU_META__?: WeakMap<Function, unknown>;
};

/**
 * Attach TypeGPU shader metadata to a function at runtime.
 * After this call, the function can be passed to `tgpu.vertexFn()`/`tgpu.fragmentFn()`
 * without needing the `'use gpu'` directive or `unplugin-typegpu`.
 *
 * @param fn The shader function to attach metadata to
 * @param getExternals Lazy function that returns the external variable bindings.
 *                     Called during pipeline resolution (inside GPU context),
 *                     so `layout.$` access is valid.
 */
/**
 * Attach TypeGPU shader metadata to a function at runtime.
 *
 * @param fn The shader function
 * @param getExternals Lazy function returning external variable bindings
 * @param stripFirstParam If true, removes the first parameter (ctx) and treats
 *                        its destructured names as externals instead
 */
export function attachShaderMetadata(
    fn: Function,
    getExternals: () => Record<string, unknown>,
    stripFirstParam = false,
): void {
    let source = fn.toString();

    // Handle method shorthand: `name(...) { }` → `function(...) { }`
    if (!source.startsWith('function') && !source.startsWith('(') && !source.startsWith('async')) {
        const parenIndex = source.indexOf('(');
        if (parenIndex !== -1) {
            source = 'function' + source.slice(parenIndex);
        }
    }

    if (stripFirstParam) {
        // Remove the first parameter from the source.
        // `function({ dynamic, statics, uniforms }, input) { ... }`
        // → `function(input) { ... }`
        // Find the first '(' and the matching comma after the first param
        const openParen = source.indexOf('(');
        if (openParen !== -1) {
            let depth = 0;
            let commaPos = -1;
            for (let i = openParen + 1; i < source.length; i++) {
                const ch = source[i];
                if (ch === '{' || ch === '(') depth++;
                else if (ch === '}' || ch === ')') depth--;
                else if (ch === ',' && depth === 0) {
                    commaPos = i;
                    break;
                }
            }
            if (commaPos !== -1) {
                // Remove everything from after '(' to after ','
                source = source.slice(0, openParen + 1) + source.slice(commaPos + 1);
            }
        }
    }

    // Parse the function source into an AST
    const wrappedSource = `const __f__ = ${source}`;
    const ast = acorn.parse(wrappedSource, {
        ecmaVersion: 2022,
        sourceType: 'module',
    }) as { body: Array<{ declarations: Array<{ init: acorn.Node }> }> };

    const fnNode = ast.body[0].declarations[0].init;
    const { params, body, externalNames } = transpileFn(fnNode);

    // Attach metadata via TypeGPU's global WeakMap
    globalThis.__TYPEGPU_META__ ??= new WeakMap();
    globalThis.__TYPEGPU_META__.set(fn, {
        v: FORMAT_VERSION,
        ast: { params, body, externalNames },
        externals: getExternals,
    });
}

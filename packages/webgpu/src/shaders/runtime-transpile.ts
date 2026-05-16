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
 *
 * @param fn The shader function
 * @param getExternals Lazy function returning external variable bindings.
 *                     Called during pipeline resolution. The returned record
 *                     is augmented with auto-detected namespace aliases (see
 *                     `namespaceAliases`) so bundler-renamed identifiers
 *                     (e.g. `d10` instead of `d`) still resolve.
 * @param stripFirstParam If true, removes the first parameter (ctx) and treats
 *                        its destructured names as externals instead
 * @param namespaceAliases Map of canonical namespace name → namespace object.
 *                         When a bundler renames `d` to `d10`, we detect it by
 *                         matching the member-access pattern in the function
 *                         source against the members of each candidate namespace,
 *                         and alias the renamed name to the right object.
 */
export function attachShaderMetadata(
    fn: Function,
    getExternals: () => Record<string, unknown>,
    stripFirstParam = false,
    namespaceAliases: Record<string, object> = {},
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

    // Walk the AST to collect member accesses per identifier: `id.member` → record `member` under `id`.
    // Used to disambiguate bundler-renamed namespace references (e.g. `d10.f32` is the data namespace).
    const memberAccesses = new Map<string, Set<string>>();
    const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as { type?: string; [k: string]: unknown };
        if (n.type === 'MemberExpression') {
            const obj = n.object as { type?: string; name?: string } | undefined;
            const prop = n.property as { type?: string; name?: string } | undefined;
            if (obj?.type === 'Identifier' && obj.name && prop?.type === 'Identifier' && prop.name && !n.computed) {
                let set = memberAccesses.get(obj.name);
                if (!set) { set = new Set(); memberAccesses.set(obj.name, set); }
                set.add(prop.name);
            }
        }
        for (const key of Object.keys(n)) {
            const v = n[key];
            if (Array.isArray(v)) for (const item of v) visit(item);
            else if (v && typeof v === 'object') visit(v);
        }
    };
    visit(fnNode);

    // For each discovered external name, if it's not already handled by the
    // caller's externals (we can't know that here without calling getExternals,
    // so we always emit a mapping when one fits), pick the namespace alias
    // whose object contains *every* member accessed via that name.
    const resolvedAliases: Record<string, object> = {};
    const candidateEntries = Object.entries(namespaceAliases);
    for (const name of externalNames) {
        const members = memberAccesses.get(name);
        if (!members || members.size === 0) continue;
        for (const [, ns] of candidateEntries) {
            let matches = true;
            for (const m of members) {
                if (!(m in (ns as Record<string, unknown>))) { matches = false; break; }
            }
            if (matches) {
                resolvedAliases[name] = ns;
                break;
            }
        }
    }

    // Wrap the caller's externals provider with the resolved aliases.
    const wrappedExternals = () => ({ ...resolvedAliases, ...getExternals() });

    // Attach metadata via TypeGPU's global WeakMap
    globalThis.__TYPEGPU_META__ ??= new WeakMap();
    globalThis.__TYPEGPU_META__.set(fn, {
        v: FORMAT_VERSION,
        ast: { params, body, externalNames },
        externals: wrappedExternals,
    });
}

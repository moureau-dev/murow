/**
 * Runtime shader transpilation — provides `unplugin-typegpu`-equivalent metadata
 * at runtime without a build step.
 *
 * Parses the function source at runtime using Acorn, transpiles it
 * with tinyest-for-wgsl, and attaches metadata to the function so TypeGPU
 * can generate WGSL from it. Works alongside `'use gpu'` directives (which
 * are stripped before transpilation) so the same functions also work when
 * the build plugin IS present.
 *
 * This only works in browser environments where Function.toString() returns
 * the original source (not optimized by the runtime like Bun does).
 */
import * as acorn from 'acorn';
import { transpileFn } from 'tinyest-for-wgsl';

/**
 * AST metadata format version.
 *
 * Each breaking change to the metadata structure requires a bump to this
 * number. It's used at runtime by `typegpu` to determine how to interpret
 * a function's AST. The build plugin (`unplugin-typegpu`) inlines this as
 * a literal; here we define it locally so runtime transpilation doesn't
 * depend on `tinyest` re-exporting this internal constant.
 */
const FORMAT_VERSION = 1;

declare const globalThis: {
    __TYPEGPU_META__?: WeakMap<Function, unknown>;
};

/**
 * Attach TypeGPU shader metadata to a function at runtime.
 *
 * @param fn The shader function
 * @param getExternals Lazy function returning external variable bindings.
 *                     Called during pipeline resolution (and once eagerly
 *                     during metadata attachment to detect bundler-renamed
 *                     identifiers). The returned record is augmented with
 *                     auto-detected namespace aliases (see `namespaceAliases`)
 *                     so bundler-renamed identifiers (e.g. `d10` instead of
 *                     `d`) still resolve.
 *
 * Note: In runtimes where Function.toString() returns optimized source
 * (Bun, Node with --optimize-for-size), the acorn/tinyest parsing may
 * fail. This is silently ignored — WebGPU isn't available in those
 * environments anyway, and the function still works for direct calls.
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

    // Strip `'use gpu'` directives — they are a signal for the build plugin
    // (`unplugin-typegpu`) and are not valid WGSL. Since the plugin can't parse
    // .ts files, we handle transpilation at runtime, and the directive must be
    // removed so tinyest doesn't include it in the WGSL body.
    source = source.replace(/['"]use gpu['"]\s*;?\s*/g, '');

    // Parse the function source into an AST.
    // If this fails (e.g. Bun's toString() returns optimized source), silently
    // skip — WebGPU isn't available in those environments anyway.
    let params: unknown, body: unknown, externalNames: string[];
    let fnNode: acorn.Node;
    try {
        const wrappedSource = `const __f__ = ${source}`;
        const ast = acorn.parse(wrappedSource, {
            ecmaVersion: 2022,
            sourceType: 'module',
        }) as { body: Array<{ declarations: Array<{ init: acorn.Node }> }> };
        fnNode = ast.body[0].declarations[0].init;
        ({ params, body, externalNames } = transpileFn(fnNode));
    } catch {
        return; // Can't parse — skip metadata attachment
    }

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

    // For each discovered external name, pick the namespace alias whose
    // object contains *every* member accessed via that name.
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

    // Resolve bare external names from namespace objects.
    // After tinyest transpilation, `d.vec4f(x)` and `std.mix(a,b)` become
    // `vec4f(x)` and `mix(a,b)` in the WGSL body, and `vec4f`/`mix` appear
    // in `externalNames`. We need to look these up in the namespace objects
    // and provide them as individual externals.
    // Also handles bundler-renamed names like `mul2` by stripping trailing digits.
    const resolvedMembers: Record<string, unknown> = {};
    for (const name of externalNames) {
        if (resolvedAliases[name]) continue;
        let found = false;
        for (const [, ns] of candidateEntries) {
            const nsRecord = ns as Record<string, unknown>;
            if (name in nsRecord) {
                resolvedMembers[name] = nsRecord[name];
                found = true;
                break;
            }
        }
        if (found) continue;
        // Bundler-renamed: try stripping trailing digits (mul2 → mul)
        const stripped = name.replace(/\d+$/, '');
        if (stripped !== name) {
            for (const [, ns] of candidateEntries) {
                const nsRecord = ns as Record<string, unknown>;
                if (stripped in nsRecord) {
                    resolvedMembers[name] = nsRecord[stripped];
                    break;
                }
            }
        }
    }

    // Also check against the caller's externals for bundler-renamed names.
    // When esbuild renames `lightContribution` to `lightContribution2` in the
    // bundled function body, tinyest's transpiled body references the renamed
    // identifier. We detect this by checking if stripping trailing digits
    // matches a key in the caller's externals.
    const baseExternals = getExternals();
    for (const name of externalNames) {
        if (resolvedAliases[name]) continue;
        if (resolvedMembers[name]) continue;
        const stripped = name.replace(/\d+$/, '');
        if (stripped !== name && stripped in baseExternals) {
            resolvedMembers[name] = baseExternals[stripped];
        }
    }

    // Wrap the caller's externals provider with resolved members,
    // resolved aliases, and the caller's own externals.
    const wrappedExternals = () => ({ ...resolvedMembers, ...resolvedAliases, ...getExternals() });

    // Attach metadata via TypeGPU's global WeakMap
    globalThis.__TYPEGPU_META__ ??= new WeakMap();
    globalThis.__TYPEGPU_META__.set(fn, {
        v: FORMAT_VERSION,
        ast: { params, body, externalNames },
        externals: wrappedExternals,
    });
}

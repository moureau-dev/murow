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
    /**
     * Known external variable names that survive minification.
     * When the function is bundled+minified, fn.toString() returns minified
     * code and tinyest extracts minified external names that don't match
     * the externals map keys. This array provides the ORIGINAL names that
     * TypeGPU needs to resolve against the externals map.
     */
    knownExternalNames?: string[],
    /**
     * Original function source as a string.
     * When provided, used instead of fn.toString() — this survives
     * minification since string literals are preserved as-is.
     * If omitted, falls back to fn.toString() (works for non-minified code).
     */
    sourceOverride?: string,
): void {
    // Lazily apply the GPUDevice shader patch on first call
    (globalThis as any).__murow_ensureShaderPatch?.();

    let source = sourceOverride ?? fn?.toString?.() ?? '';

    // Handle method shorthand: `name(...) { }` → `function(...) { }`.
    // Skip arrow functions (which may appear as `x => { … }` after minification
    // strips a single parameter's parentheses) — rewriting those corrupts them.
    const firstBrace = source.indexOf('{');
    const isArrow = firstBrace !== -1 && source.slice(0, firstBrace).includes('=>');
    if (!isArrow && !source.startsWith('function') && !source.startsWith('(') && !source.startsWith('async')) {
        const parenIndex = source.indexOf('(');
        if (parenIndex !== -1) {
            source = 'function' + source.slice(parenIndex);
        }
    }

    let strippedFirstParam = '';
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
                strippedFirstParam = source.slice(openParen + 1, commaPos);
                // Remove everything from after '(' to after ','
                source = source.slice(0, openParen + 1) + source.slice(commaPos + 1);
            }
        }
    }

    // Strip `'use gpu'` directives.
    source = source.replace(/['"]use gpu['"]\s*;?\s*/g, '');

    // Rename single `_` identifiers — WGSL rejects them, but minifiers
    // produce `_` as a short variable name.
    source = source.replace(/(?<![\w$])_(?![\w$])/g, 'v_');

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

        // Split combined declarations: minifiers produce `let a=1,b=2,c=3`
        // but tinyest only supports one declaration per statement.
        //
        // Minifiers also merge property reads into object destructuring
        // (`const { lightCount: n, alpha: a } = u`), which tinyest has no
        // transpiler for. Expand each binding back into a member access so the
        // statement stays inside the supported subset.
        const splitDecls = (stmts: acorn.Node[]): void => {
            for (let i = stmts.length - 1; i >= 0; i--) {
                const s = stmts[i] as acorn.VariableDeclaration;
                if (s.type === 'VariableDeclaration' &&
                    Array.isArray(s.declarations)) {
                    s.kind = 'const';

                    const single = (decl: acorn.VariableDeclarator): acorn.VariableDeclaration => ({
                        type: 'VariableDeclaration',
                        start: decl.start,
                        end: decl.end,
                        kind: 'const',
                        declarations: [decl],
                    } as unknown as acorn.VariableDeclaration);

                    const expanded: acorn.VariableDeclaration[] = [];
                    for (const d of s.declarations) {
                        const id = d.id as unknown as acorn.Pattern & { type?: string; properties?: unknown[] };
                        const props = id.type === 'ObjectPattern' ? (id.properties ?? []) : null;
                        // Only expand plain `{ key: binding }` patterns. Anything
                        // else is left untouched so it fails closed in tinyest
                        // instead of silently dropping a binding.
                        const simple = props !== null && props.length > 0 && props.every((prop) => {
                            const p = prop as { type?: string; computed?: boolean; key?: { type?: string }; value?: { type?: string } };
                            return p.type === 'Property' && !p.computed && p.key?.type === 'Identifier' && p.value?.type === 'Identifier';
                        });
                        if (simple && d.init) {
                            for (const prop of props as Array<{ key: { type?: string; name?: string }; value: { type?: string; name?: string } }>) {
                                expanded.push(single({
                                    type: 'VariableDeclarator',
                                    start: d.start,
                                    end: d.end,
                                    id: prop.value,
                                    init: {
                                        type: 'MemberExpression',
                                        start: d.start,
                                        end: d.end,
                                        object: d.init,
                                        property: prop.key,
                                        computed: false,
                                        optional: false,
                                    },
                                } as unknown as acorn.VariableDeclarator));
                            }
                        } else {
                            expanded.push(single(d));
                        }
                    }

                    stmts.splice(i, 1, ...expanded);
                }
                // Recurse into nested blocks
                const blk = (s as unknown as acorn.Class).body;
                if (blk && typeof blk === 'object') {
                    const arr = blk.body as acorn.Node[];
                    if (Array.isArray(arr)) splitDecls(arr as acorn.VariableDeclaration[]);
                }

                const cons = (s as unknown as acorn.ConditionalExpression).consequent;
                if (cons && typeof cons === 'object' && 'body' in cons) {
                    const arr = cons.body;
                    if (Array.isArray(arr)) splitDecls(arr as acorn.VariableDeclaration[]);
                }

                const alt = (s as unknown as acorn.IfStatement).alternate;
                if (alt && typeof alt === 'object') {
                    // `else { … }` has a `body`; `else if (…) { … }` is a nested
                    // IfStatement — recurse into either.
                    const arr = (alt as unknown as { body?: unknown }).body;
                    if (Array.isArray(arr)) splitDecls(arr as acorn.VariableDeclaration[]);
                    else splitDecls([alt as unknown as acorn.VariableDeclaration]);
                }
            }
        };

        splitDecls((fnNode as unknown as any).body.body);

        // Use temporary variable instead of destructuring assignment.
        // minifiers strip the required parentheses around ({...}=...)
        // in comma expressions, producing invalid `{params:s}=value`.
        const result = transpileFn(fnNode);
        params = result.params;
        body = result.body;
        externalNames = result.externalNames;
    } catch (e) {
        // Parsing failed — skip metadata attachment.
        if (typeof console !== 'undefined') {
            console.warn('[murow] attachShaderMetadata: could not parse function, metadata skipped', e);
        }
        return;
    }

    // Walk the AST to collect member-access paths per identifier:
    // `meshLayout.$.uniforms` records `['$', 'uniforms']` under `meshLayout`.
    // Full paths (not just the first member) disambiguate several layout
    // namespaces that all expose a `$` accessor, e.g. `meshLayout` vs
    // `matLayout` in a material shader.
    const memberPaths: Record<string, string[][]> = {};
    const visit = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        const n = node as { type?: string; [k: string]: unknown };
        if (n.type === 'MemberExpression' && !n.computed) {
            const prop = n.property as { type?: string; name?: string } | undefined;
            if (prop?.type === 'Identifier' && prop.name) {
                const path: string[] = [prop.name];
                let obj = n.object as { type?: string; name?: string; computed?: boolean; object?: unknown; property?: { type?: string; name?: string } } | undefined;
                while (obj?.type === 'MemberExpression' && !obj.computed &&
                    obj.property?.type === 'Identifier' && obj.property.name) {
                    path.unshift(obj.property.name);
                    obj = obj.object as typeof obj;
                }
                // Two segments (`$` plus the first entry) are enough to tell
                // layout namespaces apart. Going deeper would require reading
                // buffer values, which TypeGPU forbids outside codegen.
                if (path.length > 2) path.length = 2;
                if (obj?.type === 'Identifier' && obj.name) {
                    (memberPaths[obj.name] ??= []).push(path);
                }
            }
        }
        for (const key of Object.keys(n)) {
            const v = n[key];
            if (Array.isArray(v)) for (const item of v) visit(item);
            else if (v && typeof v === 'object') visit(v);
        }
    };
    visit(fnNode);

    // Use known external names when provided (survives minification).
    // Otherwise use tinyest's extracted names (works for non-minified code).
    const effectiveExternalNames = knownExternalNames ?? externalNames;

    // Traverse a member path (e.g. `['$', 'uniforms']`) through a namespace
    // object. TypeGPU layout objects expose their entries through the `$`
    // accessor, which supports `in` and property reads.
    const pathExists = (ns: unknown, path: string[]): boolean => {
        let cur: any = ns;
        for (let i = 0; i < path.length; i++) {
            if (cur === null || (typeof cur !== 'object' && typeof cur !== 'function')) return false;
            if (!(path[i]! in cur)) return false;
            // Do not read the final segment: layout entry values throw outside
            // codegen. `in` is enough to prove the path exists.
            if (i < path.length - 1) cur = cur[path[i]!];
        }
        return true;
    };

    // For each discovered external name, pick the namespace alias whose
    // object contains *every* member path accessed via that name.
    const resolvedAliases: Record<string, object> = {};
    const candidateEntries = Object.entries(namespaceAliases);
    for (const name of effectiveExternalNames) {
        const paths = memberPaths[name];
        if (!paths || paths.length === 0) continue;
        for (const [, ns] of candidateEntries) {
            if (paths.every((p) => pathExists(ns, p))) {
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
    /** Minified binding name → the externals key it destructures. */
    const destructuredAliases: Record<string, string> = {};
    for (const name of effectiveExternalNames) {
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

    // Call the externals getter eagerly to detect bundler-renamed names.
    const baseExternals = getExternals();

    // Recover externals destructured out of the stripped first parameter.
    // Minifiers rewrite `{ uniforms }` to `{ uniforms: a }`, so map each
    // renamed binding back to the externals entry it destructures. The alias
    // resolves against the live getter (below), not this eager snapshot.
    if (strippedFirstParam) {
        for (const match of strippedFirstParam.matchAll(/([\w$]+)\s*:\s*([\w$]+)/g)) {
            const propName = match[1];
            const minifiedName = match[2];
            if (propName !== minifiedName && propName in baseExternals) {
                destructuredAliases[minifiedName] = propName;
            }
        }
    }

    // Check if unresolved external names correspond to minified variable
    // names in the externals getter. Minifiers rename `lightContribution` to
    // `zs` in the function body, but the externals map key is still
    // `lightContribution`. We detect this by parsing the getter's source to
    // find which variable names map to which keys.
    if (externalNames.some(n => !resolvedAliases[n] && !resolvedMembers[n] && !(n in baseExternals))) {
        try {
            const getterSrc = typeof getExternals === 'function' ? getExternals.toString() : '';
            // Collect every `{ canonicalKey: renamedBinding }` pair. This works
            // for object-literal arrows and for block-bodied getters that build
            // an externals object and return it.
            const getterAst = acorn.parse(`(${getterSrc})`, {
                ecmaVersion: 2022,
                sourceType: 'script',
            }) as acorn.Node;
            const collectPairs = (node: unknown): void => {
                if (!node || typeof node !== 'object') return;
                const n = node as { type?: string; properties?: unknown[]; [k: string]: unknown };
                if (n.type === 'ObjectExpression' && Array.isArray(n.properties)) {
                    for (const prop of n.properties as Array<{ type?: string; computed?: boolean; key?: { type?: string; name?: string }; value?: { type?: string; name?: string } }>) {
                        if (prop.type !== 'Property' || prop.computed) continue;
                        if (prop.key?.type !== 'Identifier' || prop.value?.type !== 'Identifier') continue;
                        const canonicalKey = prop.key.name!;
                        const minifiedVar = prop.value.name!;
                        if (canonicalKey in baseExternals &&
                            !(minifiedVar in baseExternals) &&
                            !resolvedAliases[minifiedVar] &&
                            !resolvedMembers[minifiedVar]) {
                            resolvedMembers[minifiedVar] = baseExternals[canonicalKey];
                        }
                    }
                }
                for (const key of Object.keys(n)) {
                    const v = n[key];
                    if (Array.isArray(v)) for (const item of v) collectPairs(item);
                    else if (v && typeof v === 'object') collectPairs(v);
                }
            };
            collectPairs(getterAst);
        } catch {
            // Ignore — getter source parsing is best-effort
        }
    }
    // When esbuild renames `lightContribution` to `lightContribution2` in the
    // bundled function body, tinyest's transpiled body references the renamed
    // identifier. We detect this by checking if stripping trailing digits
    // matches a key in the caller's externals.
    for (const name of effectiveExternalNames) {
        if (resolvedAliases[name]) continue;
        if (resolvedMembers[name]) continue;
        const stripped = name.replace(/\d+$/, '');
        if (stripped !== name && stripped in baseExternals) {
            resolvedMembers[name] = baseExternals[stripped];
        }
    }

    // A non-destructured first parameter (e.g. `(buffers, input)`) becomes a
    // free identifier after stripping. Expose the live externals under it so
    // member access like `buffers.particles` resolves.
    const trimmedFirstParam = strippedFirstParam.trim();
    const containerAlias = /^[A-Za-z_$][\w$]*$/.test(trimmedFirstParam) ? trimmedFirstParam : '';

    // Wrap the caller's externals provider with resolved members,
    // resolved aliases, and the caller's own externals. Destructured aliases
    // are resolved from the live getter so they pick up shader-context values
    // (e.g. typed layout accessors) rather than the eager snapshot.
    const wrappedExternals = () => {
        const live = getExternals();
        const externals: Record<string, unknown> = { ...resolvedMembers, ...resolvedAliases, ...live };
        for (const minifiedName of Object.keys(destructuredAliases)) {
            const propName = destructuredAliases[minifiedName];
            if (propName in live) externals[minifiedName] = live[propName];
        }
        if (containerAlias && !(containerAlias in externals)) {
            externals[containerAlias] = live;
        }
        return externals;
    };

    // Attach metadata via TypeGPU's global WeakMap
    globalThis.__TYPEGPU_META__ ??= new WeakMap();
    globalThis.__TYPEGPU_META__.set(fn, {
        v: FORMAT_VERSION,
        ast: { params, body, externalNames: effectiveExternalNames },
        externals: wrappedExternals,
    });
}

// Patch GPUDevice.createShaderModule lazily on first attachShaderMetadata call.
// Module-level check may run before GPUDevice is available.
(globalThis as any).__murow_ensureShaderPatch = () => {
    if ((globalThis as any).__murow_shaderPatched) return;
    (globalThis as any).__murow_shaderPatched = true;
    if (typeof GPUDevice !== 'undefined' && GPUDevice.prototype && GPUDevice.prototype.createShaderModule) {
        const origCreateShaderModule = GPUDevice.prototype.createShaderModule;
        GPUDevice.prototype.createShaderModule = function (desc: GPUShaderModuleDescriptor) {
            if (desc && typeof desc.code === 'string') {
                let code = desc.code;
                if (code.indexOf('$') !== -1) {
                    code = code.replace(/\$/g, 'zz');
                }
                if (code.indexOf('_') !== -1) {
                    code = code.replace(/(?<![\w$])_(?![\w$])/g, 'zz_');
                }
                // Replace `let ` with `var ` so mutable TGSL variables produce valid WGSL.
                // Skip `let` declarations that use `&` (references) — those require `let`.
                code = code.replace(/let (?![^;]*&)/g, 'var ');
                desc.code = code;
            }
            return origCreateShaderModule.call(this, desc);
        };
    }
};

// Ensure patch is applied at module load time too (in case GPUDevice IS available).
(globalThis as any).__murow_ensureShaderPatch();

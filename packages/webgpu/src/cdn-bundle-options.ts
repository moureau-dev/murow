import type { BuildOptions } from 'esbuild';

/**
 * Options for the self-contained browser bundle served by CDNs.
 *
 * `minifySyntax` is intentionally disabled: it folds consecutive statements
 * into SequenceExpressions and merges declarations, which keeps the shader
 * function source harder to reason about. `minifyIdentifiers` is disabled too:
 * the facade lowers shader bodies against the externals provider recorded by
 * `attachShaderMetadata`, so renamed free variables would resolve the same way,
 * but keeping names stable makes the emitted source easier to inspect.
 */
export const cdnBundleOptions: BuildOptions = {
    entryPoints: ['./src/index.ts'],
    outbase: 'src',
    format: 'esm',
    platform: 'browser',
    bundle: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
};

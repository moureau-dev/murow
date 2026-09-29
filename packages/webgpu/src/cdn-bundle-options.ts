import type { BuildOptions } from 'esbuild';

/**
 * Options for the self-contained browser bundle served by CDNs.
 *
 * `minifySyntax` is intentionally disabled: it folds consecutive statements
 * into SequenceExpressions and merges declarations, which tinyest-for-wgsl
 * cannot transpile at runtime.
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

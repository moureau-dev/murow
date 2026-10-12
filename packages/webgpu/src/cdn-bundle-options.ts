import type { BuildOptions } from 'esbuild';

/**
 * Options for the self-contained browser bundle served by CDNs.
 *
 * Fully minified. Shader bodies are read from source at link time, so the
 * parser tolerates minified input: it resolves renamed `d`/`std` namespaces by
 * their members, resolves destructured helpers by their preserved keys, and
 * lowers the short-circuit/sequence folds (`c && discard`) back to statements.
 */
export const cdnBundleOptions: BuildOptions = {
    entryPoints: ['./src/index.ts'],
    outbase: 'src',
    format: 'esm',
    platform: 'browser',
    bundle: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: false,
};

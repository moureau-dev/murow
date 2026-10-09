/**
 * Build-time shader compilation.
 *
 * The compile driver turns IR entries into backend source with a keyed artifact
 * registry, and the parser front-end lowers DSL function source to IR.
 */
export * from './transform';
export * from './parse';

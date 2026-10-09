/**
 * Code generation: IR to backend source.
 *
 * A shared lowering pipeline with public extension points. A backend supplies
 * capabilities, ordered passes, a target syntax, and emit hooks. The walker
 * itself is target-agnostic.
 */
export * from './syntax';
export * from './backend';
export * from './registry';
export * from './passes';
export * from './emit';

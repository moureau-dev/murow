/**
 * Code generation: IR to backend source.
 *
 * A shared lowering pipeline with public extension points. A backend supplies
 * capabilities, ordered passes, and emit hooks; the default hooks emit WGSL.
 */
export * from './backend';
export * from './registry';
export * from './passes';
export * from './emit';
export * from './glsl';

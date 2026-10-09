/**
 * The built-in shader environment.
 *
 * Struct schemas, standard bindings, and injectable WGSL helpers shared by the
 * engine's shaders. Consumed by the DSL externals (`murow/gpu/dsl`) and by
 * backends that inject the helper source.
 */
export * from './structs';
export * from './bindings';
export * from './helpers';

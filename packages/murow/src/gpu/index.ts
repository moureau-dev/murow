/**
 * `murow/gpu` - GPU-common layer shared by GPU renderer backends.
 *
 * Schemas, the shader/compute DSL and its IR, code generation, resource
 * descriptors, and the abstract device interface. Backend-agnostic across GPU
 * APIs. See README.md.
 */

export * from './types';
export * from './descriptors';
export * from './device';
export * from './runtime';

// Build-time only. Kept out of the runtime barrel so importing `murow/gpu`
// never pulls the parser; import `murow/gpu/compiler` from build tooling.

// These modules overlap on shared vocabulary names (for example `f32` is both a
// schema field and a type factory, and `binding` exists in both the IR builders
// and the bind-group descriptors). They are namespaced here to avoid ambiguous
// re-exports; import them directly for the unqualified names.
export * as schema from './schema';
export * as ir from './ir';
export * as dsl from './dsl';
export * as environment from './environment';
export * as codegen from './codegen';

/**
 * The GPU shader authoring DSL.
 *
 * Eager builders that produce the backend-agnostic IR. `ShaderValue` wraps an
 * `IrExpr`; `d` builds values; `std` builds builtins; `shader` builds entries.
 *
 * Pure. No backend, no device.
 */
export * from './value';
export * from './data';
export * from './std';
export * from './entry';
export * from './control';
export * from './externals';

/**
 * GPU data schema layer.
 *
 * Field descriptors, primitive fields, std140/std430 layout, structs with a
 * typed mirror, and array helpers. The GPU-aligned sibling of
 * `core/binary-codec`.
 */
export * from './field';
export * from './align';
export * from './primitives';
export * from './array';
export * from './struct';
export * from './infer';

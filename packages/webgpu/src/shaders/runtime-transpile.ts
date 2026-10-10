/**
 * Shader metadata attachment.
 *
 * The renderer used to parse shader function source at runtime with Acorn and
 * `tinyest-for-wgsl`. The `murow/gpu` facade now lowers shader bodies directly,
 * so this module just re-exports the facade's recorder. Engine shaders call it
 * with a lazy externals provider before wrapping the function.
 */
export { attachShaderMetadata } from '../gpu/tgpu';

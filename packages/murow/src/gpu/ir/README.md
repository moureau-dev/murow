# ir

The intermediate representation shaders compile to. Backend-agnostic: backends
emit WGSL or GLSL from the same IR.

- `types.ts` - GPU value types (f32, vec3, mat4, sampler, texture, ...).
- `nodes.ts` - typed nodes: literal, load, store, binop, call, construct,
  swizzle, sample, builtin, binding, if, loop, return.

Structured control flow only. Pure data, fully unit-testable.

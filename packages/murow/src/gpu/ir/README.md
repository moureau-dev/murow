# ir

The intermediate representation shaders compile to. Backend-agnostic: backends
emit WGSL or GLSL from the same IR.

- `types.ts` - GPU value types (f32, vec3, mat4, sampler, texture, ...).
- `nodes.ts` - typed nodes: literal, load, store, binop, call, construct,
  swizzle, sample, builtin, binding, if, loop, return. An entry may carry
  `outputs`, the fields of a vertex output struct (a builtin or a varying
  location).

Structured control flow only. Pure data, fully unit-testable.

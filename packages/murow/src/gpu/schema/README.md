# schema

GPU data schemas: field descriptors, alignment, struct layout, and the typed
uniform mirror. The GPU-aligned sibling of `core/binary-codec`.

- `field.ts` - `Field` descriptor: size, alignment, `write`/`read`/`toNil`.
- `primitives.ts` - `f32`, `i32`, `u32`, `vec2f`, `vec3f`, `vec4f`, `mat4x4f`, ...
- `struct.ts` - `gpuStruct`: offsets, size, typed mirror, WGSL/GLSL struct text.
- `array.ts` - fixed and runtime-sized arrays, arrays of structs.
- `align.ts` - std140 / std430 offset and alignment rules.
- `infer.ts` - `Infer<F>`: field to host value type (type-level only).

Data-oriented: schemas are parallel typed arrays and descriptors, never object
graphs. Registries are name-as-id; no `Map`.

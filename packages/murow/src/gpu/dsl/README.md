# dsl

The typed authoring surface for GPU programs. A shader is written once and
compiles to the IR; types erase at runtime.

- `value.ts` - DSL value types and operator overloads.
- `d.ts` - constructors (`f32`, `vec3f`, swizzles, ...).
- `std.ts` - builtins (`sin`, `normalize`, `mix`, `textureSample`, ...).
- `entry.ts` - the `shader` namespace (`vertex`, `fragment`; backends add
  `compute`).
- `control.ts` - structured control flow (`branch`, `loop`, `select`).
- `externals.ts` - the engine environment as IR producers (`scene`, `material`,
  `lights`, `textures`, `noise`, `snoise`, `lightContribution`, `tonemap`).

The lowercase `shader` namespace matches the lowercase `d`/`std` value
namespaces used inside shader bodies. See the parent README for the full
authoring example.

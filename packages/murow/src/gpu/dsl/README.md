# dsl

The vocabulary shader bodies are written in, and the eager entry builders.

- `value.ts` - `ShaderValue`, a wrapper over an IR expression.
- `data.ts` - `d`: constructors (`f32`, `vec3f`, ...), casts, `d.builtin`
  (`position`, `vertexIndex`, `fragCoord`, ...), and `d.location(n, type)`.
- `std.ts` - `std`: math, texture, and atomic builtins (`sin`, `normalize`,
  `mix`, `textureSample`, ...). It also spreads `d`.
- `shape.ts` - swizzle and component typing.
- `typed.ts` - `InputOf` and `BindingsOf`, which type `GpuShader` bodies.
- `entry.ts` - the eager `shader` object (`vertex`, `fragment`) and `compute`.
- `control.ts` - eager structured control flow (`branch`, `loop`, `select`).
- `externals.ts` - the engine environment as IR producers (`scene`,
  `material`, `lights`, `textures`, `noise`, `snoise`, `tonemap`).

The engine writes shaders with `GpuShader` and uses `d` and `std` inside the
bodies. The eager `shader` builders run the body as JavaScript and serve tests
and `murow/gpu/runtime`. See the parent README.

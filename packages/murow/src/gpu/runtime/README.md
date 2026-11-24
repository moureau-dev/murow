# runtime

`RuntimeCompiler` and `compileShader`: emit an `IrEntry` to target source with
a given `Backend`. Re-exports the eager DSL (`shader`, `d`, `std`, `branch`,
`loop`, `select`, `ShaderValue`) so an entry can be built and compiled from one
import.

It does not parse source. Engine shaders are `GpuShader`s, parsed when a
`GpuProgram` is linked (see the parent README). The `murow/gpu` barrel
re-exports this module.

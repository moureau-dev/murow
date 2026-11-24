# compiler

The source front-end and the compile drivers.

- `parse.ts` - `parseShaderBody`: a hand-written tokenizer, Pratt expression
  parser, and small statement parser that lower a shader body's source text to
  IR. It supports native operators (`a * b`), `if`/`else`, `for`/`while`/`do`,
  `break`, and `continue`. Calls on `std` resolve against the DSL builtin
  table; calls on `d` lower to constructors and casts. It also accepts the
  folds a syntax minifier produces.
- `transform.ts` - `transform` (run an eager builder and emit), `transformSource`
  (parse source text and emit), and `ShaderCompiler` (a keyed cache over both).

`GpuProgram.link` calls `parseShaderBody` on every `GpuShader` body, so the
parser is part of the `murow/gpu` runtime, not a build-time-only tool. Loops
desugar to a single `IrLoop` whose first statement breaks when the condition
fails and whose tail runs the update.

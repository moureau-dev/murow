# compiler

Build-time shader compilation. Two front-ends feed the IR, and one driver emits
it.

- `transform.ts` - `ShaderCompiler` (IR to source, keyed cache), `transform`
  (a DSL builder to a compiled artifact), and `transformSource` (source text to
  a compiled artifact).
- `parse.ts` - the parser front-end: a hand-written tokenizer, Pratt expression
  parser, and small statement parser that lower a DSL shader body to IR. It
  supports native `a * b`, `if`/`else`, `for`/`while`/`do` loops, `break`, and
  `continue`, and resolves calls on the `v`/`m`/`s` namespaces against the DSL
  `std` object. Calls on the `d` namespace lower to IR casts (`d.u32(x)`). Loops
  desugar to a single `IrLoop` whose first statement breaks when the condition
  fails and whose tail runs the update.

`transform` compiles an eager builder by running it (no parser). `transformSource`
parses the body source instead, for callers that only have the function as text
(a bundler plugin). The parser has no dependency, and this module is kept out of
the `murow/gpu` runtime barrel so the shipped runtime carries no parser. See the
parent README.

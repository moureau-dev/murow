# ir

The intermediate representation shaders compile to. Backends emit target source
from it.

- `types.ts` - GPU value types (`f32`, vectors, matrices, samplers, textures,
  arrays, structs).
- `nodes.ts` - node kinds and `IrEntry`. Expressions: `literal`, `local`,
  `builtin`, `binding`, `access`, `swizzle`, `unary`, `binary`, `call`, `cast`,
  `construct`, `sample`. Statements: `let`, `assign`, `if`, `loop`, `break`,
  `continue`, `return`, `discard`, `expr`. A vertex entry may carry `outputs`,
  the fields of its output struct (a builtin or a varying location).
- `builders.ts` - constructors for every node.

Structured control flow only. Pure data, unit-testable without a GPU.

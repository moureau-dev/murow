# codegen

Turns the IR into backend source. A shared, target-agnostic walker plus a
pluggable target syntax, with public extension points so a backend customises
behavior without forking.

- `syntax.ts` - `TargetSyntax`: every target-specific string the walker needs,
  plus the semantic `BindingKind` and `StorageAccess` types. Includes the vertex
  output struct hooks (`outputStructName`, `outputStructDecl`, `outputField`).
- `backend.ts` - `Backend` interface: capabilities, passes, emit hooks; and
  `BaseBackend`, which implements the walker once and routes all target text
  through `this.syntax`.
- `registry.ts` - node/intrinsic/builtin registries (name-as-id).
- `passes.ts` - ordered lowering pipeline (shared passes, then backend passes).
- `emit.ts` - `emitEntry`, the pass driver and binding collector.
- `test-syntax.ts` - test-only WGSL `TargetSyntax` and backend. Not shipped API;
  the production WGSL backend lives in `murow/webgpu`.

Extension points: node registry, intrinsic registry, ordered passes, and the
target syntax, gated by capability flags (`compute`, `storageBuffers`, `f16`,
`subgroups`).

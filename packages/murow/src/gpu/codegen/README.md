# codegen

Turns the IR into backend source. A shared pipeline with public extension points
so a backend customises behavior without forking.

- `backend.ts` - `Backend` interface: capabilities, passes, emit hooks.
- `registry.ts` - node/intrinsic/builtin registries (name-as-id).
- `passes.ts` - ordered lowering pipeline (shared passes, then backend passes).
- `emit.ts` - pass driver and default emitter.
- `glsl.ts` - `GlslBackend`, GLSL ES 3.0 output (vertex/fragment only).

Extension points: node registry, intrinsic registry, ordered passes, and emit
hooks (`mapBuiltin`, `entryPoint`, `declareBinding`, `preamble`), gated by
capability flags (`compute`, `storageBuffers`, `f16`, `subgroups`).

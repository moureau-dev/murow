# murow/gpu

The GPU-common layer. It holds the parts of a GPU renderer that do not depend on
one GPU API: shader data schemas, the shader DSL and its IR, the code generator
with its extension points, resource descriptors, typed resources, and the
backend-neutral device model.

`murow/webgpu` and the shared renderer in `murow/renderer/managers/runtime` are
built on it. Every engine shader (meshes, sprites, shadows, skybox, IBL,
particles, ribbons, camera effects, custom geometry) is a `GpuShader` compiled
through this layer. Exported as `murow/gpu` and `murow/gpu/*`.

## Where this sits

```
murow/renderer      contracts, asset pipeline, and the shared renderer runtime
murow/gpu           GPU-common: schemas, DSL, IR, codegen, resources, device model
murow/webgpu        WebGPU backend: WGSL syntax and spec, device, renderers
```

- `murow/renderer` defines what a renderer provides (managers, handles,
  materials, cameras). Its runtime under `renderer/managers/runtime` authors
  shaders with `GpuShader` and talks to the GPU through the `Raw*` device types
  in `device/render-api.ts`. It never imports a concrete GPU API; the platform
  package injects a `RendererRuntime`.
- `murow/gpu` (this module) is shared by every GPU backend. A renderer that
  brings its own GPU layer, such as a three.js or PixiJS adapter, does not use
  it.
- `murow/webgpu` supplies the WGSL `TargetSyntax`, the `wgslSpec` backend spec,
  `compileProgram`, the WebGPU device, and the renderer classes. A WebGL2
  backend does not exist yet; it would supply the same three pieces for GLSL.

## Principles

- **Data-oriented.** Schemas are `Field` descriptors and plain data. The typed
  uniform mirror is a `Proxy` over a `DataView`.
- **No `Map` in registries.** Node, intrinsic, and builtin registries are
  name-as-id: a dense array with a derived numeric index (`NameIdRegistry`).
- **Plain data at the boundary.** Schemas, descriptors, and the IR carry no
  device state, so any backend can consume them and tests run without a GPU.
- **Configured, not subclassed.** A backend is a `GpuBackendSpec`: a target
  syntax plus deltas over the shared intrinsics, nodes, passes, and helpers.
- **Typed authoring.** Shader inputs and bindings are typed from their schemas.

## Authoring shaders

A shader is a `GpuShader`: a stage, an input and output schema, named bind
group layouts, and a body. The body receives `(input, bindings)` positionally.
Resources are reached by property name, which survives minification.

```ts
import { GpuBindGroupLayout, GpuShader, GpuProgram, schema } from 'murow/gpu';
import { d, std } from 'murow/webgpu';

const Params = schema.gpuStruct({ name: 'Params', fields: { tint: schema.vec4f } });
const layout = new GpuBindGroupLayout({
    params: { uniform: Params },
    map: { texture: 'float' },
    mapSampler: { sampler: 'filtering' },
});

const vertex = GpuShader.vertex(
    {
        in: { position: d.location(0, d.vec3f), uv: d.location(1, d.vec2f) },
        out: { pos: d.builtin.position, vUV: d.vec2f },
    },
    (input) => {
        return { pos: d.vec4f(input.position, 1.0), vUV: input.uv };
    },
);

const fragment = GpuShader.fragment(
    { in: { vUV: d.vec2f }, out: d.vec4f, bindings: { mat: layout } },
    (input, { mat }) => {
        const tex = std.textureSample(mat.map, mat.mapSampler, input.vUV);
        return d.vec4f(tex.rgb * mat.params.tint.rgb, 1.0);
    },
);

const program = GpuProgram.link([vertex, fragment]);
```

- `GpuShader.vertex`, `.fragment`, and `.compute` take options first, body
  second. Options: `in`, `out`, `bindings`, `expose` (flat names mapped to
  `"layout.slot"` paths), `helpers` (functions the body may call, whose source
  the backend injects only when used), and `workgroup` (compute only).
- `GpuProgram.link(shaders)` numbers bind group layouts in first-use order and
  lowers each body to IR. `program.layouts` is the pipeline layout order.
- `GpuBindGroupLayout` is the single source of truth for both the emitted
  binding declarations and the pipeline layout. Declaration order is the
  binding number.

### How a body becomes IR

The body is not executed. `GpuProgram.link` reads it with
`Function.prototype.toString` and parses it (`compiler/parse.ts`): a
hand-written tokenizer, a Pratt expression parser, and a small statement
parser. That is why bodies can use native operators (`a * b`), `if`/`else`,
`for`/`while`/`do`, `break`, and `continue`. Calls on `std` resolve against the
DSL's builtin table, and calls on `d` lower to constructors and casts. The
parser also accepts the folds a syntax minifier produces.

Consequences:

- Parsing happens at runtime, when a program is linked. The parser ships in
  `murow/gpu`.
- A body may only reference its two parameters, `d`, `std`, and names listed in
  `helpers`. Closed-over JavaScript values are not visible to the parser.
- A vertex body returns its output record from a block body
  (`(input) => { return { ... }; }`). An arrow that returns a parenthesised
  object literal is rejected.
- Use `d.f32(0)` rather than `0.0` where the type matters. Bundlers print `0.0`
  as `0`, which the parser reads as an integer.

### Compiling

`murow/webgpu` compiles a program to WGSL with
`compileProgram(shaders)`, which links, emits through `wgslSpec`, and then
post-processes the source: `$` and lone `_` identifiers are renamed, and
mutable locals the emitter declares with `let` are rewritten to `var` by a
regular expression. `new GpuBackend(wgslSpec).compile(program)` and
`WgslBackend` emit without that post-processing.

`GpuContext` pairs a `GpuBackend` with a `GpuDevice` and creates typed
resources (`GpuBuffer`, `GpuBindGroupLayout`, `GpuBindGroup`).
`createWebGpuContext()` in `murow/webgpu` builds one over a WebGPU device. The
shared renderer does not use `GpuContext`; it receives compiled source and a
`RawDevice` through its injected runtime.

## Code generation

The IR is emitted by one target-agnostic walker (`BaseBackend`). Everything
target-specific is routed through a `TargetSyntax`.

Extension points:

- **Target syntax.** `TargetSyntax` owns every target string: type names,
  builtin decorations, parameter and binding declarations, entry signatures,
  casts, sampling, literals, struct declarations, the loop keyword, and the
  preamble prefix.
- **Node registry.** `NodeRegistry.register(kind, emit)` adds or replaces the
  emitter for an IR node kind.
- **Intrinsic registry.** `IntrinsicRegistry.override(name, emit)` replaces a
  shared intrinsic; `createDefaultIntrinsics()` returns the shared set. WGSL
  uses this to map `saturate` to `clamp` and to pass atomics a pointer.
- **Passes.** Ordered `LoweringPass[]`. Shared passes run first, then backend
  passes.
- **Helpers.** Named source snippets (noise, tone mapping, light shading)
  emitted once, only when a call to them appears.
- **Capability flags.** `{ compute, storageBuffers, f16, subgroups }`. Shared
  code emits, lowers, or fails with a clear error when a feature is off.

## The eager DSL

`dsl/entry.ts` also exports a `shader` object (`shader.vertex`,
`shader.fragment`) and a `compute` factory. These execute the body with
`ShaderValue` arguments and record IR as it runs:

```ts
import { shader, d, std } from 'murow/gpu/dsl';

const entry = shader.fragment(
    { params: { uv: d.vec2f }, material: { tint: d.vec4f } },
    (input, material, s) => s.mul(material.tint, s.f32(input.uv.x)),
);
```

This path is used by the codegen tests and `murow/gpu/runtime`. The engine does
not use it. Because the body runs as JavaScript, native operators on
`ShaderValue` produce `NaN`; use `std` calls. Prefer `GpuShader`.

`murow/gpu/compiler` exposes the same pieces for tooling: `transform` (run an
eager builder and emit), `transformSource` (parse source text and emit), and
`ShaderCompiler` (a keyed cache over both).

## Portability

Everything outside compute, storage buffers, atomics, `f16`, and subgroups is
portable at the IR level. Only a WGSL target exists today. A GLSL target would
need its own `TargetSyntax` (merging textures and samplers into `sampler2D`,
a `precision` preamble, `gl_*` builtins) and would turn `compute` and
`storageBuffers` off.

## Layout

```
gpu/
  types.ts        GpuType re-exports
  schema/         GPU data schemas
    field.ts        Field descriptor: size, align, write, read, toNil
    primitives.ts   f32, i32, u32, vec2f, vec3f, vec4f, mat4x4f, ...
    struct.ts       gpuStruct({ name, fields }): offsets, size, typed mirror, struct text
    array.ts        fixed and runtime-sized arrays, arrays of structs
    align.ts        std140 / std430 offset and alignment rules
    infer.ts        Infer<F>: field to host value type (type-level only)
  ir/             the intermediate representation
    types.ts        GPU value types (f32, vec3, mat4, sampler, texture, ...)
    nodes.ts        node kinds and IrEntry
    builders.ts     node constructors
  dsl/            authoring vocabulary
    value.ts        ShaderValue, a wrapper over an IR expression
    data.ts         d: constructors, casts, d.builtin, d.location
    std.ts          std: math, texture, and atomic builtins
    shape.ts        swizzle and component typing
    typed.ts        InputOf / BindingsOf, typing for GpuShader bodies
    entry.ts        eager shader.vertex / shader.fragment / compute
    control.ts      eager structured control flow (branch, loop, select)
    externals.ts    engine environment values (scene, material, lights, ...)
  shader/         the authoring surface used by the engine
    gpu-shader.ts   GpuShader.vertex / fragment / compute
    gpu-program.ts  GpuProgram.link: group numbering and parsing to IR
  compiler/       source front-end and compile drivers
    parse.ts        parseShaderBody: shader source to IR
    transform.ts    transform, transformSource, ShaderCompiler
  codegen/        IR to target source
    syntax.ts       TargetSyntax
    backend.ts      Backend interface, BaseBackend walker, capabilities
    registry.ts     NodeRegistry, IntrinsicRegistry (name-as-id)
    passes.ts       ordered lowering passes
    emit.ts         emitEntry, emitProgram, binding collection
    test-syntax.ts  test-only WGSL syntax (not shipped API)
  backend/        GpuBackend (spec-driven compiler), GpuContext (backend + device)
  resources/      GpuBuffer, GpuBindGroupLayout, GpuBindGroup
  descriptors/    vertex layout, bind group, render state, pipeline (plain data)
  device/         device contracts
    render-api.ts     Raw* types the shared renderer is written against
    gpu-device.ts     GpuDevice, the contract behind GpuContext
    recording-device.ts  in-memory GpuDevice for tests
  environment/    engine struct schemas and default binding slots
  runtime/        RuntimeCompiler over the eager DSL
```

The `murow/gpu` barrel exports the backend, resources, `GpuShader`,
`GpuProgram`, descriptors, the device types, and the runtime compiler at the
top level. `schema`, `ir`, `dsl`, `environment`, and `codegen` are exported as
namespaces because their names overlap (`f32` is both a schema field and an IR
type). Import `murow/gpu/<module>` for unqualified names.

## Known gaps

- The emitter declares mutable locals with `let`; only `compileProgram` repairs
  this, with a regular expression.
- A ternary lowers to `select` with the condition in the wrong argument, and
  `continue` inside a `for` or `do` loop skips the update or the guard.
- std140 array stride does not round to 16 bytes.
- No CI step validates emitted WGSL with a real compiler.

## Non-goals

- No renderer contracts (those stay in `murow/renderer`).
- No API-specific device code (that stays in the backend package).
- No scene graph and no object-oriented material model.

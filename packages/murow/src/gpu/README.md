# murow/gpu

GPU-common layer shared by GPU renderer backends (`murow/webgpu`, and later
`murow/webgl`). It owns the device-agnostic pieces: shader data schemas, the
shader/compute DSL and its IR, the code generator and its per-backend extension
points, resource descriptors, and the abstract device interface.

> Status: **first version implemented**. Schemas, IR, DSL, a target-agnostic
> codegen walker with a pluggable target syntax, descriptors, the abstract
> device and a recording device, the compile driver (`transform`), the parser
> front-end (`transformSource`), and the runtime front-end are in place with
> co-located tests. No backend has adopted this layer yet. Exported as
> `murow/gpu` and `murow/gpu/*`.

## Where this sits

`murow` separates three concerns:

- **`murow/renderer`**: backend-agnostic **contracts**. What a renderer must
  provide (renderer interfaces, asset pipeline, handles, materials, camera).
  Any backend implements these, including external ones such as a three.js or
  PixiJS backend. Nothing GPU or WGSL specific lives here.
- **`murow/gpu`** (this module): the **GPU-common** machinery shared across
  GPU APIs. Schemas, the DSL/IR, codegen, descriptors, and the device interface.
  A three.js or PixiJS backend does **not** use this; those bring their own GPU
  layer. `murow/webgpu` and `murow/webgl` do.
- **`murow/webgpu` / `murow/webgl`**: concrete backends. They implement the
  `murow/renderer` contracts, built on `murow/gpu` (WGSL backend, WebGPU device)
  plus their own API-specific code.

```
murow/renderer   contracts              (three, pixi, webgpu, webgl implement this)
murow/gpu        GPU-common             (used by webgpu, webgl)
murow/webgpu     WebGPU backend         (renderer + gpu + WebGPU specifics)
murow/webgl      WebGL backend          (later)
```

The shared shader is a `murow/gpu` concept. The `murow/renderer` contract only
states that a material references a shader; each backend resolves that however
it wants (the murow DSL for webgpu/webgl, a native material otherwise).

## Principles

- **Data-oriented, consistent with `murow/core`.** Schemas are parallel typed
  arrays and `Field` descriptors, not object graphs; the typed uniform "mirror"
  is a view over a `Float32Array`/`DataView`.
- **No `Map`.** Registries (intrinsics, node emitters, bindings, builtins) use
  name-as-id: a dense array with a derived numeric index, like `defineComponent`,
  the RPC/intent registries, and buckets. Lifetimes use `SlotMap`, `Collection`,
  `FreeList`, `GenerationAllocator`.
- **Backend-agnostic at the data level.** Schemas, descriptors, and the IR are
  plain data. Any GPU API backend can consume them.
- **Hackable by design.** Code generation is a shared pipeline with public
  extension points (node registry, intrinsic registry, ordered lowering passes,
  emit hooks, capability flags). A backend customises behavior without forking
  the common layer.
- **Type safety first.** The authoring surface is fully typed. Types erase at
  runtime, so type safety costs zero shipped bytes.

## Layout

```
gpu/
  schema/         data schemas for GPU memory
    field.ts        Field descriptor: size, align, write, read, toNil
    primitives.ts   f32, i32, u32, vec2f, vec3f, vec4f, mat4x4f, ...
    struct.ts       gpuStruct({...}) with offsets, size, typed mirror
    array.ts        fixed and runtime-sized arrays, arrays of structs
    align.ts        std140 / std430 offset and alignment rules
    infer.ts        Infer<F>: field to host value type (type-level only)
  ir/             the intermediate representation
    types.ts        GPU value types (f32, vec3, mat4, sampler, texture, ...)
    nodes.ts        typed nodes (literal, load, store, binop, call, sample,
                    construct, swizzle, builtin, binding, if, loop, return)
  dsl/            the typed authoring surface
    value.ts        DSL value types and operator overloads
    d.ts            constructors (f32, vec3f, swizzle, ...)
    std.ts          builtins (sin, normalize, mix, textureSample, ...)
    entry.ts        the `shader` namespace: vertex, fragment (compute added by backend)
    control.ts      structured control flow (branch, loop, select)
  codegen/        IR to source
    syntax.ts       TargetSyntax: every target-specific string, pluggable
    backend.ts      Backend interface + target-agnostic BaseBackend walker
    registry.ts     node/intrinsic/builtin registries (name-as-id)
    passes.ts       ordered lowering pipeline (shared, then backend)
    emit.ts         pass driver
    test-syntax.ts  test-only WGSL syntax and backend
  descriptors/    resource and pipeline descriptions (plain data)
    vertex-layout.ts  attributes, strides, step mode
    bind-group.ts     bindings: uniform/storage/texture/sampler + visibility
    render-state.ts   blend, depth, cull, write mask
    pipeline.ts       pipeline descriptor assembled from the above
  device/         the abstract GPU device
    gpu-device.ts     GpuDevice: buffers, bind groups, pipelines, draw, dispatch
  compiler/       build-time compilation (opt-in entry, not in the runtime barrel)
    transform.ts      compile a DSL builder to backend source; keyed cache
    parse.ts          parse a DSL shader body and lower it to IR
  runtime/        optional in-browser front-end for dynamic shaders
    index.ts          the same DSL front-end, lazily loaded
```

## The DSL and code generation

A shader is authored once against the typed DSL and compiles to an IR. Each
backend emits target source from that same IR through a `TargetSyntax`.

The three body parameters are **positional** (`entry.ts` calls
`fn(input, material, std)`), so the names are yours; the engine style is the
full names:

- `input` - the varyings/inputs built from the `params` schema (`input.uv`,
  `input.vNormal`, `input.vWorldPos`).
- `material` - the material uniforms built from the `material` schema
  (`material.time`, `material.tint`).
- `std` - the math library (`std.sin`, `std.normalize`, `std.pow`, ...); it also
  spreads `d`, so the constructors are available (`std.vec3f`, `std.f32`).

```ts
// authored once (murow/gpu/dsl)
shader.fragment((input, material, std) => {
  const tex = std.textureSample(material.map, material.mapSampler, input.uv);
  const n = std.normalize(input.vNormal);
  const l = std.max(std.dot(n, std.vec3f(0, 1, 0)), std.f32(0));
  return std.vec4f(tex.r, tex.g, tex.b, std.f32(1));
});
```

### The `shader` namespace

Shader entries are built through a lowercase `shader` namespace, matching the
lowercase value namespaces inside shader bodies (`d`, `std`). It is a plain
object composed from named exports, not a TypeScript `namespace` and not a class
(it is a group of factories, so there is no instance and no `new`).

The portable entries live in `murow/gpu`; each backend composes its own `shader`
adding what its API supports. Composition, not inheritance or namespace merging.

```ts
// murow/gpu
export function vertex(...) { /* … */ }
export function fragment(...) { /* … */ }
export const shader = { vertex, fragment };

// murow/webgpu
import { vertex, fragment } from 'murow/gpu';
export function compute(...) { /* … */ }
export const shader = { vertex, fragment, compute };
```

```ts
import { shader } from 'murow/webgpu';
const toonFrag = shader.fragment((input, material, std) => { /* … */ });
const toonVert = shader.vertex((input, material, std) => { /* … */ });
const reduce   = shader.compute((invocation, std) => { /* … */ });   // WebGPU only
```

`vertex` and `fragment` are portable (WGSL and GLSL). `compute` is a WebGPU
capability and is absent on `murow/webgl`. Strictly, a compute program is a GPU
kernel rather than a graphics-pipeline stage; it is grouped here because it is
authored, compiled, and dispatched through the same layer. Named exports are
also provided alongside the object for tree-shaking.

Extension points (the "hackable" part):

- **Node registry.** `registerNode(kind, emit)`. A backend adds nodes (for
  example a raw WGSL node, or a subgroup op) and teaches its emitter about them.
- **Intrinsic registry.** `intrinsic(name, impl)`. Common intrinsics have
  per-backend implementations; a backend can add missing ones or polyfill.
- **Pass pipeline.** Ordered `LoweringPass[]`. Shared passes run first, then
  backend passes rewrite, merge, or lower features the target lacks.
- **Target syntax.** `TargetSyntax` owns every target-specific string: type
  names, builtin decorations, parameter and binding declarations, entry
  signatures, casts, sampling, literals, struct declarations, loop keyword,
  and preamble prefix. The shared walker never embeds one.
- **Emit hooks.** `mapBuiltin`, `entryPointSignature`, `declareBinding`,
  `preamble`, routed through the syntax. `BaseBackend` implements them once.
- **Capability flags.** `{ compute, storageBuffers, f16, subgroups }`. The
  shared layer either emits, lowers via a backend pass, or fails with a clear
  error when a feature is unavailable.

Examples of backend hacking:

- **WGSL:** a `TargetSyntax` for `@vertex`/`@fragment`/`@compute` entry points,
  `@group`/`@binding` declarations, `@builtin` mapping, raw-WGSL nodes, all
  capabilities on.
- **GLSL:** a `TargetSyntax` that merges separate textures and samplers into
  `sampler2D`, injects `precision highp float` as the preamble prefix, remaps
  builtins (`gl_Position`, `gl_FragCoord`, `gl_FrontFacing`), overrides
  sampling intrinsics; `compute` and `storageBuffers` off, lowered or rejected.

## Portability

Everything outside compute, storage buffers, atomics, `f16`, and subgroups is
portable: one shader source, WGSL and GLSL outputs. Compute has no WebGL
equivalent and is a WebGPU-only capability. Portable shaders cannot take
raw-language escape hatches; using a backend-only node or a raw node is an
explicit, deliberate loss of portability.

## Compilation model

The DSL is an eager IR builder: a shader body runs and produces IR directly.

- **Build time (default).** `transform(stage, build, { backend })` runs the
  builder to get an IR entry, then lowers and emits backend source. Ship the
  emitted source; the DSL and codegen can then be tree-shaken away. No parser is
  involved, so the runtime carries none.
- **Runtime (opt-in).** The same front-end runs in the browser
  (`murow/gpu/runtime`) for shaders authored dynamically.
- **Parser front-end (opt-in).** `transformSource(source, options)` (in
  `murow/gpu/compiler`) parses a DSL shader body and lowers it to IR, so authors
  can write native `a * b` and `if`/`else`. It is a hand-written parser with no
  dependency, and it is kept out of the `murow/gpu` runtime barrel (import
  `murow/gpu/compiler` from build tooling only) so the shipped runtime carries no
  parser.

## Non-goals

- No renderer contracts (those stay in `murow/renderer`).
- No API-specific device code (that stays in `murow/webgpu`, `murow/webgl`).
- No compute support on WebGL.
- No scene graph, no object-oriented material model.

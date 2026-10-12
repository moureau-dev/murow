# Shader authoring in murow

murow shaders are written in the `d`/`std` typed DSL and compiled to WGSL by the WebGPU backend. You author a plain JavaScript closure against typed constructors and math, declare the resources it reads (uniforms, textures, engine bindings), and the renderer parses the body, lowers it to IR, and emits the shader. This guide is the practical companion to the [WebGPU renderer](../llms.txt) reference: it shows the DSL, the material and camera-effect surfaces, custom geometry, the helper functions, and the gotchas that bite.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **Author with `d` and `std` only.** `d` builds values and layouts, `std` is the math namespace; `std` spreads `d`, so `std.vec3f` works too. Import them from `murow/webgpu` (or `murow/gpu`).
2. **Use `std.mul` / `std.add` / `std.sub` / `std.div` (or the `.mul()` methods) when an expression must keep its vector/matrix shape.** A native `a * b` is typed `number` and cannot be indexed, so it is fine for scalars and for feeding another `std.*` call, but not for `.x` afterwards.
3. **A `shader` material requires `shaders.fragment`.** Omit `shaders.vertex` to reuse the engine mesh vertex and receive `vNormal`, `vColor`, `vUV`, `vWorldPos` (and `position` / `frontFacing`).
4. **Read engine data by name inside the body.** The engine exposes `material`, `scene`, `textures`, `lights`, `dynamic`, `statics`, `slotIndices`, `shadow`, `shadowMap`, `shadowSampler` as free variables (the `expose` mechanism), plus `d`, `std`, `tonemap`, `noise`, `snoise`.
5. **Uniforms are a schema.** Declare `uniforms: { scan: d.f32, tint: d.vec3f }` and seed values with `defaultUniforms`; write at runtime through `handle.uniforms.scan`.
6. **Textures are named.** `textures: { map: 'flame' }` binds by asset id, and the body samples `textures.map` with `textures.mapSampler` (or the convenience `textures.sampler`).
7. **Camera effects are shader fragments too:** `renderer.camera.effects.add({ type: 'shader', fragment })`, where the fragment gets `input.vUV`, `textures.src`, `material.<name>`, `scene.time`, `scene.resX`/`scene.resY`, and `history`.
8. **Custom instanced geometry goes through `renderer.geometry.create(...)` on the 2D renderer** (`GeometryBuilder` / `CustomGeometry`), with `dynamic` per-frame fields and `static` per-instance fields.
9. **Turn `minifySyntax` off for anything containing shader bodies.** Bodies are parsed from `Function.prototype.toString()` at link time; identifier and whitespace minification are fine, syntax folding is not.
10. **There is no public `renderer.compute`.** Skeletal animation and GPU particles are backend ports (the WebGPU backend implements them with `ComputeBuilder` internally).

## The model

A shader body is a closure, not a string. At link time the compiler calls `body.toString()` and parses the source, lowering `a * b`, `if`/`else`, and `for`/`while` into IR. That is why you write native operators and loops instead of IR builders, and why the body must survive bundling as source.

Three surfaces exist, from low to high:

- **`GpuShader` (from `murow/gpu`)** is the low-level stage builder: `GpuShader.vertex(...)`, `.fragment(...)`, `.compute(...)`. It takes an `in`/`out` schema, `bindings` (named `GpuBindGroupLayout`), an optional `expose` map (flat names the body may read, resolved to a layout slot path), and `helpers` (named functions the backend injects when called). The engine's own materials, the geometry builder, and camera effects are built on this.
- **`renderer.materials.create(spec)`** is the friendly material path. A `type: 'shader'` spec takes `uniforms`, `defaultUniforms`, `textures`, `lit`, and `shaders: { vertex?, fragment }`. The engine wires the vertex, texture, shadow, and instance bindings and exposes them by name.
- **`renderer.camera.effects`** compiles a fullscreen `type: 'shader'` fragment against an engine fullscreen vertex.

Inside a body the first parameter is always the stage input. Exposed names are read directly as free variables (`material.scan`, `textures.map`); a body can also bind them from a second parameter, `(input, { material, textures }) => ...`, which resolves each name against the same exposed record.

Types erase at runtime. The typed authoring surface brands a value as `SV<V>` (`number & Members<V> & Ops<V>`), so component access and swizzles type-check and native operators still compile. The `number` brand is what makes `a * b`-style arithmetic natural; it is also why the result loses its shape.

## Values, constructors, and swizzles

`d` is both a set of type descriptors (for fields and layout signatures) and a set of value constructors. Every member is callable.

| family | members |
|---|---|
| scalars | `d.f32`, `d.i32`, `d.u32`, `d.bool` |
| float vectors | `d.vec2f`, `d.vec3f`, `d.vec4f` (aliases `d.v2f`, `d.v3f`, `d.v4f`) |
| integer vectors | `d.vec4u` |
| matrices | `d.mat2x2f`, `d.mat3x3f`, `d.mat4x4f` (aliases `d.m3x3f`, `d.m4x4f`) |
| composite | `d.struct({...})`, `d.arrayOf(type, count)`, `d.array(element, values)`, `d.sizeOf(type)`, `d.atomic(inner)` |
| markers | `d.texture2d()`, `d.builtin.<name>`, `d.location(index, type)` |

`std` is the WGSL math namespace and spreads `d`, so constructors and helpers live in one place:

```ts
// same value either way
const a = d.vec3f(1, 0, 0);
const b = std.vec3f(1, 0, 0);
```

Common `std` builtins: `add`, `sub`, `mul`, `div`, `neg`, `mod`, `mix`, `clamp`, `saturate`, `step`, `smoothstep`, `min`, `max`, `pow`, `abs`, `floor`, `ceil`, `fract`, `sqrt`, `length`, `distance`, `dot`, `cross`, `normalize`, `reflect`, `refract`, `sin`, `cos`, `tan`, `exp`, `log`, `sign`, `select`, `textureSample`, `textureSampleLevel`, `discard`.

Component access and swizzles are properties on the value:

```ts
const c = d.vec4f(0.2, 0.5, 0.9, 1);
const rgb = d.vec3f(c.x, c.y, c.z);
const b   = c.r;              // .r/.g/.b/.a are the x/y/z/w aliases
const xy  = c.swizzle('xy');  // arbitrary mask
```

### Shape, and why `a * b` is `number`

The typed surface makes shader values numeric so ordinary arithmetic type-checks. The trade-off: a native operator returns `number`, so the result has no `.x`, `.y`, or swizzle.

```ts
const t = material.tint;              // SV<Vec<'f32', 3>>
const s = std.saturate(std.sin(t.y * 5.0) * 0.5 + 0.5);  // number
const scaled = std.mul(t, s);         // SV<Vec<'f32', 3>> - still indexable
return d.vec4f(scaled.x, scaled.y, scaled.z, 1.0);
```

`std.mul`, `std.add`, `std.sub`, and `std.div` have shape-preserving overloads, and `ShaderValue` carries the same methods (`t.mul(s)`). Use them when you need the shape after the operation; use plain operators when you only feed another `std.*` call or produce a scalar.

## Custom materials

`renderer.materials.create({ type: 'shader', ... })` compiles a `MaterialSpec` after `init()`. `name` is optional and unique per renderer (auto `mat_<id>` when omitted; a duplicate throws). The handle carries typed `uniforms`, `setTexture`, `setCastShadow`, `setReceiveShadow`, and `destroy`.

```ts
import { d, std } from 'murow/webgpu';

const holo = renderer.materials.create({
  type: 'shader',
  name: 'holo',
  blend: 'additive',
  depthWrite: false,
  // lit vertex (default) so the fragment receives vWorldPos
  textures: { map: 'flame', mask: 'noise' },   // asset ids -> group 1
  uniforms: { scan: d.f32, tint: d.vec3f },
  defaultUniforms: { scan: 2, tint: [0.35, 0.85, 1] },
  shaders: {
    fragment: (input) => {
      const tex = std.textureSample(
        textures.map,
        textures.mapSampler,
        d.vec2f(input.vUV.x, input.vUV.y),
      );
      const band = std.saturate(std.sin(input.vWorldPos.y * material.scan) * 0.5 + 0.5);
      const c = std.mul(material.tint, band);
      return d.vec4f(c.x, c.y, c.z, tex.w);
    },
  },
});

holo.uniforms.scan += 0.6;        // typed write over the uniform mirror
holo.setTexture('mask', 'smoke'); // re-bind a declared texture by name
holo.destroy();
```

Spec fields that matter for custom shaders:

| field | notes |
|---|---|
| `type` | `'shader'` selects the declarative path |
| `uniforms` | a `d` schema (`d.f32`, `d.vec3f`, ...); becomes `material.<name>` |
| `defaultUniforms` | initial values by field name; written once, then mutable via `handle.uniforms` |
| `textures` | named texture ids from the asset bucket; each name also gets `<name>Sampler` and the first gets the convenience `sampler` |
| `shaders.vertex` | optional `{ out, fn }`; when omitted the engine mesh vertex runs |
| `shaders.fragment` | required `{ fn }`; returns a `d.vec4f` |
| `lit` | `false` selects the unlit vertex (no `vNormal`/`vWorldPos`) |
| `blend`, `depthWrite`, `depthTest`, `cull`, `colorWrite`, `depthBias` | render state |
| `shadow` | `{ cast?, receive? }` participation in the directional shadow map |

The engine exposes these free variables to a `shader` fragment (and a custom vertex):

- `material` — this material's uniforms (`material.scan`).
- `scene` — engine uniforms: `viewProjection`, `alpha`, `lightDirX/Y/Z`, `lightDirR/G/B`, `lightDirIntensity`, `ambientR/G/B`, `lightCount`, `cameraX/Y/Z`, `time`, `resolutionX/Y`.
- `textures` — one binding per declared texture name, plus `<name>Sampler` and `sampler`.
- `lights` — the dynamic-light storage buffer; `lights[i]` or `lights.at(i)`.
- `dynamic`, `statics`, `slotIndices` — the mesh instance arrays.
- `shadow`, `shadowMap`, `shadowSampler` — the directional shadow uniforms and map.
- `d`, `std`, `tonemap`, `noise`, `snoise`.

The fragment also receives `input.position` (fragment coordinates) for screen-space UV, `input.vCustom` (a `vec2` of the instance's `custom0`/`custom1`, set via `handle.setMaterialParams(a, b)`), and `input.frontFacing`. Engine fragments flip the normal on back faces, so `cull: 'none'` lights both sides.

## Camera effects

A custom camera effect is a fullscreen fragment applied after the scene renders. Add it to `renderer.camera.effects`, which keeps an ordered chain (default cap 20).

```ts
const fx = renderer.camera.effects.add({
  type: 'shader',
  uniforms: { amount: d.f32 },
  defaultUniforms: { amount: 0.5 },
  fragment: (input) => {
    const uv = input.vUV;
    const src = std.textureSample(textures.src, textures.sampler, d.vec2f(uv.x, uv.y));
    const r = std.textureSample(textures.src, textures.sampler, d.vec2f(uv.x + material.amount * 0.01, uv.y)).x;
    const b = std.textureSample(textures.src, textures.sampler, d.vec2f(uv.x - material.amount * 0.01, uv.y)).z;
    return d.vec4f(r, src.y, b, src.w);
  },
});

fx.params.amount = 0.8;  // retune a custom ('shader') effect live
fx.enabled = false;      // toggle without removing
```

The custom fragment gets `input.vUV`, `textures.src` with `textures.sampler`, `material.<name>` uniforms, `scene.time` / `scene.resX` / `scene.resY`, and `history` (a persistent target for temporal effects). Built-in effect types (`vignette`, `grade`, `grayscale`, `chromatic`, `scanlines`, `posterize`, `motionBlur`, `fxaa`, `fog`, `bloom`) are plain specs with no `fragment`.

## Compute kernels

murow's public renderer exposes no `renderer.compute` API. Skinning and GPU particles are handled automatically: the backend implements them through the particle and skeletal-animation ports. On WebGPU those ports are built with `ComputeBuilder`.

`ComputeBuilder` lives in `@murow/webgpu/src/compute` and is used internally (not exported from the public package index). Backend authors and anyone forking the renderer use it as the compute kernel path:

```ts
// internal WebGPU compute path (used by the skinning + particle ports)
const kernel = new ComputeBuilder('particle-physics', { workgroupSize: 64 }, root)
  .buffers({
    particles: { storage: d.arrayOf(Particle, MAX), readwrite: true },
    config: { uniform: Config },
  })
  .shader(({ globalId }, { buffers }) => {
    const idx = globalId.x;
    const p = buffers.particles[idx];
    // ...update p...
  })
  .build();

kernel.write('config', { dt: 1 / 60 });
kernel.dispatch(MAX);
const bytes = await kernel.read('particles');
```

`buffers` declares `storage` (read-only or `readwrite`) and `uniform` entries. The kernel body receives `(input, bindings)`: `input` is `globalId` / `localId` / `localIndex` / `workgroupId` / `numWorkgroups`, and `bindings.buffers` are the buffer accessors. `dispatch(count)` rounds up to workgroups; `dispatch([x, y, z])` passes group counts directly.

## Custom instanced geometry

`renderer.geometry` (on the 2D renderer) creates a custom instanced draw through `GeometryBuilder`. Provide a max instance count, a built-in shape (`'quad'`, `'triangle'`, `'circle'`, `'cube'`, `'plane'`) or a custom vertex layout, then the `dynamic` per-frame fields, `static` per-instance fields, uniforms, and shaders.

```ts
import { d } from 'murow/webgpu';

const render = renderer.geometry
  .create('particle-vis', { maxInstances: 10_000, geometry: 'quad' })
  .instanceLayout({
    dynamic: { posX: d.f32, posY: d.f32, life: d.f32 },  // updated per frame
    static:  { hue:  d.f32 },                             // set once
  })
  .uniforms({ resolution: d.vec2f, time: d.f32 })
  .shaders({
    vertex: {
      out: { vLife: d.f32, localUV: d.vec2f },
      fn(input, { dynamic, statics, uniforms }) {
        const p = dynamic[input.instanceIndex];
        return { pos: d.vec4f(p.posX, p.posY, 0, 1), vLife: p.life, localUV: d.vec2f(0, 0) };
      },
    },
    fragment: {
      fn({ vLife }) {
        return d.vec4f(1, 0, 0, vLife as number);
      },
    },
  })
  .build();

render.addInstance({ posX: 0.5, posY: 0.5, life: 1, hue: 0.3 });
render.updateUniforms({ resolution: [canvas.width, canvas.height], time: 0 });
render.render();

render.updateAll((ctx, slot) => {                 // zero-alloc batch update
  ctx.set('life', (ctx.get('life') as number) - deltaTime);
});
```

In the declarative form the vertex body is `fn(input, ctx)`: `input` is `{ vertexIndex, instanceIndex }`, and `ctx` destructures the exposed `{ dynamic, statics, uniforms }` (or read them as free variables). The fragment body is `fn(varyings)`, where `varyings` are the `out` fields from the vertex. `.fromBuffer(buffer)` binds an external storage buffer as the dynamic data instead of `addInstance` (use one or the other, not both), which is how a compute pass can drive the geometry.

## Shader helpers

These are callable inside a `type: 'shader'` material closure (the engine registers them as body helpers). `std.*` names resolve through the engine's `std`; the free names are registered as body helpers. Camera-effect fragments get the raw `std` math namespace plus their own bindings, not these helpers.

| helper | signature / use |
|---|---|
| `std.shadeLight(light, surface)` | diffuse contribution of one point or spot light. `light` is `{ pos, dir, color, intensity, range, innerCos, outerCos, kind }` (`kind`: 1 point, 2 spot); `surface` is `{ normal, worldPos }`. Returns a `vec3`. This is the per-light helper the engine materials loop over. |
| `tonemap(c)` / `std.tonemap(c)` | Reinhard tone map of a `vec3`. |
| `noise(x)` | 3D value noise for a `vec3` sample position. |
| `snoise(uv, res)` | signed value noise, returns roughly `[-1, 1]`. |
| `discard()` / `std.discard()` | discard the fragment. |
| utility signatures | `rotate2d`, `worldToClip2d`, `worldToClip3d`, `remap`, `scaleRotate2d`, `inverseLerp` (see the quick reference). |

`lightContribution` is the old name for the per-light helper; it was renamed to `std.shadeLight`. Use the new name.

## Gotchas

- **Shader bodies are source, not strings.** The compiler reads `Function.toString()` at link time. Bundling with `minifySyntax: true` can fold or rewrite the body so it no longer parses. Set `minifySyntax: false`; `minifyIdentifiers` and `minifyWhitespace` are safe because the parser recovers renamed `d`/`std` namespaces and preserved destructured keys. The CDN bundle options do exactly this.
- **`a * b` is `number`.** Native operators do not keep the vector/matrix shape in the type system, so `(a * b).x` does not type-check. Use `std.mul` / the `.mul()` method when you need to index the result.
- **`shader` materials need `shaders.fragment`.** The constructor throws `createMaterial: shader materials require 'shaders.fragment: { fn }'` when it is missing.
- **A duplicate material name throws.** Names are unique per renderer; `name` is optional but if you pass one it must be free.
- **Textures must be declared to be sampled.** The names in `textures: { map: 'id' }` become the bindings; sampling an undeclared name fails to resolve.
- **No public compute API.** Do not reach for `renderer.compute`; skinning and particles are backend ports. `ComputeBuilder` is internal to `@murow/webgpu`.
- **`renderer.geometry` is on the 2D renderer.** The 3D renderer has no geometry manager.
- **`material` in a body is not a mesh material object.** It is this material's uniform struct, read as `material.<name>`.
- **`std.shadeLight` and the body helpers come from the engine's `std`.** They are present in `type: 'shader'` material closures (the engine injects them), not in the bare `murow/gpu` `std` and not in camera-effect fragments.

## Quick reference

| want | use |
|---|---|
| a scalar / vector / matrix value | `d.f32`, `d.vec3f`, `d.mat4x4f`, ... |
| a struct for uniforms or buffers | `d.struct({ x: d.f32, uv: d.vec2f })` |
| a fixed array field | `d.arrayOf(element, count)` |
| shape-preserving math | `std.mul` / `std.add` / `std.sub` / `std.div` (or `.mul()`) |
| free-form math | native `+ - * /`, `std.sin`, `std.mix`, `std.clamp`, ... |
| component / swizzle | `v.x`, `v.r`, `v.swizzle('xy')` |
| a custom surface material | `renderer.materials.create({ type: 'shader', ... })` |
| a fullscreen post effect | `renderer.camera.effects.add({ type: 'shader', fragment })` |
| custom instanced draws (2D) | `renderer.geometry.create(name, { maxInstances, geometry })` |
| per-light diffuse | `std.shadeLight(light, { normal, worldPos })` |
| tone mapping | `tonemap(c)` / `std.tonemap(c)` |
| value noise | `noise(vec3)` / `snoise(vec3, res)` |
| GPU compute (internal) | `ComputeBuilder` in `@murow/webgpu/src/compute` |
| low-level stage authoring | `GpuShader.vertex` / `.fragment` / `.compute` from `murow/gpu` |
| transform a 2D point by an angle | `rotate2d(point, angle)` |
| remap / inverse lerp | `remap(...)`, `inverseLerp(min, max, value)` |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [Testing](./testing.md)


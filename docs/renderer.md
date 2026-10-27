# The WebGPU renderer in murow

`murow` itself is renderer-agnostic: the abstract renderer contracts, the asset pipeline (`AssetBucket`, `PrefabBucket`, `parseGltf`, `parseSpritesheet`, `SkeletalAnimation`), and all CPU collision/picking (`Hitbox`, `HitboxLibrary`, `Raycaster`, `Ray3D`) are pure CPU and usable on a headless server. `murow/webgpu` is the reference backend. It is a concrete WebGPU 2D/3D renderer: you author shaders in the `d`/`std` typed DSL and the backend compiles them to WGSL. Both renderers follow the same shape: `new` → `await init()` → drive the scene → `render(alpha)`.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **A renderer is a composition root.** `new WebGPU3DRenderer(canvas, options)` → `await init()` → drive instances → `render(alpha)`. `init()`, `render(alpha)`, `storePreviousState()`, `destroy()`, `onResize`, `worldToScreen` live on the renderer; every subsystem (`renderer.instances`, `.materials`, `.lights`, `.shadows`, `.decals`, `.particles`, `.models`, `.camera`, …) hangs off it.
2. **Call `storePreviousState()` in `pre-tick` and `render(alpha)` in `render`.** Without the first, motion snaps at low tick rates; the GPU interpolates `mix(prev, curr, alpha)` in the vertex shader.
3. **Creation is named per manager:** `add` is a cheap pool insert; `create` compiles or allocates GPU resources (materials). Both throw at capacity and log through the logger.
4. **Handles are versioned numbers.** Compare by `.id`, never by reference. `destroy()` is idempotent; a stale handle is inert (mutating methods no-op, reads return the last values). `handle.destroy()` frees the pool slot for reuse, not memory — full reclamation is `renderer.destroy()`.
5. **Materials are refcounted.** `material.destroy()` throws while instances still use it; `material.destroy({ force: true })` reassigns those instances to the default material first. Materials are GPU resources created **after `init()`**.
6. **3D instance `color` is set at spawn only** (`instances.add({ color: [r, g, b] })`) — there is no `setColor`/`setTint` on a 3D handle. 2D sprites differ: `SpriteHandle.setTint(r, g, b, a)` is live.
7. **`camera.fov` is DEGREES** (default 60). Pass `60`, not `Math.PI / 3`.
8. **Environment lighting and background.** A metallic-roughness `pbr` material shades direct sun and point/spot lights and supports normal maps. `renderer.ibl` adds image-based lighting from an equirectangular environment, and `renderer.skybox` draws that same environment as a fullscreen background. `standard` remains Lambert + two-sided.
9. **Draw-call budget:** 3D batches by `(materialId, modelId)`; 2D by `(layer, sheet)`. Every extra material on a model is another batch and another draw.
10. **Custom shaders and effect fragments go through `d`/`std`.** See the [shader guide](./shaders.md). Keep `minifySyntax` off for anything containing shader bodies.
11. **Shadow cost is per-system.** The directional (sun) map is cached and re-rendered only on change; the spot (≤4/frame) and point/cube (≤2/frame) maps re-render every frame. Disable what you don't use.
12. **Declare reusable models as `AssetBucket` prefabs**, not `renderer.models` factories. The factories are one-off/debug conveniences with no parallel load, typed ids, or bucket GPU sizing.

## The model

### Managers and handles

The renderer is a composition root. Lifecycle stays on it (`init`, `render(alpha)`, `storePreviousState`, `destroy`, `onResize`, `worldToScreen`, and for 3D `addInstance` / `createMaterial` / `setAmbient` / `setDirectionalLight` sugar). Each subsystem, including `renderer.models` for mesh creation/loading, is a manager reached off it:

| Manager | Creation | Returns |
|---|---|---|
| `renderer.instances` | `add(spec)` | `MeshInstanceHandle` (or `InstanceHandle`); throws at capacity |
| `renderer.materials` | `create(spec)` | `MaterialHandle<U>`; throws at capacity |
| `renderer.lights` | `add(spec)` | `LightHandle`; throws at capacity. `renderer.lights.ambient(color)` and `renderer.lights.sun(dir, color, intensity)` set the scene terms |
| `renderer.decals` | `createLayer(spec)` | a decal layer; `layer.add(x, y, z, nx, ny, nz, opts)` returns a `DecalHandle` |
| `renderer.shadows` | (system) | `enabled`, `resolution`, plus `directional` / `spot` / `point` sub-managers |
| `renderer.particles` | `addEmitter(spec)` | a particle emitter handle |
| `renderer.cameras` | `create(props)` | a camera handle; `renderer.camera` is the primary |
| `renderer.layers` | `define(name)` | a layer bit + `renderer.layers.mask(...)` |
| `renderer.camera` | (system) | the primary 2D or 3D camera + `renderer.camera.effects` |
| `renderer.models` | `createGrid` / `createCube` / `loadModel` / `loadGltf` / `uploadParsedGltf` | a `ModelHandle` / `GltfModel` for `instances.add` |
| `renderer.raycast` | (system) | cursor picking (`renderer.raycast.update(input)` / `.hit({ filter })`) |
| `renderer.sprites` / `.sheets` / `.geometry` | 2D only | sprites / spritesheets / custom geometry |

Pooled managers (`instances`, `materials`, `lights`, `decals`, `particles`, and 2D `sprites`) share one read and lifecycle contract: `get(id)`, `has(id)`, `each(cb)`, `remove(id)`, `clear()`, `destroy()`, `capacity`, `count`, and an `events` system (`add` / `remove` / `clear`). Creation is named per manager: `add` for a cheap pool insert, `create` when the manager compiles or allocates GPU resources. Capacity errors log and throw; they do not return `null`.

`cameras` is a `CameraRegistry` over `SlotMap`: `create`, `add`, `get`, `has`, `remove`, `each`, `all`, `ordered`, `primary`, `setPrimary`, `capacity`, `count`, and `events` (`add` / `remove` / `primary`). A camera handle has `destroy()`, which refuses to remove the last camera. `layers` is a static name registry with `define`, `mask`, `resolveLayer`, `resolveMask`, `count`, `capacity`, and `events` (`add` / `clear`).

Pooled ids are versioned numbers, so a stale id never aliases a recycled slot. Pooled handles carry a readonly `id` and an `alive` flag; compare handles by `.id`, never by reference. Camera handles carry a branded `CameraId` and `destroy()`. `destroy()` is idempotent; a stale handle is inert (mutating methods are no-ops, reads return the last values). `handle.destroy()` frees the pool slot for reuse, not memory; full reclamation is `renderer.destroy()`.

Materials are refcounted: `material.destroy()` throws while instances still use it, and `material.destroy({ force: true })` reassigns those instances to the default material first. Particle `capacity` is `{ maxEmitters, maxParticles }`. Pooled managers use the core collection framework; cameras use `SlotMap`; layers use a name-to-bit map. See the [zero-allocation guide](./zero-allocation.md) for the container toolkit.

### Lighting (3D)

Dynamic point and spot lights with GPU-side interpolation, plus a configurable global directional light and ambient term. The renderer supports up to `MAX_LIGHTS` (default 64) dynamic lights + one sun.

```ts
import { type LightSpec, type LightHandle } from 'murow/webgpu';

// Point light
const point = renderer.lights.add({
  type: 'point',
  position: [0, 5, 0],
  color: [1, 0.3, 0.3],        // RGB, default [1,1,1]
  intensity: 2,                 // brightness multiplier, default 1
  range: 15,                    // world-unit radius, default 10
  castShadow: false,            // cube shadow (up to maxPointShadows), default false
});

// Spot light (cone with soft edge)
const spot = renderer.lights.add({
  type: 'spot',
  position: [0, 3, 0],
  direction: [0, -1, 0],
  color: [1, 1, 0.8],
  intensity: 3,
  range: 20,
  angle: 0.5,                   // cone half-angle in radians, default 0.5
  smoothness: 0.3,              // 0 = hard edge, 1 = fades from center, default 0.5
  castShadow: false,            // spot shadow (up to maxSpotShadows)
  shadowBias: undefined,        // per-light depth bias; defaults to the renderer's
});

// All light properties are live-mutable every frame
spot.setPosition(10, 3, 10);
spot.setDirection(0, -1, -0.2);
spot.teleport(0, 5, 0);         // snap without interpolation (after a discontinuous move)
spot.setColor(0.2, 0.5, 1);
spot.intensity = 5;
spot.range = 30;
spot.angle = 0.8;
spot.smoothness = 0.7;
spot.enabled = false;           // toggle without freeing the slot
spot.destroy();                 // free the slot

// Global directional light (the "sun") — configurable, defaults to (0.3, 0.8, 0.5), white, intensity 1
renderer.lights.sun(
  [0.5, -0.8, 0.3],           // direction (points toward the light)
  [1, 0.95, 0.9],             // color
  1.5,                         // intensity
);

// Global ambient — defaults to (0.3, 0.3, 0.3)
renderer.lights.ambient([0.1, 0.1, 0.15]);

// Light positions/directions interpolate on the GPU (store previous state in pre-tick)
loop.events.on('pre-tick', () => renderer.storePreviousState());
```

`LightHandle` exposes `slot`, `id`, `alive`, `setPosition`, `setDirection`, `teleport`, `setColor`, readonly `position`/`direction`/`color` (per-handle reused tuples — copy out to retain), `intensity`, `range`, `angle`, `smoothness`, `enabled`, an optional `shadow` override, and `destroy()`.

The 3D renderer supports a metallic-roughness `pbr` material with direct sun and point/spot lighting, normal maps, image-based lighting through `renderer.ibl`, and a visible environment background through `renderer.skybox`. Use `standard` / `unlit` / `emissive` / custom `shader` for other looks. A single **directional shadow map** (the sun) is supported; see [Shadows](#shadows-3d).

### Materials (3D)

`renderer.materials.create(spec)` compiles a `MaterialSpec` into a `MaterialHandle` and throws at capacity. Materials are GPU resources created **after `init()`**. `name` is optional and unique per renderer (auto-assigned `mat_<id>` when omitted); a duplicate **throws** (`Material "x" is already registered`). The name is registered in the material library and released on `destroy()`. The handle is typed `MaterialHandle<N, U>` (literal `name` when given, typed `uniforms`) and also carries a runtime `id: MaterialId`.

```ts
import { d, std } from 'murow/webgpu';

// Declarative custom shader. Omitting `shaders.vertex` reuses the engine mesh
// vertex, so the fragment receives vNormal, vColor, vUV, vWorldPos.
const holo = renderer.materials.create({
  type: 'shader',
  name: 'holo',                 // optional, unique; auto `mat_<id>` if omitted
  id: 'holo',                   // optional debug label on the GPU pipeline
  blend: 'additive',            // 'opaque' | 'alpha' | 'additive' | 'premultiplied' | 'multiply' | 'screen'
  depthWrite: false,
  lit: false,                   // false -> lighter vertex path (no vNormal/vWorldPos)
  textures: { map: 'flame', mask: 'noise' },  // named textures from the AssetBucket -> group 1
  uniforms: { scan: d.f32, tint: d.vec3f },
  defaultUniforms: { scan: 2, tint: [0.35, 0.85, 1] },
  shaders: {
    fragment: (input) => {
      const tex = std.textureSample(textures.map, textures.sampler, d.vec2f(input.vUV.x, input.vUV.y));
      const band = std.saturate(std.sin(input.vWorldPos.y * material.scan) * 0.5 + 0.5);
      const c = std.mul(material.tint, band);
      return d.vec4f(c.x, c.y, c.z, tex.w);
    },
  },
});

const glow = renderer.materials.create({ name: 'glow', type: 'emissive', color: [1, 0.45, 0.1], emissive: 2 });

const orb = renderer.instances.add({ prefab: 'orb', material: holo });
orb.setMaterial(glow.slot + 1);      // runtime swap (O(1)); 0 = engine default
orb.setMaterialParams(1.5, 0);       // writes statics[slot].custom0 / custom1

holo.uniforms.scan += 0.6;           // typed write; `.uniforms` is a live view
holo.setTexture('mask', 'smoke');    // re-bind any declared texture by name
holo.destroy();                      // free the slot + uniform buffer
```

PBR materials use the direct sun, point, and spot lights. Call `renderer.ibl.load({ equirect })` to add image-based lighting. Normal maps use the OpenGL convention (`+Y` green) and are sampled with a derivative tangent basis, so no tangent attribute is required.

```ts
const env = document.createElement('canvas');
// draw an equirectangular sky/studio image into env
await renderer.ibl.load({ equirect: env, intensity: 1, rotation: 0 });
renderer.ibl.set({ intensity: 1.2, rotation: 0.4 });
// or individually:
renderer.ibl.intensity = 1.2;
renderer.ibl.rotation = 0.4;
renderer.ibl.clear();
```

The environment is prefiltered on the CPU at load time: an irradiance cubemap for diffuse and a box-filtered mip chain for roughness-based specular. It is an approximation, not a GGX-convolved split-sum pipeline.

`renderer.skybox` draws the same environment as a fullscreen background. It shares the environment rotation and intensity with IBL, and exposes `enabled` and `tint`:

```ts
renderer.skybox.enabled = true;
renderer.skybox.tint = [1, 1, 1];
renderer.skybox.resolution = 512; // equirect width; height is width / 2
```

The skybox equirect defaults to `512x256`. Set `skyboxResolution` on `ibl.load` or assign `renderer.skybox.resolution` at runtime; changing it recreates the equirect texture and rebinds the skybox. Tint is interpolated on the GPU from the previous tick, like light transforms. The skybox is not a texture or material; it is a renderer-owned pass and does not appear in the material system.

```ts
const steel = renderer.materials.create({
  name: 'steel',
  type: 'pbr',
  baseColor: [0.72, 0.73, 0.75],
  metallic: 1,
  roughness: 0.35,
  textures: {
    baseColor: 'steel-albedo',
    metallicRoughness: 'steel-mr',
    occlusion: 'steel-ao',
    normal: 'steel-normal',
  },
  normalScale: 1,
  sampling: { scale: [1, 1], offset: [0, 0], wrap: 'repeat', filter: 'linear' },
  shadow: { cast: true, receive: true },
});

steel.uniforms.roughness = 0.5;
steel.setTexture('baseColor', 'other-albedo');
```

`MaterialHandle<U>` (`U` = the `uniforms` schema; accessors typed from the schema's inferred host type):

| Member | Description |
|---|---|
| `id: MaterialId` | Stable, versioned identity, when created through `renderer.materials`. |
| `name` | The registered name, or `''` when unnamed. |
| `alive` | `false` after destroy. |
| `slot: number` | Material identity. An instance's `materialId` is `slot + 1` (`0` = engine default). |
| `uniforms` | Typed read/write over this material's uniform buffer. `holo.uniforms.scan = v` and `+=` both work. |
| `setUniforms(values)` | Update several uniform fields with one buffer upload. |
| `setTexture(name, texture)` | Re-binds a declared texture by name. |
| `setCastShadow(bool)` / `setReceiveShadow(bool)` | Runtime shadow toggles (receive applies to `standard` and `pbr`). |
| `destroy(opts?)` | Frees the slot and uniform buffer. Throws while instances still use it; `destroy({ force: true })` reassigns them to the default material first. |

Spec fields:

| Field | Applies to | Notes |
|---|---|---|
| `type` | all | `'standard'` (lit), `'pbr'`, `'unlit'`, `'emissive'`, `'shader'` |
| `color`, `opacity`, `emissive`, `texture` | engine types | `texture` is an AssetBucket texture id |
| `baseColor`, `metallic`, `roughness`, `occlusionStrength`, `emissive`, `opacity` | `pbr` | metallic-roughness factors. Defaults `[1,1,1]`, `0`, `0.5`, `1`, `[0,0,0]`, `1` |
| `textures` | `pbr` | `{ baseColor?, metallicRoughness?, occlusion?, normal?, emissive? }`. Metallic-roughness packs G = roughness, B = metallic; normal maps use the OpenGL convention |
| `normalScale` | `pbr` | Normal map strength. Default `1` |
| `sampling` | `pbr` | `{ scale?, offset?, wrap?, filter? }`. Defaults `[1,1]`, `[0,0]`, `'clamp'`, `'linear'` |
| `alphaTest` | engine types | discard below this alpha (cutout). Default 0 (off) |
| `uvScale`, `uvOffset`, `wrap`, `filter` | engine types | sampling controls. Defaults `[1,1]`, `[0,0]`, `'clamp'`, `'linear'` |
| `uniforms`, `defaultUniforms`, `textures`, `shaders`, `lit` | `shader` | `uniforms` is a TGSL schema; `textures: { map: 'id', mask: 'id' }` (named); `shaders.fragment` required, `shaders.vertex` optional; `lit:false` selects the unlit vertex |
| `blend`, `blendState`, `depthWrite`, `depthTest`, `cull`, `colorWrite`, `depthBias` | all | render state. `blend` (see above) or `blendState` (raw `GPUBlendComponent`s); `colorWrite` boolean or `{r,g,b,a}`; `depthBias` `{constant, slopeScale, clamp}`. Defaults: `'opaque'`, depthWrite true, depthTest true, `cull:'none'` (`'back'` for `pbr`); `emissive` defaults to additive + no depth write |
| `extrude` | engine types | object-space offset along the vertex normal; with `cull:'front'` this is an inverted-hull toon outline. Default 0 |
| `id` | all | debug label on the GPU pipeline |
| `name` | all | optional unique name (auto `mat_<id>` when omitted); a duplicate throws |
| `shadow` | all | `{ cast?, receive? }`; participate in the directional shadow map (both default `true`; transparent and alpha-tested materials default to `cast: false`) |

Free variables inside a `shader` fragment (and custom vertex): `scene` (engine uniforms: `viewProjection`, `alpha`, sun direction/color/intensity, ambient, `lightCount`, `cameraX/Y/Z`, `time`, `resolutionX/Y`), `material` (this material's uniforms), `textures` (one key per declared texture name, plus a `<name>Sampler` and a convenience `sampler`), `lights`, `dynamic`, `statics`, `slotIndices`; plus `d`, `std` (`std.shadeLight(light, surface)` for one dynamic light, where `light` is `{pos, dir, color, intensity, range, innerCos, outerCos, kind}` and `surface` is `{normal, worldPos}`), and the helper `tonemap`. The fragment also receives `input.position` (fragment coords) for screen-space UV: `input.position.xy / vec2(scene.resolutionX, scene.resolutionY)`, `input.frontFacing`, and `input.vCustom` (`vec2` = the instance's `custom0`/`custom1`, set via `handle.setMaterialParams(a, b)`). Engine fragments flip the normal on back faces, so `cull:'none'` lights both sides. Full DSL and helper reference: [shader guide](./shaders.md).

Batching is by `(materialId, modelId)`; `render()` draws opaque batches first, then transparent (`alpha`/`additive`) batches. The material count is therefore a draw-call multiplier — see the [performance guide](./performance.md).

**Multiple materials per instance.** `instances.add({ prefab, materials: [...] })` draws the instance once per material (array, or a `{ name: material }` record; `material` is sugar for a one-element list). Up to 4 materials. The handle exposes them by name or 1-based id:

```ts
const hero = renderer.instances.add({ prefab: 'hero', materials: [bodyMat] });
hero.materials.add(outlineMat);        // attach (takes a MaterialHandle)
hero.materials.has('outline');         // by name or id
hero.materials.get('outline');         // MaterialRef { materialId, name, remove() } | undefined
hero.materials.remove('outline');
hero.materials.all;                    // readonly MaterialRef[]
```

Works for skinned and non-skinned; a glTF/composite group handle fans add/remove out to every part. Names resolve through the material library. Toggling an `extrude` + `cull:'front'` `emissive` material via `add`/`remove` is the toon outline.

Caveats:

- Skinned instances honor `material`/`materials` (and `setMaterial`); materials for skinned models are supported.
- Textures get a mip chain on upload (good minification); atlas sprites must sample LOD 0 to avoid cross-cell bleed (the 3D particle path does).
- `standard` is Lambert + two-sided; `pbr` adds metallic-roughness specular for direct lights, normal maps, and optional IBL.

### Shadows (3D)

Cast by the global sun (`renderer.lights.sun`). A single `rgba16float` linear-depth ortho map is fitted around the camera position (half-extent `renderer.shadows.directional.distance`), texel-snapped, and `standard` / `pbr` materials PCF-sample it.

```ts
renderer.shadows.directional.enabled = true;   // off = skips the shadow pass AND receiver sampling
renderer.shadows.directional.softness = 1.0;   // PCF radius in texels
renderer.shadows.directional.bias = 0.0015;    // depth compare bias (plus a normal-offset bias)
renderer.shadows.directional.distance = 45;    // ortho half-extent around the camera position
renderer.shadows.directional.anchorStep = 0;   // grid the box focus snaps to; 0 follows exactly

renderer.shadows.resolution = 2048;            // rebuild + rebind (not per-frame)

// Per material:
const ground = renderer.materials.create({ name: 'ground', type: 'standard', shadow: { receive: true, cast: false } });
```

| Control | Default | Notes |
|---|---|---|
| `renderer.shadows.enabled` | `true` | Master switch for every shadow pass |
| `renderer.shadows.directional.enabled` | `true` | Truthful toggle: disabled skips the pass and the fragment branch |
| `renderer.shadows.directional.softness` | `1` | PCF tap spacing, in texels |
| `renderer.shadows.directional.bias` | `0.0015` | Depth compare bias (plus a normal-offset bias) |
| `renderer.shadows.directional.distance` | `45` | Ortho half-extent of the box fitted around the camera position |
| `renderer.shadows.directional.anchorStep` | `0` | Focus snap grid; a larger step reduces re-renders while moving |
| `renderer.shadows.resolution` | `2048` | Assignable at runtime; rebuilds the map and rebinds materials |
| `shadow: { cast }` / `{ receive }` | `true` | Per material. Transparent and alpha-tested materials default to `cast: false` (the shadow pass ignores alpha) |
| `WebGPU3DRendererOptions.shadowResolution` | `2048` | Initial map size |

**Dynamic lights can also cast.** Set `castShadow: true` on a spot or point `LightSpec`:

- **Spot** (up to 4/frame) — a perspective depth layer in a `texture_2d_array`; `standard` projects into it and 4-tap PCFs per light.
- **Point** (up to 2/frame) — a `texture_cube_array` storing distance/far; `standard` samples by light direction and compares distance.

Both are driven by the light's `castsShadow`/`shadowMapIndex`, gated per-system, and re-render every frame (not cached like the directional map); one global bias each. Controls: `renderer.shadows.spot` / `renderer.shadows.point` (`.enabled`, `.bias`, `.capacity`, `.resolution`); renderer options `maxSpotShadows` (4), `maxPointShadows` (2), `pointShadowResolution` (512). Spot shadowing defaults on (resolution 1024, bias 0.002); point shadowing defaults off (resolution 512, bias 0.008).

Casters are opaque instances, including skinned meshes (skinned casters share the animated bone matrices). **The directional map is only re-rendered when the sun, the snapped box, or a caster actually changes** (instances/skinned stores and skeletal animation carry a version counter); otherwise the previous map is reused and no shadow pass runs. Because the focus snaps to `anchorStep`, a static scene keeps the same map even while the camera moves within a cell. Limitations: one directional light; constant bias (no slope scale); a single fixed box around the camera, so casters beyond `distance` do not cast and detail falls off with distance. Custom `shader` fragments can read the map via the `shadow`, `shadowMap`, and `shadowSampler` free variables.

### Decals (3D)

Pooled surface marks (blood, scorch, AoE rings) drawn as instanced `plane` quads oriented to a surface normal, sampled from one atlas, faded over time. One draw call for the whole pool.

```ts
const decals = renderer.decals.createLayer({ atlas: 'decals', quad: 'decalQuad', capacity: 256, cols: 4, rows: 4, life: 8 });
const mark = decals.add(x, y, z, nx, ny, nz, { cell: 2, size: 0.8 });  // returns a DecalHandle; hit point + normal
mark?.destroy();                     // remove it early (decals otherwise expire by life)
```

- The atlas is an `AssetBucket` texture; each decal picks a cell via the per-instance channel (`x` = cell, `y` = spawn time), delivered to the fragment through the engine's `vCustom` varying.
- The pool is a `RingStore` — the oldest mark is recycled past `capacity` (default 256); the fade is computed in the shader from `scene.time - spawn`, so the CPU never expires anything.
- Layer options: `atlas` (required), `quad` (default `'decalQuad'`), `capacity` (default 256), `cols`/`rows` (default 4), `life` (default 8). Spawn options: `cell` (default 0), `size` (default 1), `roll` (defaults to a golden-angle step for variety).
- The material is created by the layer: `type: 'shader'`, `lit: false`, `blend: 'alpha'`, `depthWrite: false`, `cull: 'none'`.

### Renderer shape

Both renderers share the same four-step lifecycle. `storePreviousState()` snapshots the interpolated subsystems (camera, instances, lights, sprites) so `render(alpha)` can `mix(prev, curr, alpha)` in the shaders.

```ts
const loop = new GameLoop({ type: 'client', tickRate: 20 });
loop.on('pre-tick', () => renderer.storePreviousState());
loop.on('render', ({ alpha }) => renderer.render(alpha));
```

### Render layers

Every renderer exposes `layers`, a `LayerRegistry` that maps names to bits. Objects carry one bit (`renderLayer`); cameras carry a mask (`camera.mask`). Culling and picking test the numbers, so the registry is setup-time only.

```ts
const world = renderer.layers.define('world');
const viewmodel = renderer.layers.define('viewmodel');

renderer.camera.mask = renderer.layers.mask('world', 'viewmodel');
renderer.instances.add({ prefab: rock, renderLayer: world });
renderer.instances.add({ prefab: gun, renderLayer: 'viewmodel' });
```

A prefab can declare `layer: 'world'`; the instance's `renderLayer` overrides it. Sprites keep `layer` as their sort order, so visibility on a sprite is `renderLayer`. `camera.mask` defaults to `layers.all`, and raycasts use the same mask. Layers are presentation-only; do not use them for authority or physics. `maxLayers` (1-32, default 32) caps the default registry and is ignored when `layers` is provided.

### Cameras

Both renderers expose `cameras`, a registry. `renderer.camera` is the primary camera, so single-camera code is unchanged.

```ts
const main = renderer.cameras.create({ position: [0, 5, -10], target: [0, 0, 0] });
const minimap = renderer.cameras.create({
  position: [0, 20, 0],
  target: [0, 0, 0],
  fov: 40,
  rect: { x: 0.72, y: 0.72, width: 0.26, height: 0.26 },
  priority: 1,
});

renderer.cameras.setPrimary(main);
renderer.cameras.remove(minimap);
```

`renderer.camera` is created automatically. Configure it with the renderer's `camera` option instead of creating a second camera:

```ts
const renderer = new WebGPU3DRenderer(canvas, {
  camera: { fov: 65, near: 0.05, far: 100 },
});
const camera = renderer.camera;
```

Set `camera: false` to disable auto-creation. Then create the primary before `init()`:

```ts
const renderer = new WebGPU3DRenderer(canvas, { camera: false });
const camera = renderer.cameras.create({ fov: 65, near: 0.05, far: 100 });
await renderer.init();
```

`create` throws when `maxCameras` (default 2) is reached. Views draw in ascending `priority`; the first enabled view clears the color target and later views load unless `clearColor` is set. Camera effects require a full-screen rect. Occlusion culling runs only with one view. LOD follows the current primary; directional shadow focus and the stateful raycast stay on the camera that was primary at construction when `setPrimary` is called later. `raycast` and `worldToScreen` default to the primary; for a partial rect, screen coordinates are local to the view.

### 2D — `WebGPU2DRenderer`

```ts
interface WebGPU2DRendererOptions {
  assets?: AssetBucket;           // AssetBucket<'2d'>
  maxInstances?: number;          // also accepts `maxSprites` as an alias
  maxSprites?: number;
  clearColor?: [number, number, number, number];
  autoResize?: boolean;
  maxEffects?: number;            // camera-effect chain capacity (default 20)
  maxCameras?: number;            // registered camera capacity (default 2)
  camera?: Camera2DCreateOptions | false; // options for the primary; false disables auto-create
  maxLayers?: number;             // default layer registry capacity (1-32, default 32)
  debug?: boolean | Logger;
}

const renderer = new WebGPU2DRenderer(canvas, {
  assets,
  maxSprites: 60_000,
  clearColor: [0.2, 0.05, 0.15, 1],
  autoResize: true,
});
await renderer.init();

renderer.camera.x = 600;         // world-space center
renderer.camera.y = 400;
renderer.camera.zoom = 1;
renderer.camera.screenToWorld(sx, sy);   // [wx, wy]

// Sprite-sheet from the AssetBucket:
const sheet = assets.prefabs.get('characters');
// Or directly (no bucket):
const sheet2 = await renderer.sheets.load({ image: '/sprites.png', frameWidth: 32, frameHeight: 32 });

const sprite = renderer.sprites.add({
  sheet,
  sprite: 0,                     // frame index
  position: [100, 200],
  scale: 32,                     // world-space size
  layer: 0,                      // optional, for back-to-front draw order
  tint: [1, 1, 1, 1],            // RGBA tint, optional
  opacity: 1,
  rotation: 0,
  flipX: false,
  flipY: false,
});

// sprites.add returns a SpriteHandle (a SpriteAccessor at runtime). Transform,
// opacity, layer, and flip are PROPERTIES (assign directly); tint is a method.
sprite.x = 150;                  // direct property assignment — picked up next render
sprite.y = 200;
sprite.rotation = 0.5;
sprite.scaleX = 1.5;
sprite.scaleY = 1.5;
sprite.opacity = 0.5;            // property, not setOpacity()
sprite.flipX = true;             // properties, not setFlip()
sprite.flipY = false;
sprite.layer = 2;
sprite.setTint(1, 0, 0, 1);      // setTint IS a method (r, g, b, a=1)
sprite.destroy();                // or renderer.sprites.remove(sprite.id)

renderer.storePreviousState();   // call in 'pre-tick' for GPU lerp
renderer.render(alpha);
renderer.onResize((w, h) => { /* ... */ });
```

`renderer.sprites` is a collection manager: `get(id)`, `has(id)`, `each(cb)`, `remove(id)`, `clear()`, `capacity`, `count`, and an `events` system. Sprites carry a versioned `id` and an `alive` flag; `sprite.destroy()` is idempotent and frees the slot. Sprites bucket by `(layer, spritesheet)`; one draw call per bucket. For thousands of sprites in a hot system, write through the raw `SpriteAccessor` façade instead of the ergonomic handle — see the [performance guide](./performance.md). `renderer.sheets` and `renderer.geometry` are the other 2D managers. `renderer.raycast` works against sprite hitboxes, sorted topmost-first.

### 3D — `WebGPU3DRenderer`

```ts
interface WebGPU3DRendererOptions {
  assets?: AssetBucket;
  maxInstances?: number;                   // defaults to assets.prefabs.size + 16 when a bucket is given
  maxSkinnedInstances?: number;            // cap on simultaneously animated meshes
  maxBonesPerSkin?: number;                // cap on bones per skinned model
  animationCullDistance?: number;          // skip CPU skinning for instances farther than this (default 50)
  maxLights?: number;                      // max live dynamic lights (default 64)
  maxMaterials?: number;                   // max live materials (default 64)
  maxDecals?: number;                      // max decal layers (default 16)
  maxCameraEffects?: number;               // camera-effect chain capacity (default 20)
  maxCameras?: number;                     // registered camera capacity (default 2)
  camera?: Camera3DCreateOptions | false;  // options for the primary; false disables auto-create
  maxLayers?: number;                      // default layer registry capacity (1-32, default 32)
  maxParticles?: number;                   // max live 3D particles, rounded to a power of two (default 4096)
  maxParticleMaterials?: number;           // max distinct particle materials (default 16)
  maxParticleEmitters?: number;            // max live particle emitters (default 64)
  shadowResolution?: number;               // directional shadow map size (default 2048)
  maxSpotShadows?: number;                 // max casting spot lights per frame (default 4)
  maxPointShadows?: number;                // max casting point lights (cube maps) per frame (default 2)
  pointShadowResolution?: number;          // point shadow cube face size (default 512)
  maxPixelRatio?: number;                  // caps devicePixelRatio; scene + post + shadows scale with it (default uncapped)
  clearColor?: [number, number, number, number];
  autoResize?: boolean;
  debug?: boolean | Logger;
}

interface MeshInstanceOptions {
  prefab: ModelHandle | GltfModel | Prefab3D | string;  // prefab from assets.prefabs.get(id), or a registered prefab id string
  position?: readonly [x: number, y: number, z: number];
  rotation?: readonly [x: number, y: number, z: number];  // Euler radians
  scale?: number | readonly [x: number, y: number, z: number];
  color?: readonly [r: number, g: number, b: number];     // flat RGB tint, SET-AT-SPAWN ONLY — there is no setColor on the handle
  material?: MaterialHandle;                              // sugar for a one-element `materials` list
  materials?: readonly MaterialHandle[] | Record<string, MaterialHandle>;
  texture?: string | TexturePrefab;                       // per-instance texture override
}
```

**Version note (0.1.8): `color` vs `tint`.** The 3D instance option is `color: [r, g, b]` — 3 components, RGB, set at spawn only. `tint` is the **2D sprite** option: `renderer.sprites.add({ tint: [r, g, b, a] })` (4 components), plus the live `SpriteHandle.setTint(r, g, b, a)` method. Do not mix them — `instances.add({ tint: [...] })` and `renderer.sprites.add({ color: [...] })` do not exist in 0.1.8. If you see 4-component `tint` passed to a 3D `instances.add`, that code is mixing the 2D API into 3D and the tint will be silently ignored (and won't type-check in TS).

```ts
const renderer = new WebGPU3DRenderer(canvas, {
  assets,
  maxInstances: 5000,
  clearColor: [0.05, 0.07, 0.13, 1],
  autoResize: true,
  animationCullDistance: 15,
  maxPixelRatio: 1.5,          // cheapest large perf win on HiDPI: caps the internal resolution
});
await renderer.init();

const hero   = assets.prefabs.get('hero');
const handle = renderer.instances.add({
  prefab: hero,
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],                       // or a single number
  color:  [1, 0.5, 0.2],                  // RGB tint, optional — option name is `color`, NOT `tint` (tint is the 2D option)
});

handle.setPosition(x, y, z);
handle.setRotation(x, y, z);
handle.setScale(sx, sy, sz);
handle.teleport(x, y, z);                 // snap without interpolation (use after a respawn)
handle.position;                          // [x, y, z] — read-only reference (shared)
handle.rotation;
handle.scale;
handle.play?.(hero.animations.Idle, { loop: true, crossfade: 0.15, onEnd: () => { /* ... */ } });
handle.stop?.();
handle.setTexture('smoke');               // per-instance texture swap (or a TexturePrefab)
handle.setMaterial(materialId);           // swap material (0 = engine default)
handle.setMaterialParams(1.5, 0);         // writes statics[slot].custom0 / custom1
handle.destroy();                         // frees the slot + bone-matrix block; respawns reuse them

renderer.instances.remove(handle.id);
renderer.setAnimationCullDistance(20);
renderer.animationCullDistance;           // getter
renderer.instances.capacity;              // non-skinned instance capacity
renderer.instances.count;                 // live non-skinned instances
renderer.instances.skinnedCapacity;       // skinned instance capacity
renderer.instances.skinnedCount;          // live skinned instances
renderer.instances.totalCapacity;         // both pools
renderer.instances.totalCount;            // both pools
renderer.lights.count;                    // live dynamic lights
renderer.storePreviousState();            // call in 'pre-tick' for GPU lerp
renderer.render(alpha);                   // call in 'render'

renderer.raycast.update(input);           // cursor picking — see the source renderer README
renderer.raycast.hit({ filter });
renderer.debug.hitboxes = true;           // draw hitbox wireframes (green = hovered, magenta = idle)

// One-off / debug conveniences — return a ModelHandle / GltfModel for instances.add.
// For anything you spawn more than once, declare a prefab in AssetBucket instead
// (parallel load, typed ids, GPU sizing — see the AssetBucket section):
const grid   = renderer.models.createGrid({ size: 50, step: 1, lineWidth: 0.01 });
const cube   = renderer.models.createCube({ size: 1 });
const sphere = renderer.models.createSphere({ segments: 24, textureId: 'ball' });
const cyl    = renderer.models.createCylinder({ segments: 16 });
const cone   = renderer.models.createCone({ segments: 12 });
const plane  = renderer.models.createPlane({ width: 4, height: 3, textureId: 'wall' });
const model  = renderer.models.loadModel(rawModelData);          // raw geometry (ModelData), no bucket
const gltf   = await renderer.models.loadGltf('https://example.com/model.glb', { animations: ['Idle'] });  // manual glTF path
const up     = renderer.models.uploadParsedGltf(parsedGltf);     // GPU-upload an already-parsed glTF (CPU/GPU split)
```

`instances.add` returns an `InstanceHandle`. For single-mesh prefabs it's also a `MeshInstanceHandle` at runtime — both names work; pass the handle's `id` to `instances.remove`.

**Per-instance color is immutable after spawn.** Set it once via `instances.add({ color: [r, g, b] })`. There is no `setColor` / `setTint` on the 3D handle — to recolor, `destroy()` the instance and re-add it. (2D sprites differ: `SpriteHandle.setTint(...)` is live — see the 2D section.) In 0.1.8 the 3D option is named `color` — any example showing `tint` on a 3D `instances.add` is using the 2D sprite API by mistake.

**Prefabs and composites.** `prefab` accepts a `ModelHandle`/`GltfModel` from `renderer.models`, a registered prefab id string, or a `Prefab3D` from the bucket. For multi-part assets, declare a `{ type: 'composite', parts: [...] }` prefab in the `PrefabBucket`: each part references another prefab id and optionally carries a local `offset` (position/rotation); spawning the composite spawns one child per part with the offset composed onto the instance transform. Composite group handles fan `materials` / `setMaterial` / `play` out to every part. Prefer bucket prefabs over the `renderer.models` factories for anything spawned more than once.

### Camera (2D)

```ts
class Camera2D {
  // Public mutable properties
  x: number;
  y: number;
  zoom: number;
  rotation: number;

  constructor(width: number, height: number);

  get width(): number;
  get height(): number;
  setViewport(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  move(x: number, y: number): void;
  screenToWorld(sx: number, sy: number): [number, number];  // reusable tuple — don't retain
  follow(targetX: number, targetY: number, smoothing?: number): void;  // smoothing default 1
  storePrevious(): void;                  // call in 'pre-tick' for GPU lerp (already done by renderer.storePreviousState)
  interpolate(alpha: number): void;
  getMatrix(): Float32Array;              // 3x3 std140, 12 floats
}
```

### Camera (3D)

```ts
class Camera3D {
  // Public mutable properties — tuples are shared references; prefer setPosition / setTarget
  position: [number, number, number];
  target:   [number, number, number];
  up:       [number, number, number];
  fov: number;   // DEGREES in 0.1.8 (default 60) — pass `60`, NOT `Math.PI / 3` (radians)
  near: number;
  far: number;
  aspect: number;
  movement: 'local' | 'grounded' | 'global';
  // 'local'    — move relative to facing (FPS/fly camera)
  // 'grounded' — XZ movement only, ignores pitch (RTS / FPS-walk camera)
  // 'global'   — world-aligned axes (debug fly)

  setPosition(x: number, y: number, z: number): void;
  setTarget(x: number, y: number, z: number): void;
  setAspect(width: number, height: number): void;
  move(right: number, up: number, forward: number): void;  // WASD-style relative
  orbit(yawDelta: number, pitchDelta: number): void;
  zoom(delta: number): void;
  screenToRay(sx: number, sy: number): Ray3D;              // for picking
  follow(tx: number, ty: number, tz: number, smoothing?: number): void;
  storePrevious(): void;
  interpolate(alpha: number): void;
  getViewMatrix(): Float32Array;
  getProjectionMatrix(): Float32Array;
  getViewProjectionMatrix(): Float32Array;

  // Ordered fullscreen effect chain (see below).
  readonly effects: CameraEffectList;
}
```

#### Camera effects — `camera.effects`

An ordered fullscreen post chain: the scene renders off-screen, each effect is one pass (ping-pong through two targets), and the last pass presents to the swapchain. A non-empty `effects` chain enables the off-screen path; disabled entries are skipped.

```ts
renderer.camera.effects.add({ type: 'grade', saturation: 1.2 });
renderer.camera.effects.set([
  { type: 'motionBlur', feedback: 0.4 },
  { type: 'chromatic', amount: 0.3 },
  { type: 'vignette', strength: 0.3 },
]);
const blur = renderer.camera.effects.add({ type: 'motionBlur', feedback: 0.4 });
blur.feedback = 0.2;   // live
blur.enabled = false;
renderer.camera.effects.remove(blur);

for (const e of renderer.camera.effects.all('fxaa')) e.enabled = false;  // read back by type (array; a chain may hold several)
```

The list API is `add(spec | effect)`, `set(specs)` (replace the whole chain in order), `remove(effect)`, `clear()`, `count` / `length`, `at(i)`, `all(type)`, and iterable. `enableCount()` returns the number of enabled entries (this is what decides the off-screen path).

- Built-ins: `vignette` (strength/inner/outer), `grade` (saturation/contrast/brightness), `grayscale`, `chromatic` (amount), `scanlines` (intensity/frequency/speed), `posterize` (levels), `motionBlur` (temporal accumulation, feedback), `fxaa` (anti-aliasing), `fog` (exponential depth fog, color/density), `bloom` (half-res brightpass + separable blur + composite; threshold/intensity/radius). Depth-based effects (`fog`) can sample scene depth via bindings 4/5 and camera `near`/`far`.
- Custom: `new CameraEffect({ type: 'shader', fragment, uniforms?, defaultUniforms? })`. The fragment gets `input.vUV`, `textures.src`/`textures.sampler`, `material.<name>`, `scene.time`/`scene.resolutionX/Y`, and `history`; retune via `effect.params`. See the [shader guide](./shaders.md).
- Chain capacity = `maxCameraEffects` (3D) / `maxEffects` (2D), default 20; `add` throws past it.
- Both renderers support this: `renderer.camera.effects` on `WebGPU3DRenderer` and `WebGPU2DRenderer` alike. The 2D renderer enables the off-screen path the same way; it has no scene depth, so depth-based effects (`fog`) use a 1x1 fallback depth target (effectively a no-op).

### Particles (2D)

CPU-driven particles, drawn as sprites through the 2D renderer.

```ts
interface Range { min: number; max: number; }

interface ParticleEmitterConfig {
  max: number;
  lifetime:  Range;
  speed:     Range;
  size:      Range;
  gravity?:  [number, number];
  color:     [number, number, number, number];
  direction: Range;                       // degrees
  fadeOut?:  boolean;
  sheet?:    SpritesheetHandle;
  sprite?:   number;                      // frame index
  seed?:     number;                      // deterministic emission
}

class ParticleEmitter {
  constructor(renderer: WebGPU2DRenderer, config: ParticleEmitterConfig);
  emit(x: number, y: number, count?: number): void;   // count default 1
  update(deltaTime: number): void;
  getActiveCount(): number;
  clear(): void;
}

const particles = new ParticleEmitter(renderer, {
  max: 5000,
  lifetime:  { min: 0.5, max: 1.5 },
  speed:     { min: 50, max: 200 },
  size:      { min: 2, max: 6 },
  gravity:   [0, -200],
  color:     [1, 0.6, 0.1, 1],
  direction: { min: 45, max: 135 },
  fadeOut:   true,
  sheet,
  sprite:    1,
});

particles.emit(x, y, 50);
particles.update(deltaTime);
```

### Particles (3D) — `renderer.particles`

GPU-first: the CPU only queues spawn records; the GPU spawns into a power-of-two ring pool, integrates in compute, and draws instanced camera-facing quads batched by material (per-material compaction + `drawIndirect`).

```ts
const fire = renderer.particles.addEmitter({
  position: [x, y, z], rate: 160,
  lifetime: [0.5, 1.3], speed: [0.6, 2.2],
  spread: 0.6, direction: [0, 1, 0], gravity: [0, 1.5, 0],
  size: [0.1, 0.28], color: [1, 0.55, 0.15, 1],
  spawnRadius: 0.3, grow: 1.8, spin: 0.5, turbulence: 0.6,
  material: { texture: 'spark', blend: 'additive', atlas: { cols: 4, rows: 4, fps: 6 } },
  seed: 1,
});

fire.rate = 0;  fire.enabled = false;   // live
fire.update(deltaTime);                  // queue this emitter's spawns (call in tick)
renderer.particles.simulate(deltaTime);  // advance the pool (render(alpha) already does this)
renderer.particles.removeEmitter(fire);
```

- Emitter options (defaults): `position [0,0,0]`, `rate 50`, `lifetime [0.5,1.0]`, `speed [1,3]`, `spread 0.35` (radians), `direction [0,1,0]`, `gravity [0,-9.8,0]`, `size [0.1,0.2]`, `color [1,1,1,1]`, `spawnRadius 0`, `grow 1`, `spin 0`, `turbulence 0`, `material` (soft additive disc), `seed 1`.
- `emitter.update(dt)` queues spawns for that emitter (safe to call on several emitters; it costs no extra simulation). The renderer runs `simulate(dt)` once per frame (spawn kernel + integrate + per-material compaction + indirect args); `renderer.particles.simulate(dt)` is available if you drive rendering yourself. The public facade exposes `simulate`, not `update` (see Gotchas).
- Material: `{ texture?, blend: 'additive'|'alpha', atlas?: { cols, rows, fps } }`. No texture -> soft procedural disc.
- Quality knobs: `rateScale` (default 1; 0 stops spawning) and `sizeScale` (default 1.1). `particleCount` is the spawned high-water mark (draw instance count), not a live count. Capacities (renderer options): `maxParticles` (4096), `maxSpawnsPerFrame` (512), `maxParticleMaterials` (16), `maxParticleEmitters` (64). Warns once via `debug` when the pool saturates or the spawn budget clamps.
- Emitter culling: the renderer sets the camera frustum on the particle system each frame, so an emitter whose conservative reach is off-screen spawns nothing until it re-enters view (live particles still finish). Set it yourself with `renderer.particles.setCullFrustum(frustum | null)`.

### `SpriteAccessor` — direct buffer access for 2D sprites

`renderer.sprites.add` returns a `SpriteAccessor` at runtime (typed as `SpriteHandle`). It reads/writes the renderer's `Float32Array`s directly with no per-call allocation — the fastest path for thousands of sprites in a hot system. See the [performance guide](./performance.md) for 2D batching and direct sprite-buffer access.

### Typed shader DSL — `d` and `std`

Custom materials, camera-effect fragments, compute kernels, and `GeometryBuilder` all use the `d`/`std` DSL. See the [shader guide](./shaders.md) for the DSL, custom materials/effects, compute authoring, `std.shadeLight`, and the helper signatures.

### Custom instanced geometry — `GeometryBuilder` / `CustomGeometry`

`renderer.geometry.create(name, { maxInstances, geometry })` (on the 2D renderer) builds a custom instanced draw with per-frame `dynamic` fields, per-instance `static` fields, uniforms, and DSL vertex/fragment shaders. `.fromBuffer(buffer)` binds an external storage buffer instead of `addInstance`. See the [shader guide](./shaders.md).

### `AnimationController` — 2D spritesheet animation

Drives frame index over time. The output `frame: number` is read by `SpriteAccessor` / `SpriteHandle` to pick the UV slice.

```ts
interface AnimationClipConfig {
  name: string;
  frames: number[];           // frame indices into the spritesheet
  durations: number[];        // milliseconds per frame (same length as frames)
  loop: boolean;
}

interface AnimationClip {
  readonly id: number;
  readonly name: string;
  readonly frames: Uint16Array;
  readonly durations: Float32Array;
  readonly frameCount: number;
  readonly totalDuration: number;
  readonly loop: boolean;
}

interface AnimationState {
  clipId: number;
  frame: number;              // current spritesheet frame index
  time: number;               // milliseconds into the current clip
  speed: number;              // 1.0 = real-time, 0.5 = half-speed
  playing: boolean;
}

class AnimationController {
  loadClip(config: AnimationClipConfig): number;
  getClipId(name: string): number;
  getClip(id: number): AnimationClip;
  createState(clipId: number, speed?: number, playing?: boolean): AnimationState;
  update(state: AnimationState, deltaTime: number): number;  // returns the current frame index
  play(state: AnimationState, clipId: number, speed?: number): void;
  stop(state: AnimationState): void;
  resume(state: AnimationState): void;
  get clipCount(): number;
}
```

`deltaTime` is in seconds; `durations` are in milliseconds (the update multiplies `deltaTime * speed * 1000`).

### `MorphAnimation` — 3D morph-target animation

Evaluates morph weights (or vertex deltas) on the CPU and writes the result into a `Float32Array` you supply each frame. Use for facial animation, blendshapes, low-poly skin alternatives.

```ts
interface MorphClipConfig {
  name: string;
  keyframes: Float32Array[];  // per-frame vertex/weight payload (vertexCount * 3 floats each)
  durations: number[];        // milliseconds per keyframe transition
  loop: boolean;
}

interface MorphClip {
  readonly id: number;
  readonly name: string;
  readonly keyframes: Float32Array[];
  readonly durations: Float32Array;
  readonly frameCount: number;
  readonly totalDuration: number;
  readonly loop: boolean;
  readonly vertexCount: number;
}

interface MorphState {
  clipId: number;
  time: number;
  speed: number;
  playing: boolean;
}

class MorphAnimation {
  loadClip(config: MorphClipConfig): number;
  getClipId(name: string): number;
  getClip(id: number): MorphClip;
  createState(clipId: number, speed?: number, playing?: boolean): MorphState;
  update(state: MorphState, deltaTime: number, output: Float32Array): void;  // writes interpolated payload into `output`
  play(state: MorphState, clipId: number, speed?: number): void;
  stop(state: MorphState): void;
  resume(state: MorphState): void;
  get clipCount(): number;
}
```

### 3D skeletal animation

Skinned glTF instances expose `handle.play?(name, opts)` and `handle.stop?()`. Clip names are typed from the prefab (`hero.animations.Idle`).

```ts
handle.play?.(hero.animations.Idle, {
  loop: true,          // default true
  crossfade: 0.15,     // blend seconds from the previous clip
  onEnd: () => { /* fires when a non-looping clip ends */ },
});
handle.stop?.();
```

`SkeletalAnimation` itself (CPU-side bone evaluation, `GltfPrefab.animations`, lazy `loadAnimations()`/`unloadAnimations()` with the bucket's `'clips-changed'` event) lives in `murow/renderer/gltf` and is renderer-agnostic. The WebGPU backend packs and runs it on the GPU. Animation culling uses `animationCullDistance`; skinned instances farther than it still draw but reuse their last bone matrices (their clocks keep ticking) — call `renderer.setAnimationCullDistance(d)` at runtime. The netcode guide covers how animated transforms relate to server snapshots.

### Other WebGPU exports

- `Spritesheet`, `createTextureFromBitmap` — manual GPU texture/atlas building if you're not going through `AssetBucket`.
- `GeometryData`, `BuiltInGeometry`, `resolveBuiltInGeometry` — for plugging custom vertex layouts into `createGeometry`.
- `createCube`, `createPlane`, `createGrid`, `createSphere`, `createCylinder`, `createCone` — individual geometry factory functions (e.g. `createCube({ size: 2, uv: 'cross' })`).
- `DynamicSprite`, `StaticSprite`, `SpriteUniforms`, `DynamicInstance3D`, `StaticInstance3D`, `DynamicMesh`, `StaticMesh`, `SkinnedStaticMesh`, `MeshUniforms` — exported `d.struct` shapes the renderer uses internally. Use these if you want to pack data into the same format the renderer reads.
- Type exports: `MaterialSpec` / `EngineMaterialSpec` / `PbrMaterialSpec` / `PbrTextures` / `MaterialSampling` / `ShaderMaterialSpec` / `MaterialHandle` / `IblManager` / `IblLoadOptions` / `SkyboxManager` / `InstanceMaterials` / `MaterialRef` / `BlendMode` / `CullMode` / `LightSpec` / `LightHandle` / `MeshInstanceOptions` / `WebGPU3DRendererOptions` / `WebGPU2DRendererOptions` and the camera-effect types.

### Shader util signatures (DSL helpers — call inside vertex/fragment closures)

See the [shader guide](./shaders.md) for the helper signatures, `std.shadeLight`, tone mapping, and noise functions.

## Worked examples

### A 3D scene: lights, materials, shadow, loop

```ts
import { GameLoop } from 'murow';
import { WebGPU3DRenderer, d, std } from 'murow/webgpu';

const renderer = new WebGPU3DRenderer(canvas, { assets, maxInstances: 5000, maxPixelRatio: 1.5 });
await renderer.init();

renderer.camera.setPosition(6, 4, 6);
renderer.camera.setTarget(0, 0, 0);

renderer.lights.sun([0.5, -0.8, 0.3], [1, 0.95, 0.9], 1.5);
renderer.lights.ambient([0.1, 0.1, 0.15]);
const lamp = renderer.lights.add({ type: 'point', position: [0, 5, 0], color: [1, 0.4, 0.2], intensity: 3, range: 20 });

const ground = renderer.materials.create({ name: 'ground', type: 'standard', texture: 'brick', shadow: { receive: true, cast: false } });
const crate  = renderer.materials.create({ name: 'crate',  type: 'standard', texture: 'wood' });

const floor = renderer.instances.add({ prefab: 'floor', material: ground });
for (let i = 0; i < 100; i++) {
  renderer.instances.add({ prefab: 'box', material: crate, position: [(i % 10) - 5, 0.5, ((i / 10) | 0) - 5] });
}

const loop = new GameLoop({ type: 'client', tickRate: 20 });
loop.on('pre-tick', () => renderer.storePreviousState());
loop.on('tick', () => { lamp.setPosition(Math.sin(performance.now() / 1000) * 4, 5, 0); });
loop.on('render', ({ alpha }) => renderer.render(alpha));
```

### A toon outline with multiple materials

```ts
const body    = renderer.materials.create({ name: 'body',    type: 'standard', texture: 'skin' });
const outline = renderer.materials.create({
  name: 'outline', type: 'emissive', color: [0, 0, 0], emissive: 0,
  extrude: 0.03, cull: 'front',
});

const hero = renderer.instances.add({ prefab: 'hero', materials: [body, outline] });
hero.materials.has('outline');   // true
```

### A 2D scene with a camera effect

```ts
const renderer = new WebGPU2DRenderer(canvas, { assets, maxSprites: 20_000 });
await renderer.init();

renderer.camera.effects.add({ type: 'vignette', strength: 0.3 });

const sprite = renderer.sprites.add({ sheet: assets.prefabs.get('characters'), sprite: 0, position: [400, 300], scale: 32 });
sprite.setTint(1, 0.6, 0.2, 1);

const loop = new GameLoop({ type: 'client', tickRate: 30 });
loop.on('pre-tick', () => renderer.storePreviousState());
loop.on('render', ({ alpha }) => renderer.render(alpha));
```

## Gotchas

- **Forgetting `renderer.storePreviousState()` in `pre-tick`.** Without it motion snaps at low tick rates (the GPU has only the current pose to interpolate from).
- **`renderer.camera.position[0] = 5`.** The tuple property is a shared reference; use `renderer.camera.setPosition(5, y, z)`. Same for `LightHandle.position/direction/color` and instance handles.
- **`renderer.camera.fov = Math.PI / 3`.** `fov` is DEGREES (default 60): `renderer.camera.fov = 60`. Radians give a ~1° view, effectively black.
- **`instances.add({ tint: [...] })` (3D).** The 3D option is `color: [r, g, b]` (3 components, set at spawn). `tint: [r, g, b, a]` is the 2D sprite option (`sprites.add` / `SpriteHandle.setTint`).
- **`handle.setColor(...)` on a 3D instance.** No such method — `destroy()` and re-add to recolor. 2D `SpriteHandle.setTint` is live.
- **`instances.add({ model: ... })`.** The option key is `prefab`.
- **`renderer.models.createCube(...)` for the player / obstacles / ground.** Declare reusable models as `AssetBucket` prefabs (`assets.prefabs.get('id')`); the `renderer.models` factories are one-off/debug conveniences.
- **A duplicate material name throws.** Names are unique per renderer. `name` is optional (auto `mat_<id>` when omitted); if you pass one it must be free.
- **`material.destroy()` while instances use it throws.** Pass `{ force: true }` to reassign them to the default material first.
- **Materials must be created after `init()`.** They are GPU resources.
- **`handle.destroy()` then `handle.setPosition(...)`.** `destroy()` invalidates the handle — later calls are undefined (the slot may be recycled).
- **`handle.destroy()` does not reclaim GPU memory**, only the pool slot. Full reclamation is `renderer.destroy()`.
- **`shader` materials need `shaders.fragment`**, and minifying shader bodies with `minifySyntax: true` corrupts them — see the [shader guide](./shaders.md).
- **A non-empty `camera.effects` chain forces the off-screen path.** Even one effect switches to the ping-pong path. Remove effects you no longer need to get the direct path back.
- **Material count multiplies 3D draw calls.** `materials: [...]` draws the instance once per material (up to 4). Prefer one material per model on the hot path — see the [performance guide](./performance.md).
- **Spot and point shadow maps re-render every frame.** Only the directional map is cached. Enable them sparingly and gate with `renderer.shadows.spot` / `.point`.
- **Expecting an HDR skybox.** The skybox displays the same LDR environment used for IBL. There is no HDR/float environment path or exposure control yet.
- **Textures in a 3D sprite atlas must sample LOD 0** to avoid cross-cell bleed (the engine particle path does; a custom shader does not automatically).
- **`renderer.geometry` is on the 2D renderer.** The 3D renderer has no geometry manager (use `GeometryBuilder` indirectly through the 2D renderer or custom materials on meshes).
- **`renderer.particles.update(dt)` is not a method.** The particle facade exposes `simulate(dt)` (and `renderer.render(alpha)` calls it for you); you only call `emitter.update(dt)` to queue that emitter's spawns.
- **There is no public `renderer.compute`.** Skeletal animation and GPU particles are backend ports the WebGPU runtime implements with an internal `ComputeBuilder`; `renderer.geometry` (2D) covers custom instanced draws.
- **Fixed capacities are set at construction.** `maxInstances`, `maxSkinnedInstances`, `maxLights`, `maxMaterials`, `maxParticles`, emitter counts, shadow capacities, and the camera-effect chain are all sized up front (many from the `AssetBucket`); exceeding a fixed pool logs and throws.

## Quick reference

| want | use |
|---|---|
| a 3D renderer | `new WebGPU3DRenderer(canvas, { assets, … })` → `await init()` → `render(alpha)` |
| a 2D renderer | `new WebGPU2DRenderer(canvas, { assets, … })` → `await init()` → `render(alpha)` |
| per-frame interpolation | `loop.on('pre-tick', () => renderer.storePreviousState())` |
| spawn a mesh | `renderer.instances.add({ prefab, position, rotation, scale, color })` |
| spawn a 2D sprite | `renderer.sprites.add({ sheet, sprite, position, scale, layer, tint })` |
| a surface material | `renderer.materials.create({ type: 'standard' \| 'unlit' \| 'emissive' \| 'shader', … })` |
| multiple materials / toon outline | `instances.add({ materials: [...] })` + `extrude` + `cull:'front'` |
| a dynamic point/spot light | `renderer.lights.add({ type: 'point' \| 'spot', position, direction, … })` |
| global sun / ambient | `renderer.lights.sun(dir, color, intensity)` / `renderer.lights.ambient(color)` |
| shadows | `renderer.shadows.directional` / `.spot` / `.point`; per material `shadow: { cast, receive }` |
| a surface mark | `renderer.decals.createLayer({ atlas, quad, capacity })` → `layer.add(x,y,z,nx,ny,nz,{cell,size})` |
| 2D particles | `new ParticleEmitter(renderer, config)` → `emit()` / `update(dt)` |
| 3D particles | `renderer.particles.addEmitter({ … })` / `emitter.update(dt)` / `renderer.particles.simulate(dt)` |
| a post effect | `renderer.camera.effects.add({ type: 'vignette' \| 'bloom' \| 'fog' \| 'shader', … })` |
| move the camera | `renderer.camera.setPosition(...)` / `setTarget(...)` / `move(...)` / `orbit(...)` |
| cursor picking | `renderer.raycast.update(input)` then `renderer.raycast.hit({ filter })` |
| a 2D spritesheet animation | `AnimationController` (`loadClip` / `createState` / `update`) |
| a 3D morph animation | `MorphAnimation` (`loadClip` / `createState` / `update`) |
| a 3D skeletal animation | `handle.play(hero.animations.Idle, { loop, crossfade, onEnd })` |
| custom shaders / compute / geometry | see the [shader guide](./shaders.md) |
| frame-budget levers | see the [performance guide](./performance.md) |
| pooled/versioned managers | see the [zero-allocation guide](./zero-allocation.md) |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)



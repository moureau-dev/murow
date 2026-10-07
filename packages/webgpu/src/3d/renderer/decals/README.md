# Decals

Pooled surface marks — blood, scorch, AoE rings, bullet holes — drawn as
instanced `plane` quads oriented to a surface normal. One atlas texture holds
every mark; each decal picks a cell via its per-instance channel, and fades out
over time. The whole pool is one instanced draw call.

## Usage

```ts
const decals = renderer.createDecalLayer({
  atlas: 'decals',      // AssetBucket texture id (a grid of marks)
  quad: 'decalQuad',    // AssetBucket plane prefab (default)
  capacity: 256,        // pool size; oldest recycled past this
  cols: 4, rows: 4,     // atlas grid
  life: 8,              // seconds to fade
});

// From a hit point + surface normal:
decals.spawn(x, y, z, nx, ny, nz, { cell: 2, size: 0.8 });
```

## How it works

- **`decal-material.ts`** builds the material: `type: 'shader'`, `lit: false`,
  `blend: 'alpha'`, `depthWrite: false`, `cull: 'none'`. The fragment reads
  `input.vCustom` (`x` = atlas cell, `y` = spawn time) and fades by
  `scene.time - spawn`.
- **`orientation.ts`** is the pure math: given a normal it returns the Euler that
  points a `+Z` quad along it, spun by `roll`. Unit-tested in
  `orientation.test.ts`.
- **`decal-layer.ts`** owns a `RingStore<{ instance }>` from `murow/core/ring`.
  Slots start empty and register their instance on first `spawn`, so unspawned
  decals never enter the instance store. Wrapping past `capacity` recycles the
  oldest; placement uses `teleport` so marks don't slide into place.

## Notes

- Per-decal data rides the engine's `vCustom` varying (`custom0`/`custom1` set via
  `setMaterialParams`). Keep decals on one material so they stay a single batch —
  per-decal textures would break instancing.
- The atlas and quad come from the `AssetBucket`; nothing else is registered.
- The material is transparent, so decals are excluded from the shadow pass
  (`cast: false`) and drawn in the transparent pass.
- The fade is shader-side, so the CPU never expires marks; the pool only recycles.

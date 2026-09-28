# Bucket

Generic base class for **typed registries of loadable resources**. One
lifecycle for anything you declare up front and consume by id later.

```ts
const bucket = new Bucket<MySpec, MyPrefab>({ my: parseMy })
  .add({ type: 'my', id: 'thing', /* ... */ });

await bucket.load();
bucket.get('thing');   // MyPrefab, narrowed by id
```

## Lifecycle

1. `add()` / `addAll()` collect specs synchronously (no I/O).
2. `load()` runs every registered parser in parallel, emitting `loading`
   per item and `load-complete` once at the end. Idempotent.
3. `get()` / `entries()` read the parsed results; the bucket is now frozen
   (`add()` throws).

## Specs, parsers, prefabs

- A **spec** is declarative data: `{ type, id, ... }` (`BucketSpecBase`).
- A **parser** turns a spec into its result: `(spec, ctx) => Prefab | Promise<Prefab>`
  (`BucketParser<Spec, Prefab>`), registered by `type`.
- A **prefab** is the parsed result, addressed by `id` (`BucketPrefabBase`).

Parsers receive a `ParserContext` carrying the bucket's `events` channel, so
long loads can report progress.

## Typed ids

`add<const S>()` accumulates the spec record as a const generic, so
`bucket.get('typo')` is a compile-time error once specs have been added, and
the return type narrows to the matching prefab variant.

## Where it lives

`core/bucket` — the base is resource-agnostic and shared by consumers in
different layers (renderer buckets for textures/prefabs, the audio bucket for
clips). It depends only on `core/events`. Concrete buckets live with their
subsystem:

- `renderer/buckets/` — `TextureBucket`, `PrefabBucket`, `AssetBucket`
- `core/audio/` — `AudioBucket`

## See also

- [Events](../events) — the `EventSystem` behind `loading` / `load-complete`
- [AssetBucket](../../renderer/buckets/asset) — renderer assets under one `load()`

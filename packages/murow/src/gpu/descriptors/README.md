# descriptors

Resource and pipeline descriptions as plain data. Backend-agnostic; each backend
translates them to its API.

- `vertex-layout.ts` - attributes, strides, step mode.
- `bind-group.ts` - bindings (uniform/storage/texture/sampler) and visibility.
- `render-state.ts` - blend, depth, cull, write mask.
- `pipeline.ts` - pipeline descriptor assembled from the above.

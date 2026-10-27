# Ribbons

One dynamic strip batch for lines, ribbons, trails, and beams.

- `RibbonManager` is exposed as `renderer.ribbons`.
- `RibbonBatch` owns the pipeline, vertex/index buffers, texture bind groups, and the per-view draw.
- Lines and ribbons are raw point lists.
- Trails keep a bounded time history from `setHead`.
- Beams are two endpoints with optional noise and UV scroll.
- Each kind has its own pool and capacity; the vertex budget is shared.
- Tick updates geometry; `render()` calls `simulate(dt)` and draws at `alpha`.

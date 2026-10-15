# Spatial

Spatial partitioning/index structures for neighbor and overlap queries. Pure CPU,
renderer- and ECS-agnostic, headless-capable — same family as `NavMesh`. Use them
for crowd separation, broadphase picking, vision/interest queries, batching, etc.

Every index shares [`SpatialIndex`](./spatial-index.ts):

```ts
interface SpatialIndex {
    readonly size: number;
    insert(id: number, bounds: AABB): void;   // a point is min === max
    remove(id: number): void;
    update(id: number, bounds: AABB): void;
    query(bounds: AABB, results: number[]): void;   // results is cleared + filled
    clear(): void;
}
```

`results` is a caller-owned array cleared per call — `query` allocates nothing.
Every index may return ids whose *exact* box does not overlap the query box
(cell / bucket granularity); re-test with the shape you care about. Ids must be
in `[0, capacity)` for the grid hashes and quadtree/octree use arbitrary ids.

| Class | Dim | Shape | Notes |
|---|---|---|---|
| [`SpatialGrid`](./spatial-grid/spatial-grid.ts) | 2D | fixed uniform grid | bounded region; exact; typed arrays, no `Map`/`Set` |
| [`SpatialHash`](./spatial-hash/spatial-hash.ts) | 2D | hashed grid | unbounded coords (negative/large); buckets collide |
| [`Quadtree`](./quadtree/quadtree.ts) | 2D | dynamic tree | adapts to clustered data; subdivides past `maxItems` |
| [`Octree`](./octree/octree.ts) | 3D | dynamic tree | the 3D twin of `Quadtree` |

```ts
import { SpatialHash } from 'murow/core/spatial';

const grid = new SpatialHash({ cellSize: 8, capacity: 4096 });
grid.insert(enemy, { minX: x, minY: y, maxX: x, maxY: y });

const nearby: number[] = [];
grid.query({ minX: px - r, minY: py - r, maxX: px + r, maxY: py + r }, nearby);
for (const id of nearby) { /* exact distance test, push apart, etc. */ }
```

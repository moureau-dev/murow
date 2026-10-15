# Spatial

Spatial partitioning and index structures for neighbor and overlap queries. Pure
CPU, no renderer or ECS dependency.

Every index shares [`SpatialIndex`](./spatial-index.ts):

```ts
interface SpatialIndex {
    readonly size: number;
    insert(id: number, bounds: AABB): void;   // a point is min === max
    remove(id: number): void;
    update(id: number, bounds: AABB): void;
    query(bounds: AABB, results: number[]): void;   // results is cleared and filled
    clear(): void;
}
```

`results` is a caller-owned array, cleared per call. A query matches at cell or
node granularity, so it may return ids whose exact box does not overlap the query
box; re-test with the shape you need.

| Class | Dim | Index |
|---|---|---|
| [`SpatialGrid`](./spatial-grid/spatial-grid.ts) | 2D | fixed uniform grid over a bounded region |
| [`SpatialHash`](./spatial-hash/spatial-hash.ts) | 2D | hashed grid for unbounded coordinates |
| [`Quadtree`](./quadtree/quadtree.ts) | 2D | dynamic tree that subdivides as it fills |
| [`Octree`](./octree/octree.ts) | 3D | dynamic tree that subdivides as it fills |

```ts
import { SpatialHash } from 'murow/core/spatial';

const grid = new SpatialHash({ cellSize: 8, capacity: 4096 });
grid.insert(enemy, { minX: x, minY: y, maxX: x, maxY: y });

const nearby: number[] = [];
grid.query({ minX: px - r, minY: py - r, maxX: px + r, maxY: py + r }, nearby);
for (const id of nearby) { /* distance test, steering, etc. */ }
```

`SpatialGrid`, `SpatialHash`, `Quadtree` and `Octree` keep their records in typed
arrays. The grid and hash take ids in `[0, capacity)`.

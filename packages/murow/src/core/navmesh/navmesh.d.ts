type ObstacleId = number;
export type Obstacle = CircleObstacle | RectObstacle | PolygonObstacle;
/**
 * NavMesh configuration options
 */
export interface NavMeshOptions<TWorkers extends boolean | 'auto' = false> {
    /**
     * Enable Web Workers for pathfinding
     *
     * - `false` (default): Synchronous pathfinding on main thread
     * - `true`: Always use worker pool (4 workers)
     * - `'auto'`: Automatically use workers when beneficial (>= 20 pending paths)
     *
     * @default false
     *
     * @remarks
     * Workers provide 3-4.5x speedup for parallel pathfinding (20+ concurrent requests).
     * For single/sequential pathfinding, sync is faster due to message passing overhead (~0.5ms).
     *
     * Use 'auto' for games where pathfinding load varies (e.g., RTS with unit groups).
     */
    workers?: TWorkers;
    /**
     * Number of workers to spawn (only used when workers = true)
     * @default 4
     */
    workerPoolSize?: number;
    /**
     * Path to worker script (required if workers = true and running in browser)
     * For Node.js/Bun, this is handled automatically
     * @example './navmesh.worker.js'
     */
    workerPath?: string;
}
/**
 * Helper type to determine return type based on worker configuration
 */
type PathResult<TWorkers extends boolean | 'auto' | undefined> = TWorkers extends false | undefined ? Vec2[] : TWorkers extends true ? Promise<Vec2[]> : Vec2[] | Promise<Vec2[]>;
export type ObstacleInput = Omit<CircleObstacle, 'id'> | Omit<RectObstacle, 'id'> | Omit<PolygonObstacle, 'id'>;
interface Vec2 {
    x: number;
    y: number;
}
interface BaseObstacle {
    id: ObstacleId;
    type: 'circle' | 'rect' | 'polygon';
    solid?: boolean;
}
export interface CircleObstacle extends BaseObstacle {
    type: 'circle';
    pos: Vec2;
    radius: number;
}
export interface RectObstacle extends BaseObstacle {
    type: 'rect';
    pos: Vec2;
    size: Vec2;
    rotation?: number;
}
/**
 * Polygon obstacle.
 * IMPORTANT: `points` must be defined relative to local origin (0,0).
 * The polygon will be rotated around (0,0) then translated to `pos`.
 * Do NOT define points in world space.
 */
export interface PolygonObstacle extends BaseObstacle {
    type: 'polygon';
    points: Vec2[];
    pos: Vec2;
    rotation?: number;
}
/**
 * Manages obstacles with spatial hashing for fast queries.
 * Version tracking prevents unnecessary rebuilds.
 */
declare class Obstacles {
    private items;
    private spatial;
    private _cachedItems;
    dirty: boolean;
    version: number;
    add(obstacle: ObstacleInput): ObstacleId;
    move(id: ObstacleId, pos: Vec2): void;
    remove(id: ObstacleId): void;
    /**
     * Fast spatial query using hash grid.
     * O(1) average case instead of O(n) linear scan.
     */
    at(pos: Vec2): Obstacle | undefined;
    get values(): Obstacle[];
}
type NavType = 'grid' | 'graph';
/**
 * Navigation mesh with spatial hashing and smart rebuild.
 *
 * Features:
 * - Spatial hash: O(1) obstacle queries
 * - Version tracking: zero unnecessary rebuilds
 * - Binary heap A*: handles 10k+ node searches
 * - Simple full rebuild: correct and fast enough
 * - Optional Web Workers: 3-4.5x speedup for parallel pathfinding
 *
 * Performance characteristics:
 * - Obstacle query: O(1) average via spatial hash
 * - Grid rebuild: O(n * area), < 1ms for typical games
 * - Pathfinding: O(b^d * log n) with binary heap
 * - Worker overhead: ~0.5ms per request (use for 20+ concurrent paths)
 *
 * Production ready for:
 * - Grid-based games
 * - RTS with < 1000 dynamic obstacles
 * - Turn-based games
 * - Moderate map sizes (< 1M cells)
 *
 * @example
 * ```ts
 * // Simple usage (synchronous) - typed as Vec2[]
 * const navmesh = new NavMesh('grid');
 * const path = navmesh.findPath({ from: {x:0, y:0}, to: {x:10, y:10} });
 *
 * // With workers (automatic) - typed as Vec2[] | Promise<Vec2[]>
 * const navmesh = new NavMesh('grid', { workers: 'auto' });
 * const path = await navmesh.findPath({ from: {x:0, y:0}, to: {x:10, y:10} });
 *
 * // With workers (always) - typed as Promise<Vec2[]>
 * const navmesh = new NavMesh('grid', { workers: true });
 * const path = await navmesh.findPath({ from: {x:0, y:0}, to: {x:10, y:10} });
 * ```
 */
export declare class NavMesh<TWorkers extends boolean | 'auto' = false> {
    private type;
    private grid?;
    private graph?;
    private lastVersion;
    obstacles: Obstacles;
    private options;
    private workerPool?;
    private pendingPaths;
    private readonly AUTO_WORKER_THRESHOLD;
    constructor(type: NavType, options?: NavMeshOptions<TWorkers>);
    /**
     * Lazy initialize worker pool
     */
    private initWorkerPool;
    /**
     * Check if we should use workers for this request
     */
    private shouldUseWorkers;
    /**
     * Adds an obstacle and returns its unique ID.
     * For polygons: ensure points are defined relative to (0,0).
     */
    addObstacle(obstacle: ObstacleInput): ObstacleId;
    /**
     * Moves an existing obstacle to a new position.
     */
    moveObstacle(id: ObstacleId, pos: Vec2): void;
    /**
     * Removes an obstacle by ID.
     */
    removeObstacle(id: ObstacleId): void;
    /**
     * Returns all current obstacles.
     */
    getObstacles(): Obstacle[];
    /**
     * Finds a path from start to goal.
     * Automatically rebuilds navigation data if obstacles changed.
     * Returns empty array if no path exists.
     *
     * @remarks
     * - If workers are disabled (false): Returns Vec2[] synchronously
     * - If workers are enabled (true): Returns Promise<Vec2[]>
     * - If workers are 'auto': Returns Vec2[] | Promise<Vec2[]> based on load
     *
     * @example
     * ```ts
     * // Synchronous (no workers) - typed as Vec2[]
     * const navmesh = new NavMesh('grid');
     * const path = navmesh.findPath({ from, to });
     *
     * // Asynchronous (with workers) - typed as Promise<Vec2[]>
     * const navmesh = new NavMesh('grid', { workers: true });
     * const path = await navmesh.findPath({ from, to });
     *
     * // Auto mode - typed as Vec2[] | Promise<Vec2[]>
     * const navmesh = new NavMesh('grid', { workers: 'auto' });
     * const result = navmesh.findPath({ from, to });
     * const path = result instanceof Promise ? await result : result;
     * ```
     */
    findPath({ from, to }: {
        from: Vec2;
        to: Vec2;
    }): PathResult<TWorkers>;
    /**
     * Async pathfinding using worker pool
     */
    private findPathAsync;
    /**
     * Smart rebuild - only rebuilds if obstacles changed.
     * Version checking eliminates unnecessary work.
     */
    rebuild(): void;
    /**
     * Cleanup resources (terminate worker pool if active)
     * Call this when you're done with the NavMesh instance.
     *
     * @example
     * ```ts
     * const navmesh = new NavMesh('grid', { workers: true });
     * // ... use navmesh ...
     * navmesh.dispose(); // Cleanup workers
     * ```
     */
    dispose(): void;
    /**
     * Get current worker status for debugging/monitoring
     */
    getWorkerStatus(): {
        workersEnabled: TWorkers;
        workerPoolActive: boolean;
        pendingPaths: number;
        usingWorkersNow: boolean;
    };
}
export {};

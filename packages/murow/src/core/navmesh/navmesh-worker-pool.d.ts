/**
 * NavMesh Worker Pool - Manages multiple workers for parallel pathfinding
 */
import { ObstacleInput } from './navmesh';
interface Vec2 {
    x: number;
    y: number;
}
export declare class NavMeshWorkerPool {
    private poolSize;
    private workerPath;
    private navType;
    private obstacles;
    private workers;
    private nextWorkerIndex;
    private requestId;
    private pendingRequests;
    private initialized;
    constructor(poolSize: number, workerPath: string, navType?: 'grid' | 'graph', obstacles?: ObstacleInput[]);
    /**
     * Initialize all workers in the pool
     */
    init(): Promise<void>;
    /**
     * Find a path using the next available worker (round-robin)
     */
    findPath(from: Vec2, to: Vec2): Promise<Vec2[]>;
    /**
     * Add an obstacle to all workers
     */
    addObstacle(obstacle: ObstacleInput): Promise<number>;
    /**
     * Remove an obstacle from all workers
     */
    removeObstacle(obstacleId: number): Promise<void>;
    /**
     * Move an obstacle in all workers
     */
    moveObstacle(obstacleId: number, pos: Vec2): Promise<void>;
    /**
     * Terminate all workers
     */
    terminate(): void;
    /**
     * Get the number of pending requests
     */
    get pendingCount(): number;
    /**
     * Get the pool size
     */
    get size(): number;
}
export {};

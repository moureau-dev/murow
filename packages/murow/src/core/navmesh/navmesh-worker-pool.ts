/**
 * NavMesh Worker Pool - Manages multiple workers for parallel pathfinding
 */

import { ObstacleInput } from './navmesh';

interface Vec2 {
  x: number;
  y: number;
}

interface PathRequest {
  id: number;
  from: Vec2;
  to: Vec2;
  resolve: (path: Vec2[]) => void;
  reject: (error: Error) => void;
}

interface PathResultMessage {
  type: 'PATH_RESULT';
  id: number;
  path: Vec2[];
  duration: number;
}

interface ErrorMessage {
  type: 'ERROR';
  error: string;
}

type WorkerResponse = PathResultMessage | ErrorMessage;

export class NavMeshWorkerPool {
  private workers: Worker[] = [];
  private nextWorkerIndex = 0;
  private requestId = 0;
  private pendingRequests = new Map<number, PathRequest>();
  private initialized = false;

  constructor(
    private poolSize: number,
    private workerPath: string,
    private navType: 'grid' | 'graph' = 'grid',
    private obstacles: ObstacleInput[] = []
  ) {}

  /**
   * Initialize all workers in the pool
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    const initPromises: Promise<void>[] = [];

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new Worker(this.workerPath, { type: 'module' });

      // Set up message handler
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;

        if (msg.type === 'PATH_RESULT') {
          const request = this.pendingRequests.get(msg.id);
          if (request) {
            request.resolve(msg.path);
            this.pendingRequests.delete(msg.id);
          }
        } else if (msg.type === 'ERROR') {
          // Reject all pending requests for this worker
          for (const [id, request] of this.pendingRequests.entries()) {
            request.reject(new Error(msg.error));
            this.pendingRequests.delete(id);
          }
        }
      };

      worker.onerror = (error) => {
        console.error('Worker error:', error);
        // Reject all pending requests for this worker
        for (const [id, request] of this.pendingRequests.entries()) {
          request.reject(new Error('Worker error'));
          this.pendingRequests.delete(id);
        }
      };

      this.workers.push(worker);

      // Initialize worker
      const readyPromise = new Promise<void>((resolve) => {
        const onReady = (e: MessageEvent) => {
          if (e.data.type === 'READY') {
            worker.removeEventListener('message', onReady);
            resolve();
          }
        };
        worker.addEventListener('message', onReady);
      });

      worker.postMessage({
        type: 'INIT',
        navType: this.navType,
        obstacles: this.obstacles,
      });

      initPromises.push(readyPromise);
    }

    await Promise.all(initPromises);
    this.initialized = true;
  }

  /**
   * Find a path using the next available worker (round-robin)
   */
  async findPath(from: Vec2, to: Vec2): Promise<Vec2[]> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized. Call init() first.');
    }

    const id = this.requestId++;
    const worker = this.workers[this.nextWorkerIndex];
    this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;

    return new Promise<Vec2[]>((resolve, reject) => {
      this.pendingRequests.set(id, { id, from, to, resolve, reject });

      worker.postMessage({
        type: 'FIND_PATH',
        id,
        from,
        to,
      });
    });
  }

  /**
   * Add an obstacle to all workers
   */
  async addObstacle(obstacle: ObstacleInput): Promise<number> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized. Call init() first.');
    }

    // Add to all workers
    const promises = this.workers.map((worker) => {
      return new Promise<number>((resolve) => {
        const onAdded = (e: MessageEvent) => {
          if (e.data.type === 'OBSTACLE_ADDED') {
            worker.removeEventListener('message', onAdded);
            resolve(e.data.obstacleId);
          }
        };
        worker.addEventListener('message', onAdded);
        worker.postMessage({ type: 'ADD_OBSTACLE', obstacle });
      });
    });

    const ids = await Promise.all(promises);
    return ids[0]; // All workers should return the same ID
  }

  /**
   * Remove an obstacle from all workers
   */
  async removeObstacle(obstacleId: number): Promise<void> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized. Call init() first.');
    }

    const promises = this.workers.map((worker) => {
      return new Promise<void>((resolve) => {
        const onRemoved = (e: MessageEvent) => {
          if (e.data.type === 'OBSTACLE_REMOVED') {
            worker.removeEventListener('message', onRemoved);
            resolve();
          }
        };
        worker.addEventListener('message', onRemoved);
        worker.postMessage({ type: 'REMOVE_OBSTACLE', obstacleId });
      });
    });

    await Promise.all(promises);
  }

  /**
   * Move an obstacle in all workers
   */
  async moveObstacle(obstacleId: number, pos: Vec2): Promise<void> {
    if (!this.initialized) {
      throw new Error('Worker pool not initialized. Call init() first.');
    }

    const promises = this.workers.map((worker) => {
      return new Promise<void>((resolve) => {
        const onMoved = (e: MessageEvent) => {
          if (e.data.type === 'OBSTACLE_MOVED') {
            worker.removeEventListener('message', onMoved);
            resolve();
          }
        };
        worker.addEventListener('message', onMoved);
        worker.postMessage({ type: 'MOVE_OBSTACLE', obstacleId, pos });
      });
    });

    await Promise.all(promises);
  }

  /**
   * Terminate all workers
   */
  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.pendingRequests.clear();
    this.initialized = false;
  }

  /**
   * Get the number of pending requests
   */
  get pendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Get the pool size
   */
  get size(): number {
    return this.workers.length;
  }
}

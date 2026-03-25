/**
 * NavMesh Worker Pool - Manages multiple workers for parallel pathfinding
 */
export class NavMeshWorkerPool {
    constructor(poolSize, workerPath, navType = 'grid', obstacles = []) {
        this.poolSize = poolSize;
        this.workerPath = workerPath;
        this.navType = navType;
        this.obstacles = obstacles;
        this.workers = [];
        this.nextWorkerIndex = 0;
        this.requestId = 0;
        this.pendingRequests = new Map();
        this.initialized = false;
    }
    /**
     * Initialize all workers in the pool
     */
    async init() {
        if (this.initialized)
            return;
        const initPromises = [];
        for (let i = 0; i < this.poolSize; i++) {
            const worker = new Worker(this.workerPath, { type: 'module' });
            // Set up message handler
            worker.onmessage = (e) => {
                const msg = e.data;
                if (msg.type === 'PATH_RESULT') {
                    const request = this.pendingRequests.get(msg.id);
                    if (request) {
                        request.resolve(msg.path);
                        this.pendingRequests.delete(msg.id);
                    }
                }
                else if (msg.type === 'ERROR') {
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
            const readyPromise = new Promise((resolve) => {
                const onReady = (e) => {
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
    async findPath(from, to) {
        if (!this.initialized) {
            throw new Error('Worker pool not initialized. Call init() first.');
        }
        const id = this.requestId++;
        const worker = this.workers[this.nextWorkerIndex];
        this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
        return new Promise((resolve, reject) => {
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
    async addObstacle(obstacle) {
        if (!this.initialized) {
            throw new Error('Worker pool not initialized. Call init() first.');
        }
        // Add to all workers
        const promises = this.workers.map((worker) => {
            return new Promise((resolve) => {
                const onAdded = (e) => {
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
    async removeObstacle(obstacleId) {
        if (!this.initialized) {
            throw new Error('Worker pool not initialized. Call init() first.');
        }
        const promises = this.workers.map((worker) => {
            return new Promise((resolve) => {
                const onRemoved = (e) => {
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
    async moveObstacle(obstacleId, pos) {
        if (!this.initialized) {
            throw new Error('Worker pool not initialized. Call init() first.');
        }
        const promises = this.workers.map((worker) => {
            return new Promise((resolve) => {
                const onMoved = (e) => {
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
    get pendingCount() {
        return this.pendingRequests.size;
    }
    /**
     * Get the pool size
     */
    get size() {
        return this.workers.length;
    }
}

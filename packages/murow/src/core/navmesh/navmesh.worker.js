/**
 * NavMesh Worker - Offloads pathfinding to background thread
 *
 * Message Protocol:
 * - INIT: Initialize NavMesh with obstacles
 * - FIND_PATH: Request pathfinding (from, to)
 * - ADD_OBSTACLE: Add obstacle dynamically
 * - REMOVE_OBSTACLE: Remove obstacle dynamically
 * - MOVE_OBSTACLE: Move obstacle
 */
import { NavMesh } from './navmesh';
let navmesh = null;
self.onmessage = (e) => {
    const msg = e.data;
    try {
        switch (msg.type) {
            case 'INIT': {
                navmesh = new NavMesh(msg.navType);
                if (msg.obstacles) {
                    for (const obstacle of msg.obstacles) {
                        navmesh.addObstacle(obstacle);
                    }
                }
                self.postMessage({ type: 'READY' });
                break;
            }
            case 'FIND_PATH': {
                if (!navmesh) {
                    throw new Error('NavMesh not initialized');
                }
                const start = performance.now();
                const path = navmesh.findPath({ from: msg.from, to: msg.to });
                const duration = performance.now() - start;
                const result = {
                    type: 'PATH_RESULT',
                    id: msg.id,
                    path,
                    duration,
                };
                self.postMessage(result);
                break;
            }
            case 'ADD_OBSTACLE': {
                if (!navmesh) {
                    throw new Error('NavMesh not initialized');
                }
                const obstacleId = navmesh.addObstacle(msg.obstacle);
                const result = {
                    type: 'OBSTACLE_ADDED',
                    obstacleId,
                };
                self.postMessage(result);
                break;
            }
            case 'REMOVE_OBSTACLE': {
                if (!navmesh) {
                    throw new Error('NavMesh not initialized');
                }
                navmesh.removeObstacle(msg.obstacleId);
                self.postMessage({ type: 'OBSTACLE_REMOVED' });
                break;
            }
            case 'MOVE_OBSTACLE': {
                if (!navmesh) {
                    throw new Error('NavMesh not initialized');
                }
                navmesh.moveObstacle(msg.obstacleId, msg.pos);
                self.postMessage({ type: 'OBSTACLE_MOVED' });
                break;
            }
        }
    }
    catch (error) {
        self.postMessage({
            type: 'ERROR',
            error: error instanceof Error ? error.message : String(error)
        });
    }
};

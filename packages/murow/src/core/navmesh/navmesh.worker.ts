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

import { NavMesh, ObstacleInput } from './navmesh';

interface Vec2 {
  x: number;
  y: number;
}

interface InitMessage {
  type: 'INIT';
  navType: 'grid' | 'graph';
  obstacles?: ObstacleInput[];
}

interface FindPathMessage {
  type: 'FIND_PATH';
  id: number;
  from: Vec2;
  to: Vec2;
}

interface AddObstacleMessage {
  type: 'ADD_OBSTACLE';
  obstacle: ObstacleInput;
}

interface RemoveObstacleMessage {
  type: 'REMOVE_OBSTACLE';
  obstacleId: number;
}

interface MoveObstacleMessage {
  type: 'MOVE_OBSTACLE';
  obstacleId: number;
  pos: Vec2;
}

type WorkerMessage =
  | InitMessage
  | FindPathMessage
  | AddObstacleMessage
  | RemoveObstacleMessage
  | MoveObstacleMessage;

interface PathResultMessage {
  type: 'PATH_RESULT';
  id: number;
  path: Vec2[];
  duration: number;
}

interface ObstacleAddedMessage {
  type: 'OBSTACLE_ADDED';
  obstacleId: number;
}

let navmesh: NavMesh | null = null;

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
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

        const result: PathResultMessage = {
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

        const result: ObstacleAddedMessage = {
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
  } catch (error) {
    self.postMessage({
      type: 'ERROR',
      error: error instanceof Error ? error.message : String(error)
    });
  }
};

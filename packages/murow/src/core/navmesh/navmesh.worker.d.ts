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
export {};

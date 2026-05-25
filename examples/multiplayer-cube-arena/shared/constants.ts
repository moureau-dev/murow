/**
 * Wire / world constants shared by server and client. Keeping them in one
 * file means there's a single source of truth for everything that has to
 * agree across both sides.
 */
/**
 * Single port for everything: Bun's HTTP server serves the built client
 * bundle at `/`, and the WebSocket transport upgrades at `WS_PATH`. Vite's
 * dev server proxies the same path through to this port so dev and prod
 * speak the same URL shape.
 */
export const PORT = 3010;
export const WS_PATH = '/ws';

/** Logic ticks per second. Both sides must run the same rate for prediction to match. */
export const TICK_RATE = 12;

/** World units per second when moving. */
export const MOVE_SPEED = 4;

/** Half-size of the playable arena (cubes are clamped to ±ARENA_HALF). */
export const ARENA_HALF = 9;

/** Grid cell size in world units. The floor mesh and clamping use this. */
export const CELL_SIZE = 1;

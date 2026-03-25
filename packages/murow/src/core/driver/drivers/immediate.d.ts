import { LoopDriver } from "../driver";
/**
 * Server-side game loop driver using setImmediate.
 *
 * This driver runs the game loop as fast as possible without blocking the event loop,
 * making it suitable for Node.js server environments where high tick rates are desired.
 *
 * Delta time is automatically calculated between iterations and passed to the update callback in seconds.
 *
 * **Note:** This driver requires Node.js as it uses `setImmediate` which is not available in browsers.
 *
 * @example
 * ```typescript
 * const driver = new ImmediateDriver((dt) => {
 *   world.tick(dt);
 *   broadcastState();
 * });
 * driver.start();
 * ```
 */
export declare class ImmediateDriver implements LoopDriver {
    update: (dt: number) => void;
    /**
     * @param update - Callback invoked each tick with delta time in seconds
     */
    constructor(update: (dt: number) => void);
    private last;
    private running;
    /**
     * Starts the game loop using setImmediate.
     *
     * Resets timing to prevent large initial delta.
     */
    start(): void;
    /**
     * Stops the game loop.
     *
     * Note: Does not cancel already queued setImmediate callbacks.
     */
    stop(): void;
    /**
     * Internal loop method that calculates delta time and schedules the next iteration.
     *
     * Delta time is provided in seconds.
     */
    loop: () => void;
}

import { LoopDriver } from "../driver";
/**
 * Server-side game loop driver using setTimeout.
 *
 * This driver provides a more controlled alternative to setImmediate, running the game loop
 * with a minimal delay (1ms) between iterations. This ensures the event loop can process
 * I/O operations while maintaining high tick rates.
 *
 * Unlike setImmediate which runs as fast as possible, setTimeout provides better I/O responsiveness
 * by yielding to the event loop between ticks with a minimal delay.
 *
 * Delta time is automatically calculated between iterations and passed to the update callback in seconds.
 *
 * **Note:** This driver is designed for Node.js/Bun server environments. For maximum performance
 * without I/O concerns, use ImmediateDriver instead.
 *
 * @example
 * ```typescript
 * const driver = new TimeoutDriver((dt) => {
 *   world.tick(dt);
 *   broadcastState();
 * });
 * driver.start();
 * ```
 */
export declare class TimeoutDriver implements LoopDriver {
    update: (dt: number) => void;
    /**
     * @param update - Callback invoked each tick with delta time in seconds
     */
    constructor(update: (dt: number) => void);
    private last;
    private running;
    /**
     * Starts the game loop using setTimeout with minimal delay.
     *
     * Resets timing to prevent large initial delta.
     */
    start(): void;
    /**
     * Stops the game loop.
     *
     * Note: Does not cancel already queued setTimeout callbacks.
     */
    stop(): void;
    /**
     * Internal loop method that calculates delta time and schedules the next iteration.
     *
     * Delta time is provided in seconds. Uses 1ms delay to allow I/O processing.
     */
    loop: () => void;
}

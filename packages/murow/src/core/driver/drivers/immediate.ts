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
export class ImmediateDriver implements LoopDriver {
    /**
     * @param update - Callback invoked each tick with delta time in seconds
     */
    constructor(public update: (dt: number) => void) { }

    private last = performance.now();
    private running = false;

    /**
     * Starts the game loop using setImmediate.
     * 
     * Resets timing to prevent large initial delta.
     */
    start() {
        this.running = true;
        this.last = performance.now();
        this.loop();
    }

    /**
     * Stops the game loop.
     * 
     * Note: Does not cancel already queued setImmediate callbacks.
     */
    stop() {
        this.running = false;
    }

    /**
     * Internal loop method that calculates delta time and schedules the next iteration.
     * 
     * Delta time is provided in seconds.
     */
    loop = () => {
        if (!this.running) return;

        const now = performance.now();
        const dt = (now - this.last) / 1000;
        this.last = now;

        this.update(dt);
        setImmediate(this.loop);
    };
}

import { LoopDriver } from "../driver";
/**
 * Client-side game loop driver using requestAnimationFrame.
 *
 * This driver synchronizes updates with the browser's display refresh rate (typically 60 FPS),
 * providing smooth rendering and automatic throttling when the tab is not visible.
 *
 * Delta time is automatically calculated between frames and passed to the update callback in seconds.
 *
 * @example
 * ```typescript
 * const driver = new RafDriver((dt) => {
 *   player.update(dt);
 *   renderer.render();
 * });
 * driver.start();
 * ```
 */
export declare class RafDriver implements LoopDriver {
    update: (dt: number) => void;
    /**
     * @param update - Callback invoked each frame with delta time in seconds
     */
    constructor(update: (dt: number) => void);
    private last;
    private running;
    private rafId;
    /**
     * Starts the game loop using requestAnimationFrame.
     *
     * Resets timing to prevent large initial delta.
     */
    start(): void;
    /**
     * Stops the game loop and cancels any pending animation frame.
     */
    stop(): void;
    /**
     * Internal loop method that calculates delta time and schedules the next frame.
     *
     * Delta time is provided in seconds.
     */
    loop: () => void;
}

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
export class RafDriver implements LoopDriver {
    /**
     * @param update - Callback invoked each frame with delta time in seconds
     */
    constructor(public update: (dt: number) => void) { }

    private last = performance.now();
    private running = false;
    private rafId: number | null = null;

    /**
     * Starts the game loop using requestAnimationFrame.
     * 
     * Resets timing to prevent large initial delta.
     */
    start() {
        this.running = true;
        this.last = performance.now();
        this.rafId = requestAnimationFrame(this.loop);
    }

    /**
     * Stops the game loop and cancels any pending animation frame.
     */
    stop() {
        this.running = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    /**
     * Internal loop method that calculates delta time and schedules the next frame.
     * 
     * Delta time is provided in seconds.
     */
    loop = () => {
        if (!this.running) return;

        const now = performance.now();
        const dt = (now - this.last) / 1000;
        this.last = now;

        this.update(dt);
        requestAnimationFrame(this.loop);
    };
}

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
     * Hard upper bound on a single frame's delta, in ms. Long pauses (tab
     * backgrounded, breakpoint hit, browser throttling) deliver one huge
     * frame on resume. Clamping keeps the engine from trying to "catch up"
     * by replaying that lost time at high speed.
     */
    private static readonly MAX_DT_MS = 250;

    /**
     * @param update - Callback invoked each frame with delta time in seconds
     */
    constructor(public update: (dt: number) => void) { }

    private last = performance.now();
    private running = false;
    private rafId: number | null = null;
    private visibilityHandler: (() => void) | null = null;

    /**
     * Starts the game loop using requestAnimationFrame.
     *
     * Resets timing to prevent large initial delta and installs a
     * visibilitychange handler so the first frame after a hidden tab
     * doesn't deliver a multi-second delta.
     */
    start() {
        this.running = true;
        this.last = performance.now();
        if (typeof document !== 'undefined' && !this.visibilityHandler) {
            this.visibilityHandler = () => {
                if (document.visibilityState === 'visible') this.last = performance.now();
            };
            document.addEventListener('visibilitychange', this.visibilityHandler);
        }
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
        if (this.visibilityHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this.visibilityHandler);
            this.visibilityHandler = null;
        }
    }

    /**
     * Internal loop method that calculates delta time and schedules the next frame.
     *
     * Delta time is provided in seconds, clamped to `MAX_DT_MS` so a paused
     * tab doesn't deliver a multi-second frame.
     */
    loop = () => {
        if (!this.running) return;

        const now = performance.now();
        const rawDt = now - this.last;
        this.last = now;
        const dt = Math.min(rawDt, RafDriver.MAX_DT_MS) / 1000;

        this.update(dt);
        requestAnimationFrame(this.loop);
    };
}

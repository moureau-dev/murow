/**
 * @description
 * A utility class for managing fixed-rate update ticks, useful for deterministic behaviour
 * in both client and server.
 *
 * The `FixedTicker` accumulates elapsed time and determines how many fixed-interval "ticks"
 * should be processed based on a specified tick rate. It also limits the maximum number of
 * ticks per frame to prevent runaway update loops when frame times are long.
 *
 *
 * @remarks
 * - The `tick` method should be called once per frame, passing the elapsed time in seconds.
 * - The class ensures that no more than a safe number of ticks are processed per frame.
 */
export declare class FixedTicker {
    /**
     * @description Accumulator for the time passed since the last tick (in milliseconds)
     */
    private accumulator;
    /**
     * @description Rate of ticks per second
     */
    rate: number;
    /**
     * @description
     * Interval in milliseconds per tick
     */
    intervalMs: number;
    /**
     * @description
     * Maximum amount of ticks to run per frame, to avoid
     * running too many ticks in a single frame.
     */
    private maxTicksPerFrame;
    /**
     * @description
     * Callback to execute on each tick
     */
    private onTick;
    /**
     * @description
     * Optional callback to execute when ticks are skipped due to high delta time.
     * This can be useful for debugging or logging purposes.
     */
    private onTickSkipped?;
    /**
     * @description
     * Internal counter for the number of ticks processed.
     */
    private _tickCount;
    constructor({ rate, onTick }: FixedTickerProps);
    /**
     * @description
     * Returns how many ticks to run.
     *
     * @param deltaTime Delta time in seconds
     * @returns {number} Amount of ticks to run
     */
    private getTicks;
    /**
     * @description
     * Processes the ticks based on the elapsed time.
     *
     * @param deltaTime Delta time in seconds
     */
    tick(deltaTime: number): void;
    /**
     * @description
     * Returns the number of ticks processed since the last reset.
     *
     * @returns {number} Number of ticks processed
     */
    get tickCount(): number;
    /**
     * @description
     * Resets the tick count to zero.
     */
    resetTickCount(): void;
    /**
     * @description
     * Returns the accumulated time in seconds, useful for interpolation.
     *
     * @returns {number} Accumulated time in seconds
     */
    get accumulatedTime(): number;
    /**
     * @description
     * Returns the interpolation factor between 0 and 1 for smooth rendering between ticks.
     * Clamped to prevent extrapolation when ticks are skipped.
     *
     * @returns {number} Alpha value between 0 and 1
     */
    get alpha(): number;
}
interface FixedTickerProps {
    /**
     * @description
     * Rate of ticks per second
     */
    rate: number;
    /**
     * @description
     * Callback to execute on each tick
     */
    onTick: (deltaTime: number, tick?: number) => void;
    /**
     * @description
     * Optional callback to execute when ticks are skipped due to high delta time.
     * This can be useful for debugging or logging purposes.
     */
    onTickSkipped?: (skippedTicks: number) => void;
}
export {};

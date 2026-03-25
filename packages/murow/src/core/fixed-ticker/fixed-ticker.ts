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
export class FixedTicker {
  /**
   * @description Accumulator for the time passed since the last tick (in milliseconds)
   */
  private accumulator = 0;

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
  private maxTicksPerFrame: number;

  /**
   * @description
   * Callback to execute on each tick
   */
  private onTick: (deltaTime: number, tick?: number) => void;

  /**
   * @description
   * Optional callback to execute when ticks are skipped due to high delta time.
   * This can be useful for debugging or logging purposes.
   */
  private onTickSkipped?: (skippedTicks: number) => void;

  /**
   * @description
   * Internal counter for the number of ticks processed.
   */
  private _tickCount = 0;

  constructor({ rate, onTick }: FixedTickerProps) {
    this.rate = rate;
    this.intervalMs = 1000 / this.rate;
    this.onTick = onTick;

    // Allow up to rate/2 ticks per frame, but at least 1.
    // Prevents runaway loops if delta is too large.
    this.maxTicksPerFrame = Math.max(1, Math.floor(rate / 2));
  }

  /**
   * @description
   * Returns how many ticks to run.
   *
   * @param deltaTime Delta time in seconds
   * @returns {number} Amount of ticks to run
   */
  private getTicks(deltaTime: number): number {
    this.accumulator += deltaTime * 1000;

    let ticks = 0;

    // Use a small epsilon relative to interval to handle floating point precision errors
    // Without this, accumulator might be 0.9999999 when it should be 1.0
    const epsilon = this.intervalMs * 0.001;

    while (
      this.accumulator >= this.intervalMs - epsilon &&
      ticks < this.maxTicksPerFrame
    ) {
      this.accumulator -= this.intervalMs;
      ticks++;
    }

    const skippedTicks = Math.floor(this.accumulator / this.intervalMs);
    if (skippedTicks > 0 && this.onTickSkipped) {
      this.onTickSkipped(skippedTicks);
    }

    return ticks;
  }

  /**
   * @description
   * Processes the ticks based on the elapsed time.
   *
   * @param deltaTime Delta time in seconds
   */
  tick(deltaTime: number): void {
    const ticks = this.getTicks(deltaTime);

    for (let i = 0; i < ticks; i++) {
      this.onTick(1 / this.rate, this._tickCount++);
    }
  }

  /**
   * @description
   * Returns the number of ticks processed since the last reset.
   *
   * @returns {number} Number of ticks processed
   */
  get tickCount(): number {
    return this._tickCount;
  }

  /**
   * @description
   * Resets the tick count to zero.
   */
  resetTickCount(): void {
    this._tickCount = 0;
    this.accumulator = 0;
  }

  /**
   * @description
   * Returns the accumulated time in seconds, useful for interpolation.
   *
   * @returns {number} Accumulated time in seconds
   */
  get accumulatedTime(): number {
    return this.accumulator / 1000; // Convert to seconds
  }

  /**
   * @description
   * Returns the interpolation factor between 0 and 1 for smooth rendering between ticks.
   * Clamped to prevent extrapolation when ticks are skipped.
   *
   * @returns {number} Alpha value between 0 and 1
   */
  get alpha(): number {
    return Math.min(this.accumulatedTime / (1 / this.rate), 1.0);
  }
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
  onTickSkipped?: (skippedTicks: number) => void
}

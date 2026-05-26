import type { InputSnapshot } from "../types";

export interface ScrollZoomOptions {
    /** Starting value. */
    initial: number;
    /** Lower clamp. */
    min: number;
    /** Upper clamp. */
    max: number;
    /**
     * Multiplied with the per-tick scroll delta. Positive scroll (wheel
     * forward / two-finger up) increases `value` by `sensitivity *
     * deltaScrollY`. Use a negative sensitivity to invert. Default 0.01.
     */
    sensitivity?: number;
}

/**
 * Scroll-wheel driven scalar with clamps. Use for orbit distance, FOV,
 * RTS camera height, anything that's "scroll to change a number."
 *
 * Usage:
 * ```ts
 * const zoom = new ScrollZoom({ initial: 8, min: 3, max: 20 });
 *
 * loop.events.on('tick', ({ input }) => {
 *     zoom.update(input);
 *     const [cx, cy, cz] = mouseLook.orbit(playerPos, zoom.value);
 *     // ...
 * });
 * ```
 */
export class ScrollZoom {
    value: number;
    min: number;
    max: number;
    sensitivity: number;

    constructor(opts: ScrollZoomOptions) {
        this.value = opts.initial;
        this.min = opts.min;
        this.max = opts.max;
        this.sensitivity = opts.sensitivity ?? 0.01;
    }

    update(input: InputSnapshot): void {
        const dy = input.mouse.delta.scroll.y;
        if (dy === 0) return;
        this.value += dy * this.sensitivity;
        if (this.value < this.min) this.value = this.min;
        else if (this.value > this.max) this.value = this.max;
    }
}

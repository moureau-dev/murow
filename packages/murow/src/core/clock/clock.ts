export interface SlewClockOptions {
    /** Drift under this advances at nominal rate instead of warping. Default 0.25. */
    deadZone?: number;
    /** Step bounds while warping to close a gap. */
    warp?: {
        /** Minimum step when warping to close a gap. Default 0.6. */
        min?: number;
        /** Maximum step when warping to close a gap. Default 1.4. */
        max?: number;
    };
    /** Per-unit-of-drift warp gain. Default 0.1. */
    gain?: number;
}

/**
 * A scalar that advances one nominal step per `advance` toward a moving
 * target, slewing within a band to close drift, holding steady inside a
 * dead-zone, and snapping when the forward gap is too large to chase.
 *
 * Domain-agnostic: the caller supplies the target and the snap threshold.
 */
export class SlewClock {
    private _value = -Infinity;
    private readonly deadZone: number;
    private readonly warpMin: number;
    private readonly warpMax: number;
    private readonly gain: number;

    constructor(opts: SlewClockOptions = {}) {
        this.deadZone = opts.deadZone ?? 0.25;
        this.warpMin = opts.warp?.min ?? 0.6;
        this.warpMax = opts.warp?.max ?? 1.4;
        this.gain = opts.gain ?? 0.1;
    }

    get value(): number {
        return this._value;
    }

    get initialized(): boolean {
        return this._value !== -Infinity;
    }

    reset(): void {
        this._value = -Infinity;
    }

    /**
     * Advance toward `target`. Seeds to `target` on first call. Forward drift
     * beyond `snap` jumps to `target`; drift inside the dead-zone advances one
     * nominal step; otherwise the step warps within the band to close the gap.
     */
    advance(target: number, snap: number): number {
        if (this._value === -Infinity) {
            this._value = target;
            return this._value;
        }
        const drift = target - this._value;
        if (drift > snap) {
            this._value = target;
        } else if (Math.abs(drift) < this.deadZone) {
            this._value += 1;
        } else {
            this._value += Math.max(this.warpMin, Math.min(this.warpMax, 1 + drift * this.gain));
        }
        return this._value;
    }
}

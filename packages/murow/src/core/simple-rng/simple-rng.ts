/**
 * SimpleRNG — deterministic, seedable, zero-allocation pseudo-random number generator.
 * Uses a 32-bit LCG (Linear Congruential Generator).
 *
 * Ideal for gameplay logic that must be reproducible (multiplayer, replays),
 * particle systems, procedural generation, and any hot path where
 * Math.random() is too slow or non-deterministic.
 */
export class SimpleRNG {
    private state: number;

    constructor(seed?: number) {
        this.state = (seed ?? (Math.random() * 0x7FFFFFFF)) | 0;
        if (this.state === 0) this.state = 1;
    }

    /**
     * Returns a float in [0, 1).
     */
    rand(): number {
        this.state = (this.state * 1664525 + 1013904223) & 0x7FFFFFFF;
        return this.state / 0x7FFFFFFF;
    }

    /**
     * Returns a float in [min, max).
     */
    range(min: number, max: number): number {
        return min + this.rand() * (max - min);
    }

    /**
     * Returns an integer in [min, max] (inclusive).
     */
    int(min: number, max: number): number {
        return min + ((this.rand() * (max - min + 1)) | 0);
    }

    /**
     * Returns true with the given probability (0-1).
     */
    chance(probability: number): boolean {
        return this.rand() < probability;
    }

    /**
     * Pick a random element from an array.
     */
    pick<T>(array: T[]): T {
        return array[(this.rand() * array.length) | 0];
    }

    /**
     * Reset to a new seed.
     */
    seed(value: number): void {
        this.state = value | 0;
        if (this.state === 0) this.state = 1;
    }
}

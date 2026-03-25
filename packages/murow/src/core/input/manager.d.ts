import type { InputEventSource, InputSnapshot } from "./types";
/**
 * Manages keyboard and mouse input.
 *
 * Design goals:
 * - Zero allocations per frame/tick
 * - Render reads live state (peek)
 * - Simulation reads frozen state (snapshot)
* - Deterministic hit/release semantics
*/
export declare class InputManager {
    private keys;
    private prevKeys;
    private mouse;
    private prevMouse;
    private snapshotA;
    private snapshotB;
    private snapshotFlip;
    private inputSource;
    private handlers;
    constructor();
    /**
     * Returns a live, non-allocating view of the current input state.
     *
     * - No hit/release detection
     * - No resets
     * - Safe for render passes
     */
    peek(): Readonly<InputSnapshot>;
    /**
     * Produces a frozen snapshot of the input state.
     *
     * - Computes hit/release
     * - Resets deltas
     * - Safe to store for the duration of the tick
     */
    snapshot(): InputSnapshot;
    /**
     * Starts listening to an input event source
     */
    listen(source: InputEventSource): void;
    /**
     * Stops listening to the current input source.
     */
    unlisten(): void;
    private onKeyDown;
    private onKeyUp;
    private onMouseMove;
    private onMouseDown;
    private onMouseUp;
    private onMouseWheel;
    private onSwipe;
    private onPinch;
}

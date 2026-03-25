import type {
    ButtonState,
    InputEventSource,
    InputHandlers,
        InputSnapshot,
    } from "./types";

    /**
     * Manages keyboard and mouse input.
     *
     * Design goals:
     * - Zero allocations per frame/tick
     * - Render reads live state (peek)
     * - Simulation reads frozen state (snapshot)
 * - Deterministic hit/release semantics
 */
export class InputManager {
    private keys: Record<string, ButtonState> = Object.create(null);
    private prevKeys: Record<string, boolean> = Object.create(null);

    private mouse = {
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
        left: false,
        right: false,
        middle: false,
        scrollX: 0,
        scrollY: 0,
    };

    private prevMouse = {
        left: false,
        right: false,
        middle: false,
    };

    private snapshotA: InputSnapshot;
    private snapshotB: InputSnapshot;
    private snapshotFlip = false;
    private inputSource!: InputEventSource;

    private handlers: InputHandlers = {
        keydown: (e) => this.onKeyDown(e),
        keyup: (e) => this.onKeyUp(e),
        mousemove: (e) => this.onMouseMove(e),
        mousedown: (e) => this.onMouseDown(e),
        mouseup: (e) => this.onMouseUp(e),
        wheel: (e) => this.onMouseWheel(e),
        swipe: (dir) => this.onSwipe(dir),
        pinch: (scale) => this.onPinch(scale),
    };

    constructor() {
        this.snapshotA = createEmptySnapshot();
        this.snapshotB = createEmptySnapshot();
    }

    /**
     * Returns a live, non-allocating view of the current input state.
     *
     * - No hit/release detection
     * - No resets
     * - Safe for render passes
     */
    peek(): Readonly<InputSnapshot> {
        const snap = this.snapshotFlip ? this.snapshotA : this.snapshotB;
        fillLiveView(snap, this.keys, this.mouse);
        return snap;
    }

    /**
     * Produces a frozen snapshot of the input state.
     *
     * - Computes hit/release
     * - Resets deltas
     * - Safe to store for the duration of the tick
     */
    snapshot(): InputSnapshot {
        const snap = this.snapshotFlip ? this.snapshotA : this.snapshotB;
        this.snapshotFlip = !this.snapshotFlip;

        fillSnapshot(
            snap,
            this.keys,
            this.prevKeys,
            this.mouse,
            this.prevMouse
        );

        this.mouse.dx = 0;
        this.mouse.dy = 0;
        this.mouse.scrollX = 0;
        this.mouse.scrollY = 0;

        this.prevMouse.left = this.mouse.left;
        this.prevMouse.right = this.mouse.right;
        this.prevMouse.middle = this.mouse.middle;

        return snap;
    }

    /**
     * Starts listening to an input event source
     */
    listen(source: InputEventSource) {
        if (this.inputSource) this.inputSource.detach();
        this.inputSource = source;
        source.attach(this.handlers);
    }

    /**
     * Stops listening to the current input source.
     */
    unlisten() {
        if (!this.inputSource) return;
        this.inputSource.detach();
    }

    private onKeyDown(e: KeyboardEvent) {
        const key = (this.keys[e.code] ??= { down: false, hit: false, released: false });
        key.down = true;
    }

    private onKeyUp(e: KeyboardEvent) {
        const key = (this.keys[e.code] ??= { down: false, hit: false, released: false });
        key.down = false;
    }

    private onMouseMove(e: MouseEvent) {
        const rect = (e.target as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        this.mouse.dx += x - this.mouse.x;
        this.mouse.dy += y - this.mouse.y;

        this.mouse.x = x;
        this.mouse.y = y;
    }

    private onMouseDown(e: MouseEvent) {
        if (e.button === 0) this.mouse.left = true;
        if (e.button === 1) this.mouse.middle = true;
        if (e.button === 2) this.mouse.right = true;
    }

    private onMouseUp(e: MouseEvent) {
        if (e.button === 0) this.mouse.left = false;
        if (e.button === 1) this.mouse.middle = false;
        if (e.button === 2) this.mouse.right = false;
    }

    private onMouseWheel(e: WheelEvent) {
        this.mouse.scrollX += e.deltaX;
        this.mouse.scrollY += e.deltaY;
    }

    private onSwipe(_dir: "up" | "down" | "left" | "right") {
        // Gesture layer lives above core input
    }

    private onPinch(_scale: number) {
        // Gesture layer lives above core input
    }
}

/**
 * Creates a reusable, fully-initialized snapshot object.
 */
function createEmptySnapshot(): InputSnapshot {
    return {
        mouse: {
            position: { x: 0, y: 0 },
            delta: {
                position: { x: 0, y: 0 },
                scroll: { x: 0, y: 0 },
            },
            left: { down: false, hit: false, released: false },
            right: { down: false, hit: false, released: false },
            middle: { down: false, hit: false, released: false },
        },
        keys: Object.create(null),
    };
}

/**
 * Fills a snapshot with live input state.
 * No hit/release, no resets.
 */
function fillLiveView(
    snap: InputSnapshot,
    keys: Record<string, ButtonState>,
    mouse: InputManager["mouse"]
) {
    for (const k in keys) {
        const dst = (snap.keys[k] ??= { down: false, hit: false, released: false });
        dst.down = keys[k].down;
        dst.hit = false;
        dst.released = false;
    }

    snap.mouse.position.x = mouse.x;
    snap.mouse.position.y = mouse.y;
    snap.mouse.delta.position.x = mouse.dx;
    snap.mouse.delta.position.y = mouse.dy;
    snap.mouse.delta.scroll.x = mouse.scrollX;
    snap.mouse.delta.scroll.y = mouse.scrollY;

    snap.mouse.left.down = mouse.left;
    snap.mouse.right.down = mouse.right;
    snap.mouse.middle.down = mouse.middle;

    snap.mouse.left.hit = snap.mouse.left.released = false;
    snap.mouse.right.hit = snap.mouse.right.released = false;
    snap.mouse.middle.hit = snap.mouse.middle.released = false;
}

/**
 * Fills a snapshot with frozen input state.
 * Computes hit/release and updates previous state.
 */
function fillSnapshot(
    snap: InputSnapshot,
    keys: Record<string, ButtonState>,
    prevKeys: Record<string, boolean>,
    mouse: InputManager["mouse"],
    prevMouse: InputManager["prevMouse"]
) {
    for (const k in keys) {
        const now = keys[k].down;
        const prev = prevKeys[k] ?? false;

        const dst = (snap.keys[k] ??= { down: false, hit: false, released: false });
        dst.down = now;
        dst.hit = now && !prev;
        dst.released = !now && prev;

        prevKeys[k] = now;
    }

    snap.mouse.position.x = mouse.x;
    snap.mouse.position.y = mouse.y;
    snap.mouse.delta.position.x = mouse.dx;
    snap.mouse.delta.position.y = mouse.dy;
    snap.mouse.delta.scroll.x = mouse.scrollX;
    snap.mouse.delta.scroll.y = mouse.scrollY;

    applyButton(snap.mouse.left, mouse.left, prevMouse.left);
    applyButton(snap.mouse.right, mouse.right, prevMouse.right);
    applyButton(snap.mouse.middle, mouse.middle, prevMouse.middle);
}

function applyButton(dst: ButtonState, now: boolean, prev: boolean) {
    dst.down = now;
    dst.hit = now && !prev;
    dst.released = !now && prev;
}

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

    private lastClientX: number | null = null;
    private lastClientY: number | null = null;

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
        this.snapshotA = createInputSnapshot();
        this.snapshotB = createInputSnapshot();
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
        const target = e.target as HTMLElement;
        const rect = target.getBoundingClientRect();

        const locked = typeof document !== 'undefined' && document.pointerLockElement === target;
        if (locked) {
            this.mouse.dx += e.movementX;
            this.mouse.dy += e.movementY;
        } else if (this.lastClientX !== null && this.lastClientY !== null) {
            this.mouse.dx += e.clientX - this.lastClientX;
            this.mouse.dy += e.clientY - this.lastClientY;
        }

        this.lastClientX = e.clientX;
        this.lastClientY = e.clientY;

        if (locked) {
            this.mouse.x = rect.width / 2;
            this.mouse.y = rect.height / 2;
        } else {
            this.mouse.x = e.clientX - rect.left;
            this.mouse.y = e.clientY - rect.top;
        }
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

        this.lastClientX = null;
        this.lastClientY = null;
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
export function createInputSnapshot(): InputSnapshot {
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

/**
 * ORs several managers into one snapshot, so e.g. a keyboard/mouse manager and a
 * gamepad can drive the same control scheme. Buttons merge (a press on any source
 * counts); the pointer comes from the source with the most activity this pass,
 * falling back to the first. `target` is reset and reused — no per-call allocation.
 *
 * `peek` samples each manager's live view (no hit/release) instead of a frozen
 * snapshot, matching `InputManager.peek()`.
 */
export function mergeInputSnapshots(
    target: InputSnapshot,
    managers: readonly InputManager[],
    peek = false,
): InputSnapshot {
    for (const k in target.keys) {
        const b = target.keys[k];
        b.down = false;
        b.hit = false;
        b.released = false;
    }

    let bestActivity = -1;
    for (let i = 0; i < managers.length; i++) {
        const src = peek ? managers[i]!.peek() : managers[i]!.snapshot();

        const srcKeys = src.keys;
        for (const k in srcKeys) {
            const s = srcKeys[k];
            const dst = (target.keys[k] ??= { down: false, hit: false, released: false });
            dst.down = dst.down || s.down;
            dst.hit = dst.hit || s.hit;
            dst.released = dst.released || s.released;
        }

        const m = src.mouse;
        const activity =
            Math.abs(m.delta.position.x) + Math.abs(m.delta.position.y) +
            Math.abs(m.delta.scroll.x) + Math.abs(m.delta.scroll.y) +
            (m.left.down || m.right.down || m.middle.down ? 1 : 0);
        if (activity > bestActivity) {
            bestActivity = activity;
            const t = target.mouse;
            t.position.x = m.position.x;
            t.position.y = m.position.y;
            t.delta.position.x = m.delta.position.x;
            t.delta.position.y = m.delta.position.y;
            t.delta.scroll.x = m.delta.scroll.x;
            t.delta.scroll.y = m.delta.scroll.y;
            t.left.down = m.left.down; t.left.hit = m.left.hit; t.left.released = m.left.released;
            t.right.down = m.right.down; t.right.hit = m.right.hit; t.right.released = m.right.released;
            t.middle.down = m.middle.down; t.middle.hit = m.middle.hit; t.middle.released = m.middle.released;
        }
    }

    return target;
}

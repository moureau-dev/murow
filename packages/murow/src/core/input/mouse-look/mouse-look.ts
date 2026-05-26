import type { InputSnapshot } from "../types";

export interface MouseLookOptions {
    /** Radians per pixel of mouse motion. Default 0.002. */
    sensitivity?: number;
    /** Lower pitch clamp, radians. Default -PI/2 + 0.01. */
    pitchMin?: number;
    /** Upper pitch clamp, radians. Default PI/2 - 0.01. */
    pitchMax?: number;
    /** Initial yaw, radians. Default 0. */
    initialYaw?: number;
    /** Initial pitch, radians. Default 0. */
    initialPitch?: number;
    /**
     * Flip horizontal look direction. With the default (false), moving
     * the mouse right rotates the view right; set true to invert.
     */
    invertX?: boolean;
    /**
     * Flip vertical look direction. With the default (false), moving the
     * mouse up tilts the view up; set true for flight-sim style.
     */
    invertY?: boolean;
    /**
     * Accept drag-to-look as a fallback for platforms without Pointer Lock
     * (iOS Safari). When true, `update(input)` accumulates while
     * `dragButton` is held even without an active lock. Default true.
     */
    drag?: boolean;
    /** Mouse button that drives drag-to-look. Default 'left'. */
    dragButton?: "left" | "middle" | "right";
}

/**
 * Yaw/pitch state driven by mouse motion, with optional pointer lock and
 * drag-to-look fallback.
 *
 * The class owns the input handling. Output helpers (`forward`, `right`,
 * `up`, `orbit`) are read-only views computed from yaw/pitch each call.
 *
 * Zero-alloc: each output has its own backing `Float32Array(3)` reused
 * across calls. Don't hold a reference past the next call to the same
 * accessor — the values will overwrite. Copy if you need to persist.
 *
 * Usage:
 * ```ts
 * const look = new MouseLook({ sensitivity: 0.002 });
 *
 * canvas.addEventListener('click', () => {
 *     look.lock(canvas).catch(() => {}); // iOS: drag-to-look takes over
 * });
 *
 * loop.events.on('tick', ({ input }) => {
 *     look.update(input);
 *
 *     // FPS:
 *     const pos = renderer.camera.position;
 *     const f = look.forward;
 *     renderer.camera.setTarget(pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]);
 *
 *     // Or TPS / orbit:
 *     const c = look.orbit(playerPos, 8);
 *     renderer.camera.setPosition(c[0], c[1], c[2]);
 *     renderer.camera.setTarget(playerPos[0], playerPos[1], playerPos[2]);
 * });
 * ```
 */
export class MouseLook {
    yaw: number;
    pitch: number;
    sensitivity: number;
    pitchMin: number;
    pitchMax: number;
    invertX: boolean;
    invertY: boolean;
    drag: boolean;
    dragButton: "left" | "middle" | "right";

    private lockedElement: HTMLElement | null = null;
    /** Active `pointerlockchange`/`error` listeners from an in-flight `lock()`. */
    private pendingLockCleanup: (() => void) | null = null;

    // Per-output backing buffers. Reused on every accessor call to avoid
    // per-frame allocation.
    private _forward = new Float32Array(3);
    private _right = new Float32Array(3);
    private _up = new Float32Array(3);
    private _orbit = new Float32Array(3);

    constructor(opts: MouseLookOptions = {}) {
        this.sensitivity = opts.sensitivity ?? 0.002;
        this.pitchMin = opts.pitchMin ?? -Math.PI / 2 + 0.01;
        this.pitchMax = opts.pitchMax ?? Math.PI / 2 - 0.01;
        this.yaw = opts.initialYaw ?? 0;
        this.pitch = opts.initialPitch ?? 0;
        this.invertX = opts.invertX ?? false;
        this.invertY = opts.invertY ?? false;
        this.drag = opts.drag ?? true;
        this.dragButton = opts.dragButton ?? "left";
    }

    /**
     * Apply input deltas. Gated internally: writes happen when pointer
     * lock is active, or (if `drag` is true) while `dragButton` is held.
     */
    update(input: InputSnapshot): void {
        const button = input.mouse[this.dragButton];
        const driving = this.locked || (this.drag && button.down);
        if (!driving) return;

        const dx = input.mouse.delta.position.x;
        const dy = input.mouse.delta.position.y;
        if (dx === 0 && dy === 0) return;

        // dx > 0 when the mouse moves right. Default (invertX=false)
        // rotates yaw negative -> camera turns right.
        this.yaw -= dx * this.sensitivity * (this.invertX ? -1 : 1);
        // dy > 0 when the mouse moves down (screen coordinates). Default
        // (invertY=false) maps mouse-up to look-up.
        this.pitch -= dy * this.sensitivity * (this.invertY ? -1 : 1);
        if (this.pitch < this.pitchMin) this.pitch = this.pitchMin;
        else if (this.pitch > this.pitchMax) this.pitch = this.pitchMax;
    }

    /**
     * Request pointer lock on `element`. Resolves once locked. Rejects if
     * Pointer Lock API is unavailable (iOS Safari) or the browser denies
     * the request, in which case drag-to-look takes over (if enabled).
     */
    lock(element: HTMLElement): Promise<void> {
        const req = (element as any).requestPointerLock;
        if (typeof req !== "function") {
            return Promise.reject(new Error("Pointer Lock unsupported"));
        }
        this.lockedElement = element;
        const result = req.call(element) as Promise<void> | undefined;
        if (result && typeof result.then === "function") return result;
        // Older browsers don't return a promise; resolve on the next
        // pointerlockchange event matching our element.
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                document.removeEventListener("pointerlockchange", onChange);
                document.removeEventListener("pointerlockerror", onError);
                if (this.pendingLockCleanup === cleanup) {
                    this.pendingLockCleanup = null;
                }
            };
            const onChange = () => {
                cleanup();
                if (document.pointerLockElement === element) resolve();
                else reject(new Error("Pointer Lock denied"));
            };
            const onError = () => {
                cleanup();
                reject(new Error("Pointer Lock denied"));
            };
            document.addEventListener("pointerlockchange", onChange);
            document.addEventListener("pointerlockerror", onError);
            this.pendingLockCleanup = cleanup;
        });
    }

    /** Release pointer lock if currently held. */
    unlock(): void {
        if (typeof document !== "undefined" && document.exitPointerLock) {
            document.exitPointerLock();
        }
    }

    /** True while pointer lock is active on the element we locked to. */
    get locked(): boolean {
        if (typeof document === "undefined") return false;
        if (this.lockedElement === null) return false;
        return document.pointerLockElement === this.lockedElement;
    }

    /**
     * Unit vector pointing the way the camera is facing. Shared buffer:
     * don't hold the returned reference past the next `forward` read.
     */
    get forward(): Float32Array {
        const cp = Math.cos(this.pitch);
        const v = this._forward;
        v[0] = Math.sin(this.yaw) * cp;
        v[1] = Math.sin(this.pitch);
        v[2] = Math.cos(this.yaw) * cp;
        return v;
    }

    /**
     * Right direction. Lies in the XZ plane, independent of pitch.
     * Shared buffer: don't hold the returned reference past the next
     * `right` read.
     */
    get right(): Float32Array {
        const v = this._right;
        v[0] = Math.cos(this.yaw);
        v[1] = 0;
        v[2] = -Math.sin(this.yaw);
        return v;
    }

    /**
     * Camera-local up. Tilts with pitch. Shared buffer: don't hold the
     * returned reference past the next `up` read.
     */
    get up(): Float32Array {
        const sp = Math.sin(this.pitch);
        const v = this._up;
        v[0] = -Math.sin(this.yaw) * sp;
        v[1] = Math.cos(this.pitch);
        v[2] = -Math.cos(this.yaw) * sp;
        return v;
    }

    /**
     * Camera position in orbit around `target` at `distance`, given the
     * current yaw/pitch. Pairs naturally with `setTarget(target)` to
     * point the camera back at the orbited object. Shared buffer: don't
     * hold the returned reference past the next `orbit` call.
     */
    orbit(
        target: ArrayLike<number>,
        distance: number,
    ): Float32Array {
        const cp = Math.cos(this.pitch);
        const v = this._orbit;
        v[0] = target[0] + distance * cp * Math.sin(this.yaw);
        v[1] = target[1] + distance * Math.sin(this.pitch);
        v[2] = target[2] + distance * cp * Math.cos(this.yaw);
        return v;
    }

    /**
     * Release pointer lock, drop the locked element, and detach any
     * in-flight `lock()` listeners. Safe to call multiple times.
     */
    destroy(): void {
        this.pendingLockCleanup?.();
        this.pendingLockCleanup = null;
        this.unlock();
        this.lockedElement = null;
    }
}

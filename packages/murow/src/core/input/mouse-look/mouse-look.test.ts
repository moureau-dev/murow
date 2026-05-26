import { describe, test, expect } from "bun:test";
import { MouseLook } from "./mouse-look";
import type { InputSnapshot } from "../types";

function makeInput(overrides: Partial<{
    dx: number;
    dy: number;
    scrollX: number;
    scrollY: number;
    leftDown: boolean;
    rightDown: boolean;
    middleDown: boolean;
}> = {}): InputSnapshot {
    const o = {
        dx: 0, dy: 0, scrollX: 0, scrollY: 0,
        leftDown: false, rightDown: false, middleDown: false,
        ...overrides,
    };
    const button = (down: boolean) => ({ down, hit: false, released: false });
    return {
        keys: {},
        mouse: {
            position: { x: 0, y: 0 },
            delta: {
                position: { x: o.dx, y: o.dy },
                scroll: { x: o.scrollX, y: o.scrollY },
            },
            left: button(o.leftDown),
            middle: button(o.middleDown),
            right: button(o.rightDown),
        },
    };
}

describe("MouseLook", () => {
    test("drag-mode: applies delta only while drag button is held", () => {
        const look = new MouseLook({ sensitivity: 1, drag: true, dragButton: "left" });
        look.update(makeInput({ dx: 10, dy: 0, leftDown: false }));
        expect(look.yaw).toBeCloseTo(0);

        look.update(makeInput({ dx: 10, dy: 0, leftDown: true }));
        expect(look.yaw).toBeCloseTo(-10);
    });

    test("dx > 0 rotates yaw negative (mouse right = look right)", () => {
        const look = new MouseLook({ sensitivity: 1, drag: true });
        look.update(makeInput({ dx: 5, leftDown: true }));
        expect(look.yaw).toBeCloseTo(-5);
    });

    test("invertX=true: mouse-right rotates yaw positive", () => {
        const look = new MouseLook({ sensitivity: 1, drag: true, invertX: true });
        look.update(makeInput({ dx: 5, leftDown: true }));
        expect(look.yaw).toBeCloseTo(5);
    });

    test("default (invertY=false): mouse-up tilts pitch up", () => {
        const look = new MouseLook({
            sensitivity: 1, drag: true,
            pitchMin: -10, pitchMax: 10,
        });
        // Mouse up = negative dy (screen y grows downward).
        look.update(makeInput({ dy: -3, leftDown: true }));
        expect(look.pitch).toBeCloseTo(3);
    });

    test("invertY=true: mouse-up tilts pitch down", () => {
        const look = new MouseLook({
            sensitivity: 1, drag: true, invertY: true,
            pitchMin: -10, pitchMax: 10,
        });
        look.update(makeInput({ dy: -3, leftDown: true }));
        expect(look.pitch).toBeCloseTo(-3);
    });

    test("pitch clamps to [pitchMin, pitchMax]", () => {
        const look = new MouseLook({
            sensitivity: 1, drag: true,
            pitchMin: -0.5, pitchMax: 0.5,
        });
        look.update(makeInput({ dy: -100, leftDown: true })); // tries pitch += 100
        expect(look.pitch).toBeCloseTo(0.5);
        look.update(makeInput({ dy: 1000, leftDown: true }));
        expect(look.pitch).toBeCloseTo(-0.5);
    });

    test("drag=false: drag button is ignored, only lock drives", () => {
        const look = new MouseLook({ sensitivity: 1, drag: false });
        look.update(makeInput({ dx: 10, leftDown: true }));
        expect(look.yaw).toBeCloseTo(0); // no lock, no drag -> nothing
    });

    test("forward / right / up are unit vectors", () => {
        const look = new MouseLook({ initialYaw: 0.7, initialPitch: 0.3 });
        const norm = (v: [number, number, number]) =>
            Math.hypot(v[0], v[1], v[2]);
        expect(norm(look.forward)).toBeCloseTo(1);
        expect(norm(look.right)).toBeCloseTo(1);
        expect(norm(look.up)).toBeCloseTo(1);
    });

    test("forward / right / up are pairwise orthogonal", () => {
        const look = new MouseLook({ initialYaw: 0.7, initialPitch: 0.3 });
        const dot = (
            a: [number, number, number],
            b: [number, number, number],
        ) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(dot(look.forward, look.right)).toBeCloseTo(0);
        expect(dot(look.forward, look.up)).toBeCloseTo(0);
        expect(dot(look.right, look.up)).toBeCloseTo(0);
    });

    test("right lies in the XZ plane (y component is 0)", () => {
        const look = new MouseLook({ initialYaw: 0.7, initialPitch: 0.5 });
        expect(look.right[1]).toBeCloseTo(0);
    });

    test("orbit puts camera at `distance` from target", () => {
        const look = new MouseLook({ initialYaw: 0.5, initialPitch: 0.4 });
        const target: [number, number, number] = [1, 2, 3];
        const [cx, cy, cz] = look.orbit(target, 8);
        const dist = Math.hypot(cx - 1, cy - 2, cz - 3);
        expect(dist).toBeCloseTo(8);
    });

    test("lock() rejects when Pointer Lock API is unavailable", async () => {
        const look = new MouseLook();
        const fakeEl = {} as HTMLElement; // no requestPointerLock
        await expect(look.lock(fakeEl)).rejects.toThrow(/unsupported/i);
    });

    test("accessors reuse their backing buffer (zero-alloc contract)", () => {
        const look = new MouseLook({ initialYaw: 0.7, initialPitch: 0.3 });
        // Same accessor returns the same instance across reads.
        expect(look.forward).toBe(look.forward);
        expect(look.right).toBe(look.right);
        expect(look.up).toBe(look.up);
        // Different accessors return different buffers (no cross-bleed).
        expect(look.forward).not.toBe(look.right);
        expect(look.forward).not.toBe(look.up);
        expect(look.right).not.toBe(look.up);
        // orbit() reuses its own buffer too.
        const o1 = look.orbit([0, 0, 0], 5);
        const o2 = look.orbit([1, 0, 0], 5);
        expect(o1).toBe(o2);
    });
});

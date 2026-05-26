import { describe, test, expect } from "bun:test";
import { ScrollZoom } from "./scroll-zoom";
import type { InputSnapshot } from "../types";

function makeInput(scrollY: number = 0): InputSnapshot {
    const button = { down: false, hit: false, released: false };
    return {
        keys: {},
        mouse: {
            position: { x: 0, y: 0 },
            delta: { position: { x: 0, y: 0 }, scroll: { x: 0, y: scrollY } },
            left: button, middle: button, right: button,
        },
    };
}

describe("ScrollZoom", () => {
    test("scroll-y * sensitivity is added to value", () => {
        const z = new ScrollZoom({ initial: 10, min: 0, max: 100, sensitivity: 0.5 });
        z.update(makeInput(4));
        expect(z.value).toBeCloseTo(12);
    });

    test("value clamps to [min, max]", () => {
        const z = new ScrollZoom({ initial: 5, min: 3, max: 8, sensitivity: 1 });
        z.update(makeInput(100));
        expect(z.value).toBeCloseTo(8);
        z.update(makeInput(-100));
        expect(z.value).toBeCloseTo(3);
    });

    test("zero scroll is a no-op", () => {
        const z = new ScrollZoom({ initial: 5, min: 0, max: 10 });
        z.update(makeInput(0));
        expect(z.value).toBeCloseTo(5);
    });

    test("negative sensitivity inverts direction", () => {
        const z = new ScrollZoom({ initial: 5, min: 0, max: 10, sensitivity: -1 });
        z.update(makeInput(2));
        expect(z.value).toBeCloseTo(3);
    });
});

import { describe, expect, test } from "bun:test";
import { lerp } from "./lerp";

describe("lerp", () => {
  test("should return start value when t is 0", () => {
    expect(lerp(0, 100, 0)).toBe(0);
    expect(lerp(50, 200, 0)).toBe(50);
    expect(lerp(-10, 10, 0)).toBe(-10);
  });

  test("should return end value when t is 1", () => {
    expect(lerp(0, 100, 1)).toBe(100);
    expect(lerp(50, 200, 1)).toBe(200);
    expect(lerp(-10, 10, 1)).toBe(10);
  });

  test("should return midpoint when t is 0.5", () => {
    expect(lerp(0, 100, 0.5)).toBe(50);
    expect(lerp(50, 150, 0.5)).toBe(100);
    expect(lerp(-10, 10, 0.5)).toBe(0);
  });

  test("should interpolate between positive values", () => {
    expect(lerp(0, 100, 0.25)).toBe(25);
    expect(lerp(0, 100, 0.75)).toBe(75);
    expect(lerp(10, 20, 0.3)).toBeCloseTo(13, 5);
  });

  test("should interpolate between negative values", () => {
    expect(lerp(-100, -50, 0.5)).toBe(-75);
    expect(lerp(-10, -5, 0.2)).toBe(-9);
  });

  test("should interpolate from negative to positive", () => {
    expect(lerp(-50, 50, 0.5)).toBe(0);
    expect(lerp(-10, 10, 0.25)).toBe(-5);
    expect(lerp(-10, 10, 0.75)).toBe(5);
  });

  test("should handle extrapolation when t > 1", () => {
    expect(lerp(0, 100, 1.5)).toBe(150);
    expect(lerp(0, 100, 2)).toBe(200);
    expect(lerp(10, 20, 1.1)).toBeCloseTo(21, 5);
  });

  test("should handle extrapolation when t < 0", () => {
    expect(lerp(0, 100, -0.5)).toBe(-50);
    expect(lerp(0, 100, -1)).toBe(-100);
    expect(lerp(10, 20, -0.1)).toBeCloseTo(9, 5);
  });

  test("should handle same start and end values", () => {
    expect(lerp(50, 50, 0)).toBe(50);
    expect(lerp(50, 50, 0.5)).toBe(50);
    expect(lerp(50, 50, 1)).toBe(50);
    expect(lerp(50, 50, 2)).toBe(50);
  });

  test("should handle floating point values", () => {
    expect(lerp(0.1, 0.9, 0.5)).toBeCloseTo(0.5, 10);
    expect(lerp(1.5, 2.5, 0.3)).toBeCloseTo(1.8, 10);
  });

  test("should be commutative with inverted t", () => {
    const start = 10;
    const end = 20;
    expect(lerp(start, end, 0.3)).toBeCloseTo(lerp(end, start, 0.7), 10);
  });

  test("should handle very small differences", () => {
    expect(lerp(1.0, 1.0001, 0.5)).toBeCloseTo(1.00005, 10);
  });

  test("should handle very large values", () => {
    expect(lerp(1e10, 2e10, 0.5)).toBe(1.5e10);
  });

  test("should be linear (no easing)", () => {
    const start = 0;
    const end = 100;
    const step = 0.1;
    const expectedDiff = 10;

    for (let t = 0; t < 1; t += step) {
      const val1 = lerp(start, end, t);
      const val2 = lerp(start, end, t + step);
      expect(val2 - val1).toBeCloseTo(expectedDiff, 5);
    }
  });
});

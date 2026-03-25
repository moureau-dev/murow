import { describe, it, expect } from "bun:test";
import { Snapshot, applySnapshot } from "./snapshot";

interface TestState {
  x: number;
  y: number;
  health?: number;
  nested?: {
    a: number;
    b?: number;
  };
  items?: string[];
}

describe("Snapshot", () => {
  describe("applySnapshot", () => {
    it("should apply simple property updates", () => {
      const state: TestState = { x: 0, y: 0 };
      const snapshot: Snapshot<TestState> = {
        tick: 100,
        updates: { x: 10, y: 20 },
      };

      applySnapshot(state, snapshot);
      expect(state.x).toBe(10);
      expect(state.y).toBe(20);
    });

    it("should apply partial updates without affecting other properties", () => {
      const state: TestState = { x: 0, y: 0, health: 100 };
      const snapshot: Snapshot<TestState> = {
        tick: 100,
        updates: { x: 10 },
      };

      applySnapshot(state, snapshot);
      expect(state.x).toBe(10);
      expect(state.y).toBe(0);
      expect(state.health).toBe(100);
    });

    it("should handle nested object updates", () => {
      const state: TestState = { x: 0, y: 0, nested: { a: 1, b: 2 } };
      const snapshot: Snapshot<TestState> = {
        tick: 100,
        updates: { nested: { a: 10 } },
      };

      applySnapshot(state, snapshot);
      expect(state.nested?.a).toBe(10);
      expect(state.nested?.b).toBe(2);
    });

    it("should replace arrays entirely", () => {
      const state: TestState = { x: 0, y: 0, items: ["a", "b", "c"] };
      const snapshot: Snapshot<TestState> = {
        tick: 100,
        updates: { items: ["x", "y"] },
      };

      applySnapshot(state, snapshot);
      expect(state.items).toEqual(["x", "y"]);
    });

    it("should handle null values", () => {
      const state: TestState = { x: 0, y: 0, health: 100 };
      const snapshot: Snapshot<TestState> = {
        tick: 100,
        updates: { health: null as any },
      };

      applySnapshot(state, snapshot);
      expect(state.health).toBeNull();
    });
  });
});

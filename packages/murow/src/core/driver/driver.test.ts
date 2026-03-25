import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { RafDriver, ImmediateDriver, TimeoutDriver } from "./drivers";
import { createDriver } from "./driver";

// Mock requestAnimationFrame for testing (Node.js doesn't have it)
(() => {
  let rafId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  let running = false;
  let intervalId: Timer | null = null;

  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = ++rafId;
    callbacks.set(id, callback);

    if (!running) {
      running = true;
      intervalId = setInterval(() => {
        const now = performance.now();
        const cbs = Array.from(callbacks.entries());
        callbacks.clear();
        for (const [_, cb] of cbs) {
          cb(now);
        }
        if (callbacks.size === 0) {
          running = false;
          if (intervalId) clearInterval(intervalId);
        }
      }, 16); // ~60fps
    }

    return id;
  };

  (globalThis as any).cancelAnimationFrame = (id: number): void => {
    callbacks.delete(id);
    if (callbacks.size === 0) {
      running = false;
      if (intervalId) clearInterval(intervalId);
    }
  };
})();

describe("Driver", () => {
  describe("createDriver", () => {
    test("should create RafDriver for client type", () => {
      const driver = createDriver('client', () => {});
      expect(driver).toBeInstanceOf(RafDriver);
    });

    test("should create ImmediateDriver for server-immediate type", () => {
      const driver = createDriver('server-immediate', () => {});
      expect(driver).toBeInstanceOf(ImmediateDriver);
    });

    test("should create TimeoutDriver for server-timeout type", () => {
      const driver = createDriver('server-timeout', () => {});
      expect(driver).toBeInstanceOf(TimeoutDriver);
    });

    test("should pass update callback to driver", () => {
      let called = false;
      const update = () => { called = true; };
      const driver = createDriver('server-immediate', update);

      // Access the update function directly
      (driver as ImmediateDriver).update(0.016);
      expect(called).toBe(true);
    });
  });

  describe("ImmediateDriver", () => {
    let driver: ImmediateDriver;
    let updateCalls: number[] = [];

    beforeEach(() => {
      updateCalls = [];
      driver = new ImmediateDriver((dt) => {
        updateCalls.push(dt);
      });
    });

    afterEach(() => {
      driver.stop();
    });

    test("should initialize without starting", () => {
      expect(updateCalls.length).toBe(0);
    });

    test("should call update with delta time", async () => {
      driver.start();

      // Wait for a few ticks
      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      expect(updateCalls.length).toBeGreaterThan(0);

      // Delta times should be positive and in seconds
      for (const dt of updateCalls) {
        expect(dt).toBeGreaterThan(0);
        expect(dt).toBeLessThan(1); // Should be less than 1 second
      }
    });

    test("should stop calling update after stop", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      driver.stop();

      const callsAfterStop = updateCalls.length;

      // Wait a bit more
      await new Promise(resolve => setTimeout(resolve, 20));

      // Should not have significantly more calls (allow 1-2 in-flight)
      expect(updateCalls.length - callsAfterStop).toBeLessThanOrEqual(2);
    });

    test("should calculate delta time correctly", async () => {
      driver.start();

      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      // Sum of all deltas should approximately equal wall time
      const totalTime = updateCalls.reduce((sum, dt) => sum + dt, 0);
      expect(totalTime).toBeGreaterThan(0.04); // At least 40ms
      expect(totalTime).toBeLessThan(0.1); // Less than 100ms
    });

    test("should handle restart", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      driver.stop();

      const firstBatch = updateCalls.length;
      updateCalls = [];

      driver.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      driver.stop();

      expect(updateCalls.length).toBeGreaterThan(0);
    });
  });

  describe("RafDriver", () => {
    let driver: RafDriver;
    let updateCalls: number[] = [];

    beforeEach(() => {
      updateCalls = [];
      driver = new RafDriver((dt) => {
        updateCalls.push(dt);
      });
    });

    afterEach(() => {
      driver.stop();
    });

    test("should initialize without starting", () => {
      expect(updateCalls.length).toBe(0);
    });

    test("should call update with delta time", async () => {
      driver.start();

      // Wait for a few frames (at 60fps, 100ms = ~6 frames)
      await new Promise(resolve => setTimeout(resolve, 100));
      driver.stop();

      expect(updateCalls.length).toBeGreaterThan(0);

      // Delta times should be positive and reasonable for 60fps
      for (const dt of updateCalls) {
        expect(dt).toBeGreaterThan(0);
        expect(dt).toBeLessThan(0.1); // Less than 100ms per frame
      }
    });

    test("should stop calling update after stop", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      const callsAfterStop = updateCalls.length;

      // Wait for potential in-flight RAF
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should not have any more calls (RAF properly cancelled)
      expect(updateCalls.length).toBe(callsAfterStop);
    });

    test("should calculate delta time correctly", async () => {
      driver.start();

      await new Promise(resolve => setTimeout(resolve, 100));
      driver.stop();

      // Sum of all deltas should approximately equal wall time
      const totalTime = updateCalls.reduce((sum, dt) => sum + dt, 0);
      expect(totalTime).toBeGreaterThan(0.08); // At least 80ms
      expect(totalTime).toBeLessThan(0.15); // Less than 150ms
    });

    test("should handle restart", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      const firstBatch = updateCalls.length;
      updateCalls = [];

      driver.start();
      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test("should cancel RAF on stop", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Stop should cancel the RAF
      driver.stop();

      // rafId should be cleared
      expect((driver as any).rafId).toBe(null);
    });
  });

  describe("TimeoutDriver", () => {
    let driver: TimeoutDriver;
    let updateCalls: number[] = [];

    beforeEach(() => {
      updateCalls = [];
      driver = new TimeoutDriver((dt) => {
        updateCalls.push(dt);
      });
    });

    afterEach(() => {
      driver.stop();
    });

    test("should initialize without starting", () => {
      expect(updateCalls.length).toBe(0);
    });

    test("should call update with delta time", async () => {
      driver.start();

      // Wait for a few ticks
      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      expect(updateCalls.length).toBeGreaterThan(0);

      // Delta times should be positive and in seconds
      for (const dt of updateCalls) {
        expect(dt).toBeGreaterThan(0);
        expect(dt).toBeLessThan(1); // Should be less than 1 second
      }
    });

    test("should stop calling update after stop", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      driver.stop();

      const callsAfterStop = updateCalls.length;

      // Wait a bit more
      await new Promise(resolve => setTimeout(resolve, 20));

      // Should not have significantly more calls (allow 1-2 in-flight)
      expect(updateCalls.length - callsAfterStop).toBeLessThanOrEqual(2);
    });

    test("should calculate delta time correctly", async () => {
      driver.start();

      await new Promise(resolve => setTimeout(resolve, 50));
      driver.stop();

      // Sum of all deltas should approximately equal wall time
      const totalTime = updateCalls.reduce((sum, dt) => sum + dt, 0);
      expect(totalTime).toBeGreaterThan(0.04); // At least 40ms
      expect(totalTime).toBeLessThan(0.1); // Less than 100ms
    });

    test("should handle restart", async () => {
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      driver.stop();

      const firstBatch = updateCalls.length;
      updateCalls = [];

      driver.start();
      await new Promise(resolve => setTimeout(resolve, 20));
      driver.stop();

      expect(updateCalls.length).toBeGreaterThan(0);
    });

    test("should run slower than ImmediateDriver due to 1ms delay", async () => {
      let timeoutTicks = 0;
      let immediateTicks = 0;

      const timeoutDriver = new TimeoutDriver(() => { timeoutTicks++; });
      const immediateDriver = new ImmediateDriver(() => { immediateTicks++; });

      timeoutDriver.start();
      immediateDriver.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      timeoutDriver.stop();
      immediateDriver.stop();

      // ImmediateDriver should tick significantly more than TimeoutDriver
      expect(immediateTicks).toBeGreaterThan(timeoutTicks);
    });
  });

  describe("Driver comparison", () => {
    test("ImmediateDriver should run faster than RAF", async () => {
      let immediateTicks = 0;
      let rafTicks = 0;

      const immediateDriver = new ImmediateDriver(() => { immediateTicks++; });
      const rafDriver = new RafDriver(() => { rafTicks++; });

      immediateDriver.start();
      rafDriver.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      immediateDriver.stop();
      rafDriver.stop();

      // setImmediate should tick way more than RAF (~60fps)
      expect(immediateTicks).toBeGreaterThan(rafTicks * 2);
    });

    test("TimeoutDriver should run faster than RAF but slower than Immediate", async () => {
      let timeoutTicks = 0;
      let rafTicks = 0;
      let immediateTicks = 0;

      const timeoutDriver = new TimeoutDriver(() => { timeoutTicks++; });
      const rafDriver = new RafDriver(() => { rafTicks++; });
      const immediateDriver = new ImmediateDriver(() => { immediateTicks++; });

      timeoutDriver.start();
      rafDriver.start();
      immediateDriver.start();

      await new Promise(resolve => setTimeout(resolve, 100));

      timeoutDriver.stop();
      rafDriver.stop();
      immediateDriver.stop();

      // TimeoutDriver should be between RAF and Immediate
      expect(timeoutTicks).toBeGreaterThan(rafTicks);
      expect(immediateTicks).toBeGreaterThan(timeoutTicks);
    });
  });

  describe("Edge cases", () => {
    test("should handle multiple stops gracefully", () => {
      const driver = new ImmediateDriver(() => {});
      driver.start();
      driver.stop();
      driver.stop(); // Should not throw
      driver.stop(); // Should not throw
    });

    test("should handle stop before start", () => {
      const driver = new RafDriver(() => {});
      driver.stop(); // Should not throw
    });

    test("should reset timing on restart to prevent large delta", async () => {
      let firstDelta = 0;
      const driver = new ImmediateDriver((dt) => {
        if (firstDelta === 0) firstDelta = dt;
      });

      driver.start();
      await new Promise(resolve => setTimeout(resolve, 10));
      driver.stop();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 100));

      firstDelta = 0;
      driver.start();
      await new Promise(resolve => setTimeout(resolve, 10));
      driver.stop();

      // First delta after restart should be small, not 100ms+
      expect(firstDelta).toBeLessThan(0.05);
    });
  });
});

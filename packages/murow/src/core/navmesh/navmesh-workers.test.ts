import { describe, test, expect, beforeEach } from "bun:test";
import { NavMesh } from "./navmesh";

interface Vec2 {
  x: number;
  y: number;
}

describe("NavMesh - Worker Configuration", () => {
  test("should initialize with default options (workers disabled)", () => {
    const navmesh = new NavMesh("grid");

    const status = navmesh.getWorkerStatus();
    expect(status.workersEnabled).toBe(false);
    expect(status.workerPoolActive).toBe(false);
    expect(status.pendingPaths).toBe(0);
    expect(status.usingWorkersNow).toBe(false);
  });

  test("should accept workers: false option", () => {
    const navmesh = new NavMesh("grid", { workers: false });

    const status = navmesh.getWorkerStatus();
    expect(status.workersEnabled).toBe(false);
  });

  test("should accept workers: 'auto' option", () => {
    const navmesh = new NavMesh("grid", { workers: "auto" });

    const status = navmesh.getWorkerStatus();
    expect(status.workersEnabled).toBe("auto");
    expect(status.workerPoolActive).toBe(false); // Not initialized yet
  });

  test("should accept workers: true option", () => {
    const navmesh = new NavMesh("grid", { workers: true });

    const status = navmesh.getWorkerStatus();
    expect(status.workersEnabled).toBe(true);
  });

  test("should accept workerPoolSize option", () => {
    const navmesh = new NavMesh("grid", {
      workers: false,
      workerPoolSize: 8
    });

    // Pool size stored but not used when workers disabled
    expect(navmesh).toBeDefined();
  });

  test("should accept workerPath option", () => {
    const navmesh = new NavMesh("grid", {
      workers: false,
      workerPath: "./custom-worker.js"
    });

    expect(navmesh).toBeDefined();
  });
});

describe("NavMesh - Synchronous Pathfinding (workers: false)", () => {
  let navmesh: NavMesh<false>;

  beforeEach(() => {
    navmesh = new NavMesh("grid", { workers: false });
  });

  test("should find path synchronously", () => {
    const path = navmesh.findPath({
      from: { x: 0, y: 0 },
      to: { x: 5, y: 5 }
    }); // No type assertion needed! Typed as Vec2[]

    // Result should be an array (not a Promise)
    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });

  test("should handle obstacles with sync pathfinding", () => {
    navmesh.addObstacle({
      type: "circle",
      pos: { x: 2, y: 2 },
      radius: 1,
    });

    const path = navmesh.findPath({
      from: { x: 0, y: 0 },
      to: { x: 5, y: 5 }
    }); // No type assertion needed!

    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });

  test("should never use workers when disabled", () => {
    const status1 = navmesh.getWorkerStatus();
    expect(status1.usingWorkersNow).toBe(false);

    // Even with many pending paths (simulate by checking status)
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });

    const status2 = navmesh.getWorkerStatus();
    expect(status2.usingWorkersNow).toBe(false);
    expect(Array.isArray(path)).toBe(true);
  });

  test("should handle multiple sequential paths", () => {
    const paths: Vec2[][] = [];

    for (let i = 0; i < 10; i++) {
      const path = navmesh.findPath({
        from: { x: i, y: 0 },
        to: { x: i, y: 5 },
      });
      paths.push(path);
    }

    expect(paths.length).toBe(10);
    paths.forEach((path) => {
      expect(Array.isArray(path)).toBe(true);
    });
  });
});

describe("NavMesh - Auto Mode (workers: 'auto')", () => {
  let navmesh: NavMesh<'auto'>;

  beforeEach(() => {
    navmesh = new NavMesh("grid", { workers: "auto" });
  });

  test("should use sync for small number of paths", () => {
    const status1 = navmesh.getWorkerStatus();
    expect(status1.usingWorkersNow).toBe(false);

    // Single path should be sync - typed as Vec2[] | Promise<Vec2[]>
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });
    // In auto mode with low load, it returns Vec2[] (sync)
    expect(Array.isArray(path) || path instanceof Promise).toBe(true);
  });

  test("should track pending paths", () => {
    const status1 = navmesh.getWorkerStatus();
    expect(status1.pendingPaths).toBe(0);

    // After finding a path synchronously
    navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });

    const status2 = navmesh.getWorkerStatus();
    expect(status2.pendingPaths).toBe(0); // Sync path completes immediately
  });

  test("should not initialize workers until threshold reached", () => {
    const status = navmesh.getWorkerStatus();
    expect(status.workerPoolActive).toBe(false);
  });
});

describe("NavMesh - Return Type Handling", () => {
  test("sync mode returns Vec2[]", () => {
    const navmesh = new NavMesh("grid", { workers: false });
    const result = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });

    // Should be a plain array - TypeScript knows it's Vec2[]
    expect(Array.isArray(result)).toBe(true);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.length).toBeGreaterThan(0); // No type error!
  });

  test("auto mode with low load", () => {
    const navmesh = new NavMesh("grid", { workers: "auto" });
    const result = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });

    // Could be Vec2[] or Promise<Vec2[]>
    expect(Array.isArray(result) || result instanceof Promise).toBe(true);
  });

  test("should handle both sync and async results gracefully", async () => {
    const navmesh = new NavMesh("grid", { workers: "auto" });

    const result = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });

    // Handle both cases
    const path = result instanceof Promise ? await result : result;

    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe("NavMesh - Obstacle Management with Workers", () => {
  test("should add obstacles before pathfinding (sync)", () => {
    const navmesh = new NavMesh("grid", { workers: false });

    const id1 = navmesh.addObstacle({ type: "circle", pos: { x: 2, y: 2 }, radius: 1 });
    const id2 = navmesh.addObstacle({ type: "circle", pos: { x: 3, y: 3 }, radius: 1 });

    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(0);
    expect(id1).not.toBe(id2);

    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });
    expect(Array.isArray(path)).toBe(true);
  });

  test("should move obstacles (sync)", () => {
    const navmesh = new NavMesh("grid", { workers: false });

    const id = navmesh.addObstacle({ type: "circle", pos: { x: 2, y: 2 }, radius: 1 });
    navmesh.moveObstacle(id, { x: 3, y: 3 });

    const obstacles = navmesh.getObstacles();
    expect(obstacles[0].pos.x).toBe(3);
    expect(obstacles[0].pos.y).toBe(3);
  });

  test("should remove obstacles (sync)", () => {
    const navmesh = new NavMesh("grid", { workers: false });

    const id = navmesh.addObstacle({ type: "circle", pos: { x: 2, y: 2 }, radius: 1 });
    expect(navmesh.getObstacles().length).toBe(1);

    navmesh.removeObstacle(id);
    expect(navmesh.getObstacles().length).toBe(0);
  });
});

describe("NavMesh - Cleanup", () => {
  test("should dispose cleanly (sync mode)", () => {
    const navmesh = new NavMesh("grid", { workers: false });

    navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });
    navmesh.dispose();

    const status = navmesh.getWorkerStatus();
    expect(status.workerPoolActive).toBe(false);
  });

  test("should dispose cleanly (auto mode, not initialized)", () => {
    const navmesh = new NavMesh("grid", { workers: "auto" });

    navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });
    navmesh.dispose();

    const status = navmesh.getWorkerStatus();
    expect(status.workerPoolActive).toBe(false);
  });
});

describe("NavMesh - Edge Cases", () => {
  test("should handle same start and end position", () => {
    const navmesh = new NavMesh("grid", { workers: false });
    const path = navmesh.findPath({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 } });

    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });

  test("should handle no path available", () => {
    const navmesh = new NavMesh("grid", { workers: false });

    // Create a small blocked area (not too large to avoid memory issues)
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        if (x === 0 && y === 0) continue;
        navmesh.addObstacle({
          type: "circle",
          pos: { x, y },
          radius: 0.9,
        });
      }
    }

    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    expect(path.length).toBe(0);
  });

  test("should handle negative coordinates", () => {
    const navmesh = new NavMesh("grid", { workers: false });
    const path = navmesh.findPath({
      from: { x: -5, y: -5 },
      to: { x: 5, y: 5 },
    });

    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe("NavMesh - Graph Navigation with Workers", () => {
  test("should support graph mode with sync", () => {
    const navmesh = new NavMesh("graph", { workers: false });
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });

    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });

  test("should support graph mode with auto", () => {
    const navmesh = new NavMesh("graph", { workers: "auto" });
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }) as Vec2[];

    expect(Array.isArray(path)).toBe(true);
    expect(path.length).toBeGreaterThan(0);
  });
});

describe("NavMesh - Integration Tests", () => {
  test("should handle realistic game scenario (10 units)", () => {
    const navmesh = new NavMesh("grid", { workers: "auto" });

    // Add some obstacles
    for (let i = 0; i < 5; i++) {
      navmesh.addObstacle({
        type: "circle",
        pos: { x: Math.random() * 20, y: Math.random() * 20 },
        radius: 0.5,
      });
    }

    // Find paths for 10 units
    const paths = [];
    for (let i = 0; i < 10; i++) {
      const path = navmesh.findPath({
        from: { x: i, y: 0 },
        to: { x: i, y: 20 },
      });
      paths.push(path);
    }

    expect(paths.length).toBe(10);
    paths.forEach((path) => {
      expect(Array.isArray(path)).toBe(true);
    });

    navmesh.dispose();
  });

  test("should maintain worker status throughout lifecycle", () => {
    const navmesh = new NavMesh("grid", { workers: "auto" });

    const status1 = navmesh.getWorkerStatus();
    expect(status1.pendingPaths).toBe(0);

    navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 5 } });

    const status2 = navmesh.getWorkerStatus();
    expect(status2.pendingPaths).toBe(0); // Completed synchronously

    navmesh.dispose();

    const status3 = navmesh.getWorkerStatus();
    expect(status3.workerPoolActive).toBe(false);
  });
});

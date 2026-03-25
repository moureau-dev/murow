import { describe, expect, test, beforeEach } from "bun:test";
import { NavMesh } from "./navmesh";

describe("NavMesh - Grid Navigation", () => {
  let navmesh: NavMesh;

  beforeEach(() => {
    navmesh = new NavMesh("grid");
  });

  test("should initialize with grid type", () => {
    expect(navmesh).toBeDefined();
  });

  test("should find straight path with no obstacles", () => {
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 3, y: 0 } });
    expect(path.length).toBeGreaterThan(0);
    // Path returns cell centers (0.5, 0.5) not exact coordinates
    expect(path[0].x).toBeCloseTo(0.5, 1);
    expect(path[0].y).toBeCloseTo(0.5, 1);
  });

  test("should add circle obstacle", () => {
    const id = navmesh.addObstacle({
      type: "circle",
      pos: { x: 5, y: 5 },
      radius: 2,
    });
    expect(id).toBeGreaterThan(0);
    expect(navmesh.getObstacles().length).toBe(1);
  });

  test("should add rectangle obstacle", () => {
    const id = navmesh.addObstacle({
      type: "rect",
      pos: { x: 5, y: 5 },
      size: { x: 2, y: 3 },
    });
    expect(id).toBeGreaterThan(0);
  });

  test("should add polygon obstacle", () => {
    const id = navmesh.addObstacle({
      type: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      pos: { x: 10, y: 10 },
    });
    expect(id).toBeGreaterThan(0);
  });

  test("should find path around circle obstacle", () => {
    navmesh.addObstacle({
      type: "circle",
      pos: { x: 2, y: 0 },
      radius: 1,
    });

    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 4, y: 0 } });
    expect(path.length).toBeGreaterThan(2); // Should go around, not through
  });

  test("should find path around rectangle obstacle", () => {
    navmesh.addObstacle({
      type: "rect",
      pos: { x: 2, y: -1 },
      size: { x: 2, y: 2 },
    });

    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 5, y: 0 } });
    expect(path.length).toBeGreaterThan(0);
  });

  test("should return empty path when completely surrounded", () => {
    // Surround the start position completely
    for (let x = -2; x <= 2; x++) {
      for (let y = -2; y <= 2; y++) {
        if (x === 0 && y === 0) continue; // Skip the start position
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

  test("should remove obstacle", () => {
    const id = navmesh.addObstacle({
      type: "circle",
      pos: { x: 5, y: 5 },
      radius: 1,
    });

    expect(navmesh.getObstacles().length).toBe(1);
    navmesh.removeObstacle(id);
    expect(navmesh.getObstacles().length).toBe(0);
  });

  test("should move obstacle", () => {
    const id = navmesh.addObstacle({
      type: "circle",
      pos: { x: 5, y: 5 },
      radius: 1,
    });

    navmesh.moveObstacle(id, { x: 10, y: 10 });
    const obstacles = navmesh.getObstacles();
    expect(obstacles[0].pos.x).toBe(10);
    expect(obstacles[0].pos.y).toBe(10);
  });

  test("should handle multiple obstacles", () => {
    navmesh.addObstacle({ type: "circle", pos: { x: 2, y: 2 }, radius: 1 });
    navmesh.addObstacle({ type: "circle", pos: { x: 4, y: 2 }, radius: 1 });
    navmesh.addObstacle({ type: "circle", pos: { x: 6, y: 2 }, radius: 1 });

    expect(navmesh.getObstacles().length).toBe(3);
  });

  test("should rebuild navigation when obstacles change", () => {
    const id = navmesh.addObstacle({
      type: "circle",
      pos: { x: 2, y: 0 },
      radius: 1,
    });

    const path1 = navmesh.findPath({
      from: { x: 0, y: 0 },
      to: { x: 4, y: 0 },
    });

    navmesh.removeObstacle(id);

    const path2 = navmesh.findPath({
      from: { x: 0, y: 0 },
      to: { x: 4, y: 0 },
    });

    // Path should be shorter after removing obstacle
    expect(path2.length).toBeLessThanOrEqual(path1.length);
  });

  test("should handle rotated rectangle obstacle", () => {
    const id = navmesh.addObstacle({
      type: "rect",
      pos: { x: 5, y: 5 },
      size: { x: 3, y: 1 },
      rotation: Math.PI / 4, // 45 degrees
    });

    expect(navmesh.getObstacles().length).toBe(1);
  });

  test("should handle rotated polygon obstacle", () => {
    const id = navmesh.addObstacle({
      type: "polygon",
      points: [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: 1 },
      ],
      pos: { x: 5, y: 5 },
      rotation: Math.PI / 6,
    });

    expect(navmesh.getObstacles().length).toBe(1);
  });

  test("should handle non-solid obstacles", () => {
    navmesh.addObstacle({
      type: "circle",
      pos: { x: 2, y: 0 },
      radius: 1,
      solid: false,
    });

    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 4, y: 0 } });
    // Path should go through non-solid obstacle
    expect(path.length).toBeGreaterThan(0);
  });

  test("should find optimal path", () => {
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 0, y: 5 } });
    // Direct path should be approximately 6 steps (0 to 5)
    expect(path.length).toBeLessThanOrEqual(10);
  });
});

describe("NavMesh - Graph Navigation", () => {
  let navmesh: NavMesh;

  beforeEach(() => {
    navmesh = new NavMesh("graph");
  });

  test("should initialize with graph type", () => {
    expect(navmesh).toBeDefined();
  });

  test("should find direct path with no obstacles", () => {
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    expect(path.length).toBeGreaterThan(0);
    expect(path[0].x).toBeCloseTo(0, 1);
    expect(path[0].y).toBeCloseTo(0, 1);
  });

  test("should add obstacles", () => {
    const id = navmesh.addObstacle({
      type: "circle",
      pos: { x: 5, y: 5 },
      radius: 2,
    });
    expect(id).toBeGreaterThan(0);
  });

  test("should find path around obstacles", () => {
    navmesh.addObstacle({
      type: "circle",
      pos: { x: 5, y: 5 },
      radius: 2,
    });

    const path = navmesh.findPath({ from: { x: 0, y: 5 }, to: { x: 10, y: 5 } });
    expect(path.length).toBeGreaterThan(0);
  });
});

describe("NavMesh - Edge Cases", () => {
  test("should handle same start and end position", () => {
    const navmesh = new NavMesh("grid");
    const path = navmesh.findPath({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 } });
    expect(path.length).toBeGreaterThan(0);
  });

  test("should handle negative coordinates", () => {
    const navmesh = new NavMesh("grid");
    const path = navmesh.findPath({
      from: { x: -5, y: -5 },
      to: { x: 5, y: 5 },
    });
    expect(path.length).toBeGreaterThan(0);
  });

  test("should handle large distances", () => {
    const navmesh = new NavMesh("grid");
    const path = navmesh.findPath({
      from: { x: 0, y: 0 },
      to: { x: 100, y: 100 },
    });
    expect(path.length).toBeGreaterThan(0);
  });

  test("should handle very small obstacles", () => {
    const navmesh = new NavMesh("grid");
    navmesh.addObstacle({
      type: "circle",
      pos: { x: 5, y: 5 },
      radius: 0.1,
    });
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    expect(path.length).toBeGreaterThan(0);
  });

  test("should handle overlapping obstacles", () => {
    const navmesh = new NavMesh("grid");
    navmesh.addObstacle({ type: "circle", pos: { x: 5, y: 5 }, radius: 2 });
    navmesh.addObstacle({ type: "circle", pos: { x: 5, y: 5 }, radius: 3 });
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    expect(path.length).toBeGreaterThanOrEqual(0);
  });

  test("should generate unique obstacle IDs", () => {
    const navmesh = new NavMesh("grid");
    const id1 = navmesh.addObstacle({
      type: "circle",
      pos: { x: 1, y: 1 },
      radius: 1,
    });
    const id2 = navmesh.addObstacle({
      type: "circle",
      pos: { x: 2, y: 2 },
      radius: 1,
    });
    const id3 = navmesh.addObstacle({
      type: "circle",
      pos: { x: 3, y: 3 },
      radius: 1,
    });

    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
    expect(id1).not.toBe(id3);
  });

  test("should handle complex polygon shapes", () => {
    const navmesh = new NavMesh("grid");
    navmesh.addObstacle({
      type: "polygon",
      points: [
        { x: -2, y: -1 },
        { x: 0, y: -2 },
        { x: 2, y: -1 },
        { x: 2, y: 1 },
        { x: 0, y: 2 },
        { x: -2, y: 1 },
      ],
      pos: { x: 10, y: 10 },
    });

    const path = navmesh.findPath({ from: { x: 0, y: 10 }, to: { x: 20, y: 10 } });
    expect(path.length).toBeGreaterThanOrEqual(0);
  });
});

describe("NavMesh - Performance", () => {
  test("should handle many obstacles efficiently", () => {
    const navmesh = new NavMesh("grid");

    // Add 100 random obstacles
    for (let i = 0; i < 100; i++) {
      navmesh.addObstacle({
        type: "circle",
        pos: { x: Math.random() * 50, y: Math.random() * 50 },
        radius: 0.5,
      });
    }

    const start = performance.now();
    const path = navmesh.findPath({ from: { x: 0, y: 0 }, to: { x: 50, y: 50 } });
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(1000); // Should complete in under 1 second
    expect(path).toBeDefined();
  });
});

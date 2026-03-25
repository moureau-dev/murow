import { describe, expect, test } from "bun:test";
import { IntentTracker, Reconciliator } from "./prediction";

describe("IntentTracker", () => {
  test("should initialize with size 0", () => {
    const tracker = new IntentTracker<string>();
    expect(tracker.size).toBe(0);
  });

  test("should track intent for a tick", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(1, "move_forward");
    expect(tracker.size).toBe(1);
  });

  test("should track multiple intents", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(1, "move_forward");
    tracker.track(2, "jump");
    tracker.track(3, "shoot");
    expect(tracker.size).toBe(3);
  });

  test("should return all intents in ascending tick order", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(3, "third");
    tracker.track(1, "first");
    tracker.track(2, "second");

    const values = tracker.values();
    expect(values).toEqual(["first", "second", "third"]);
  });

  test("should drop intents up to specified tick", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(1, "intent1");
    tracker.track(2, "intent2");
    tracker.track(3, "intent3");
    tracker.track(4, "intent4");

    const remaining = tracker.dropUpTo(2);
    expect(remaining).toEqual(["intent3", "intent4"]);
    expect(tracker.size).toBe(2);
  });

  test("should drop all intents when tick is at the end", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(1, "intent1");
    tracker.track(2, "intent2");
    tracker.track(3, "intent3");

    const remaining = tracker.dropUpTo(5);
    expect(remaining).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  test("should keep all intents when drop tick is before all", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(5, "intent1");
    tracker.track(6, "intent2");
    tracker.track(7, "intent3");

    const remaining = tracker.dropUpTo(4);
    expect(remaining).toEqual(["intent1", "intent2", "intent3"]);
    expect(tracker.size).toBe(3);
  });

  test("should handle dropping from empty tracker", () => {
    const tracker = new IntentTracker<string>();
    const remaining = tracker.dropUpTo(10);
    expect(remaining).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  test("should handle complex intent objects", () => {
    interface MoveIntent {
      action: string;
      x: number;
      y: number;
    }

    const tracker = new IntentTracker<MoveIntent>();
    tracker.track(1, { action: "move", x: 10, y: 20 });
    tracker.track(2, { action: "move", x: 15, y: 25 });

    const values = tracker.values();
    expect(values.length).toBe(2);
    expect(values[0]).toEqual({ action: "move", x: 10, y: 20 });
    expect(values[1]).toEqual({ action: "move", x: 15, y: 25 });
  });

  test("should handle multiple intents at same tick", () => {
    const tracker = new IntentTracker<string>();
    tracker.track(1, "first");
    tracker.track(1, "second"); // Add to same tick

    expect(tracker.size).toBe(1); // Still one tick
    const values = tracker.values();
    expect(values).toEqual(["first", "second"]); // Both intents stored
  });

  test("should maintain correct size after operations", () => {
    const tracker = new IntentTracker<number>();
    expect(tracker.size).toBe(0);

    tracker.track(1, 100);
    expect(tracker.size).toBe(1);

    tracker.track(2, 200);
    expect(tracker.size).toBe(2);

    tracker.dropUpTo(1);
    expect(tracker.size).toBe(1);

    tracker.dropUpTo(10);
    expect(tracker.size).toBe(0);
  });
});

describe("Reconciliator", () => {
  interface PlayerState {
    x: number;
    y: number;
    health: number;
  }

  interface PlayerIntent {
    dx: number;
    dy: number;
  }

  test("should initialize with callbacks", () => {
    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: () => {},
      onReplay: () => {},
    });

    expect(reconciliator).toBeDefined();
  });

  test("should track intents", () => {
    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: () => {},
      onReplay: () => {},
    });

    reconciliator.trackIntent(1, { dx: 1, dy: 0 });
    reconciliator.trackIntent(2, { dx: 0, dy: 1 });

    // No direct way to check size, but we can verify through snapshot
    expect(reconciliator).toBeDefined();
  });

  test("should load state and replay intents on snapshot", () => {
    let loadedState: PlayerState | null = null;
    let replayedIntents: PlayerIntent[] = [];

    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: (state) => {
        loadedState = state;
      },
      onReplay: (intents) => {
        replayedIntents = intents;
      },
    });

    // Track some intents
    reconciliator.trackIntent(1, { dx: 1, dy: 0 });
    reconciliator.trackIntent(2, { dx: 0, dy: 1 });
    reconciliator.trackIntent(3, { dx: -1, dy: 0 });

    // Receive snapshot at tick 2
    const snapshot = {
      tick: 2,
      state: { x: 10, y: 20, health: 100 },
    };

    reconciliator.onSnapshot(snapshot);

    // Should load state
    expect(loadedState!).toEqual({ x: 10, y: 20, health: 100 });

    // Should replay only intent at tick 3 (after tick 2)
    expect(replayedIntents).toEqual([{ dx: -1, dy: 0 }]);
  });

  test("should drop all intents when snapshot is ahead", () => {
    let replayedIntents: PlayerIntent[] = [];

    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: () => {},
      onReplay: (intents) => {
        replayedIntents = intents;
      },
    });

    reconciliator.trackIntent(1, { dx: 1, dy: 0 });
    reconciliator.trackIntent(2, { dx: 0, dy: 1 });

    // Snapshot ahead of all intents
    reconciliator.onSnapshot({
      tick: 10,
      state: { x: 100, y: 100, health: 50 },
    });

    expect(replayedIntents).toEqual([]);
  });

  test("should keep all intents when snapshot is behind", () => {
    let replayedIntents: PlayerIntent[] = [];

    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: () => {},
      onReplay: (intents) => {
        replayedIntents = intents;
      },
    });

    reconciliator.trackIntent(5, { dx: 1, dy: 0 });
    reconciliator.trackIntent(6, { dx: 0, dy: 1 });
    reconciliator.trackIntent(7, { dx: -1, dy: 0 });

    // Snapshot before all intents
    reconciliator.onSnapshot({
      tick: 3,
      state: { x: 0, y: 0, health: 100 },
    });

    expect(replayedIntents.length).toBe(3);
    expect(replayedIntents).toEqual([
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: 0 },
    ]);
  });

  test("should handle multiple snapshots", () => {
    let loadedStates: PlayerState[] = [];
    let allReplayedIntents: PlayerIntent[][] = [];

    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: (state) => {
        loadedStates.push({ ...state });
      },
      onReplay: (intents) => {
        allReplayedIntents.push([...intents]);
      },
    });

    // Track intents 1-5
    for (let i = 1; i <= 5; i++) {
      reconciliator.trackIntent(i, { dx: i, dy: i });
    }

    // First snapshot at tick 2
    reconciliator.onSnapshot({
      tick: 2,
      state: { x: 20, y: 20, health: 100 },
    });

    // Track more intents 6-8
    for (let i = 6; i <= 8; i++) {
      reconciliator.trackIntent(i, { dx: i, dy: i });
    }

    // Second snapshot at tick 6
    reconciliator.onSnapshot({
      tick: 6,
      state: { x: 60, y: 60, health: 90 },
    });

    expect(loadedStates.length).toBe(2);
    expect(loadedStates[0]).toEqual({ x: 20, y: 20, health: 100 });
    expect(loadedStates[1]).toEqual({ x: 60, y: 60, health: 90 });

    // After first snapshot, should replay ticks 3, 4, 5
    expect(allReplayedIntents[0].length).toBe(3);

    // After second snapshot, should replay ticks 7, 8
    expect(allReplayedIntents[1].length).toBe(2);
  });

  test("should handle empty intent list", () => {
    let onReplayCalled = false;

    const reconciliator = new Reconciliator<PlayerIntent, PlayerState>({
      onLoadState: () => {},
      onReplay: (intents) => {
        onReplayCalled = true;
      },
    });

    // Receive snapshot with no tracked intents
    reconciliator.onSnapshot({
      tick: 5,
      state: { x: 50, y: 50, health: 100 },
    });

    // onReplay should not be called when there are no intents to replay
    expect(onReplayCalled).toBe(false);
  });

  test("should work with complex intent types", () => {
    interface ComplexIntent {
      type: "move" | "attack" | "defend";
      target?: { x: number; y: number };
      data?: Record<string, any>;
    }

    interface ComplexState {
      position: { x: number; y: number };
      inventory: string[];
    }

    let capturedState: ComplexState | null = null;
    let capturedIntents: ComplexIntent[] = [];

    const reconciliator = new Reconciliator<ComplexIntent, ComplexState>({
      onLoadState: (state) => {
        capturedState = state;
      },
      onReplay: (intents) => {
        capturedIntents = intents;
      },
    });

    reconciliator.trackIntent(1, { type: "move", target: { x: 10, y: 10 } });
    reconciliator.trackIntent(2, { type: "attack", data: { damage: 50 } });
    reconciliator.trackIntent(3, { type: "defend" });

    reconciliator.onSnapshot({
      tick: 1,
      state: {
        position: { x: 5, y: 5 },
        inventory: ["sword", "shield"],
      },
    });

    expect(capturedState!).toEqual({
      position: { x: 5, y: 5 },
      inventory: ["sword", "shield"],
    });

    expect(capturedIntents.length).toBe(2);
    expect(capturedIntents[0].type).toBe("attack");
    expect(capturedIntents[1].type).toBe("defend");
  });

  test("should handle rapid intent tracking", () => {
    let replayCount = 0;

    const reconciliator = new Reconciliator<number, { value: number }>({
      onLoadState: () => {},
      onReplay: (intents) => {
        replayCount = intents.length;
      },
    });

    // Track 1000 intents rapidly
    for (let i = 1; i <= 1000; i++) {
      reconciliator.trackIntent(i, i);
    }

    // Snapshot in the middle
    reconciliator.onSnapshot({
      tick: 500,
      state: { value: 500 },
    });

    // Should replay remaining 500 intents
    expect(replayCount).toBe(500);
  });
});

describe("Reconciliator - Integration", () => {
  test("should correctly reconcile game state", () => {
    interface Position {
      x: number;
      y: number;
    }

    interface MoveIntent {
      dx: number;
      dy: number;
    }

    let playerPos: Position = { x: 0, y: 0 };

    const reconciliator = new Reconciliator<MoveIntent, Position>({
      onLoadState: (state) => {
        playerPos = { ...state };
      },
      onReplay: (intents) => {
        // Apply all remaining intents
        for (const intent of intents) {
          playerPos.x += intent.dx;
          playerPos.y += intent.dy;
        }
      },
    });

    // Client predicts movements
    reconciliator.trackIntent(1, { dx: 1, dy: 0 });
    playerPos.x += 1;

    reconciliator.trackIntent(2, { dx: 1, dy: 0 });
    playerPos.x += 1;

    reconciliator.trackIntent(3, { dx: 0, dy: 1 });
    playerPos.y += 1;

    // Server snapshot arrives (slightly different due to lag)
    // Snapshot at tick 2 means intents 1 and 2 are confirmed
    reconciliator.onSnapshot({
      tick: 2,
      state: { x: 1.9, y: 0 }, // Server processed ticks 1 and 2
    });

    // After reconciliation: server state + replayed intent (3 only)
    expect(playerPos.x).toBeCloseTo(1.9, 1); // 1.9 + 0
    expect(playerPos.y).toBeCloseTo(1, 1); // 0 + 1
  });
});

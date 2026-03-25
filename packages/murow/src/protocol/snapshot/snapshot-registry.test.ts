import { describe, it, expect, beforeEach } from "bun:test";
import { SnapshotRegistry } from "./snapshot-registry";
import { Snapshot } from "./snapshot";

// Mock codec for testing
class MockCodec<T> {
  encode(value: T): Uint8Array {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json);
  }

  decode(buf: Uint8Array): T {
    const json = new TextDecoder().decode(buf);
    return JSON.parse(json);
  }
}

// Test update types
interface PlayerUpdate {
  players: Array<{ entityId: number; x: number; y: number }>;
}

interface ScoreUpdate {
  score: number;
}

interface ProjectileUpdate {
  projectiles: Array<{ id: number; x: number; y: number }>;
}

type GameUpdate = PlayerUpdate & ScoreUpdate & ProjectileUpdate;

describe("SnapshotRegistry", () => {
  let registry: SnapshotRegistry<GameUpdate>;

  beforeEach(() => {
    registry = new SnapshotRegistry<GameUpdate>();
  });

  describe("register", () => {
    it("should register a codec for a snapshot type", () => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      expect(registry.has("players")).toBe(true);
    });

    it("should throw error when registering duplicate type", () => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      expect(() => registry.register("players", new MockCodec<PlayerUpdate>())).toThrow(
        'Snapshot type "players" is already registered'
      );
    });

    it("should allow registering multiple types", () => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      registry.register("score", new MockCodec<ScoreUpdate>());
      registry.register("projectiles", new MockCodec<ProjectileUpdate>());

      expect(registry.has("players")).toBe(true);
      expect(registry.has("score")).toBe(true);
      expect(registry.has("projectiles")).toBe(true);
    });
  });

  describe("encode", () => {
    beforeEach(() => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      registry.register("score", new MockCodec<ScoreUpdate>());
    });

    it("should encode a snapshot with type ID", () => {
      const snapshot: Snapshot<PlayerUpdate> = {
        tick: 100,
        updates: {
          players: [
            { entityId: 1, x: 10, y: 20 },
          ],
        },
      };

      const buf = registry.encode("players", snapshot);

      expect(buf).toBeInstanceOf(Uint8Array);
      expect(buf.length).toBeGreaterThan(5); // type(1) + tick(4) + data
      expect(buf[0]).toBe(0); // First registered type gets ID 0
    });

    it("should encode different types with different type IDs", () => {
      const playerSnapshot: Snapshot<PlayerUpdate> = {
        tick: 100,
        updates: { players: [{ entityId: 1, x: 10, y: 20 }] },
      };

      const scoreSnapshot: Snapshot<ScoreUpdate> = {
        tick: 101,
        updates: { score: 50 },
      };

      const buf1 = registry.encode("players", playerSnapshot);
      const buf2 = registry.encode("score", scoreSnapshot);

      expect(buf1[0]).toBe(0); // players = ID 0
      expect(buf2[0]).toBe(1); // score = ID 1
    });

    it("should throw error when encoding unregistered type", () => {
      const snapshot: Snapshot<ProjectileUpdate> = {
        tick: 100,
        updates: { projectiles: [] },
      };

      expect(() => registry.encode("projectiles", snapshot)).toThrow(
        'No codec registered for snapshot type "projectiles"'
      );
    });

    it("should preserve tick number in encoding", () => {
      const snapshot: Snapshot<ScoreUpdate> = {
        tick: 12345,
        updates: { score: 100 },
      };

      const buf = registry.encode("score", snapshot);

      // Tick is at bytes 1-4 (after type ID)
      const tick = new DataView(buf.buffer, buf.byteOffset + 1).getUint32(0, true);
      expect(tick).toBe(12345);
    });
  });

  describe("decode", () => {
    beforeEach(() => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      registry.register("score", new MockCodec<ScoreUpdate>());
    });

    it("should decode a snapshot and return type", () => {
      const original: Snapshot<PlayerUpdate> = {
        tick: 100,
        updates: {
          players: [
            { entityId: 1, x: 10, y: 20 },
          ],
        },
      };

      const buf = registry.encode("players", original);
      const { type, snapshot } = registry.decode<PlayerUpdate>(buf);

      expect(type).toBe("players");
      expect(snapshot.tick).toBe(100);
      expect(snapshot.updates).toEqual(original.updates);
    });

    it("should decode different snapshot types correctly", () => {
      const playerSnapshot: Snapshot<PlayerUpdate> = {
        tick: 100,
        updates: { players: [{ entityId: 1, x: 10, y: 20 }] },
      };

      const scoreSnapshot: Snapshot<ScoreUpdate> = {
        tick: 101,
        updates: { score: 50 },
      };

      const buf1 = registry.encode("players", playerSnapshot);
      const buf2 = registry.encode("score", scoreSnapshot);

      const decoded1 = registry.decode(buf1);
      const decoded2 = registry.decode(buf2);

      expect(decoded1.type).toBe("players");
      expect(decoded1.snapshot.updates).toEqual(playerSnapshot.updates);

      expect(decoded2.type).toBe("score");
      expect(decoded2.snapshot.updates).toEqual(scoreSnapshot.updates);
    });

    it("should throw error when decoding unknown type ID", () => {
      const buf = new Uint8Array([99, 0, 0, 0, 100]); // Unknown type ID 99

      expect(() => registry.decode(buf)).toThrow("Unknown snapshot type ID: 99");
    });
  });

  describe("round-trip encoding/decoding", () => {
    beforeEach(() => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      registry.register("score", new MockCodec<ScoreUpdate>());
      registry.register("projectiles", new MockCodec<ProjectileUpdate>());
    });

    it("should preserve data through encode/decode cycle", () => {
      const original: Snapshot<PlayerUpdate> = {
        tick: 500,
        updates: {
          players: [
            { entityId: 1, x: 100, y: 200 },
            { entityId: 2, x: 300, y: 400 },
          ],
        },
      };

      const buf = registry.encode("players", original);
      const { type, snapshot } = registry.decode(buf);

      expect(type).toBe("players");
      expect(snapshot).toEqual(original);
    });

    it("should handle multiple round-trips", () => {
      const original: Snapshot<ScoreUpdate> = {
        tick: 1000,
        updates: { score: 99999 },
      };

      for (let i = 0; i < 10; i++) {
        const buf = registry.encode("score", original);
        const { type, snapshot } = registry.decode(buf);
        expect(type).toBe("score");
        expect(snapshot).toEqual(original);
      }
    });

    it("should handle arrays in updates", () => {
      const original: Snapshot<ProjectileUpdate> = {
        tick: 250,
        updates: {
          projectiles: [
            { id: 1, x: 10, y: 20 },
            { id: 2, x: 30, y: 40 },
            { id: 3, x: 50, y: 60 },
          ],
        },
      };

      const buf = registry.encode("projectiles", original);
      const { type, snapshot } = registry.decode(buf);

      expect(type).toBe("projectiles");
      expect(snapshot.updates).toEqual(original.updates);
    });
  });

  describe("getTypes", () => {
    it("should return empty array when no types registered", () => {
      expect(registry.getTypes()).toEqual([]);
    });

    it("should return all registered types", () => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      registry.register("score", new MockCodec<ScoreUpdate>());

      const types = registry.getTypes();
      expect(types).toContain("players");
      expect(types).toContain("score");
      expect(types.length).toBe(2);
    });
  });

  describe("integration scenarios", () => {
    beforeEach(() => {
      registry.register("players", new MockCodec<PlayerUpdate>());
      registry.register("score", new MockCodec<ScoreUpdate>());
    });

    it("should allow sending only specific updates", () => {
      // Server only sends player updates this tick
      const playerBuf = registry.encode("players", {
        tick: 100,
        updates: { players: [{ entityId: 1, x: 5, y: 10 }] },
      });

      // Next tick, only send score
      const scoreBuf = registry.encode("score", {
        tick: 101,
        updates: { score: 100 },
      });

      // Client can decode both
      const decoded1 = registry.decode(playerBuf);
      const decoded2 = registry.decode(scoreBuf);

      expect(decoded1.type).toBe("players");
      expect(decoded2.type).toBe("score");
    });

    it("should maintain type safety with unions", () => {
      const snapshot: Snapshot<PlayerUpdate> = {
        tick: 100,
        updates: { players: [{ entityId: 1, x: 5, y: 10 }] },
      };

      const buf = registry.encode("players", snapshot);
      const { type, snapshot: decoded } = registry.decode<GameUpdate>(buf);

      if (('players' in decoded.updates)) {
        decoded.updates.players!.forEach((p) => {
          expect(typeof p.entityId).toBe("number");
          expect(typeof p.x).toBe("number");
          expect(typeof p.y).toBe("number");
        });
      }

      // Type narrowing based on type field
      expect(type).toBe("players");
      expect(type in decoded.updates).toBeDefined();
      expect(type in decoded.updates).toBe(true);
    });
  });
});

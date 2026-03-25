import { describe, it, expect } from "bun:test";
import { SnapshotCodec } from "./snapshot-codec";
import { Snapshot } from "./snapshot";
import { Codec } from "./snapshot-codec";

// Simple mock codec for testing
class MockCodec<T> implements Codec<T> {
  encode(value: T): Uint8Array {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json);
  }

  decode(buf: Uint8Array): T {
    const json = new TextDecoder().decode(buf);
    return JSON.parse(json);
  }
}

interface TestState {
  x: number;
  y: number;
  health?: number;
}

describe("SnapshotCodec", () => {
  it("should encode and decode a snapshot", () => {
    const codec = new SnapshotCodec<TestState>(new MockCodec());
    const snapshot: Snapshot<TestState> = {
      tick: 100,
      updates: { x: 10, y: 20 },
    };

    const buf = codec.encode(snapshot);
    const decoded = codec.decode(buf);

    expect(decoded.tick).toBe(100);
    expect(decoded.updates.x).toBe(10);
    expect(decoded.updates.y).toBe(20);
  });

  it("should handle partial updates", () => {
    const codec = new SnapshotCodec<TestState>(new MockCodec());
    const snapshot: Snapshot<TestState> = {
      tick: 50,
      updates: { x: 5 },
    };

    const buf = codec.encode(snapshot);
    const decoded = codec.decode(buf);

    expect(decoded.tick).toBe(50);
    expect(decoded.updates.x).toBe(5);
    expect(decoded.updates.y).toBeUndefined();
  });

  it("should handle large tick numbers", () => {
    const codec = new SnapshotCodec<TestState>(new MockCodec());
    const snapshot: Snapshot<TestState> = {
      tick: 4294967295, // Max u32
      updates: { x: 1, y: 2 },
    };

    const buf = codec.encode(snapshot);
    const decoded = codec.decode(buf);

    expect(decoded.tick).toBe(4294967295);
  });

  it("should preserve tick in binary format", () => {
    const codec = new SnapshotCodec<TestState>(new MockCodec());
    const snapshot: Snapshot<TestState> = {
      tick: 12345,
      updates: { x: 1 },
    };

    const buf = codec.encode(snapshot);

    // First 4 bytes should be the tick (little-endian)
    const tick = new DataView(buf.buffer, buf.byteOffset).getUint32(0, true);
    expect(tick).toBe(12345);
  });

  it("should handle empty updates", () => {
    const codec = new SnapshotCodec<TestState>(new MockCodec());
    const snapshot: Snapshot<TestState> = {
      tick: 100,
      updates: {},
    };

    const buf = codec.encode(snapshot);
    const decoded = codec.decode(buf);

    expect(decoded.tick).toBe(100);
    expect(decoded.updates).toEqual({});
  });

  it("should handle nested state", () => {
    interface NestedState {
      player: {
        position: { x: number; y: number };
        health: number;
      };
    }

    const codec = new SnapshotCodec<NestedState>(new MockCodec());
    const snapshot: Snapshot<NestedState> = {
      tick: 200,
      updates: {
        player: {
          position: { x: 10, y: 20 },
          health: 80,
        },
      },
    };

    const buf = codec.encode(snapshot);
    const decoded = codec.decode(buf);

    expect(decoded.tick).toBe(200);
    expect(decoded.updates.player?.position.x).toBe(10);
    expect(decoded.updates.player?.position.y).toBe(20);
    expect(decoded.updates.player?.health).toBe(80);
  });

  it("should round-trip multiple times", () => {
    const codec = new SnapshotCodec<TestState>(new MockCodec());
    const original: Snapshot<TestState> = {
      tick: 999,
      updates: { x: 123, y: 456, health: 78 },
    };

    for (let i = 0; i < 10; i++) {
      const buf = codec.encode(original);
      const decoded = codec.decode(buf);
      expect(decoded).toEqual(original);
    }
  });
});

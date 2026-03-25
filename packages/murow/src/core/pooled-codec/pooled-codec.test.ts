import { describe, expect, test } from "bun:test";
import {
  ObjectPool,
  PooledDecoder,
  PooledEncoder,
  PooledCodec,
  PooledArrayDecoder,
} from "./pooled-codec";
import { BinaryCodec, BinaryPrimitives, Schema } from "../binary-codec";

describe("ObjectPool", () => {
  test("should create new object when pool is empty", () => {
    const pool = new ObjectPool(() => ({ value: 0 }));
    const obj = pool.acquire();
    expect(obj).toEqual({ value: 0 });
  });

  test("should reuse released objects", () => {
    const pool = new ObjectPool(() => ({ value: 0 }));
    const obj1 = pool.acquire();
    obj1.value = 42;
    pool.release(obj1);

    const obj2 = pool.acquire();
    expect(obj2.value).toBe(42);
    expect(obj2).toBe(obj1); // Same object reference
  });

  test("should handle multiple acquire/release cycles", () => {
    const pool = new ObjectPool(() => ({ count: 0 }));

    const obj1 = pool.acquire();
    obj1.count = 1;
    pool.release(obj1);

    const obj2 = pool.acquire();
    obj2.count = 2;
    pool.release(obj2);

    const obj3 = pool.acquire();
    expect(obj3.count).toBe(2); // Gets the last released object
  });

  test("should release multiple objects at once", () => {
    const pool = new ObjectPool(() => ({ id: 0 }));

    const objs = [
      pool.acquire(),
      pool.acquire(),
      pool.acquire(),
    ];

    objs.forEach((obj, i) => (obj.id = i));
    pool.releaseAll(objs);

    const reused1 = pool.acquire();
    const reused2 = pool.acquire();
    const reused3 = pool.acquire();

    expect([reused1.id, reused2.id, reused3.id].sort()).toEqual([0, 1, 2]);
  });
});

describe("PooledDecoder", () => {
  test("should decode data into pooled objects", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.f32,
    };

    const decoder = new PooledDecoder(schema);

    // Use BinaryCodec to encode the data first
    const data = { value: 10.5 };
    const buffer = BinaryCodec.encode(schema, data);

    const obj = decoder.decode(buffer);
    expect(obj.value).toBeCloseTo(10.5, 5);
  });

  test("should reuse released objects", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u32,
    };

    const decoder = new PooledDecoder(schema);

    const buffer = new Uint8Array(4);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, 42, false);

    const obj1 = decoder.decode(buffer);
    expect(obj1.value).toBe(42);

    decoder.release(obj1);

    view.setUint32(0, 100, false);
    const obj2 = decoder.decode(buffer);
    expect(obj2.value).toBe(100);
    expect(obj2).toBe(obj1); // Same object reference
  });

  test("should decode into existing target object", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u8,
    };

    const decoder = new PooledDecoder(schema);

    // Use BinaryCodec to encode the data first
    const data = { value: 10 };
    const buffer = BinaryCodec.encode(schema, data);
    const target = { value: 0 };

    decoder.decodeInto(buffer, target);
    expect(target.value).toBe(10);
  });
});

describe("PooledArrayDecoder", () => {
  test("should decode multiple buffers into pooled objects", () => {
    const schema: Schema<{ id: number }> = {
      id: BinaryPrimitives.u32,
    };

    const arrayDecoder = new PooledArrayDecoder(schema);

    const buffers = [
      new Uint8Array([0, 0, 0, 1]),
      new Uint8Array([0, 0, 0, 2]),
      new Uint8Array([0, 0, 0, 3]),
    ];

    const objs = arrayDecoder.decodeAll(buffers);
    expect(objs.length).toBe(3);
    expect(objs[0].id).toBe(1);
    expect(objs[1].id).toBe(2);
    expect(objs[2].id).toBe(3);
  });

  test("should release multiple objects", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u8,
    };

    const arrayDecoder = new PooledArrayDecoder(schema);

    // Use BinaryCodec to encode the data first
    const buffers = [
      BinaryCodec.encode(schema, { value: 10 }),
      BinaryCodec.encode(schema, { value: 20 }),
      BinaryCodec.encode(schema, { value: 30 }),
    ];

    const objs = arrayDecoder.decodeAll(buffers);
    const objValues = objs.map(o => o.value);
    expect(objValues).toEqual([10, 20, 30]);

    arrayDecoder.releaseAll(objs);

    // Decode again and verify objects are reused (checking references)
    const newObjs = arrayDecoder.decodeAll(buffers);
    // Objects should be reused (same references)
    let reuseCount = 0;
    for (const newObj of newObjs) {
      if (objs.includes(newObj)) reuseCount++;
    }
    expect(reuseCount).toBeGreaterThan(0);
  });
});

describe("PooledEncoder", () => {
  test("should encode objects into pooled buffers", () => {
    const schema: Schema<{ x: number; y: number }> = {
      x: BinaryPrimitives.f32,
      y: BinaryPrimitives.f32,
    };

    const encoder = new PooledEncoder(schema);
    const data = { x: 5.5, y: 10.5 };

    const buffer = encoder.encode(data);
    expect(buffer.length).toBe(8);

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    expect(view.getFloat32(0, false)).toBeCloseTo(5.5, 5);
    expect(view.getFloat32(4, false)).toBeCloseTo(10.5, 5);
  });

  test("should reuse released buffers", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u32,
    };

    const encoder = new PooledEncoder(schema, 16);
    const data1 = { value: 42 };

    const buffer1 = encoder.encode(data1);
    encoder.release(buffer1);

    const data2 = { value: 100 };
    const buffer2 = encoder.encode(data2);

    // Should reuse the same underlying buffer
    expect(buffer2.buffer).toBe(buffer1.buffer);
  });

  test("should handle custom buffer size", () => {
    const schema: Schema<{ id: number }> = {
      id: BinaryPrimitives.u8,
    };

    const encoder = new PooledEncoder(schema, 64);
    const data = { id: 5 };

    const buffer = encoder.encode(data);
    expect(buffer.length).toBe(1); // Only actual data
  });
});

describe("PooledCodec", () => {
  test("should encode and decode with pooling", () => {
    const schema: Schema<{ id: number }> = {
      id: BinaryPrimitives.u32,
    };

    const codec = new PooledCodec(schema);
    const data = { id: 123 };

    const encoded = codec.encode(data);
    const decoded = codec.decode(encoded);

    expect(decoded.id).toBe(123);
  });

  test("should reuse objects after release", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u32,
    };

    const codec = new PooledCodec(schema);

    const encoded1 = codec.encode({ value: 42 });
    const decoded1 = codec.decode(encoded1);
    expect(decoded1.value).toBe(42);

    codec.release(decoded1);

    const encoded2 = codec.encode({ value: 100 });
    const decoded2 = codec.decode(encoded2);
    expect(decoded2.value).toBe(100);
    expect(decoded2).toBe(decoded1); // Same object
  });

  test("should handle multiple encode/decode cycles", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u16,
    };

    const codec = new PooledCodec(schema);

    for (let i = 0; i < 100; i++) {
      const data = { value: i * 10 };
      const encoded = codec.encode(data);
      const decoded = codec.decode(encoded);

      expect(decoded.value).toBe(i * 10);

      codec.release(decoded);
    }
  });

  test("should work with single field schemas", () => {
    const schema: Schema<{
      id: number;
    }> = {
      id: BinaryPrimitives.u32,
    };

    const codec = new PooledCodec(schema);
    const data = {
      id: 999,
    };

    const encoded = codec.encode(data);
    const decoded = codec.decode(encoded);

    expect(decoded.id).toBe(999);
  });
});

describe("PooledCodec - Memory Efficiency", () => {
  test("should reduce allocations with pooling", () => {
    const schema: Schema<{ value: number }> = {
      value: BinaryPrimitives.u32,
    };

    const codec = new PooledCodec(schema);
    const objects: any[] = [];

    const times = 10000;

    // Encode and decode {times} times
    for (let i = 0; i < times; i++) {
      const encoded = codec.encode({ value: i });
      const decoded = codec.decode(encoded);
      objects.push(decoded);
    }

    // Release all
    objects.forEach((obj) => codec.release(obj));

    // Decode again - should reuse objects
    const newObjects: any[] = [];
    for (let i = 0; i < times; i++) {
      const encoded = codec.encode({ value: i });
      const decoded = codec.decode(encoded);
      newObjects.push(decoded);
    }

    // At least some objects should be reused
    let reusedCount = 0;
    for (const newObj of newObjects) {
      if (objects.includes(newObj)) {
        reusedCount++;
      }
    }

    expect(reusedCount).toBeGreaterThan(0);
  });

  test("should handle concurrent encode/decode without release", () => {
    const schema: Schema<{ id: number }> = {
      id: BinaryPrimitives.u16,
    };

    const codec = new PooledCodec(schema);
    const objects: any[] = [];

    // Create many objects without releasing
    for (let i = 0; i < 50; i++) {
      const encoded = codec.encode({ id: i });
      const decoded = codec.decode(encoded);
      objects.push(decoded);
    }

    expect(objects.length).toBe(50);
    objects.forEach((obj, i) => expect(obj.id).toBe(i));
  });
});

describe("PooledCodec.array", () => {
  test("should encode and decode arrays of objects", () => {
    const PlayerSchema = {
      entityId: BinaryPrimitives.u32,
      x: BinaryPrimitives.f32,
      y: BinaryPrimitives.f32,
    } satisfies Schema<{ entityId: number; x: number; y: number }>;

    const UpdateSchema = {
      tick: BinaryPrimitives.u32,
      players: PooledCodec.array(PlayerSchema),
    };

    const codec = new PooledCodec(UpdateSchema);

    // Encode
    const buffer = codec.encode({
      tick: 42,
      players: [
        { entityId: 1, x: 10.5, y: 20.5 },
        { entityId: 2, x: 30.5, y: 40.5 },
      ],
    });

    // Decode
    const snapshot = codec.decode(buffer);

    expect(snapshot.tick).toBe(42);
    expect(snapshot.players.length).toBe(2);
    expect(snapshot.players[0].entityId).toBe(1);
    expect(snapshot.players[0].x).toBeCloseTo(10.5, 5);
    expect(snapshot.players[0].y).toBeCloseTo(20.5, 5);
    expect(snapshot.players[1].entityId).toBe(2);
    expect(snapshot.players[1].x).toBeCloseTo(30.5, 5);
    expect(snapshot.players[1].y).toBeCloseTo(40.5, 5);
  });

  test("should handle empty arrays", () => {
    const ItemSchema = {
      id: BinaryPrimitives.u32,
    } satisfies Schema<{ id: number }>;

    const UpdateSchema = {
      tick: BinaryPrimitives.u16,
      items: PooledCodec.array(ItemSchema),
    };

    const codec = new PooledCodec(UpdateSchema);

    // Encode with empty array
    const buffer = codec.encode({
      tick: 100,
      items: [],
    });

    // Decode
    const snapshot = codec.decode(buffer);

    expect(snapshot.tick).toBe(100);
    expect(snapshot.items).toEqual([]);
  });

  test("should handle arrays with many items", () => {
    const PositionSchema = {
      x: BinaryPrimitives.f32,
      y: BinaryPrimitives.f32,
    } satisfies Schema<{ x: number; y: number }>;

    const UpdateSchema = {
      positions: PooledCodec.array(PositionSchema),
    };

    const codec = new PooledCodec(UpdateSchema);

    // Create 100 positions
    const positions = Array.from({ length: 100 }, (_, i) => ({
      x: i * 1.5,
      y: i * 2.5,
    }));

    // Encode
    const buffer = codec.encode({ positions });

    // Decode
    const snapshot = codec.decode(buffer);

    expect(snapshot.positions.length).toBe(100);
    for (let i = 0; i < 100; i++) {
      expect(snapshot.positions[i].x).toBeCloseTo(i * 1.5, 5);
      expect(snapshot.positions[i].y).toBeCloseTo(i * 2.5, 5);
    }
  });

  test("should work with multiple array fields", () => {
    const PlayerSchema = {
      id: BinaryPrimitives.u32,
      health: BinaryPrimitives.u8,
    } satisfies Schema<{ id: number; health: number }>;

    const EnemySchema = {
      id: BinaryPrimitives.u32,
      type: BinaryPrimitives.u8,
    } satisfies Schema<{ id: number; type: number }>;

    const UpdateSchema = {
      tick: BinaryPrimitives.u32,
      players: PooledCodec.array(PlayerSchema),
      enemies: PooledCodec.array(EnemySchema),
    };

    const codec = new PooledCodec(UpdateSchema);

    // Encode
    const buffer = codec.encode({
      tick: 50,
      players: [
        { id: 1, health: 100 },
        { id: 2, health: 75 },
      ],
      enemies: [
        { id: 10, type: 1 },
        { id: 11, type: 2 },
        { id: 12, type: 1 },
      ],
    });

    // Decode
    const snapshot = codec.decode(buffer);

    expect(snapshot.tick).toBe(50);
    expect(snapshot.players.length).toBe(2);
    expect(snapshot.players[0]).toEqual({ id: 1, health: 100 });
    expect(snapshot.players[1]).toEqual({ id: 2, health: 75 });
    expect(snapshot.enemies.length).toBe(3);
    expect(snapshot.enemies[0]).toEqual({ id: 10, type: 1 });
    expect(snapshot.enemies[1]).toEqual({ id: 11, type: 2 });
    expect(snapshot.enemies[2]).toEqual({ id: 12, type: 1 });
  });
});

describe("PooledCodec - Zero-Copy Encoding", () => {
  test("calculateSize should return correct size for simple schema", () => {
    const schema = {
      id: BinaryPrimitives.u32,
      x: BinaryPrimitives.f32,
      y: BinaryPrimitives.f32,
    };

    const codec = new PooledCodec(schema);
    const data = { id: 1, x: 10.5, y: 20.5 };

    const size = codec.calculateSize(data);
    expect(size).toBe(4 + 4 + 4); // u32 + f32 + f32 = 12 bytes
  });

  test("calculateSize should return correct size for schema with arrays", () => {
    const PlayerSchema = {
      entityId: BinaryPrimitives.u32,
      x: BinaryPrimitives.f32,
      y: BinaryPrimitives.f32,
    };

    const UpdateSchema = {
      tick: BinaryPrimitives.u32,
      players: PooledCodec.array(PlayerSchema),
    };

    const codec = new PooledCodec(UpdateSchema);
    const data = {
      tick: 42,
      players: [
        { entityId: 1, x: 10.5, y: 20.5 },
        { entityId: 2, x: 30.5, y: 40.5 },
      ],
    };

    const size = codec.calculateSize(data);
    // tick(4) + array_length(2) + 2 * (entityId(4) + x(4) + y(4))
    expect(size).toBe(4 + 2 + 2 * 12); // 30 bytes
  });

  test("encodeInto should write directly to buffer without allocations", () => {
    const schema = {
      id: BinaryPrimitives.u32,
      value: BinaryPrimitives.f32,
    };

    const codec = new PooledCodec(schema);
    const data = { id: 123, value: 45.67 };

    const buffer = new Uint8Array(100);
    const bytesWritten = codec.encodeInto(data, buffer, 10);

    expect(bytesWritten).toBe(8); // 4 + 4

    // Verify the data was written at the correct offset (using big-endian like BinaryPrimitives)
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    expect(view.getUint32(10, false)).toBe(123);
    expect(view.getFloat32(14, false)).toBeCloseTo(45.67, 2);
  });

  test("encodeInto should produce same result as encode", () => {
    const PlayerSchema = {
      entityId: BinaryPrimitives.u32,
      x: BinaryPrimitives.f32,
      y: BinaryPrimitives.f32,
    };

    const UpdateSchema = {
      tick: BinaryPrimitives.u32,
      players: PooledCodec.array(PlayerSchema),
    };

    const codec = new PooledCodec(UpdateSchema);
    const data = {
      tick: 42,
      players: [
        { entityId: 1, x: 10.5, y: 20.5 },
        { entityId: 2, x: 30.5, y: 40.5 },
      ],
    };

    // Encode using the old method
    const encodedOld = codec.encode(data);

    // Encode using encodeInto
    const size = codec.calculateSize(data);
    const buffer = new Uint8Array(size);
    const bytesWritten = codec.encodeInto(data, buffer, 0);

    expect(bytesWritten).toBe(size);
    expect(Array.from(buffer)).toEqual(Array.from(encodedOld));
  });

  test("encodeInto should work with offset in target buffer", () => {
    const schema = {
      a: BinaryPrimitives.u16,
      b: BinaryPrimitives.u16,
    };

    const codec = new PooledCodec(schema);
    const data1 = { a: 100, b: 200 };
    const data2 = { a: 300, b: 400 };

    const buffer = new Uint8Array(20);

    // Write first object at offset 0
    const bytes1 = codec.encodeInto(data1, buffer, 0);
    expect(bytes1).toBe(4);

    // Write second object at offset 4
    const bytes2 = codec.encodeInto(data2, buffer, 4);
    expect(bytes2).toBe(4);

    // Verify both objects are in the buffer (using big-endian)
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    expect(view.getUint16(0, false)).toBe(100);
    expect(view.getUint16(2, false)).toBe(200);
    expect(view.getUint16(4, false)).toBe(300);
    expect(view.getUint16(6, false)).toBe(400);
  });

  test("array field encodeInto should write directly without intermediate allocations", () => {
    const PlayerSchema = {
      id: BinaryPrimitives.u32,
      health: BinaryPrimitives.u8,
    };

    const arrayField = PooledCodec.array(PlayerSchema);
    const players = [
      { id: 1, health: 100 },
      { id: 2, health: 75 },
      { id: 3, health: 50 },
    ];

    const buffer = new Uint8Array(100);
    const bytesWritten = arrayField.encodeInto(players, buffer, 5);

    // 2 (length) + 3 * 5 (id:4 + health:1) = 17 bytes
    expect(bytesWritten).toBe(17);

    // Verify array length was written
    const view = new DataView(buffer.buffer, buffer.byteOffset);
    expect(view.getUint16(5, false)).toBe(3);

    // Verify first player (using big-endian)
    expect(view.getUint32(7, false)).toBe(1);
    expect(view.getUint8(11)).toBe(100);
  });

  test("calculateSize and encodeInto should work with multiple arrays", () => {
    const PlayerSchema = {
      id: BinaryPrimitives.u32,
      health: BinaryPrimitives.u8,
    };

    const EnemySchema = {
      id: BinaryPrimitives.u32,
      type: BinaryPrimitives.u8,
    };

    const UpdateSchema = {
      tick: BinaryPrimitives.u32,
      players: PooledCodec.array(PlayerSchema),
      enemies: PooledCodec.array(EnemySchema),
    };

    const codec = new PooledCodec(UpdateSchema);
    const data = {
      tick: 100,
      players: [
        { id: 1, health: 100 },
        { id: 2, health: 75 },
      ],
      enemies: [
        { id: 10, type: 1 },
        { id: 11, type: 2 },
        { id: 12, type: 3 },
      ],
    };

    const size = codec.calculateSize(data);
    // tick(4) + players_len(2) + 2*5 + enemies_len(2) + 3*5 = 4 + 2 + 10 + 2 + 15 = 33
    expect(size).toBe(33);

    const buffer = new Uint8Array(size);
    const bytesWritten = codec.encodeInto(data, buffer, 0);
    expect(bytesWritten).toBe(33);

    // Verify it can be decoded correctly
    const decoded = codec.decode(buffer);
    expect(decoded.tick).toBe(100);
    expect(decoded.players.length).toBe(2);
    expect(decoded.enemies.length).toBe(3);
  });
});

/**
 * Tests for DataView reuse optimization in PooledCodec.array()
 *
 * These tests verify that the shared encodeView/decodeView optimization
 * is safe under various usage patterns that might seem problematic.
 */
describe("PooledCodec.array() - DataView Reuse Safety", () => {
  const playerSchema = {
    id: BinaryCodec.u32,
    health: BinaryCodec.u8,
  };
  test("same ArrayField instance used in nested schema (sequential)", () => {
    // Scenario: Reusing same ArrayField in multiple schema fields
    const playerArray = PooledCodec.array(playerSchema);
    const teamSchema = {
      teamA: playerArray, // Same instance
      teamB: playerArray, // Same instance
    };
    const codec = new PooledCodec(teamSchema);
    const data = {
      teamA: [
        { id: 1, health: 100 },
        { id: 2, health: 80 },
      ],
      teamB: [
        { id: 3, health: 90 },
        { id: 4, health: 70 },
      ],
    };
    const encoded = codec.encode(data);
    const decoded = codec.decode(encoded);
    // Verify no corruption
    expect(decoded.teamA[0].id).toBe(1);
    expect(decoded.teamA[0].health).toBe(100);
    expect(decoded.teamA[1].id).toBe(2);
    expect(decoded.teamA[1].health).toBe(80);
    expect(decoded.teamB[0].id).toBe(3);
    expect(decoded.teamB[0].health).toBe(90);
    expect(decoded.teamB[1].id).toBe(4);
    expect(decoded.teamB[1].health).toBe(70);
  });
  test("rapid sequential encode/decode (simulates game loop)", () => {
    // Scenario: High-frequency encoding like multiplayer snapshots
    const playerArray = PooledCodec.array(playerSchema);
    const iterations = 1000;
    for (let i = 0; i < iterations; i++) {
      const data = [
        { id: i, health: 100 },
        { id: i + 1, health: 80 },
      ];
      const encoded = playerArray.encode(data);
      const decoded = playerArray.decode(encoded);
      expect(decoded[0].id).toBe(i);
      expect(decoded[0].health).toBe(100);
      expect(decoded[1].id).toBe(i + 1);
      expect(decoded[1].health).toBe(80);
    }
  });
  test("async encode/decode with Promise.all (no corruption)", async () => {
    // Scenario: Multiple async operations using same ArrayField
    const playerArray = PooledCodec.array(playerSchema);
    async function encodeTask(taskId: number) {
      return playerArray.encode([
        { id: taskId * 10, health: 100 },
        { id: taskId * 10 + 1, health: 80 },
      ]);
    }
    // Run 10 encode operations "concurrently"
    const results = await Promise.all([
      encodeTask(1),
      encodeTask(2),
      encodeTask(3),
      encodeTask(4),
      encodeTask(5),
      encodeTask(6),
      encodeTask(7),
      encodeTask(8),
      encodeTask(9),
      encodeTask(10),
    ]);
    // Decode and verify each result
    for (let i = 0; i < results.length; i++) {
      const decoded = playerArray.decode(results[i]);
      const expectedId = (i + 1) * 10;
      expect(decoded[0].id).toBe(expectedId);
      expect(decoded[0].health).toBe(100);
      expect(decoded[1].id).toBe(expectedId + 1);
      expect(decoded[1].health).toBe(80);
    }
  });
  test("encode while decode is queued (microtask interleaving)", async () => {
    // Scenario: Encode and decode queued as microtasks
    const playerArray = PooledCodec.array(playerSchema);
    let encoded1: Uint8Array | null = null;
    let encoded2: Uint8Array | null = null;
    queueMicrotask(() => {
      encoded1 = playerArray.encode([{ id: 1, health: 100 }]);
    });
    queueMicrotask(() => {
      encoded2 = playerArray.encode([{ id: 2, health: 200 }]);
    });
    // Wait for microtasks to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(encoded1).not.toBeNull();
    expect(encoded2).not.toBeNull();
    const decoded1 = playerArray.decode(encoded1!);
    const decoded2 = playerArray.decode(encoded2!);
    expect(decoded1[0].id).toBe(1);
    expect(decoded1[0].health).toBe(100);
    expect(decoded2[0].id).toBe(2);
    expect(decoded2[0].health).toBe(200);
  });
  test("buffer pool with different-sized arrays (reuse correctness)", () => {
    // Scenario: Encoding arrays of different sizes (buffer pool behavior)
    const playerArray = PooledCodec.array(playerSchema);
    // Small array
    const small = playerArray.encode([{ id: 1, health: 100 }]);
    const decodedSmall = playerArray.decode(small);
    expect(decodedSmall).toHaveLength(1);
    expect(decodedSmall[0].id).toBe(1);
    // Large array
    const largeData = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      health: 100,
    }));
    const large = playerArray.encode(largeData);
    const decodedLarge = playerArray.decode(large);
    expect(decodedLarge).toHaveLength(100);
    expect(decodedLarge[0].id).toBe(0);
    expect(decodedLarge[99].id).toBe(99);
    // Small again (verifies buffer pool reuse doesn't corrupt)
    const small2 = playerArray.encode([{ id: 999, health: 50 }]);
    const decodedSmall2 = playerArray.decode(small2);
    expect(decodedSmall2).toHaveLength(1);
    expect(decodedSmall2[0].id).toBe(999);
    expect(decodedSmall2[0].health).toBe(50);
  });
  test("encodeInto with different buffers (zero-copy safety)", () => {
    // Scenario: Using encodeInto with external buffers
    const playerArray = PooledCodec.array(playerSchema);
    const data = [
      { id: 1, health: 100 },
      { id: 2, health: 80 },
    ];
    // Calculate size and allocate buffer
    const size = playerArray.calculateSize(data);
    const buffer = new Uint8Array(size);
    // Encode directly into buffer
    const bytesWritten = playerArray.encodeInto(data, buffer, 0);
    expect(bytesWritten).toBe(size);
    // Decode and verify
    const decoded = playerArray.decode(buffer);
    expect(decoded[0].id).toBe(1);
    expect(decoded[0].health).toBe(100);
    expect(decoded[1].id).toBe(2);
    expect(decoded[1].health).toBe(80);
  });
  test("stress test: 10k rapid encode/decode cycles", () => {
    // Scenario: Extreme throughput test
    const playerArray = PooledCodec.array(playerSchema);
    for (let i = 0; i < 10000; i++) {
      const data = [
        { id: i % 256, health: 100 },
        { id: (i + 1) % 256, health: 80 },
      ];
      const encoded = playerArray.encode(data);
      const decoded = playerArray.decode(encoded);
      // Spot check every 1000th iteration
      if (i % 1000 === 0) {
        expect(decoded[0].id).toBe(i % 256);
        expect(decoded[0].health).toBe(100);
      }
    }
  });
});

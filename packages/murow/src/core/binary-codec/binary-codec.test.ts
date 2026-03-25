import { describe, expect, test } from "bun:test";
import { BinaryCodec, BinaryPrimitives } from "./binary-codec";

describe("BinaryCodec - Primitives", () => {
  test("should encode and decode u8", () => {
    const schema = { value: BinaryPrimitives.u8 };
    const data = { value: 255 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBe(255);
  });

  test("should encode and decode u16", () => {
    const schema = { value: BinaryPrimitives.u16 };
    const data = { value: 65535 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBe(65535);
  });

  test("should encode and decode u32", () => {
    const schema = { value: BinaryPrimitives.u32 };
    const data = { value: 4294967295 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBe(4294967295);
  });

  test("should encode and decode i8", () => {
    const schema = { value: BinaryPrimitives.i8 };
    const data = { value: -128 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBe(-128);
  });

  test("should encode and decode i16", () => {
    const schema = { value: BinaryPrimitives.i16 };
    const data = { value: -32768 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBe(-32768);
  });

  test("should encode and decode i32", () => {
    const schema = { value: BinaryPrimitives.i32 };
    const data = { value: -2147483648 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBe(-2147483648);
  });

  test("should encode and decode f32", () => {
    const schema = { value: BinaryPrimitives.f32 };
    const data = { value: 3.14159 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBeCloseTo(3.14159, 5);
  });

  test("should encode and decode f64", () => {
    const schema = { value: BinaryPrimitives.f64 };
    const data = { value: Math.PI };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBeCloseTo(Math.PI, 15);
  });

  test("should encode and decode bool", () => {
    const schema = { flag: BinaryPrimitives.bool };
    const data1 = { flag: true };
    const encoded1 = BinaryCodec.encode(schema, data1);
    const decoded1 = BinaryCodec.decode(schema, encoded1, { flag: false });
    expect(decoded1.flag).toBe(true);

    const data2 = { flag: false };
    const encoded2 = BinaryCodec.encode(schema, data2);
    const decoded2 = BinaryCodec.decode(schema, encoded2, { flag: true });
    expect(decoded2.flag).toBe(false);
  });

  test("should encode and decode string", () => {
    const schema = { name: BinaryPrimitives.string(20) };
    const data = { name: "Player1" };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { name: "" });
    expect(decoded.name).toBe("Player1");
  });

  test("should throw on string too long", () => {
    const schema = { name: BinaryPrimitives.string(5) };
    const data = { name: "TooLongString" };
    expect(() => BinaryCodec.encode(schema, data)).toThrow();
  });

  test("should encode and decode vec2", () => {
    const schema = { pos: BinaryPrimitives.vec2 };
    const data = { pos: { x: 10.5, y: 20.7 } };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { pos: { x: 0, y: 0 } });
    expect(decoded.pos.x).toBeCloseTo(10.5, 5);
    expect(decoded.pos.y).toBeCloseTo(20.7, 5);
  });

  test("should encode and decode vec3", () => {
    const schema = { pos: BinaryPrimitives.vec3 };
    const data = { pos: { x: 1.1, y: 2.2, z: 3.3 } };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      pos: { x: 0, y: 0, z: 0 },
    });
    expect(decoded.pos.x).toBeCloseTo(1.1, 5);
    expect(decoded.pos.y).toBeCloseTo(2.2, 5);
    expect(decoded.pos.z).toBeCloseTo(3.3, 5);
  });

  test("should encode and decode color", () => {
    const schema = { color: BinaryPrimitives.color };
    const data = { color: { r: 255, g: 128, b: 64, a: 32 } };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    expect(decoded.color.r).toBe(255);
    expect(decoded.color.g).toBe(128);
    expect(decoded.color.b).toBe(64);
    expect(decoded.color.a).toBe(32);
  });
});

describe("BinaryCodec - Complex Schemas", () => {
  test("should encode and decode multiple fields", () => {
    const schema = {
      id: BinaryPrimitives.u32,
      name: BinaryPrimitives.string(10),
      health: BinaryPrimitives.f32,
      alive: BinaryPrimitives.bool,
    };
    const data = {
      id: 12345,
      name: "Hero",
      health: 85.5,
      alive: true,
    };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      id: 0,
      name: "",
      health: 0,
      alive: false,
    });
    expect(decoded.id).toBe(12345);
    expect(decoded.name).toBe("Hero");
    expect(decoded.health).toBeCloseTo(85.5, 5);
    expect(decoded.alive).toBe(true);
  });

  test("should maintain field order", () => {
    const schema = {
      a: BinaryPrimitives.u8,
      b: BinaryPrimitives.u8,
      c: BinaryPrimitives.u8,
    };
    const data = { a: 1, b: 2, c: 3 };
    const encoded = BinaryCodec.encode(schema, data);
    expect(Array.from(encoded)).toEqual([1, 2, 3]);
  });

  test("should throw on buffer too small", () => {
    const schema = { value: BinaryPrimitives.u32 };
    const smallBuffer = new Uint8Array(2); // Only 2 bytes, need 4
    expect(() =>
      BinaryCodec.decode(schema, smallBuffer, { value: 0 })
    ).toThrow();
  });

  test("should handle empty string", () => {
    const schema = { name: BinaryPrimitives.string(10) };
    const data = { name: "" };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { name: "default" });
    expect(decoded.name).toBe("");
  });

  test("should handle unicode strings", () => {
    const schema = { text: BinaryPrimitives.string(20) };
    const data = { text: "Hello 世界" };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { text: "" });
    expect(decoded.text).toBe("Hello 世界");
  });
});

describe("BinaryCodec - Little Endian Variants", () => {
  test("should encode and decode f32_le", () => {
    const schema = { value: BinaryPrimitives.f32_le };
    const data = { value: 1.234 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBeCloseTo(1.234, 5);
  });

  test("should encode and decode f64_le", () => {
    const schema = { value: BinaryPrimitives.f64_le };
    const data = { value: Math.E };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { value: 0 });
    expect(decoded.value).toBeCloseTo(Math.E, 15);
  });

  test("should encode and decode vec2_le", () => {
    const schema = { pos: BinaryPrimitives.vec2_le };
    const data = { pos: [5.5, 6.6] as [number, number] };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, { pos: [0, 0] as [number, number] });
    expect(decoded.pos[0]).toBeCloseTo(5.5, 5);
    expect(decoded.pos[1]).toBeCloseTo(6.6, 5);
  });

  test("should encode and decode vec3_le", () => {
    const schema = { pos: BinaryPrimitives.vec3_le };
    const data = { pos: [1.1, 2.2, 3.3] as [number, number, number] };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      pos: [0, 0, 0] as [number, number, number],
    });
    expect(decoded.pos[0]).toBeCloseTo(1.1, 5);
    expect(decoded.pos[1]).toBeCloseTo(2.2, 5);
    expect(decoded.pos[2]).toBeCloseTo(3.3, 5);
  });

  test("should encode and decode vec4_le", () => {
    const schema = { quat: BinaryPrimitives.vec4_le };
    const data = { quat: [0.1, 0.2, 0.3, 0.4] as [number, number, number, number] };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      quat: [0, 0, 0, 0] as [number, number, number, number],
    });
    expect(decoded.quat[0]).toBeCloseTo(0.1, 5);
    expect(decoded.quat[1]).toBeCloseTo(0.2, 5);
    expect(decoded.quat[2]).toBeCloseTo(0.3, 5);
    expect(decoded.quat[3]).toBeCloseTo(0.4, 5);
  });
});

describe("BinaryCodec - Edge Cases", () => {
  test("should handle zero values", () => {
    const schema = {
      u8: BinaryPrimitives.u8,
      i32: BinaryPrimitives.i32,
      f32: BinaryPrimitives.f32,
    };
    const data = { u8: 0, i32: 0, f32: 0 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      u8: 1,
      i32: 1,
      f32: 1,
    });
    expect(decoded.u8).toBe(0);
    expect(decoded.i32).toBe(0);
    expect(decoded.f32).toBe(0);
  });

  test("should handle max values", () => {
    const schema = {
      u8: BinaryPrimitives.u8,
      u16: BinaryPrimitives.u16,
      u32: BinaryPrimitives.u32,
    };
    const data = { u8: 255, u16: 65535, u32: 4294967295 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      u8: 0,
      u16: 0,
      u32: 0,
    });
    expect(decoded.u8).toBe(255);
    expect(decoded.u16).toBe(65535);
    expect(decoded.u32).toBe(4294967295);
  });

  test("should handle min signed values", () => {
    const schema = {
      i8: BinaryPrimitives.i8,
      i16: BinaryPrimitives.i16,
      i32: BinaryPrimitives.i32,
    };
    const data = { i8: -128, i16: -32768, i32: -2147483648 };
    const encoded = BinaryCodec.encode(schema, data);
    const decoded = BinaryCodec.decode(schema, encoded, {
      i8: 0,
      i16: 0,
      i32: 0,
    });
    expect(decoded.i8).toBe(-128);
    expect(decoded.i16).toBe(-32768);
    expect(decoded.i32).toBe(-2147483648);
  });
});

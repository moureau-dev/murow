import { describe, test, expect } from 'bun:test';
import {
  BinaryCodec,
  u8,
  u16,
  u32,
  i8,
  i16,
  i32,
  f16,
  f32,
  f64,
  bool,
  string,
  vec2,
  vec3,
  vec2_le,
  vec3_le,
  vec4_le,
  color,
} from './binary-codec';

describe('bare type aliases', () => {
  test('each alias is the same instance as its namespaced counterpart', () => {
    expect(u8).toBe(BinaryCodec.u8);
    expect(u16).toBe(BinaryCodec.u16);
    expect(u32).toBe(BinaryCodec.u32);
    expect(i8).toBe(BinaryCodec.i8);
    expect(i16).toBe(BinaryCodec.i16);
    expect(i32).toBe(BinaryCodec.i32);
    expect(f16).toBe(BinaryCodec.f16);
    expect(f32).toBe(BinaryCodec.f32);
    expect(bool).toBe(BinaryCodec.bool);
    expect(string).toBe(BinaryCodec.string);
    expect(vec2).toBe(BinaryCodec.vec2);
    expect(vec3).toBe(BinaryCodec.vec3);
    expect(color).toBe(BinaryCodec.color);
  });

  test('aliases can be used as fields in a schema', () => {
    const schema = { dx: f32, dy: f32, count: u8 };
    const value = { dx: 1.5, dy: -2.5, count: 7 };
    const encoded = BinaryCodec.encode(schema, value);
    const decoded = BinaryCodec.decode(schema, encoded, { dx: 0, dy: 0, count: 0 });
    expect(decoded.dx).toBeCloseTo(1.5);
    expect(decoded.dy).toBeCloseTo(-2.5);
    expect(decoded.count).toBe(7);
  });

  test('string(n) alias produces a sized string field', () => {
    const schema = { name: string(16) };
    const encoded = BinaryCodec.encode(schema, { name: 'hello' });
    const decoded = BinaryCodec.decode(schema, encoded, { name: '' });
    expect(decoded.name).toBe('hello');
  });

  test('f64 alias is exposed even though BinaryCodec does not re-export it', () => {
    // f64 lives on BinaryPrimitives; the bare alias surfaces it.
    expect(f64).toBeDefined();
  });

  test('vec_le aliases are exposed', () => {
    expect(vec2_le).toBeDefined();
    expect(vec3_le).toBeDefined();
    expect(vec4_le).toBeDefined();
  });
});

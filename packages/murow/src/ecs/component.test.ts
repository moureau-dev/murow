import { describe, test, expect } from 'bun:test';
import { defineComponent } from './component';
import { BinaryCodec, f32, u16 } from '../core/binary-codec';

describe('defineComponent', () => {
  describe('bare schema form (backwards compatible)', () => {
    test('returns a Component with name, schema, size, fieldCount, fieldNames', () => {
      const Position = defineComponent('Position', {
        x: BinaryCodec.f32,
        y: BinaryCodec.f32,
      });
      expect(Position.name).toBe('Position');
      expect(Position.fieldCount).toBe(2);
      expect(Position.fieldNames).toEqual(['x', 'y']);
      expect(Position.size).toBeGreaterThan(0);
    });

    test('does not attach __sync', () => {
      const Local = defineComponent('Local', { x: f32 });
      expect(Local.__sync).toBeUndefined();
    });
  });

  describe('descriptor form { schema, sync }', () => {
    test('routes to the descriptor path and attaches __sync', () => {
      const Position = defineComponent('Position', {
        schema: { x: f32, y: f32 },
        sync: { rate: 'every-tick', interest: 'aoi' },
      });
      expect(Position.name).toBe('Position');
      expect(Position.fieldCount).toBe(2);
      expect(Position.fieldNames).toEqual(['x', 'y']);
      expect(Position.__sync).toEqual({ rate: 'every-tick', interest: 'aoi' });
    });

    test('preserves the schema fields independently of the sync metadata', () => {
      const Health = defineComponent('Health', {
        schema: { hp: u16, max: u16 },
        sync: { rate: 'on-change' },
      });
      expect(Health.fieldNames).toEqual(['hp', 'max']);
      expect(Health.size).toBeGreaterThan(0);
    });
  });

  describe('detection edge cases', () => {
    test('a bare schema whose field is named "schema" (without "sync") still routes to the bare path', () => {
      // The check requires BOTH `schema` and `sync` keys. A schema with only one of these as a field
      // name is still treated as a bare schema.
      const Weird = defineComponent('Weird', { schema: f32 } as any);
      expect(Weird.fieldNames as string[]).toEqual(['schema']);
      expect(Weird.__sync).toBeUndefined();
    });

    test('a bare schema whose field is named "sync" (without "schema") still routes to the bare path', () => {
      const Weird = defineComponent('Weird', { sync: f32 } as any);
      expect(Weird.fieldNames as string[]).toEqual(['sync']);
      expect(Weird.__sync).toBeUndefined();
    });
  });

  describe('scalar field guard', () => {
    test('accepts number and boolean fields', () => {
      expect(() => defineComponent('Ok', { hp: u16, dead: BinaryCodec.bool })).not.toThrow();
    });

    test('throws on a composite field', () => {
      expect(() => defineComponent('Bad', { v: BinaryCodec.vec2 } as any)).toThrow(/must be a scalar/);
    });

    test('rejects a composite field at the type level', () => {
      // Never invoked: this asserts the compile-time guard (validated by tsc),
      // not runtime behavior.
      const _check = () =>
        // @ts-expect-error composite fields are not assignable to a scalar component schema
        defineComponent('CompileBad', { v: BinaryCodec.vec2 });
      expect(typeof _check).toBe('function');
    });
  });
});

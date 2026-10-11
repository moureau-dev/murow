import { describe, expect, test } from 'bun:test';
import type { Infer, TypedArrayOf } from './infer';
import { f32, i32, vec3f } from './primitives';

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type Schema = { pos: typeof vec3f; hp: typeof i32 };
type Host = Infer<Schema>;

const inferredHost: Equal<Host, { pos: [number, number, number]; hp: number }> = true;
const typedArray: Equal<TypedArrayOf<typeof f32>, Float32Array> = true;

describe('infer', () => {
    test('maps a schema to its host shape at the type level', () => {
        expect(inferredHost).toBe(true);
        expect(typedArray).toBe(true);
    });
});

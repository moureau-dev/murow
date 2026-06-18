import { describe, test, expect } from 'bun:test';
import { World } from './world';
import { defineComponent } from '../components/component';
import { f32, u16, u8 } from '../../core/binary-codec';

const Position = defineComponent('Position', { x: f32, z: f32 });
const Health = defineComponent('Health', { hp: u16 });
const Mana = defineComponent('Mana', { mp: u8 });

function makeWorld() {
    return new World({ maxEntities: 64, components: [Position, Health, Mana] });
}

describe('world-codec', () => {
    test('round-trips scalar components', () => {
        const w = makeWorld();
        const src = w.spawn();
        w.add(src, Position, { x: 1.5, z: -2.25 });
        w.add(src, Health, { hp: 42 });

        const bytes = w.serialize(src, [Position, Health]);
        const dst = w.spawn();
        w.restore(dst, bytes, [Position, Health]);

        expect(w.get(dst, Position)).toEqual({ x: 1.5, z: -2.25 });
        expect(w.get(dst, Health)).toEqual({ hp: 42 });
    });

    test('the presence bitmask restores only the components the entity had', () => {
        const w = makeWorld();
        const src = w.spawn();
        w.add(src, Position, { x: 1, z: 1 });
        w.add(src, Mana, { mp: 9 });

        const bytes = w.serialize(src);
        const dst = w.spawn();
        w.restore(dst, bytes);

        expect(w.has(dst, Position)).toBe(true);
        expect(w.has(dst, Health)).toBe(false);
        expect(w.get(dst, Mana)).toEqual({ mp: 9 });
    });

    test('self-describing default round-trips without passing components', () => {
        const w = makeWorld();
        const src = w.spawn();
        w.add(src, Position, { x: 7, z: 8 });
        w.add(src, Health, { hp: 100 });

        const bytes = w.serialize(src);
        const dst = w.spawn();
        w.restore(dst, bytes);

        expect(w.get(dst, Position)).toEqual({ x: 7, z: 8 });
        expect(w.get(dst, Health)).toEqual({ hp: 100 });
        expect(w.has(dst, Mana)).toBe(false);
    });

    test('a subset filter serializes only the chosen components', () => {
        const w = makeWorld();
        const src = w.spawn();
        w.add(src, Position, { x: 1, z: 2 });
        w.add(src, Health, { hp: 5 });

        const bytes = w.serialize(src, [Position]);
        const dst = w.spawn();
        w.restore(dst, bytes, [Position]);

        expect(w.has(dst, Position)).toBe(true);
        expect(w.has(dst, Health)).toBe(false);
    });

    test('byte size equals the bytes written (mask + present fields)', () => {
        const w = makeWorld();
        const e = w.spawn();
        w.add(e, Position, { x: 1, z: 2 });
        w.add(e, Health, { hp: 3 });

        const bytes = w.serialize(e, [Position, Health, Mana]);
        // 1 mask word (4) + Position (2 x f32 = 8) + Health (u16 = 2); Mana absent.
        expect(bytes.length).toBe(4 + 8 + 2);
    });
});

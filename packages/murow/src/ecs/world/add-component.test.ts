import { describe, test, expect } from 'bun:test';
import { World } from './world';
import { defineComponent } from '../components/component';
import { f32, u16 } from '../../core/binary-codec';

const Position = defineComponent('Position', { x: f32, y: f32 });

describe('world.addComponent', () => {
    test('registers a component after construction; fields, get and query work', () => {
        const w = new World({ maxEntities: 64, components: [Position] });
        const Velocity = defineComponent('Velocity', { vx: f32, vy: f32 });

        expect(w.addComponent(Velocity)).toBe(Velocity);

        const e = w.spawn();
        w.add(e, Position, { x: 1, y: 2 });
        w.add(e, Velocity, { vx: 3, vy: 4 });

        expect(w.has(e, Velocity)).toBe(true);
        expect(w.get(e, Velocity)).toEqual({ vx: 3, vy: 4 });

        const fields = w.fields(Velocity);
        expect(fields.vx[e]).toBe(3);
        fields.vx[e] = 9;
        expect(w.get(e, Velocity).vx).toBe(9);

        expect(Array.from(w.query(Position, Velocity))).toContain(e);
    });

    test('is idempotent for a component already registered in this world', () => {
        const w = new World({ maxEntities: 8, components: [Position] });
        expect(w.addComponent(Position)).toBe(Position);

        const e = w.spawn();
        w.add(e, Position, { x: 5, y: 6 });
        expect(w.get(e, Position)).toEqual({ x: 5, y: 6 });
        expect(Array.from(w.query(Position))).toEqual([e]);
    });

    test('grows the mask words when a component crosses the 32-bit boundary', () => {
        const w = new World({ maxEntities: 8, components: [Position] });

        let last = Position;
        for (let i = 0; i < 40; i++) {
            last = defineComponent(`C${i}`, { v: u16 });
            w.addComponent(last);
        }
        // Position=0, C0=1 .. C39=40 -> index 40 lives in mask word 1.

        const e = w.spawn();
        w.add(e, last, { v: 7 });
        expect(w.has(e, last)).toBe(true);
        expect(w.get(e, last)).toEqual({ v: 7 });

        const e2 = w.spawn();
        expect(w.has(e2, last)).toBe(false);

        expect(Array.from(w.query(last))).toEqual([e]);
    });

    test('chains via world.fields(world.addComponent(C))', () => {
        const w = new World({ maxEntities: 8, components: [Position] });
        const Health = defineComponent('Health', { hp: u16 });

        const fields = w.fields(w.addComponent(Health));
        const e = w.spawn();
        w.add(e, Health, { hp: 100 });

        expect(fields.hp[e]).toBe(100);
    });
});

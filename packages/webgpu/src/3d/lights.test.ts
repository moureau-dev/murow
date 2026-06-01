import { test, expect, describe } from 'bun:test';
import { LightSystem } from './lights';
import { LIGHT_FLOATS, MESH_UNIFORM_FLOATS, MESH_UNIFORM_LIGHT_OFFSET } from '../core/types';

const L = MESH_UNIFORM_LIGHT_OFFSET;

/** Read field f of the i-th packed record. */
function packedField(data: Float32Array, record: number, field: number): number {
    return data[record * LIGHT_FLOATS + field];
}

describe('LightSystem', () => {
    describe('add', () => {
        test('a point light packs its position, color, intensity and range', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'point', position: [1, 2, 3], color: [0.5, 0.6, 0.7], intensity: 4, range: 9 });
            const { data, count } = ls.pack();
            expect(count).toBe(1);
            expect(packedField(data, 0, 0)).toBe(1);   // kind = point
            expect(packedField(data, 0, 1)).toBe(1);   // pos x
            expect(packedField(data, 0, 2)).toBe(2);
            expect(packedField(data, 0, 3)).toBe(3);
            expect(packedField(data, 0, 7)).toBeCloseTo(0.5); // color r
            expect(packedField(data, 0, 10)).toBe(4);  // intensity
            expect(packedField(data, 0, 11)).toBe(9);  // range
        });

        test('a point light disables the cone (innerCos=1, outerCos=-1)', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'point', position: [0, 0, 0] });
            const { data } = ls.pack();
            expect(packedField(data, 0, 12)).toBe(1);
            expect(packedField(data, 0, 13)).toBe(-1);
        });

        test('a spot light packs direction and cone cosines', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'spot', position: [0, 5, 0], direction: [0, -1, 0], innerAngle: 0.3, outerAngle: 0.5 });
            const { data } = ls.pack();
            expect(packedField(data, 0, 0)).toBe(2);   // kind = spot
            expect(packedField(data, 0, 5)).toBe(-1);  // dir y
            expect(packedField(data, 0, 12)).toBeCloseTo(Math.cos(0.3));
            expect(packedField(data, 0, 13)).toBeCloseTo(Math.cos(0.5));
        });

        test('reserved shadow fields default to 0 / -1', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'point', position: [0, 0, 0] });
            const { data } = ls.pack();
            expect(packedField(data, 0, 14)).toBe(0);   // castsShadow
            expect(packedField(data, 0, 15)).toBe(-1);  // shadowMapIndex
        });

        test('throws past capacity', () => {
            const ls = new LightSystem(2);
            ls.add({ type: 'point', position: [0, 0, 0] });
            ls.add({ type: 'point', position: [0, 0, 0] });
            expect(() => ls.add({ type: 'point', position: [0, 0, 0] })).toThrow();
        });
    });

    describe('handle mutation', () => {
        test('setters update the packed data', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'point', position: [0, 0, 0], intensity: 1, range: 5 });
            h.setPosition(10, 11, 12);
            h.setColor(0.1, 0.2, 0.3);
            h.intensity = 7;
            h.range = 20;
            const { data } = ls.pack();
            expect(packedField(data, 0, 1)).toBe(10);
            expect(packedField(data, 0, 7)).toBeCloseTo(0.1);
            expect(packedField(data, 0, 10)).toBe(7);
            expect(packedField(data, 0, 11)).toBe(20);
            expect(h.intensity).toBe(7);
            expect(h.range).toBe(20);
        });

        test('position, direction and color are readable back', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'spot', position: [1, 2, 3], direction: [0, -1, 0], color: [0.4, 0.5, 0.6] });
            expect([...h.position]).toEqual([1, 2, 3]);
            expect([...h.direction]).toEqual([0, -1, 0]);
            expect(h.color[0]).toBeCloseTo(0.4);
            expect(h.color[1]).toBeCloseTo(0.5);
            expect(h.color[2]).toBeCloseTo(0.6);
        });

        test('getters reflect setter writes', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'point', position: [0, 0, 0] });
            h.setPosition(7, 8, 9);
            h.setColor(0.1, 0.2, 0.3);
            expect([...h.position]).toEqual([7, 8, 9]);
            expect(h.color[0]).toBeCloseTo(0.1);
        });

        test('destroy frees the slot and drops it from the pack', () => {
            const ls = new LightSystem(8);
            const a = ls.add({ type: 'point', position: [1, 0, 0] });
            ls.add({ type: 'point', position: [2, 0, 0] });
            a.destroy();
            expect(ls.count).toBe(1);
            expect(ls.pack().count).toBe(1);
            // double destroy is a no-op
            expect(() => a.destroy()).not.toThrow();
            expect(ls.count).toBe(1);
        });
    });

    describe('pack', () => {
        test('skips disabled lights', () => {
            const ls = new LightSystem(8);
            const a = ls.add({ type: 'point', position: [1, 0, 0] });
            ls.add({ type: 'point', position: [2, 0, 0] });
            a.enabled = false;
            const { count, byteLength } = ls.pack();
            expect(count).toBe(1);
            expect(byteLength).toBe(LIGHT_FLOATS * 4);
        });

        test('re-enabling restores the light', () => {
            const ls = new LightSystem(8);
            const a = ls.add({ type: 'point', position: [1, 0, 0] });
            a.enabled = false;
            expect(ls.pack().count).toBe(0);
            a.enabled = true;
            expect(ls.pack().count).toBe(1);
        });

        test('byteLength matches count', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'point', position: [0, 0, 0] });
            ls.add({ type: 'point', position: [0, 0, 0] });
            ls.add({ type: 'point', position: [0, 0, 0] });
            expect(ls.pack().byteLength).toBe(3 * LIGHT_FLOATS * 4);
        });
    });

    describe('writeUniforms', () => {
        test('stamps directional, ambient and count at the given offset', () => {
            const ls = new LightSystem(8);
            ls.setDirectional([0, 1, 0], [0.8, 0.9, 1.0], 2);
            ls.setAmbient([0.1, 0.2, 0.3]);
            const u = new Float32Array(MESH_UNIFORM_FLOATS);
            ls.writeUniforms(u, L, 5);
            expect(u[L + 0]).toBe(0);          // dir x
            expect(u[L + 1]).toBe(1);          // dir y
            expect(u[L + 3]).toBeCloseTo(0.8); // dir color r
            expect(u[L + 6]).toBe(2);          // dir intensity
            expect(u[L + 7]).toBeCloseTo(0.1); // ambient r
            // count is a u32 reinterpret at offset+10
            expect(new Uint32Array(u.buffer)[L + 10]).toBe(5);
        });

        test('defaults reproduce the classic fixed look', () => {
            const ls = new LightSystem(8);
            const u = new Float32Array(MESH_UNIFORM_FLOATS);
            ls.writeUniforms(u, L, 0);
            expect(u[L + 0]).toBeCloseTo(0.3);
            expect(u[L + 1]).toBeCloseTo(0.8);
            expect(u[L + 2]).toBeCloseTo(0.5);
            expect(u[L + 6]).toBe(1);          // intensity
            expect(u[L + 7]).toBeCloseTo(0.3); // ambient
        });
    });
});

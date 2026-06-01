import { test, expect, describe } from 'bun:test';
import { LightSystem } from './lights';
import { LIGHT_FLOATS, MESH_UNIFORM_FLOATS, MESH_UNIFORM_LIGHT_OFFSET } from '../core/types';

const L = MESH_UNIFORM_LIGHT_OFFSET;

// Light record field offsets (mirror the Light struct in core/types).
const F = {
    KIND: 0,
    CURR_POS_X: 1, CURR_POS_Y: 2, CURR_POS_Z: 3,
    PREV_POS_X: 4, PREV_POS_Y: 5, PREV_POS_Z: 6,
    CURR_DIR_X: 7, CURR_DIR_Y: 8, CURR_DIR_Z: 9,
    PREV_DIR_X: 10, PREV_DIR_Y: 11, PREV_DIR_Z: 12,
    COL_R: 13, COL_G: 14, COL_B: 15, INTENSITY: 16, RANGE: 17,
    INNER_COS: 18, OUTER_COS: 19, CASTS_SHADOW: 20, SHADOW_INDEX: 21,
} as const;

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
            expect(packedField(data, 0, F.KIND)).toBe(1);   // point
            expect(packedField(data, 0, F.CURR_POS_X)).toBe(1);
            expect(packedField(data, 0, F.CURR_POS_Y)).toBe(2);
            expect(packedField(data, 0, F.CURR_POS_Z)).toBe(3);
            expect(packedField(data, 0, F.COL_R)).toBeCloseTo(0.5);
            expect(packedField(data, 0, F.INTENSITY)).toBe(4);
            expect(packedField(data, 0, F.RANGE)).toBe(9);
        });

        test('a freshly added light seeds prev = curr (no spawn lerp)', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'spot', position: [1, 2, 3], direction: [0, -1, 0] });
            const { data } = ls.pack();
            expect(packedField(data, 0, F.PREV_POS_X)).toBe(1);
            expect(packedField(data, 0, F.PREV_POS_Y)).toBe(2);
            expect(packedField(data, 0, F.PREV_POS_Z)).toBe(3);
            expect(packedField(data, 0, F.PREV_DIR_Y)).toBe(-1);
        });

        test('a point light disables the cone (innerCos=1, outerCos=-1)', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'point', position: [0, 0, 0] });
            const { data } = ls.pack();
            expect(packedField(data, 0, F.INNER_COS)).toBe(1);
            expect(packedField(data, 0, F.OUTER_COS)).toBe(-1);
        });

        test('a spot light derives cone cosines from angle + smoothness', () => {
            const ls = new LightSystem(8);
            // angle 0.5 (outer edge), smoothness 0.4 -> inner edge at 0.5*(1-0.4)=0.3
            ls.add({ type: 'spot', position: [0, 5, 0], direction: [0, -1, 0], angle: 0.5, smoothness: 0.4 });
            const { data } = ls.pack();
            expect(packedField(data, 0, F.KIND)).toBe(2);   // spot
            expect(packedField(data, 0, F.CURR_DIR_Y)).toBe(-1);
            expect(packedField(data, 0, F.OUTER_COS)).toBeCloseTo(Math.cos(0.5));
            expect(packedField(data, 0, F.INNER_COS)).toBeCloseTo(Math.cos(0.3));
        });

        test('smoothness 0 is a hard edge (inner == outer)', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'spot', position: [0, 5, 0], direction: [0, -1, 0], angle: 0.5, smoothness: 0 });
            const { data } = ls.pack();
            expect(packedField(data, 0, F.INNER_COS)).toBeCloseTo(packedField(data, 0, F.OUTER_COS));
            expect(packedField(data, 0, F.OUTER_COS)).toBeCloseTo(Math.cos(0.5));
        });

        test('smoothness 1 fades from the cone center (inner cos = 1)', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'spot', position: [0, 5, 0], direction: [0, -1, 0], angle: 0.5, smoothness: 1 });
            const { data } = ls.pack();
            expect(packedField(data, 0, F.INNER_COS)).toBeCloseTo(1); // cos(0) = full from center
            expect(packedField(data, 0, F.OUTER_COS)).toBeCloseTo(Math.cos(0.5));
        });

        test('reserved shadow fields default to 0 / -1', () => {
            const ls = new LightSystem(8);
            ls.add({ type: 'point', position: [0, 0, 0] });
            const { data } = ls.pack();
            expect(packedField(data, 0, F.CASTS_SHADOW)).toBe(0);
            expect(packedField(data, 0, F.SHADOW_INDEX)).toBe(-1);
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
            expect(packedField(data, 0, F.CURR_POS_X)).toBe(10);
            expect(packedField(data, 0, F.COL_R)).toBeCloseTo(0.1);
            expect(packedField(data, 0, F.INTENSITY)).toBe(7);
            expect(packedField(data, 0, F.RANGE)).toBe(20);
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

        test('angle and smoothness are readable and live-settable', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'spot', position: [0, 0, 0], direction: [0, -1, 0], angle: 0.5, smoothness: 0.4 });
            expect(h.angle).toBeCloseTo(0.5);
            expect(h.smoothness).toBeCloseTo(0.4);

            h.smoothness = 0;   // hard edge -> inner cos == outer cos
            let data = ls.pack().data;
            expect(packedField(data, 0, F.INNER_COS)).toBeCloseTo(packedField(data, 0, F.OUTER_COS));
            expect(h.smoothness).toBe(0);

            h.smoothness = 1;   // fades from center -> inner cos = 1
            data = ls.pack().data;
            expect(packedField(data, 0, F.INNER_COS)).toBeCloseTo(1);

            h.angle = 0.8;      // widen the cone -> outer cos = cos(0.8)
            data = ls.pack().data;
            expect(h.angle).toBeCloseTo(0.8);
            expect(packedField(data, 0, F.OUTER_COS)).toBeCloseTo(Math.cos(0.8));
        });

        test('smoothness is clamped to 0..1', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'spot', position: [0, 0, 0], direction: [0, -1, 0], angle: 0.5, smoothness: 0.5 });
            h.smoothness = 5;
            expect(h.smoothness).toBe(1);
            h.smoothness = -3;
            expect(h.smoothness).toBe(0);
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

    describe('interpolation', () => {
        test('storePrevious snapshots curr into prev, leaving curr untouched', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'point', position: [0, 0, 0] });
            h.setPosition(10, 20, 30);
            // prev still holds the spawn position until we snapshot.
            let data = ls.pack().data;
            expect(packedField(data, 0, F.PREV_POS_X)).toBe(0);
            expect(packedField(data, 0, F.CURR_POS_X)).toBe(10);

            ls.storePrevious();
            data = ls.pack().data;
            expect(packedField(data, 0, F.PREV_POS_X)).toBe(10);
            expect(packedField(data, 0, F.PREV_POS_Y)).toBe(20);
            expect(packedField(data, 0, F.CURR_POS_X)).toBe(10); // curr unchanged
        });

        test('a move after storePrevious leaves prev and curr distinct (lerp range)', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'point', position: [0, 0, 0] });
            ls.storePrevious();      // prev = curr = 0
            h.setPosition(4, 0, 0);  // curr = 4, prev still 0
            const data = ls.pack().data;
            expect(packedField(data, 0, F.PREV_POS_X)).toBe(0);
            expect(packedField(data, 0, F.CURR_POS_X)).toBe(4);
        });

        test('teleport snaps prev to curr (no interpolation)', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'point', position: [0, 0, 0] });
            ls.storePrevious();
            h.teleport(100, 0, 0);
            const data = ls.pack().data;
            expect(packedField(data, 0, F.PREV_POS_X)).toBe(100);
            expect(packedField(data, 0, F.CURR_POS_X)).toBe(100);
        });

        test('storePrevious also snapshots direction', () => {
            const ls = new LightSystem(8);
            const h = ls.add({ type: 'spot', position: [0, 0, 0], direction: [0, -1, 0] });
            h.setDirection(1, 0, 0);
            ls.storePrevious();
            const data = ls.pack().data;
            expect(packedField(data, 0, F.PREV_DIR_X)).toBe(1);
            expect(packedField(data, 0, F.CURR_DIR_X)).toBe(1);
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

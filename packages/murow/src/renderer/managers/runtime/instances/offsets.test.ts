import { describe, expect, test } from 'bun:test';
import { MAX_MATERIALS_PER_INSTANCE, DYN_PREV_PX, DYN_CURR_PX, STAT_SX, STAT_MATERIAL_ID } from './offsets';

describe('instance offsets', () => {
    test('dynamic prev/curr are distinct slots', () => {
        expect(DYN_PREV_PX).not.toBe(DYN_CURR_PX);
    });

    test('static slots are ordered and bounded', () => {
        expect(STAT_SX).toBe(0);
        expect(STAT_MATERIAL_ID).toBeGreaterThan(STAT_SX);
    });

    test('material capacity is positive', () => {
        expect(MAX_MATERIALS_PER_INSTANCE).toBeGreaterThan(0);
    });
});

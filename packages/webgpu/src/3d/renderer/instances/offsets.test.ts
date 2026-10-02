import { test, expect, describe } from 'bun:test';
import * as d from 'typegpu/data';
import { StaticMesh, STATIC_MESH_FLOATS } from '../../../core/types';
import {
    STAT_SX,
    STAT_SY,
    STAT_SZ,
    STAT_CR,
    STAT_CG,
    STAT_CB,
    STAT_MATERIAL_ID,
    STAT_CUSTOM0,
    STAT_CUSTOM1,
} from './offsets';

const fields = Object.keys((StaticMesh as any).propTypes);

describe('StaticMesh GPU layout', () => {
    test('packed f32 count matches statically declared float count', () => {
        expect(d.sizeOf(StaticMesh)).toBe(STATIC_MESH_FLOATS * 4);
    });

    test('struct has exactly STATIC_MESH_FLOATS fields', () => {
        expect(fields.length).toBe(STATIC_MESH_FLOATS);
    });

    test('offset constants match the struct field order', () => {
        expect([
            STAT_SX,
            STAT_SY,
            STAT_SZ,
            STAT_CR,
            STAT_CG,
            STAT_CB,
            STAT_MATERIAL_ID,
            STAT_CUSTOM0,
            STAT_CUSTOM1,
        ]).toEqual(fields.map((_, i) => i));
    });

    test('field names are in the expected slot order', () => {
        expect(fields).toEqual([
            'scaleX',
            'scaleY',
            'scaleZ',
            'colorR',
            'colorG',
            'colorB',
            'materialId',
            'custom0',
            'custom1',
        ]);
    });

    test('materialId and custom slots use their fixed offsets', () => {
        expect(STAT_MATERIAL_ID).toBe(6);
        expect(STAT_CUSTOM0).toBe(7);
        expect(STAT_CUSTOM1).toBe(8);
    });
});

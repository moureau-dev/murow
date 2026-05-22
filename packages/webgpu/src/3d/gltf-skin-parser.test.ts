import { test, expect, describe } from 'bun:test';
import { parseSkin, getNodeTRS } from './gltf-skin-parser';

/**
 * Minimal accessor reader for tests — we construct typed-array data inline
 * and serve it from a tiny in-memory buffer view table.
 */
function makeAccessorReader(buffers: ArrayBuffer[]) {
    return (accessorIndex: number) => {
        // For these tests, accessors are 1:1 with bufferViews and we pre-populate
        // all of them with the right type metadata via a global shared registry.
        throw new Error(`accessor ${accessorIndex} not in fixture`);
    };
}

describe('parseSkin', () => {
    test('pre-extracts rest-pose TRS for every joint', () => {
        // Build a minimal glTF with 2 joints. The skin's IBM accessor is just 0;
        // we provide the reader inline so it returns the right shape.
        const ibmData = new Float32Array(32); // 2 joints × 16 floats — values don't matter for this test
        const gltf = {
            nodes: [
                // node 0 — joint A (root): translation (1,2,3), no rotation
                { name: 'jointA', translation: [1, 2, 3] },
                // node 1 — joint B (child of A): rotation quaternion
                { name: 'jointB', rotation: [0, 0, 0, 1], scale: [2, 2, 2] },
            ],
            skins: [
                { joints: [0, 1], inverseBindMatrices: 0 },
            ],
        };

        const getAccessorData = (idx: number) => {
            // Accessor 0 is the IBM
            if (idx === 0) return { data: ibmData, count: 2, elementSize: 16 };
            throw new Error(`unexpected accessor ${idx}`);
        };

        const skinData = parseSkin(gltf, 0, getAccessorData);

        expect(skinData.jointCount).toBe(2);
        expect(skinData.restPoseTRS).toBeDefined();
        expect(skinData.restPoseTRS.length).toBe(20); // 2 joints × 10 floats

        // Verify each joint's TRS matches what getNodeTRS would produce
        const trsA = getNodeTRS(gltf.nodes[0]);
        const trsB = getNodeTRS(gltf.nodes[1]);
        for (let k = 0; k < 10; k++) {
            expect(skinData.restPoseTRS[0 * 10 + k]).toBe(trsA[k]);
            expect(skinData.restPoseTRS[1 * 10 + k]).toBe(trsB[k]);
        }
    });

    test('rest pose TRS encodes translation correctly', () => {
        const ibmData = new Float32Array(16);
        const gltf = {
            nodes: [{ name: 'a', translation: [5, 6, 7] }],
            skins: [{ joints: [0], inverseBindMatrices: 0 }],
        };
        const skinData = parseSkin(gltf, 0,
            (idx) => idx === 0 ? { data: ibmData, count: 1, elementSize: 16 } : (() => { throw new Error(); })()
        );

        // TRS layout: [tx, ty, tz, qx, qy, qz, qw, sx, sy, sz]
        expect(skinData.restPoseTRS[0]).toBe(5);
        expect(skinData.restPoseTRS[1]).toBe(6);
        expect(skinData.restPoseTRS[2]).toBe(7);
    });

    test('rest pose TRS defaults to identity for joints without TRS', () => {
        const ibmData = new Float32Array(16);
        const gltf = {
            nodes: [{ name: 'a' }],
            skins: [{ joints: [0], inverseBindMatrices: 0 }],
        };
        const skinData = parseSkin(gltf, 0,
            (idx) => idx === 0 ? { data: ibmData, count: 1, elementSize: 16 } : (() => { throw new Error(); })()
        );

        // Default: translation (0,0,0), quat identity (0,0,0,1), scale (1,1,1)
        expect(Array.from(skinData.restPoseTRS)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    });
});

describe('getNodeTRS', () => {
    test('extracts translation/rotation/scale', () => {
        const trs = getNodeTRS({ translation: [1, 2, 3], rotation: [0.1, 0.2, 0.3, 0.9], scale: [2, 3, 4] });
        const expected = [1, 2, 3, 0.1, 0.2, 0.3, 0.9, 2, 3, 4];
        for (let i = 0; i < expected.length; i++) {
            expect(trs[i]).toBeCloseTo(expected[i], 5);
        }
    });

    test('defaults missing fields to identity', () => {
        const trs = getNodeTRS({});
        expect(Array.from(trs)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    });

    test('extracts translation from matrix when matrix is provided', () => {
        const trs = getNodeTRS({ matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, 5,6,7,1] });
        expect(trs[0]).toBe(5);
        expect(trs[1]).toBe(6);
        expect(trs[2]).toBe(7);
    });
});

import { test, expect, describe } from 'bun:test';
import { Camera2D } from './camera-2d';

describe('Camera2D', () => {
    describe('constructor', () => {
        test('sets initial width and height', () => {
            const cam = new Camera2D(800, 600);
            expect(cam.width).toBe(800);
            expect(cam.height).toBe(600);
        });

        test('defaults to zero position, unit zoom, zero rotation', () => {
            const cam = new Camera2D(800, 600);
            expect(cam.x).toBe(0);
            expect(cam.y).toBe(0);
            expect(cam.zoom).toBe(1);
            expect(cam.rotation).toBe(0);
        });
    });

    describe('setViewport', () => {
        test('updates width and height', () => {
            const cam = new Camera2D(800, 600);
            cam.setViewport(1920, 1080);
            expect(cam.width).toBe(1920);
            expect(cam.height).toBe(1080);
        });

        test('marks camera as dirty', () => {
            const cam = new Camera2D(800, 600);
            // Get matrix to clear dirty flag
            cam.getMatrix();
            expect(cam.dirty).toBe(false);
            cam.setViewport(1024, 768);
            expect(cam.dirty).toBe(true);
        });
    });

    describe('getMatrix — identity case', () => {
        test('returns a Float32Array of length 12', () => {
            const cam = new Camera2D(800, 600);
            const m = cam.getMatrix();
            expect(m).toBeInstanceOf(Float32Array);
            expect(m.length).toBe(12);
        });

        test('at origin with no rotation and zoom=1, the matrix is an ortho projection', () => {
            const cam = new Camera2D(800, 600);
            const m = cam.getMatrix();

            // sx = zoom / hw = 1 / 400 = 0.0025
            // sy = zoom / hh = 1 / 300 ~= 0.003333
            expect(m[0]).toBeCloseTo(1 / 400);    // col0.x = sx * cos(0) = sx
            expect(m[1]).toBeCloseTo(0);            // col0.y = sx * sin(0) = 0
            expect(m[2]).toBe(0);                   // col0.z
            expect(m[3]).toBe(0);                   // pad

            expect(m[4]).toBeCloseTo(0);            // col1.x = -sy * sin(0) = 0
            expect(m[5]).toBeCloseTo(1 / 300);     // col1.y = sy * cos(0) = sy
            expect(m[6]).toBe(0);                   // col1.z
            expect(m[7]).toBe(0);                   // pad

            // Translation: -(x * col0.x + y * col1.x) = 0
            expect(m[8]).toBeCloseTo(0);
            expect(m[9]).toBeCloseTo(0);
            expect(m[10]).toBe(1);
            expect(m[11]).toBe(0);
        });
    });

    describe('getMatrix — translation', () => {
        test('translating the camera shifts the matrix', () => {
            const cam = new Camera2D(800, 600);
            cam.x = 100;
            cam.y = 50;
            const m = cam.getMatrix();

            const sx = 1 / 400;
            const sy = 1 / 300;

            // col2.x = -(x * sx + y * 0) = -100 * sx
            expect(m[8]).toBeCloseTo(-100 * sx);
            // col2.y = -(x * 0 + y * sy) = -50 * sy
            expect(m[9]).toBeCloseTo(-50 * sy);
        });
    });

    describe('getMatrix — zoom', () => {
        test('zoom=2 doubles the scale', () => {
            const cam = new Camera2D(800, 600);
            cam.zoom = 2;
            const m = cam.getMatrix();

            expect(m[0]).toBeCloseTo(2 / 400);
            expect(m[5]).toBeCloseTo(2 / 300);
        });

        test('zoom=0.5 halves the scale', () => {
            const cam = new Camera2D(800, 600);
            cam.zoom = 0.5;
            const m = cam.getMatrix();

            expect(m[0]).toBeCloseTo(0.5 / 400);
            expect(m[5]).toBeCloseTo(0.5 / 300);
        });
    });

    describe('getMatrix — rotation', () => {
        test('90 degree rotation swaps axes', () => {
            const cam = new Camera2D(800, 600);
            cam.rotation = Math.PI / 2;
            const m = cam.getMatrix();

            const sx = 1 / 400;
            const sy = 1 / 300;
            const cos = Math.cos(-Math.PI / 2);
            const sin = Math.sin(-Math.PI / 2);

            expect(m[0]).toBeCloseTo(sx * cos);
            expect(m[1]).toBeCloseTo(sx * sin);
            expect(m[4]).toBeCloseTo(-sy * sin);
            expect(m[5]).toBeCloseTo(sy * cos);
        });

        test('rotation + translation: translation is rotated', () => {
            const cam = new Camera2D(800, 600);
            cam.rotation = Math.PI / 4;
            cam.x = 100;
            cam.y = 0;
            const m = cam.getMatrix();

            // col2.x = -(x * m[0] + y * m[4])
            expect(m[8]).toBeCloseTo(-(100 * m[0] + 0 * m[4]));
            expect(m[9]).toBeCloseTo(-(100 * m[1] + 0 * m[5]));
        });
    });

    describe('getMatrix — combined transforms', () => {
        test('zoom + rotation + translation produces consistent matrix', () => {
            const cam = new Camera2D(1024, 768);
            cam.x = -50;
            cam.y = 30;
            cam.zoom = 1.5;
            cam.rotation = 0.3;
            const m = cam.getMatrix();

            const hw = 512;
            const hh = 384;
            const z = 1.5;
            const cos = Math.cos(-0.3);
            const sin = Math.sin(-0.3);
            const sx = z / hw;
            const sy = z / hh;

            expect(m[0]).toBeCloseTo(sx * cos);
            expect(m[1]).toBeCloseTo(sx * sin);
            expect(m[4]).toBeCloseTo(-sy * sin);
            expect(m[5]).toBeCloseTo(sy * cos);
            expect(m[8]).toBeCloseTo(-(cam.x * m[0] + cam.y * m[4]));
            expect(m[9]).toBeCloseTo(-(cam.x * m[1] + cam.y * m[5]));
            expect(m[10]).toBe(1);
        });
    });

    describe('dirty flag', () => {
        test('getMatrix clears dirty flag', () => {
            const cam = new Camera2D(800, 600);
            cam.markDirty();
            expect(cam.dirty).toBe(true);
            cam.getMatrix();
            expect(cam.dirty).toBe(false);
        });

        test('markDirty sets dirty flag', () => {
            const cam = new Camera2D(800, 600);
            cam.getMatrix();
            expect(cam.dirty).toBe(false);
            cam.markDirty();
            expect(cam.dirty).toBe(true);
        });
    });

    describe('getMatrix returns same buffer instance', () => {
        test('subsequent calls return the same Float32Array reference', () => {
            const cam = new Camera2D(800, 600);
            const m1 = cam.getMatrix();
            cam.x = 10;
            const m2 = cam.getMatrix();
            expect(m1).toBe(m2); // same buffer, zero allocation
        });
    });

    describe('edge cases', () => {
        test('very small viewport', () => {
            const cam = new Camera2D(1, 1);
            const m = cam.getMatrix();
            expect(m[0]).toBeCloseTo(2); // 1 / 0.5
            expect(m[5]).toBeCloseTo(2);
        });

        test('square viewport', () => {
            const cam = new Camera2D(500, 500);
            const m = cam.getMatrix();
            expect(m[0]).toBeCloseTo(m[5]); // sx === sy when square
        });
    });
});

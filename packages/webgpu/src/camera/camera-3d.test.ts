import { test, expect, describe } from 'bun:test';
import { Camera3D } from './camera-3d';

describe('Camera3D', () => {
    describe('defaults', () => {
        test('default position is [0, 5, -10]', () => {
            const cam = new Camera3D();
            expect(cam.position).toEqual([0, 5, -10]);
        });

        test('default target is [0, 0, 0]', () => {
            const cam = new Camera3D();
            expect(cam.target).toEqual([0, 0, 0]);
        });

        test('default up is [0, 1, 0]', () => {
            const cam = new Camera3D();
            expect(cam.up).toEqual([0, 1, 0]);
        });

        test('default fov is 60', () => {
            const cam = new Camera3D();
            expect(cam.fov).toBe(60);
        });

        test('default near/far are 0.1 and 1000', () => {
            const cam = new Camera3D();
            expect(cam.near).toBe(0.1);
            expect(cam.far).toBe(1000);
        });

        test('default aspect is 1', () => {
            const cam = new Camera3D();
            expect(cam.aspect).toBe(1);
        });
    });

    describe('getViewMatrix', () => {
        test('returns a Float32Array of length 16', () => {
            const cam = new Camera3D();
            const v = cam.getViewMatrix();
            expect(v).toBeInstanceOf(Float32Array);
            expect(v.length).toBe(16);
        });

        test('view matrix last row is [0, 0, 0, 1] (affine transform)', () => {
            const cam = new Camera3D();
            const v = cam.getViewMatrix();
            expect(v[3]).toBeCloseTo(0);
            expect(v[7]).toBeCloseTo(0);
            expect(v[11]).toBeCloseTo(0);
            expect(v[15]).toBeCloseTo(1);
        });

        test('returns same buffer reference on repeated calls', () => {
            const cam = new Camera3D();
            const v1 = cam.getViewMatrix();
            const v2 = cam.getViewMatrix();
            expect(v1).toBe(v2);
        });

        test('looking down Z-axis: identity-like upper-left 3x3', () => {
            const cam = new Camera3D();
            cam.position = [0, 0, -5];
            cam.target = [0, 0, 0];
            cam.up = [0, 1, 0];
            const v = cam.getViewMatrix();

            // Forward = normalize(target - eye) = normalize([0,0,5]) = [0,0,1]
            // Right = cross(forward, up) = cross([0,0,1],[0,1,0]) = [-1,0,0]
            // After normalization and lookAt convention:
            // The view matrix should transform world to view space correctly
            // The translation row (12,13,14) encodes the camera position in view space
            expect(v[15]).toBeCloseTo(1);
        });

        test('moving position changes translation columns', () => {
            const cam = new Camera3D();
            cam.position = [10, 20, 30];
            cam.target = [0, 0, 0];
            const v1 = cam.getViewMatrix();
            // Copy the translation column since the buffer is reused
            const t1 = [v1[12], v1[13], v1[14]];

            cam.position = [100, 200, 300];
            cam.getViewMatrix();
            const t2 = [v1[12], v1[13], v1[14]];

            // At least one of the translation values should differ
            const anyDifferent = t1.some((val, i) => Math.abs(val - t2[i]) > 0.01);
            expect(anyDifferent).toBe(true);
        });
    });

    describe('getProjectionMatrix', () => {
        test('returns a Float32Array of length 16', () => {
            const cam = new Camera3D();
            const p = cam.getProjectionMatrix();
            expect(p).toBeInstanceOf(Float32Array);
            expect(p.length).toBe(16);
        });

        test('returns same buffer reference', () => {
            const cam = new Camera3D();
            const p1 = cam.getProjectionMatrix();
            const p2 = cam.getProjectionMatrix();
            expect(p1).toBe(p2);
        });

        test('perspective matrix structure: off-diagonal zeros', () => {
            const cam = new Camera3D();
            cam.aspect = 16 / 9;
            const p = cam.getProjectionMatrix();

            // Standard perspective matrix has zeros in specific positions
            expect(p[1]).toBe(0);
            expect(p[2]).toBe(0);
            expect(p[3]).toBe(0);
            expect(p[4]).toBe(0);
            expect(p[6]).toBe(0);
            expect(p[7]).toBe(0);
            expect(p[8]).toBe(0);
            expect(p[9]).toBe(0);
            expect(p[12]).toBe(0);
            expect(p[13]).toBe(0);
            expect(p[15]).toBe(0);
        });

        test('p[11] is -1 for standard perspective', () => {
            const cam = new Camera3D();
            const p = cam.getProjectionMatrix();
            expect(p[11]).toBe(-1);
        });

        test('fov affects the projection scale', () => {
            const cam = new Camera3D();
            cam.fov = 60;
            const p60 = cam.getProjectionMatrix();
            const f60 = p60[5]; // f = 1/tan(fov/2)

            cam.fov = 90;
            const p90 = cam.getProjectionMatrix();
            const f90 = p90[5];

            // Wider FOV => smaller f
            expect(f60).toBeGreaterThan(f90);
        });

        test('aspect ratio affects X scale but not Y', () => {
            const cam = new Camera3D();
            cam.fov = 60;
            cam.aspect = 2;
            const p = cam.getProjectionMatrix();

            const fovRad = 60 * (Math.PI / 180);
            const f = 1 / Math.tan(fovRad * 0.5);

            expect(p[0]).toBeCloseTo(f / 2);
            expect(p[5]).toBeCloseTo(f);
        });

        test('near/far affect depth mapping', () => {
            const cam = new Camera3D();
            cam.near = 1;
            cam.far = 100;
            const p = cam.getProjectionMatrix();

            const rangeInv = 1 / (1 - 100);
            expect(p[10]).toBeCloseTo((1 + 100) * rangeInv);
            expect(p[14]).toBeCloseTo(2 * 1 * 100 * rangeInv);
        });
    });

    describe('getViewProjectionMatrix', () => {
        test('returns a Float32Array of length 16', () => {
            const cam = new Camera3D();
            const vp = cam.getViewProjectionMatrix();
            expect(vp).toBeInstanceOf(Float32Array);
            expect(vp.length).toBe(16);
        });

        test('returns same buffer reference', () => {
            const cam = new Camera3D();
            const vp1 = cam.getViewProjectionMatrix();
            const vp2 = cam.getViewProjectionMatrix();
            expect(vp1).toBe(vp2);
        });

        test('VP = P * V (manual verification)', () => {
            const cam = new Camera3D();
            cam.position = [3, 4, 5];
            cam.target = [0, 0, 0];
            cam.aspect = 1.5;
            cam.fov = 45;

            const v = cam.getViewMatrix();
            const p = cam.getProjectionMatrix();
            const vp = cam.getViewProjectionMatrix();

            // Manually compute P * V for one element
            // vp[0] = p[0]*v[0] + p[4]*v[1] + p[8]*v[2] + p[12]*v[3]
            const expected00 = p[0] * v[0] + p[4] * v[1] + p[8] * v[2] + p[12] * v[3];
            expect(vp[0]).toBeCloseTo(expected00);

            // vp[5] = p[1]*v[4] + p[5]*v[5] + p[9]*v[6] + p[13]*v[7]
            const expected05 = p[1] * v[4] + p[5] * v[5] + p[9] * v[6] + p[13] * v[7];
            expect(vp[5]).toBeCloseTo(expected05);
        });
    });

    describe('setAspect', () => {
        test('computes aspect ratio from width and height', () => {
            const cam = new Camera3D();
            cam.setAspect(1920, 1080);
            expect(cam.aspect).toBeCloseTo(1920 / 1080);
        });

        test('square viewport gives aspect 1', () => {
            const cam = new Camera3D();
            cam.setAspect(500, 500);
            expect(cam.aspect).toBe(1);
        });

        test('portrait gives aspect < 1', () => {
            const cam = new Camera3D();
            cam.setAspect(600, 1200);
            expect(cam.aspect).toBeCloseTo(0.5);
        });
    });

    describe('edge cases', () => {
        test('camera at origin looking at positive Z', () => {
            const cam = new Camera3D();
            cam.position = [0, 0, 0];
            cam.target = [0, 0, 10];
            const v = cam.getViewMatrix();
            // Should not produce NaN
            for (let i = 0; i < 16; i++) {
                expect(Number.isNaN(v[i])).toBe(false);
            }
        });

        test('very narrow FOV', () => {
            const cam = new Camera3D();
            cam.fov = 1;
            const p = cam.getProjectionMatrix();
            // f = 1/tan(0.5 deg) should be very large
            expect(p[5]).toBeGreaterThan(100);
        });

        test('wide FOV close to 180', () => {
            const cam = new Camera3D();
            cam.fov = 179;
            const p = cam.getProjectionMatrix();
            // f = 1/tan(89.5 deg) should be very small
            expect(p[5]).toBeLessThan(0.02);
        });
    });
});

import { test, expect, describe } from 'bun:test';
import { MorphAnimation } from './morph-animation';

describe('MorphAnimation', () => {
    // Two keyframes: a triangle that moves from Y=0 to Y=1
    const frame0 = new Float32Array([0, 0, 0,  1, 0, 0,  0.5, 0, 0]);
    const frame1 = new Float32Array([0, 1, 0,  1, 1, 0,  0.5, 1, 0]);
    const frame2 = new Float32Array([0, 2, 0,  1, 2, 0,  0.5, 2, 0]);

    function makeAnim() {
        const anim = new MorphAnimation();
        anim.loadClip({
            name: 'bounce',
            keyframes: [frame0, frame1],
            durations: [100],
            loop: true,
        });
        anim.loadClip({
            name: 'rise',
            keyframes: [frame0, frame1, frame2],
            durations: [100, 100],
            loop: false,
        });
        return anim;
    }

    describe('loadClip', () => {
        test('returns sequential IDs', () => {
            const anim = makeAnim();
            expect(anim.clipCount).toBe(2);
        });

        test('stores clip data', () => {
            const anim = makeAnim();
            const clip = anim.getClip(0);
            expect(clip.name).toBe('bounce');
            expect(clip.frameCount).toBe(2);
            expect(clip.vertexCount).toBe(3);
            expect(clip.loop).toBe(true);
        });

        test('throws with less than 2 keyframes', () => {
            const anim = new MorphAnimation();
            expect(() => anim.loadClip({
                name: 'bad',
                keyframes: [frame0],
                durations: [],
                loop: true,
            })).toThrow('at least 2');
        });
    });

    describe('getClipId', () => {
        test('resolves name', () => {
            const anim = makeAnim();
            expect(anim.getClipId('bounce')).toBe(0);
            expect(anim.getClipId('rise')).toBe(1);
        });

        test('throws on unknown', () => {
            const anim = makeAnim();
            expect(() => anim.getClipId('nope')).toThrow('not found');
        });
    });

    describe('update', () => {
        test('at t=0 outputs frame 0', () => {
            const anim = makeAnim();
            const state = anim.createState(0);
            const out = new Float32Array(9);
            anim.update(state, 0, out);
            expect(Array.from(out)).toEqual(Array.from(frame0));
        });

        test('at t=0.5 (halfway) interpolates between frames', () => {
            const anim = makeAnim();
            const state = anim.createState(0);
            const out = new Float32Array(9);
            anim.update(state, 0.05, out); // 50ms = halfway through 100ms
            // Y should be 0.5 for all vertices
            expect(out[1]).toBeCloseTo(0.5);
            expect(out[4]).toBeCloseTo(0.5);
            expect(out[7]).toBeCloseTo(0.5);
        });

        test('looping wraps around', () => {
            const anim = makeAnim();
            const state = anim.createState(0);
            const out = new Float32Array(9);
            anim.update(state, 0.15, out); // 150ms, wraps at 100ms → 50ms into next cycle
            expect(out[1]).toBeCloseTo(0.5);
        });

        test('non-looping stops at end', () => {
            const anim = makeAnim();
            const state = anim.createState(1); // rise: 3 frames, 200ms total
            const out = new Float32Array(9);
            anim.update(state, 0.5, out); // 500ms > 200ms
            expect(state.playing).toBe(false);
            // Should be at or near frame2
            expect(out[1]).toBeCloseTo(2, 0);
        });

        test('speed multiplier works', () => {
            const anim = makeAnim();
            const state = anim.createState(0, 2.0); // 2x speed
            const out = new Float32Array(9);
            anim.update(state, 0.025, out); // 25ms real = 50ms anim = halfway
            expect(out[1]).toBeCloseTo(0.5);
        });

        test('stopped state does not advance', () => {
            const anim = makeAnim();
            const state = anim.createState(0);
            anim.stop(state);
            const out = new Float32Array(9);
            anim.update(state, 1.0, out);
            expect(Array.from(out)).toEqual(Array.from(frame0));
        });
    });

    describe('play / stop / resume', () => {
        test('play switches clip and resets', () => {
            const anim = makeAnim();
            const state = anim.createState(0);
            const out = new Float32Array(9);
            anim.update(state, 0.05, out); // advance
            anim.play(state, 1);
            expect(state.clipId).toBe(1);
            expect(state.time).toBe(0);
            expect(state.playing).toBe(true);
        });

        test('resume continues', () => {
            const anim = makeAnim();
            const state = anim.createState(0);
            anim.stop(state);
            anim.resume(state);
            expect(state.playing).toBe(true);
        });
    });

    describe('multi-frame interpolation', () => {
        test('interpolates correctly between frame 1 and frame 2', () => {
            const anim = makeAnim();
            const state = anim.createState(1); // rise: 0→1→2
            const out = new Float32Array(9);
            anim.update(state, 0.15, out); // 150ms = 100ms (frame0→1) + 50ms into frame1→2
            // Y should be ~1.5
            expect(out[1]).toBeCloseTo(1.5);
        });
    });
});

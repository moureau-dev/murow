import { test, expect, describe } from 'bun:test';
import { AnimationController } from './animation';

describe('AnimationController', () => {
    function makeController() {
        const ctrl = new AnimationController();
        ctrl.loadClip({
            name: 'idle',
            frames: [0, 1, 2, 3],
            durations: [100, 100, 100, 100], // ms per frame
            loop: true,
        });
        ctrl.loadClip({
            name: 'attack',
            frames: [4, 5, 6],
            durations: [80, 120, 80],
            loop: false,
        });
        return ctrl;
    }

    describe('loadClip', () => {
        test('returns sequential IDs', () => {
            const ctrl = new AnimationController();
            expect(ctrl.loadClip({ name: 'a', frames: [0], durations: [100], loop: true })).toBe(0);
            expect(ctrl.loadClip({ name: 'b', frames: [1], durations: [100], loop: true })).toBe(1);
        });

        test('stores clip data correctly', () => {
            const ctrl = makeController();
            const clip = ctrl.getClip(0);
            expect(clip.name).toBe('idle');
            expect(clip.frameCount).toBe(4);
            expect(clip.totalDuration).toBe(400);
            expect(clip.loop).toBe(true);
            expect(Array.from(clip.frames)).toEqual([0, 1, 2, 3]);
        });

        test('clipCount reflects loaded clips', () => {
            const ctrl = makeController();
            expect(ctrl.clipCount).toBe(2);
        });
    });

    describe('getClipId', () => {
        test('resolves name to id', () => {
            const ctrl = makeController();
            expect(ctrl.getClipId('idle')).toBe(0);
            expect(ctrl.getClipId('attack')).toBe(1);
        });

        test('throws on unknown name', () => {
            const ctrl = makeController();
            expect(() => ctrl.getClipId('nope')).toThrow('not found');
        });
    });

    describe('createState', () => {
        test('starts at frame 0, time 0, playing', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            expect(state.clipId).toBe(0);
            expect(state.frame).toBe(0);
            expect(state.time).toBe(0);
            expect(state.speed).toBe(1);
            expect(state.playing).toBe(true);
        });

        test('accepts custom speed and playing', () => {
            const ctrl = makeController();
            const state = ctrl.createState(1, 2.0, false);
            expect(state.speed).toBe(2.0);
            expect(state.playing).toBe(false);
        });
    });

    describe('update', () => {
        test('returns first frame sprite ID at time 0', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            const frame = ctrl.update(state, 0);
            expect(frame).toBe(0); // idle frame 0
        });

        test('advances to next frame after duration', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            // 100ms = exactly one frame duration
            const frame = ctrl.update(state, 0.1);
            expect(frame).toBe(1); // idle frame 1
        });

        test('advances multiple frames in one update', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            // 250ms = 2.5 frames
            const frame = ctrl.update(state, 0.25);
            expect(frame).toBe(2); // idle frame 2
        });

        test('looping clip wraps around', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            // 450ms = past all 4 frames (400ms total), wraps to frame 0 + 50ms into it
            const frame = ctrl.update(state, 0.45);
            expect(frame).toBe(0); // wrapped back to frame 0, 50ms into it (< 100ms duration)
        });

        test('non-looping clip stops at last frame', () => {
            const ctrl = makeController();
            const state = ctrl.createState(1); // attack: 80+120+80 = 280ms
            const frame = ctrl.update(state, 0.5); // 500ms > 280ms
            expect(frame).toBe(6); // last frame
            expect(state.playing).toBe(false);
        });

        test('stopped animation returns current frame', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            ctrl.update(state, 0.15); // advance to frame 1
            ctrl.stop(state);
            const frame = ctrl.update(state, 1.0); // big deltaTime, but stopped
            expect(state.frame).toBe(1); // didn't advance
            expect(frame).toBe(1);
        });

        test('speed multiplier affects playback', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0, 2.0); // 2x speed
            // At 2x speed, 50ms real time = 100ms animation time = 1 frame
            const frame = ctrl.update(state, 0.05);
            expect(frame).toBe(1);
        });

        test('speed 0 freezes animation', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0, 0);
            ctrl.update(state, 1.0);
            expect(state.frame).toBe(0);
        });
    });

    describe('play', () => {
        test('switches to a different clip', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            ctrl.update(state, 0.15); // advance idle
            ctrl.play(state, 1); // switch to attack
            expect(state.clipId).toBe(1);
            expect(state.frame).toBe(0);
            expect(state.time).toBe(0);
            expect(state.playing).toBe(true);
        });

        test('play resets a stopped animation', () => {
            const ctrl = makeController();
            const state = ctrl.createState(1);
            ctrl.update(state, 0.5); // finish attack
            expect(state.playing).toBe(false);
            ctrl.play(state, 1); // replay
            expect(state.playing).toBe(true);
            expect(state.frame).toBe(0);
        });

        test('play with custom speed', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            ctrl.play(state, 0, 0.5);
            expect(state.speed).toBe(0.5);
        });
    });

    describe('stop / resume', () => {
        test('stop pauses playback', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            ctrl.stop(state);
            expect(state.playing).toBe(false);
        });

        test('resume continues playback', () => {
            const ctrl = makeController();
            const state = ctrl.createState(0);
            ctrl.stop(state);
            ctrl.resume(state);
            expect(state.playing).toBe(true);
        });
    });

    describe('variable frame durations', () => {
        test('respects per-frame durations', () => {
            const ctrl = new AnimationController();
            ctrl.loadClip({
                name: 'mixed',
                frames: [10, 20, 30],
                durations: [50, 200, 50], // short, long, short
                loop: false,
            });
            const state = ctrl.createState(0);

            // 50ms → past frame 0 (50ms), into frame 1
            let frame = ctrl.update(state, 0.05);
            expect(frame).toBe(20);

            // Another 100ms → still in frame 1 (200ms total)
            frame = ctrl.update(state, 0.1);
            expect(frame).toBe(20);

            // Another 100ms → past frame 1 (200ms), into frame 2
            frame = ctrl.update(state, 0.1);
            expect(frame).toBe(30);
        });
    });
});

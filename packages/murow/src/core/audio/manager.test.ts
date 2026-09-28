import { describe, test, expect } from 'bun:test';
import { AudioManager, type ClipIdsOf } from './manager';
import { AudioBucket } from './bucket';
import { NullAudioOutput, type NullSource } from './sources/null';
import type { AudioCategory, AudioClip, AudioClipSource } from './types';

function makeClip(id: string, category: AudioCategory = 'sfx'): AudioClip {
    return {
        type: 'audio',
        id,
        src: `/${id}.ogg`,
        buffer: { id },
        duration: 1,
        category,
        metadata: {},
    };
}

function clipSource(...clips: AudioClip[]): AudioClipSource {
    const map = new Map(clips.map((c) => [c.id, c]));
    return {
        get(id: string): AudioClip {
            const c = map.get(id);
            if (!c) throw new Error(`unknown clip '${id}'`);
            return c;
        },
    };
}

function setup(...clips: AudioClip[]) {
    const out = new NullAudioOutput();
    const audio = new AudioManager({ output: out, clips: clipSource(...clips) });
    return { out, audio };
}

function sources(out: NullAudioOutput): NullSource[] {
    return out.sourceIds().map((id) => out.source(id)!);
}

function firstSource(out: NullAudioOutput): NullSource {
    return out.source(out.sourceIds()[0])!;
}

describe('AudioManager', () => {
    describe('playback', () => {
        test('play spawns a positioned source and returns a handle', () => {
            const { out, audio } = setup(makeClip('waterfall'));
            const h = audio.play({
                clip: 'waterfall',
                position: [40, 0, 12],
                loop: true,
                distance: { max: 40 },
            });

            expect(audio.activeCount).toBe(1);
            expect(out.sourceCount).toBe(1);
            const s = firstSource(out);
            expect(s.spec.x).toBe(40);
            expect(s.spec.z).toBe(12);
            expect(s.spec.loop).toBe(true);
            expect(h.clipId).toBe('waterfall');
            expect(h.playing).toBe(true);
        });

        test('position accepts a 2-tuple and defaults z to 0', () => {
            const { out, audio } = setup(makeClip('a'));
            audio.play({ clip: 'a', position: [3, 4] });
            expect(firstSource(out).spec.z).toBe(0);
        });

        test('clip accepts a resolved AudioClip (no registry)', () => {
            const out = new NullAudioOutput();
            const audio = new AudioManager({ output: out, dimension: '2d' });
            audio.play({ clip: makeClip('hit', 'sfx'), position: [1, 2] });
            expect(out.sourceCount).toBe(1);
        });

        test('stop() releases the source and invalidates the handle', () => {
            const { out, audio } = setup(makeClip('hit'));
            const h = audio.play({ clip: 'hit', position: [0, 0], loop: true });
            h.stop();

            expect(audio.activeCount).toBe(0);
            expect(out.sourceCount).toBe(0);

            // Stale handle must be inert, not throw.
            h.setPosition(9, 9);
            h.setVolume(0.1);
            h.fade({ to: 0, seconds: 1 });
            expect(out.sourceCount).toBe(0);
        });

        test('a stale handle does not affect a source that reuses its slot', () => {
            const { out, audio } = setup(makeClip('a'));
            const h1 = audio.play({ clip: 'a', position: [0, 0], loop: true });
            h1.stop();
            const h2 = audio.play({ clip: 'a', position: [1, 1], loop: true });

            h1.setPosition(99, 99);
            h1.setVolume(0.01);

            const s = firstSource(out);
            expect(s.spec.x).toBe(1);
            expect(s.volume).toBe(1);
            expect(h2.playing).toBe(true);
        });

        test('setPosition mutates the output spec in place (no per-tick allocation)', () => {
            const { out, audio } = setup(makeClip('a'));
            const h = audio.play({ clip: 'a', position: [0, 0], loop: true });
            const before = out.source(out.sourceIds()[0])!.spec;

            h.setPosition(5, 6, 7);

            const after = out.source(out.sourceIds()[0])!.spec;
            expect(after).toBe(before);   // same object, mutated — nothing allocated
            expect(after.x).toBe(5);
            expect(after.y).toBe(6);
            expect(after.z).toBe(7);
        });

        test('setDistance / setDirection mutate the output spec in place', () => {
            const { out, audio } = setup(makeClip('a'));
            const h = audio.play({ clip: 'a', position: [0, 0], loop: true, distance: { reference: 1, rolloff: 1, max: 10 } });
            const spec = out.source(out.sourceIds()[0])!.spec;

            h.setDistance({ max: 50 });
            expect(spec.maxDistance).toBe(50);   // applied in place
            expect(spec.refDistance).toBe(1);    // untouched

            h.setDirection(1, 0, 0);
            expect(spec.dirX).toBe(1);
        });

        test('source volume is clamped non-negative', () => {
            const { audio } = setup(makeClip('a'));
            const h = audio.play({ clip: 'a', position: [0, 0], loop: true });
            h.setVolume(-1);
            expect(h.volume).toBe(0);
        });

        test('playOnce auto-frees when the clip ends', () => {
            const { out, audio } = setup(makeClip('sword'));
            audio.playOnce({ clip: 'sword', position: [0, 0] });
            expect(audio.activeCount).toBe(1);

            out.endSource(out.sourceIds()[0]!);
            expect(audio.activeCount).toBe(0);
        });

        test('play without loop marks playing=false on end but keeps the handle', () => {
            const { out, audio } = setup(makeClip('sfx'));
            const h = audio.play({ clip: 'sfx', position: [0, 0] });
            out.endSource(out.sourceIds()[0]!);

            expect(audio.activeCount).toBe(1);
            expect(h.playing).toBe(false);
        });

        test('throws when the clip id is unknown', () => {
            const { audio } = setup(makeClip('a'));
            expect(() => audio.play({ clip: 'missing', position: [0, 0] })).toThrow(/unknown clip/);
        });
    });

    describe('categories', () => {
        test('resolves bus from source, then clip, then default', () => {
            const { out, audio } = setup(makeClip('theme', 'music'), makeClip('hit', 'sfx'));
            audio.play({ clip: 'theme', position: [0, 0] });                  // clip -> music
            audio.play({ clip: 'hit', position: [0, 0], category: 'voice' }); // source -> voice
            audio.play({ clip: 'hit', position: [0, 0] });                    // clip -> sfx

            const cats = sources(out).map((s) => s.spec.category);
            expect(cats).toEqual(['music', 'voice', 'sfx']);
        });

        test('setVolume records and forwards to the output', () => {
            const { out, audio } = setup(makeClip('theme', 'music'));
            audio.setVolume({ category: 'music', volume: 0.25, seconds: 0.5 });
            expect(audio.getVolume('music')).toBe(0.25);
            expect(out.categoryVolumes.music).toBe(0.25);
        });

        test('volume is a non-negative multiplier (no upper clamp, negatives flip to 0)', () => {
            const { audio } = setup(makeClip('theme', 'music'));
            audio.setVolume({ category: 'music', volume: 1.5, seconds: 0 });
            expect(audio.getVolume('music')).toBe(1.5);   // may amplify
            audio.setVolume({ category: 'music', volume: -2, seconds: 0 });
            expect(audio.getVolume('music')).toBe(0);     // no phase inversion
        });

        test('setVolume(number) sets master', () => {
            const { out, audio } = setup(makeClip('a'));
            audio.setVolume(0.4);
            expect(audio.getVolume('master')).toBe(0.4);
            expect(audio.getVolume()).toBe(0.4);
            expect(out.categoryVolumes.master).toBe(0.4);
        });

        test('setVolume defaults the category to master', () => {
            const { audio } = setup(makeClip('a'));
            audio.setVolume({ volume: 0.3 });
            expect(audio.getVolume('master')).toBe(0.3);
        });

        test('a manager-level maxDistance default applies to sources that omit it', () => {
            const out = new NullAudioOutput({ dimension: '2d' });
            const audio = new AudioManager({ output: out, dimension: '2d', distance: { max: 25 }, clips: clipSource(makeClip('a')) });
            audio.play({ clip: 'a', position: [0, 0] });
            expect(firstSource(out).spec.maxDistance).toBe(25);
            audio.play({ clip: 'a', position: [0, 0], distance: { max: 5 } });
            expect(sources(out)[1]!.spec.maxDistance).toBe(5);
        });

        test('clip playback defaults apply, and play options override them', () => {
            const out = new NullAudioOutput({ dimension: '2d' });
            const clip: AudioClip = { ...makeClip('waterfall'), volume: 0.5, distance: { max: 30, reference: 4, rolloff: 2 } };
            const audio = new AudioManager({ output: out, dimension: '2d', distance: { max: 100 }, clips: clipSource(clip) });

            audio.play({ clip: 'waterfall', position: [0, 0] });
            const fromClip = firstSource(out).spec;
            expect(fromClip.volume).toBe(0.5);      // clip beats the 1 default
            expect(fromClip.maxDistance).toBe(30);  // clip beats the manager default
            expect(fromClip.refDistance).toBe(4);
            expect(fromClip.rolloffFactor).toBe(2);

            audio.play({ clip: 'waterfall', position: [0, 0], volume: 1, distance: { max: 5 } });
            const fromPlay = sources(out)[1]!.spec;
            expect(fromPlay.volume).toBe(1);        // play beats the clip
            expect(fromPlay.maxDistance).toBe(5);   // play beats the clip
        });
    });

    describe('fades', () => {
        test('fade() sets the target volume on the output', () => {
            const { out, audio } = setup(makeClip('theme', 'music'));
            const h = audio.play({ clip: 'theme', position: [0, 0] });
            h.fade({ to: 0, seconds: 2 });
            expect(h.volume).toBe(0);
            expect(firstSource(out).volume).toBe(0);
        });

        test('stopAfter frees the source immediately for a zero-length fade-out', () => {
            const { out, audio } = setup(makeClip('theme', 'music'));
            const h = audio.play({ clip: 'theme', position: [0, 0] });
            h.fade({ to: 0, seconds: 0, stopAfter: true });
            expect(audio.activeCount).toBe(0);
            expect(out.sourceCount).toBe(0);
        });

        test('stopAfter with a duration frees once update() advances past it', () => {
            const { out, audio } = setup(makeClip('theme', 'music'));
            const h = audio.play({ clip: 'theme', position: [0, 0], loop: true });
            h.fade({ to: 0, seconds: 0.5, stopAfter: true });

            expect(audio.activeCount).toBe(1);
            audio.update(0.25);
            expect(audio.activeCount).toBe(1);
            audio.update(0.3);
            expect(audio.activeCount).toBe(0);
            expect(out.sourceCount).toBe(0);
        });
    });

    describe('steering', () => {
        test('setListener forwards to the output', () => {
            const { out, audio } = setup(makeClip('a'));
            audio.setListener({ x: 5, y: 0, z: 0, forwardX: 0, forwardY: 0, forwardZ: -1 });
            expect(out.listener?.x).toBe(5);
        });

        test('scalar listener setters update the output without reallocating', () => {
            const { out, audio } = setup(makeClip('a'));
            audio.setListenerPosition(0, 0);
            const ref = out.listener;

            audio.setListenerPosition(5, 6, 7);
            audio.setListenerOrientation(0, -1, 0);

            expect(out.listener).toBe(ref);          // same object — no per-tick allocation
            expect(out.listener?.x).toBe(5);
            expect(out.listener?.y).toBe(6);
            expect(out.listener?.z).toBe(7);
            expect(out.listener?.forwardY).toBe(-1);
        });

        test('2D update culls sources past maxDistance', () => {
            const out = new NullAudioOutput({ dimension: '2d' });
            const audio = new AudioManager({ output: out, dimension: '2d', clips: clipSource(makeClip('ambient')) });
            audio.setListener({ x: 0, y: 0 });
            audio.play({ clip: 'ambient', position: [100, 0], distance: { max: 40 }, loop: true });

            audio.update(1 / 20);
            expect(firstSource(out).paused).toBe(true);

            audio.setListener({ x: 95, y: 0 });
            audio.update(1 / 20);
            expect(firstSource(out).paused).toBe(false);
        });

        test('a manual pause is not clobbered by culling', () => {
            const out = new NullAudioOutput({ dimension: '2d' });
            const audio = new AudioManager({ output: out, dimension: '2d', clips: clipSource(makeClip('a')) });
            audio.setListener({ x: 0, y: 0 });
            const h = audio.play({ clip: 'a', position: [0, 0], loop: true, distance: { max: 10 } });

            h.setPaused(true);
            expect(firstSource(out).paused).toBe(true);

            audio.update(1 / 20);
            expect(firstSource(out).paused).toBe(true);

            audio.setListener({ x: 1000, y: 0 });     // far -> cull
            audio.update(1 / 20);
            expect(firstSource(out).paused).toBe(true);

            h.setPaused(false);                       // manual unpause, still culled
            expect(firstSource(out).paused).toBe(true);

            audio.setListener({ x: 0, y: 0 });        // near again -> cull clears
            audio.update(1 / 20);
            expect(firstSource(out).paused).toBe(false);
        });

        test('steals the farthest non-music source when the budget is full', () => {
            const out = new NullAudioOutput({ dimension: '2d' });
            const audio = new AudioManager({
                output: out,
                dimension: '2d',
                maxSources: 2,
                clips: clipSource(makeClip('sfx'), makeClip('music', 'music')),
            });
            audio.setListener({ x: 0, y: 0 });
            audio.play({ clip: 'music', position: [0, 0], loop: true }); // protected
            audio.play({ clip: 'sfx', position: [5, 0] });              // near
            audio.play({ clip: 'sfx', position: [90, 0] });             // forces a steal

            expect(audio.activeCount).toBe(2);
            const cats = sources(out).map((s) => s.spec.category);
            expect(cats).toContain('music');
        });

        test('throws when the budget is full and every source is protected (music)', () => {
            const out = new NullAudioOutput();
            const audio = new AudioManager({
                output: out,
                maxSources: 1,
                clips: clipSource(makeClip('theme', 'music')),
            });
            audio.play({ clip: 'theme', position: [0, 0], loop: true });
            expect(() => audio.play({ clip: 'theme', position: [0, 0], loop: true })).toThrow(/maxSources/);
        });
    });

    describe('lifecycle', () => {
        test('destroy stops every source, is idempotent, and blocks further playback', () => {
            const { out, audio } = setup(makeClip('a'));
            audio.play({ clip: 'a', position: [0, 0], loop: true });
            audio.play({ clip: 'a', position: [1, 1], loop: true });

            audio.destroy();
            audio.destroy();                     // idempotent

            expect(audio.activeCount).toBe(0);
            expect(out.sourceCount).toBe(0);
            expect(out.destroyed).toBe(true);
            expect(() => audio.play({ clip: 'a', position: [0, 0], loop: true })).toThrow(/destroyed/);

            // Mutators no-op rather than touch a closed context.
            audio.update(1 / 20);
            audio.setListenerPosition(1, 1);
            audio.setVolume(0.5);
        });
    });

    describe('events', () => {
        test('distinguishes ended / stopped / evicted', () => {
            const { out, audio } = setup(makeClip('a'));
            let ended = 0, stopped = 0;
            audio.events.on('source-ended', () => ended++);
            audio.events.on('source-stopped', () => stopped++);

            audio.playOnce({ clip: 'a', position: [0, 0] });
            out.endSource(out.sourceIds()[0]!);
            expect(ended).toBe(1);

            const h = audio.play({ clip: 'a', position: [0, 0], loop: true });
            h.stop();
            expect(stopped).toBe(1);

            const small = new NullAudioOutput();
            const steal = new AudioManager({ output: small, maxSources: 1, clips: clipSource(makeClip('a')) });
            let evicted = 0;
            steal.events.on('source-evicted', () => evicted++);
            steal.play({ clip: 'a', position: [0, 0], loop: true });
            steal.play({ clip: 'a', position: [0, 0], loop: true });   // steals the first
            expect(evicted).toBe(1);
        });
    });
});

// ——— compile-time: clip ids are inferred from the bucket, not widened to string ———

{
    const bucket = new AudioBucket({ decode: async () => ({ buffer: {}, duration: 0 }) })
        .add({ type: 'audio', id: 'theme', src: '/theme.ogg' })
        .add({ type: 'audio', id: 'hit', src: '/hit.ogg' });

    type BucketIds = ClipIdsOf<typeof bucket>;
    type BucketIsLiteral = string extends BucketIds ? false : true;
    const _bucketIds: BucketIsLiteral = true;

    const audio = new AudioManager({ clips: bucket });
    type ManagerClips = typeof audio extends AudioManager<infer C> ? C : never;
    type ManagerIds = ClipIdsOf<ManagerClips>;
    type ManagerIsLiteral = string extends ManagerIds ? false : true;
    const _managerIds: ManagerIsLiteral = true;

    // Known ids autocomplete; an unknown id still compiles (StringOr allows any string).
    // Declared, never called — this is a compile-time check only.
    const _typecheck = (a: typeof audio) => {
        a.play({ clip: 'theme', position: [0, 0], loop: true });
        a.playOnce({ clip: 'typo', position: [0, 0] });
    };
    void _typecheck;
    void [_bucketIds, _managerIds];
}

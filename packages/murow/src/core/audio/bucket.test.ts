import { describe, test, expect } from 'bun:test';
import { AudioBucket } from './bucket';
import type { AudioDecoder } from './types';

const decode: AudioDecoder = async (data) => ({
    buffer: { bytes: data.byteLength },
    duration: 2.5,
});

const okFetch = (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })) as unknown as typeof fetch;

describe('AudioBucket', () => {
    test('loads, decodes, and narrows by id', async () => {
        const clips = new AudioBucket({ decode, fetch: okFetch })
            .add({ type: 'audio', id: 'theme', src: '/theme.ogg', category: 'music' })
            .add({ type: 'audio', id: 'hit', src: '/hit.ogg' });

        await clips.load();

        expect(clips.get('theme').duration).toBe(2.5);
        expect(clips.get('theme').category).toBe('music');
        expect(clips.get('theme').buffer).toEqual({ bytes: 4 });
        // Falls back to the bucket default category.
        expect(clips.get('hit').category).toBe('sfx');
    });

    test('rejects when fetching the source fails', async () => {
        const failFetch = (async () =>
            new Response('nope', { status: 404 })) as unknown as typeof fetch;
        const clips = new AudioBucket({ decode, fetch: failFetch })
            .add({ type: 'audio', id: 'x', src: '/x.ogg' });

        await expect(clips.load()).rejects.toThrow(/failed to fetch '\/x.ogg'/);
    });

    test('propagates decode errors', async () => {
        const badDecode: AudioDecoder = () => { throw new Error('bad codec'); };
        const clips = new AudioBucket({ decode: badDecode, fetch: okFetch })
            .add({ type: 'audio', id: 'x', src: '/x.ogg' });

        await expect(clips.load()).rejects.toThrow(/bad codec/);
    });

    test('one bad source rejects the whole load (all-or-nothing)', async () => {
        const selectiveFetch = (async (url: RequestInfo | URL) =>
            String(url).includes('bad')
                ? new Response('nope', { status: 404 })
                : new Response(new Uint8Array([1]), { status: 200 })) as unknown as typeof fetch;

        const clips = new AudioBucket({ decode, fetch: selectiveFetch })
            .add({ type: 'audio', id: 'ok', src: '/ok.ogg' })
            .add({ type: 'audio', id: 'bad', src: '/bad.ogg' });

        await expect(clips.load()).rejects.toThrow(/failed to fetch '\/bad.ogg'/);
        expect(clips.loaded).toBe(false);
    });

    test('passes metadata through to the clip', async () => {
        const clips = new AudioBucket({ decode, fetch: okFetch })
            .add({ type: 'audio', id: 'x', src: '/x.ogg', metadata: { loop: true } });

        await clips.load();
        expect(clips.get('x').metadata).toEqual({ loop: true });
    });

    test('carries playback defaults from the spec', async () => {
        const clips = new AudioBucket({ decode, fetch: okFetch })
            .add({
                type: 'audio',
                id: 'waterfall',
                src: '/w.ogg',
                volume: 0.8,
                distance: { reference: 4, rolloff: 1.5, max: 40 },
            });

        await clips.load();
        const clip = clips.get('waterfall');
        expect(clip.volume).toBe(0.8);
        expect(clip.distance).toEqual({ reference: 4, rolloff: 1.5, max: 40 });
    });
});

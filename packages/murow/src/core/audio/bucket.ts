/**
 * AudioBucket — typed registry of audio clips.
 *
 * Builds on the generic `Bucket` (core/bucket). The parser fetches each
 * `AudioSpec.src` and decodes it through the supplied `AudioDecoder` — usually
 * the active `AudioOutput`'s `decode`, so decoding uses the same Web Audio
 * context that will play the clip.
 *
 * Format support is whatever the decoder accepts — Web Audio decodes
 * WAV/MP3/AAC-M4A/Ogg-Vorbis/FLAC, browser-dependent. There is no extension
 * check: a fetch error or an unsupported/corrupt file makes `load()` reject,
 * so loading is all-or-nothing (matching the renderer buckets).
 *
 * ```ts
 * const clips = new AudioBucket({ decode: (data, spec) => output.decode(data, spec) })
 *   .add({ type: 'audio', id: 'theme', src: '/music/theme.ogg', category: 'music' });
 *
 * await clips.load();
 * const clip = clips.get('theme');
 * ```
 *
 * `clip` is the parsed {@link AudioClip}, narrowed by id.
 */

import { Bucket, type BucketParser, type ParserContext } from '../bucket';
import type { AudioCategory, AudioClip, AudioDecoder, AudioSpec } from './types';

export interface AudioBucketOptions {
    /** Decodes fetched bytes. Typically `(d, s) => output.decode(d, s)`. */
    decode: AudioDecoder;
    /** Fetch implementation. Defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Bus applied when a spec omits `category`. Default `'sfx'`. */
    defaultCategory?: AudioCategory;
}

function makeAudioParser(opts: AudioBucketOptions): BucketParser<AudioSpec, AudioClip> {
    const fetchImpl = opts.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    return async (spec: AudioSpec, _ctx: ParserContext): Promise<AudioClip> => {
        const res = await fetchImpl(spec.src);
        if (!res.ok) {
            throw new Error(`AudioBucket: failed to fetch '${spec.src}' (${res.status})`);
        }
        const data = await res.arrayBuffer();
        const decoded = await opts.decode(data, spec);
        return {
            type: 'audio',
            id: spec.id,
            src: spec.src,
            buffer: decoded.buffer,
            duration: decoded.duration,
            category: spec.category ?? opts.defaultCategory ?? 'sfx',
            volume: spec.volume,
            distance: spec.distance,
            metadata: spec.metadata ?? {},
        };
    };
}

/**
 * Bucket specialised for audio. Ids are type-narrowed so
 * `clips.get('typo')` is a compile-time error.
 */
export class AudioBucket<
    Specs extends Record<string, AudioSpec> = {},
> extends Bucket<AudioSpec, AudioClip, Specs> {

    constructor(opts: AudioBucketOptions) {
        super({ audio: makeAudioParser(opts) });
    }

    /** Add a single spec; returns the subclass type so chaining accumulates ids. */
    add<const S extends AudioSpec>(
        spec: S,
    ): AudioBucket<Specs & Record<S['id'], S>> {
        return super.add(spec) as unknown as AudioBucket<Specs & Record<S['id'], S>>;
    }
}

# Audio

Spatial audio runtime. A pure `AudioManager` drives a swappable `AudioOutput`
(`WebAudioOutput` in the browser, `NullAudioOutput` on the server/tests),
mirroring how `InputManager` drives an `InputEventSource`.

Dimensionality follows the simulation, not the renderer: a 2D game rendered in
3D still uses 2D audio. Pick it with `dimension`.

## AudioManager

```ts
import { AudioManager } from 'murow/core/audio';

const audio = new AudioManager({ clips: assets.audio }); // web output by default

const waterfall = audio.play({
    clip: 'waterfall',
    position: [40, 0, 12],
    loop: true,
    distance: { reference: 4, rolloff: 1.5, max: 40 },
});

// per tick: listener follows the camera, moving sources update their position
loop.events.on('tick', () => {
    audio.setListenerPosition(x, y, z);        // zero-allocation
    audio.setListenerOrientation(fx, fy, fz);
    waterfall.setPosition(40, 0, 12);
    audio.update(1 / 20);
});
```

- `play({ clip, position, ... })` → `SourceHandle`. `clip` is a clip id or a
  resolved `AudioClip` (`assets.audio.get(...)`); `position` is `[x, y]` or
  `[x, y, z]`; `direction` is `[x, y, z]` for a 3D cone. `loop: true` keeps it
  playing until `stop()`. Live source: `setPosition`, `setDistance`,
  `setDirection`, `setVolume`, `setPaused`, `fade`, `stop`.
- `playOnce({ clip, position, ... })` → fire-and-forget (auto-free on end).
- `destroy()` — stops everything and tears down the output; idempotent, and the
  manager is unusable afterwards (`play` throws, other mutators no-op).
- `setListenerPosition(x, y, z?)` / `setListenerOrientation(fx, fy, fz?)` —
  the listener pose, **zero-allocation** (cameras drive this each tick).
  `setListener(state)` is a convenience that copies a pose object.
- `update(deltaTime)` — advances distance culling and fade-out completion; call once per tick (or render).
- `setVolume({ category?, volume, seconds? })` — set/fade a bus; `category`
  defaults to `'master'`.
- `setVolume(volume)` — shorthand for the master bus.
- `getVolume(category?)` — current bus volume (defaults to `'master'`).
- `maxSources` (default 64) caps live sources; beyond it the farthest
  non-`music` source is stolen.

`addSource` needs `x`/`y`; `z`/`dir*` are ignored when `dimension: '2d'`.

## Dimensions

`dimension: '3d'` (default) spatializes with a panner (HRTF, distance model,
cone). `dimension: '2d'` pans relative to the listener's facing and attenuates
by distance — so a rotating camera pans correctly (feed the listener's
`forwardX`/`forwardY`).

Nothing spatial is hardcoded:
- `panRange` — 2D only; the distance along the listener's right axis that maps
  to a hard left/right pan (`AudioManagerOptions.panRange`, or
  `WebAudioOutputOptions.panRange`). Set it to half your viewport's world
  width. Default `12`.
- `distance` — per source (`{ reference, rolloff, max }`), or a manager-wide
  default (`AudioManagerOptions.distance`). Defaults `1` / `1` / `Infinity`.

### Distance model

`distance: { reference, rolloff, max }`:

- `reference` — the radius around the source where it plays at **full volume**.
- `rolloff` — how steeply it drops past that radius (`0` = no falloff).
- `max` — the outer bound; beyond it the source is at its quietest / culled.

3D uses Web Audio's `inverse` model: `gain = reference / (reference + rolloff × (d − reference))`, clamped to `reference ≤ d ≤ max`. 2D does the same manually.

```ts
// a nearby footstep
play({ clip: 'step',  position, distance: { reference: 1, rolloff: 2,   max: 8 } });
// distant ambience that carries
play({ clip: 'river', position, distance: { reference: 8, rolloff: 0.5, max: 60 } });
```

## Categories

`'master' | 'music' | 'sfx' | 'ambient' | 'voice' | 'ui'`. A source's bus
resolves as `opts.category ?? clip.category ?? defaultCategory` (`'sfx'`).
`master` is the final output bus.

## Levels

Volumes are **absolute linear multipliers** and they **multiply**:

```
effective = source.volume × category.volume × master.volume   (× distance attenuation)
```

- `play({ volume })` sets the source's own level; `handle.setVolume(v)` changes it.
- `setVolume({ category, volume })` sets one bus — `master` scales everything,
  `music` scales only music. `setVolume(volume)`/`setVolume({ volume })` target
  `master`.
- Everything defaults to `1`. Volumes are **non-negative multipliers**: `1` is
  unity, `> 1` amplifies, `< 0` clamps to `0` (no phase inversion).

## Events

`audio.events` emits `source-started`, `source-ended` (clip finished),
`source-stopped` (`handle.stop()`), and `source-evicted` (budget steal) — each
`{ id, clipId, category? }`.

## Fades

`handle.fade({ to, seconds, stopAfter? })` subsumes fade-in/out/to —
it fades from the current volume and retargets if called again. Fades are
**real-time** (audio clock), not tick-stepped; the output schedules native
`AudioParam` ramps. `stopAfter` frees the source when a fade-out reaches 0.

Live spatial updates (pan, 2D attenuation, panner position) are smoothed on the
audio clock too, so moved sources don't zipper; spawning a source sets its
position directly.

## Outputs

The manager delegates all platform work to an `AudioOutput`:

```ts
interface AudioOutput {
    readonly dimension: AudioDimension;
    resume(): Promise<void>;              // call from a user gesture (autoplay)
    suspend(): Promise<void>;
    decode(data: ArrayBuffer, spec: AudioSpec): Promise<AudioDecoded>;
    createSource(spec: SourceSpec, onEnded: () => void): number;
    updateSource(sourceId: number, spec: SourceSpec): void;
    setSourceVolume(sourceId: number, volume: number, seconds?): void;
    setSourcePaused(sourceId: number, paused: boolean): void;
    stopSource(sourceId: number): void;
    setListener(state: AudioListenerState): void;
    setCategoryVolume(category: AudioCategory, opts: { volume: number; seconds?: number }): void;
    destroy(): void;
}
```

- `WebAudioOutput` — browser. Uses `AudioContext` + panners. Supply a shared
  `context` if the app already has one.
- `NullAudioOutput` — no-op, records state for assertions/headless.

If no `output` is passed, the manager picks `WebAudioOutput` when Web Audio is
available and `NullAudioOutput` otherwise, so the same construction runs on the
server.

## AudioBucket

Clips load through the generic bucket and surface as `assets.audio`:

```ts
const clips = new AudioBucket({ decode: (data, spec) => output.decode(data, spec) })
    .add({ type: 'audio', id: 'theme', src: '/music/theme.ogg', category: 'music' });

await clips.load();
clips.get('theme'); // AudioClip
```

The parser only fetches bytes; decoding is the output's job, so loading needs no
audio device. Pass `assets.audio` to the manager via `clips`.

A spec can carry **playback defaults** — `category`, `volume`,
`distance: { reference, rolloff, max }` — so a clip's spatial character lives
with the asset. `play` options override them; anything unset falls back to the
manager default (`distance`) or `1`:

```ts
assets.audio.add({ type: 'audio', id: 'waterfall', src: '/w.ogg', distance: { reference: 4, rolloff: 1.5, max: 40 } });
// play({ clip: 'waterfall', position }) picks those up; pass distance to override
```

## Formats & failure

There is **no extension check**. `WebAudioOutput.decode` calls
`AudioContext.decodeAudioData`, so supported formats are whatever the browser
decodes — typically WAV, MP3, AAC/M4A, Ogg Vorbis, and FLAC (Safari does not
decode Ogg/Opus; Chrome and Firefox do). Encode accordingly, and offer a
fallback format if you target Safari.

Loading is **all-or-nothing** (the generic `Bucket` uses `Promise.all`): a
fetch error or an unsupported/corrupt file rejects the whole `load()`. If a
clip must be optional, load it in a second `AudioBucket` and catch — don't mix
required and optional clips in one `load()`.

## See also

- [Bucket](../../bucket) — the generic registry `AudioBucket` builds on
- [Input](../input) — the same manager + adapter split

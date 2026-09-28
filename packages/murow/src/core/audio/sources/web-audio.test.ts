import { describe, test, expect } from 'bun:test';
import { WebAudioOutput } from './web-audio';
import type { AudioSpec, SourceSpec } from '../types';

// ——— Minimal fake Web Audio ————————————————————————————————————————————

interface ParamCall { m: 'set' | 'ramp' | 'cancel'; v: number; t?: number }

class FakeParam {
    value: number;
    readonly calls: ParamCall[] = [];
    constructor(value = 0) { this.value = value; }
    cancelScheduledValues(t: number): void { this.calls.push({ m: 'cancel', v: t }); }
    setValueAtTime(v: number, t: number): void { this.calls.push({ m: 'set', v, t }); this.value = v; }
    linearRampToValueAtTime(v: number, t: number): void { this.calls.push({ m: 'ramp', v, t }); this.value = v; }
    setTargetAtTime(v: number, t: number, _tc: number): void { this.calls.push({ m: 'ramp', v, t }); this.value = v; }
}

class FakeNode {
    readonly connections: FakeNode[] = [];
    disconnected = false;
    connect(n: FakeNode): FakeNode { this.connections.push(n); return n; }
    disconnect(): void { this.disconnected = true; }
}

class FakeGain extends FakeNode { readonly gain = new FakeParam(1); }

class FakeSource extends FakeNode {
    buffer: unknown = null;
    loop = false;
    onended: (() => void) | null = null;
    started = false;
    stopped = false;
    start(): void { this.started = true; }
    stop(): void { this.stopped = true; }
}

class FakeStereo extends FakeNode { readonly pan = new FakeParam(0); }

class FakePanner extends FakeNode {
    panningModel = '';
    distanceModel = '';
    refDistance = 0;
    rolloffFactor = 0;
    maxDistance = 0;
    coneInnerAngle = 0;
    coneOuterAngle = 0;
    readonly positionX = new FakeParam();
    readonly positionY = new FakeParam();
    readonly positionZ = new FakeParam();
    readonly orientationX = new FakeParam();
    readonly orientationY = new FakeParam();
    readonly orientationZ = new FakeParam();
    readonly positions: number[][] = [];
    setPosition(x: number, y: number, z: number): void { this.positions.push([x, y, z]); }
}

class FakeListener {
    readonly positionX = new FakeParam();
    readonly positionY = new FakeParam();
    readonly positionZ = new FakeParam();
    readonly forwardX = new FakeParam();
    readonly forwardY = new FakeParam();
    readonly forwardZ = new FakeParam();
    readonly upX = new FakeParam();
    readonly upY = new FakeParam();
    readonly upZ = new FakeParam();
    setPosition(): void { /* legacy path, unused by these tests */ }
    setOrientation(): void { /* legacy path, unused by these tests */ }
}

class FakeContext {
    currentTime = 0;
    state: AudioContextState = 'running';
    readonly destination = new FakeNode();
    readonly listener = new FakeListener();
    readonly gains: FakeGain[] = [];
    readonly sources: FakeSource[] = [];
    readonly stereos: FakeStereo[] = [];
    readonly panners: FakePanner[] = [];
    closed = false;
    createGain(): FakeGain { const g = new FakeGain(); this.gains.push(g); return g; }
    createBufferSource(): FakeSource { const s = new FakeSource(); this.sources.push(s); return s; }
    createStereoPanner(): FakeStereo { const s = new FakeStereo(); this.stereos.push(s); return s; }
    createPanner(): FakePanner { const p = new FakePanner(); this.panners.push(p); return p; }
    decodeAudioData(_buf: ArrayBuffer): Promise<{ duration: number }> {
        return Promise.resolve({ duration: 3.5 });
    }
    resume(): Promise<void> { this.state = 'running'; return Promise.resolve(); }
    suspend(): Promise<void> { this.state = 'suspended'; return Promise.resolve(); }
    close(): Promise<void> { this.closed = true; return Promise.resolve(); }
}

const spec = (over: Partial<SourceSpec> = {}): SourceSpec => ({
    buffer: { id: 'buf' },
    loop: false,
    volume: 1,
    category: 'sfx',
    x: 0, y: 0, z: 0,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: Infinity,
    ...over,
});

const audioSpec: AudioSpec = { type: 'audio', id: 'x', src: '/x.ogg' };

function make(dimension: '2d' | '3d' = '3d', capacity = 256, panRange?: number) {
    const ctx = new FakeContext();
    const out = new WebAudioOutput({ context: ctx as unknown as AudioContext, dimension, capacity, panRange });
    return { ctx, out };
}

// ——— Tests ——————————————————————————————————————————————————————————————

describe('WebAudioOutput', () => {
    test('builds the master + one bus per category lazily', () => {
        const { ctx, out } = make();
        // No graph until something needs it.
        expect(ctx.gains.length).toBe(0);
        out.setCategoryVolume('music', { volume: 0.5 });
        // master + 5 other category buses
        expect(ctx.gains.length).toBe(6);
        expect(ctx.gains[0].connections).toContain(ctx.destination as unknown as FakeNode);
    });

    test('createSource wires the graph, starts playback, and returns an id', async () => {
        const { ctx, out } = make('3d');
        const id = out.createSource(spec({ loop: true, category: 'music', volume: 0.5 }), () => {});

        expect(id).toBeGreaterThan(0);
        const src = ctx.sources[0]!;
        expect(src.started).toBe(true);
        expect(src.loop).toBe(true);
        expect(src.buffer).toEqual({ id: 'buf' });
        // volume + distance + mute created on top of the 6 bus gains
        expect(ctx.gains.length).toBe(9);
        // one panner for 3D
        expect(ctx.panners.length).toBe(1);
        expect(ctx.stereos.length).toBe(0);
    });

    test('3D panner is configured with the distance model', async () => {
        const { ctx, out } = make('3d');
        out.createSource(spec({ refDistance: 4, rolloffFactor: 2, maxDistance: 40 }), () => {});
        const p = ctx.panners[0]!;
        expect(p.panningModel).toBe('HRTF');
        expect(p.distanceModel).toBe('inverse');
        expect(p.refDistance).toBe(4);
        expect(p.rolloffFactor).toBe(2);
        expect(p.maxDistance).toBe(40);
    });

    test('2D uses a StereoPanner instead of a Panner', () => {
        const { ctx, out } = make('2d');
        out.createSource(spec({ x: 5 }), () => {});
        expect(ctx.stereos.length).toBe(1);
        expect(ctx.panners.length).toBe(0);
    });

    test('2D pan scales with the configured panRange', () => {
        const { ctx, out } = make('2d', 256, 10);
        out.setListener({ x: 0, y: 0 });
        out.createSource(spec({ x: 5 }), () => {});
        expect(ctx.stereos[0]!.pan.value).toBeCloseTo(0.5, 5);
        out.createSource(spec({ x: -20 }), () => {});
        expect(ctx.stereos[1]!.pan.value).toBe(-1);
    });

    test('2D pan honors listener orientation', () => {
        const { ctx, out } = make('2d', 256, 10);
        // Facing +Y: right axis is +X, so a source to the right pans right.
        out.setListener({ x: 0, y: 0, forwardX: 0, forwardY: 1 });
        out.createSource(spec({ x: 5, y: 0 }), () => {});
        expect(ctx.stereos[0]!.pan.value).toBeCloseTo(0.5, 5);

        // Rotate to face +X: the same source is now dead-centre.
        out.setListener({ x: 0, y: 0, forwardX: 1, forwardY: 0 });
        expect(ctx.stereos[0]!.pan.value).toBeCloseTo(0, 5);

        // A source "above" is now to the left (−X of the listener's right axis).
        out.createSource(spec({ x: 0, y: 5 }), () => {});
        expect(ctx.stereos[1]!.pan.value).toBeCloseTo(-0.5, 5);
    });

    test('2D attenuation matches the inverse distance model', () => {
        const { ctx, out } = make('2d');
        out.setListener({ x: 0, y: 0 });

        // per source the gains are [volume, distance, mute]; attenuation lands on `distance`.
        // 4 / (4 + 1*(8-4)) = 0.5
        out.createSource(spec({ x: 8, refDistance: 4, rolloffFactor: 1, maxDistance: Infinity }), () => {});
        expect(ctx.gains[7]!.gain.value).toBeCloseTo(0.5, 5);

        // inside the reference radius -> no attenuation
        out.createSource(spec({ x: 2, refDistance: 4, rolloffFactor: 1, maxDistance: Infinity }), () => {});
        expect(ctx.gains[10]!.gain.value).toBe(1);

        // beyond maxDistance the distance is clamped, not zero: 4 / (4 + 1*(20-4))
        out.createSource(spec({ x: 100, refDistance: 4, rolloffFactor: 1, maxDistance: 20 }), () => {});
        expect(ctx.gains[13]!.gain.value).toBeCloseTo(0.2, 5);

        // z is ignored in 2D: same attenuation as the z=0 case
        out.createSource(spec({ x: 8, z: 100, refDistance: 4, rolloffFactor: 1, maxDistance: Infinity }), () => {});
        expect(ctx.gains[16]!.gain.value).toBeCloseTo(0.5, 5);
    });

    test('a listener update does not cancel an in-flight fade (2D)', () => {
        const { ctx, out } = make('2d');
        out.setListener({ x: 0, y: 0 });
        const id = out.createSource(spec({ x: 0 }), () => {});
        const volumeNode = ctx.gains[6]!;
        const distanceNode = ctx.gains[7]!;

        out.setSourceVolume(id, 0, 1);                         // start a 1s fade-out
        const afterFade = volumeNode.gain.calls.length;

        out.setListener({ x: 5, y: 0 });                       // per-tick listener update
        expect(volumeNode.gain.calls.length).toBe(afterFade);  // fade node untouched
        expect(distanceNode.gain.value).toBeCloseTo(0.2, 5);   // attenuation on the distance node
    });

    test('setSourcePosition updates pan/attenuation without rebuilding nodes', () => {
        const { ctx, out } = make('2d', 256, 10);
        out.setListener({ x: 0, y: 0 });
        const id = out.createSource(spec({ x: 0 }), () => {});
        const gainsBefore = ctx.gains.length;

        out.setSourcePosition(id, 5, 0, 0);
        expect(ctx.stereos[0]!.pan.value).toBeCloseTo(0.5, 5);
        expect(ctx.gains.length).toBe(gainsBefore);            // no new nodes
    });

    test('setSourceVolume ramps when seconds > 0, sets otherwise', async () => {
        const { ctx, out } = make();
        const id = out.createSource(spec({ volume: 1 }), () => {});
        const volumeNode = ctx.gains[6]!;

        out.setSourceVolume(id, 0.25, 2);
        expect(volumeNode.gain.calls.some((c) => c.m === 'ramp' && c.v === 0.25)).toBe(true);

        volumeNode.gain.calls.length = 0;
        out.setSourceVolume(id, 0.75);
        expect(volumeNode.gain.value).toBe(0.75);
        expect(volumeNode.gain.calls.some((c) => c.m === 'ramp')).toBe(false);
    });

    test('setSourceDistance reconfigures the 3D panner', () => {
        const { ctx, out } = make('3d');
        const id = out.createSource(spec({ refDistance: 1, rolloffFactor: 1, maxDistance: 10 }), () => {});
        const p = ctx.panners[0]!;
        out.setSourceDistance(id, 4, 2, 100);
        expect(p.refDistance).toBe(4);
        expect(p.rolloffFactor).toBe(2);
        expect(p.maxDistance).toBe(100);
    });

    test('setSourceOrientation updates the 3D panner orientation', () => {
        const { ctx, out } = make('3d');
        const id = out.createSource(spec(), () => {});
        out.setSourceOrientation(id, 1, 0, 0);
        expect(ctx.panners[0]!.orientationX.value).toBe(1);
    });

    test('setSourcePaused mutes and unmutes without stopping', async () => {
        const { ctx, out } = make();
        const id = out.createSource(spec(), () => {});
        const mute = ctx.gains[8]!;

        out.setSourcePaused(id, true);
        expect(mute.gain.value).toBe(0);
        out.setSourcePaused(id, false);
        expect(mute.gain.value).toBe(1);
        expect(ctx.sources[0]!.stopped).toBe(false);
    });

    test('setCategoryVolume ramps the matching bus', () => {
        const { ctx, out } = make();
        out.setCategoryVolume('music', { volume: 0.2, seconds: 1 });
        // gains: [master, music, sfx, ambient, ...] in AUDIO_CATEGORIES order
        const music = ctx.gains[1]!;
        expect(music.gain.calls.some((c) => c.m === 'ramp' && c.v === 0.2)).toBe(true);
    });

    test('a 3D listener pose set before the graph exists is applied when it is created', () => {
        const fake = new FakeContext();
        const prev = (globalThis as any).AudioContext;
        (globalThis as any).AudioContext = function () { return fake; };
        try {
            const out = new WebAudioOutput({ dimension: '3d' });   // no context yet
            out.setListener({ x: 1, y: 2, z: 3, forwardX: 0, forwardY: 0, forwardZ: -1 });
            expect(fake.listener.positionX.value).toBe(0);          // deferred

            out.createSource(spec(), () => {});                     // builds the graph

            expect(fake.listener.positionX.value).toBe(1);
            expect(fake.listener.positionY.value).toBe(2);
            expect(fake.listener.positionZ.value).toBe(3);
        } finally {
            if (prev === undefined) delete (globalThis as any).AudioContext;
            else (globalThis as any).AudioContext = prev;
        }
    });

    test('live spatial updates are smoothed; spawn is immediate', () => {
        const { ctx, out } = make('2d');
        out.setListener({ x: 0, y: 0 });
        out.createSource(spec({ x: 0 }), () => {});
        const distanceNode = ctx.gains[7]!;
        expect(distanceNode.gain.calls.length).toBe(0);            // spawn wrote .value directly

        out.setListener({ x: 5, y: 0 });                           // live update
        expect(distanceNode.gain.calls.some((c) => c.m === 'ramp')).toBe(true);
    });

    test('setListener drives the listener pose', async () => {
        const { ctx, out } = make('3d');
        out.setListener({ x: 1, y: 2, z: 3, forwardX: 0, forwardY: 0, forwardZ: -1 });
        expect(ctx.listener.positionX.value).toBe(1);
        expect(ctx.listener.positionY.value).toBe(2);
        expect(ctx.listener.positionZ.value).toBe(3);
        expect(ctx.listener.forwardZ.value).toBe(-1);
    });

    test('stopSource frees the slot for reuse and disconnects nodes', async () => {
        const { ctx, out } = make('3d', 1);
        const id = out.createSource(spec(), () => {});
        expect(() => out.createSource(spec(), () => {})).toThrow(/capacity/);

        out.stopSource(id);
        expect(ctx.sources[0]!.stopped).toBe(true);
        // Capacity freed — a new source is accepted.
        expect(() => out.createSource(spec(), () => {})).not.toThrow();
    });

    test('decode returns the decoded duration', async () => {
        const { out } = make();
        const decoded = await out.decode(new ArrayBuffer(8), audioSpec);
        expect(decoded.duration).toBe(3.5);
        expect(decoded.buffer).toEqual({ duration: 3.5 });
    });

    test('destroy stops every live source', async () => {
        const { ctx, out } = make();
        out.createSource(spec(), () => {});
        out.createSource(spec(), () => {});
        out.destroy();
        expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    });

    test('an ended source invokes the onEnded callback', async () => {
        const { ctx, out } = make();
        let ended = 0;
        out.createSource(spec(), () => { ended++; });
        ctx.sources[0]!.onended?.();
        expect(ended).toBe(1);
    });
});

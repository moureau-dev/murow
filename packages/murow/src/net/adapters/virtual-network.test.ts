import { describe, test, expect } from 'bun:test';
import { VirtualNetwork, VirtualServerTransport, type JitterConfig } from './virtual-network';

function collect(opts: { seed?: number; cfg?: JitterConfig; override?: JitterConfig; count: number }): number[] {
    const vnet = new VirtualNetwork();
    const server = new VirtualServerTransport({ vnet, seed: opts.seed, cfg: opts.cfg });
    const received: number[] = [];
    server.onConnection((peer) => peer.onMessage((d) => received.push(d[0]!)));

    const { client } = server.connectClient();
    if (opts.override) server.setConfig(opts.override);

    for (let i = 0; i < opts.count; i++) client.send(new Uint8Array([i]));
    vnet.advance(1);
    return received;
}

describe('VirtualServerTransport', () => {
    test('pristine default delivers every packet in order', () => {
        expect(collect({ count: 5 })).toEqual([0, 1, 2, 3, 4]);
    });

    test('setConfig actually takes effect (100% loss drops everything)', () => {
        const out = collect({
            override: { baseLatencyMs: 0, jitterMs: 0, lossChance: 1 },
            count: 5,
        });
        expect(out).toEqual([]);
    });

    test('a fixed seed reproduces the same delivery pattern', () => {
        const cfg: JitterConfig = { baseLatencyMs: 0, jitterMs: 0, lossChance: 0.5 };
        const a = collect({ seed: 7, cfg, count: 50 });
        const b = collect({ seed: 7, cfg, count: 50 });
        expect(a).toEqual(b);
        expect(a.length).toBeGreaterThan(0);
        expect(a.length).toBeLessThan(50);
    });
});

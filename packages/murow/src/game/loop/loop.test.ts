import { describe, test, expect } from 'bun:test';
import { GameLoop } from './loop';

describe('GameLoop sync phase', () => {
  test('emits sync before pre-tick, tick, and post-tick', () => {
    const order: string[] = [];

    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    loop.events.on('sync', () => order.push('sync'));
    loop.events.on('pre-tick', () => order.push('pre-tick'));
    loop.events.on('tick', () => order.push('tick'));
    loop.events.on('post-tick', () => order.push('post-tick'));

    // Manual loop: advance the ticker by exactly one tick worth of deltaTime.
    loop.step(1 / 60 + 0.001);

    // Expect sync first, then pre-tick, then tick, then post-tick.
    expect(order).toEqual(['sync', 'pre-tick', 'tick', 'post-tick']);
  });

  test('sync payload exposes tick, deltaTime, input (server input is empty)', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    let captured: any = null;
    loop.events.on('sync', (data) => { captured = data; });
    loop.step(1 / 60 + 0.001);

    expect(captured).not.toBeNull();
    expect(typeof captured.tick).toBe('number');
    expect(typeof captured.deltaTime).toBe('number');
    // input field exists even on server loops (innofensive)
    expect(captured.input).toBeDefined();
  });

  test('sync fires once per tick, not once per render', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-client' });
    let syncs = 0;
    loop.events.on('sync', () => { syncs++; });

    // Three ticks worth of deltaTime — expect 3 syncs.
    loop.step(3 / 60 + 0.001);
    expect(syncs).toBe(3);
  });
});

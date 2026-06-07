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

describe('GameLoop schedules', () => {
  test('every(n).ticks fires on the tick interval', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    let fired = 0;
    loop.every(3).ticks(() => { fired++; });

    // Ticks 0..9; fires at 3, 6, 9.
    loop.step(10 / 60 + 0.001);
    expect(fired).toBe(3);
  });

  test('seconds and milliseconds resolve to ticks via tickRate', () => {
    const loop = new GameLoop({ tickRate: 20, type: 'manual-server' });
    let seconds = 0;
    let millis = 0;
    loop.every(1).seconds(() => { seconds++; });       // 20 ticks
    loop.every(500).milliseconds(() => { millis++; }); // 10 ticks

    // One tick per step (the ticker caps ticks-per-step at rate/2).
    // Ticks 0..20: seconds fires at 20; millis fires at 10, 20.
    for (let i = 0; i < 21; i++) loop.step(1 / 20 + 0.0001);
    expect(seconds).toBe(1);
    expect(millis).toBe(2);
  });

  test('clearSchedule stops a single schedule', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    let fired = 0;
    const id = loop.every(2).ticks(() => { fired++; });

    loop.step(3 / 60 + 0.001); // fires once at tick 2
    expect(fired).toBe(1);

    loop.clearSchedule(id);
    loop.step(10 / 60 + 0.001);
    expect(fired).toBe(1);
  });

  test('clearSchedules stops every schedule', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    let a = 0;
    let b = 0;
    loop.every(2).ticks(() => { a++; });
    loop.every(3).ticks(() => { b++; });

    loop.clearSchedules();
    loop.step(12 / 60 + 0.001);
    expect(a).toBe(0);
    expect(b).toBe(0);
  });

  test('a schedule may cancel itself mid-tick without skipping others', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    let self = 0;
    let other = 0;
    let id = 0;
    id = loop.every(2).ticks(() => { self++; loop.clearSchedule(id); });
    loop.every(2).ticks(() => { other++; });

    loop.step(6 / 60 + 0.001);
    expect(self).toBe(1);   // cancelled after its first fire
    expect(other).toBeGreaterThan(1);
  });

  test('schedules persist across stop and rebase on start', () => {
    const loop = new GameLoop({ tickRate: 60, type: 'manual-server' });
    let fired = 0;
    loop.every(3).ticks(() => { fired++; });

    loop.step(4 / 60 + 0.001); // fires once at tick 3
    expect(fired).toBe(1);

    loop.stop();   // resets tick count, keeps schedules
    loop.start();  // rebases next relative to the new origin
    loop.step(4 / 60 + 0.001); // fires once more at tick 3
    expect(fired).toBe(2);
  });
});

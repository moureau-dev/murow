import { describe, expect, test } from "bun:test";
import { FixedTicker } from "./fixed-ticker";

describe("FixedTicker", () => {
  test("should initialize with correct rate", () => {
    const ticker = new FixedTicker({ rate: 60, onTick: () => { } });
    expect(ticker.rate).toBe(60);
  });

  test("should call onTick with correct deltaTime", () => {
    let calledDelta = 0;
    const ticker = new FixedTicker({
      rate: 60,
      onTick: (dt) => {
        calledDelta = dt;
      },
    });

    ticker.tick(1 / 60);
    expect(calledDelta).toBeCloseTo(1 / 60, 5);
  });

  test("should accumulate time and execute multiple ticks", () => {
    let tickCount = 0;
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => {
        tickCount++;
      },
    });

    // Simulate 3 frames worth of time (add small epsilon for floating point)
    ticker.tick(3.01 / 60);
    expect(tickCount).toBe(3);
  });

  test("should track tick count correctly", () => {
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => { },
    });

    ticker.tick(5.01 / 60);
    expect(ticker.tickCount).toBe(5);
  });

  test("should reset tick count", () => {
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => { },
    });

    ticker.tick(3.01 / 60);
    expect(ticker.tickCount).toBe(3);

    ticker.resetTickCount();
    expect(ticker.tickCount).toBe(0);
  });

  test("should pass tick number to onTick callback", () => {
    const tickNumbers: number[] = [];
    const ticker = new FixedTicker({
      rate: 60,
      onTick: (_dt, tick) => {
        if (tick !== undefined) tickNumbers.push(tick);
      },
    });

    ticker.tick(3.01 / 60);
    expect(tickNumbers).toEqual([0, 1, 2]);
  });

  test("should limit ticks per frame to maxTicksPerFrame", () => {
    let tickCount = 0;
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => {
        tickCount++;
      },
    });

    // Simulate a huge delta time (2 seconds)
    ticker.tick(2);
    // maxTicksPerFrame should be Math.max(1, Math.floor(60 / 2)) = 30
    expect(tickCount).toBe(30);
  });

  test("should provide accumulated time", () => {
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => { },
    });

    // Give it 1.5 ticks worth of time
    ticker.tick(1.5 / 60);
    expect(ticker.accumulatedTime).toBeCloseTo(0.5 / 60, 5);
  });

  test("should call onTickSkipped when ticks are skipped", () => {
    let skippedCount = 0;
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => { },
    });

    // Access the private onTickSkipped through constructor
    const tickerWithSkip = new FixedTicker({
      rate: 60,
      onTick: () => { },
    });

    // Monkey patch to add onTickSkipped
    (tickerWithSkip as any).onTickSkipped = (count: number) => {
      skippedCount = count;
    };

    // Simulate huge delta that exceeds maxTicksPerFrame
    tickerWithSkip.tick(2);
    expect(skippedCount).toBeGreaterThan(0);
  });

  test("should handle zero delta time", () => {
    let tickCount = 0;
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => {
        tickCount++;
      },
    });

    ticker.tick(0);
    expect(tickCount).toBe(0);
    expect(ticker.tickCount).toBe(0);
  });

  test("should handle very small delta times", () => {
    let tickCount = 0;
    const ticker = new FixedTicker({
      rate: 60,
      onTick: () => {
        tickCount++;
      },
    });

    // Simulate 100 very small frames that add up to slightly more than 1 tick
    for (let i = 0; i < 100; i++) {
      ticker.tick(1.01 / 60 / 100);
    }
    expect(tickCount).toBe(1);
  });
});

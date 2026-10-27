import { describe, expect, test } from 'bun:test';
import { BeamItem, RibbonItem, TrailItem } from './items';
import type { RibbonBatch } from './ribbon-batch';
import type { BeamId, RibbonId, TrailId } from '../../types';

interface Call {
    points: number[];
    count: number;
    opts: Record<string, unknown>;
}

class FakeBatch {
    readonly calls: Call[] = [];
    appendStrip(points: ArrayLike<number>, count: number, opts: Record<string, unknown>): boolean {
        const copy: number[] = [];
        for (let i = 0; i < count * 3; i++) copy.push(points[i]!);
        this.calls.push({ points: copy, count, opts });
        return true;
    }
}

const host = {
    has: () => true,
    remove: () => {},
};

function batch(): { fake: FakeBatch; value: RibbonBatch } {
    const fake = new FakeBatch();
    return { fake, value: fake as unknown as RibbonBatch };
}

describe('RibbonItem', () => {
    test('copies points and writes width/color', () => {
        const b = batch();
        const item = new RibbonItem(1 as RibbonId, host, b.value, {
            points: [0, 0, 0, 1, 0, 0],
            width: 0.25,
            color: [1, 0, 0, 1],
        });
        item.write(1);
        expect(b.fake.calls.length).toBe(1);
        expect(b.fake.calls[0]!.count).toBe(2);
        expect(b.fake.calls[0]!.points).toEqual([0, 0, 0, 1, 0, 0]);
        expect(b.fake.calls[0]!.opts.width).toBe(0.25);
    });

    test('interpolates points at render alpha', () => {
        const b = batch();
        const item = new RibbonItem(1 as RibbonId, host, b.value, { maxPoints: 2 });
        item.setPoints([0, 0, 0, 1, 0, 0]);
        item.setPoints([2, 0, 0, 3, 0, 0]);
        item.write(0.5);
        expect(b.fake.calls[0]!.points).toEqual([1, 0, 0, 2, 0, 0]);
    });

    test('live opacity, texture, and blend', () => {
        const b = batch();
        const item = new RibbonItem(1 as RibbonId, host, b.value, { points: [0, 0, 0, 1, 0, 0] });
        item.setOpacity(0.4);
        item.setTexture('spark');
        item.setBlend('additive');
        item.write(1);
        expect(b.fake.calls[0]!.opts.opacity).toBe(0.4);
        expect(b.fake.calls[0]!.opts.texture).toBe('spark');
        expect(b.fake.calls[0]!.opts.blend).toBe('additive');
    });

    test('rejects points over maxPoints', () => {
        const b = batch();
        const item = new RibbonItem(1 as RibbonId, host, b.value, { maxPoints: 2 });
        expect(() => item.setPoints([0, 0, 0, 1, 0, 0, 2, 0, 0])).toThrow();
    });
});

describe('TrailItem', () => {
    test('commits history and interpolates the live head', () => {
        const b = batch();
        const trail = new TrailItem(1 as TrailId, host, b.value, {
            maxPoints: 8,
            lifetime: 1,
            minDistance: 0.1,
            width: [0.2, 0],
        }, 64);
        trail.setHead(0, 0, 0);
        trail.setHead(1, 0, 0);
        trail.write(0.5);
        expect(b.fake.calls.length).toBe(1);
        expect(b.fake.calls[0]!.count).toBe(2);
        expect(b.fake.calls[0]!.points).toEqual([0, 0, 0, 0.5, 0, 0]);
    });

    test('ages out history', () => {
        const b = batch();
        const trail = new TrailItem(1 as TrailId, host, b.value, {
            maxPoints: 8,
            lifetime: 0.5,
            minDistance: 0.1,
        }, 64);
        trail.setHead(0, 0, 0);
        trail.setHead(1, 0, 0);
        trail.simulate(0.6);
        trail.write(0.5);
        expect(b.fake.calls.length).toBe(0);
    });

    test('clear resets the trail', () => {
        const b = batch();
        const trail = new TrailItem(1 as TrailId, host, b.value, { lifetime: 1 }, 64);
        trail.setHead(0, 0, 0);
        trail.setHead(1, 0, 0);
        trail.clear();
        trail.write(0.5);
        expect(b.fake.calls.length).toBe(0);
        expect(trail.pointCount).toBe(0);
    });

    test('teleport clears history without a streak', () => {
        const b = batch();
        const trail = new TrailItem(1 as TrailId, host, b.value, { lifetime: 1, minDistance: 0 }, 64);
        trail.setHead(0, 0, 0);
        trail.setHead(1, 0, 0);
        trail.teleport(5, 0, 0);
        expect(trail.pointCount).toBe(1);
        trail.write(0.5);
        expect(b.fake.calls.length).toBe(0);
    });

    test('lifetime and beam noise are live', () => {
        const b = batch();
        const trail = new TrailItem(1 as TrailId, host, b.value, { lifetime: 1 }, 64);
        trail.setLifetime(0.25);
        expect(trail.lifetime).toBe(0.25);
        const beam = new BeamItem(2 as BeamId, host, b.value, { noise: 0.5 });
        beam.setNoise(0.1);
        beam.setUvScroll(2);
        beam.setNoiseSpeed(0.5);
        beam.setNoiseFrequency(3);
        beam.setOpacity(0.6);
        beam.setTexture('spark');
        beam.setBlend('alpha');
        beam.set(0, 0, 0, 1, 0, 0);
        beam.advance(0.5);
        beam.write(1);
        expect(b.fake.calls.length).toBe(1);
        expect(b.fake.calls[0]!.opts.uvOffset).toBe(1);
        expect(b.fake.calls[0]!.opts.opacity).toBe(0.6);
        expect(b.fake.calls[0]!.opts.texture).toBe('spark');
        expect(b.fake.calls[0]!.opts.blend).toBe('alpha');
    });
});

describe('BeamItem', () => {
    test('subdivides and advances uv scroll', () => {
        const b = batch();
        const beam = new BeamItem(1 as BeamId, host, b.value, {
            segments: 4,
            uvScroll: 2,
            width: 0.5,
        });
        beam.set(0, 0, 0, 10, 0, 0);
        beam.advance(0.5);
        beam.write(1);
        expect(b.fake.calls.length).toBe(1);
        expect(b.fake.calls[0]!.count).toBe(5);
        expect(b.fake.calls[0]!.points.slice(0, 3)).toEqual([0, 0, 0]);
        expect(b.fake.calls[0]!.points.slice(-3)).toEqual([10, 0, 0]);
        expect(b.fake.calls[0]!.opts.uvOffset).toBe(1);
    });

    test('interpolates endpoints at render alpha', () => {
        const b = batch();
        const beam = new BeamItem(1 as BeamId, host, b.value, { segments: 1 });
        beam.set(0, 0, 0, 1, 0, 0);
        beam.set(10, 0, 0, 11, 0, 0);
        beam.write(0.5);
        expect(b.fake.calls[0]!.points.slice(0, 3)).toEqual([5, 0, 0]);
        expect(b.fake.calls[0]!.points.slice(-3)).toEqual([6, 0, 0]);
    });

    test('skips zero-length beams', () => {
        const b = batch();
        const beam = new BeamItem(1 as BeamId, host, b.value, {});
        beam.set(1, 2, 3, 1, 2, 3);
        beam.write(1);
        expect(b.fake.calls.length).toBe(0);
    });
});

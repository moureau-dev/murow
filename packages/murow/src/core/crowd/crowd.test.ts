import { describe, expect, test } from 'bun:test';
import { NavMesh } from '../navmesh';
import { Crowd } from './crowd';

describe('Crowd', () => {
    test('follows a path to its goal', () => {
        const crowd = new Crowd({ navmesh: new NavMesh('grid'), radius: 0.5, speed: 10, waypointRadius: 0.6 });
        const a = crowd.add({ x: 0, y: 0 })!;
        a.setGoal(20, 0);
        for (let i = 0; i < 200; i++) crowd.update(1 / 20);
        expect(a.arrived).toBe(true);
        expect(Math.abs(a.x - 20)).toBeLessThan(1);
        expect(Math.abs(a.y)).toBeLessThan(1);
    });

    test('pushes overlapping agents apart', () => {
        const crowd = new Crowd({ navmesh: new NavMesh('grid'), radius: 1, speed: 4, separation: 4 });
        const a = crowd.add({ x: 0, y: 0 })!;
        const b = crowd.add({ x: 0, y: 0 })!;
        // Same goal: without separation these would stay perfectly stacked.
        a.setGoal(20, 0);
        b.setGoal(20, 0);
        for (let i = 0; i < 40; i++) crowd.update(1 / 20);
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.5);
    });

    test('stop halts, resume continues', () => {
        const crowd = new Crowd({ navmesh: new NavMesh('grid'), radius: 0.5, speed: 10, waypointRadius: 0.6 });
        const a = crowd.add({ x: 0, y: 0 })!;
        a.setGoal(30, 0);
        a.stop();
        for (let i = 0; i < 20; i++) crowd.update(1 / 20);
        expect(a.x).toBeCloseTo(0, 5);
        a.resume();
        for (let i = 0; i < 100; i++) crowd.update(1 / 20);
        expect(a.x).toBeGreaterThan(5);
    });

    test('teleport moves and re-paths; remove/allocation track', () => {
        const crowd = new Crowd({ navmesh: new NavMesh('grid'), capacity: 2, radius: 0.5, speed: 10 });
        const a = crowd.add({ x: 0, y: 0 })!;
        const b = crowd.add({ x: 0, y: 0 })!;
        expect(crowd.add({ x: 0, y: 0 })).toBeNull();
        expect(crowd.count).toBe(2);

        a.teleport(50, 50);
        expect(a.x).toBe(50);
        b.destroy();
        expect(crowd.count).toBe(1);
        expect(b.alive).toBe(false);
    });

    test('reports when an agent crosses a grid cell', () => {
        const crowd = new Crowd({ navmesh: new NavMesh('grid'), radius: 0.5, speed: 10, waypointRadius: 0.6 });
        const a = crowd.add({ x: 1, y: 0 })!;
        a.setGoal(10, 0);
        let crossings = 0;
        for (let i = 0; i < 100 && !a.arrived; i++) {
            crowd.update(1 / 20);
            if (a.cellChanged) crossings++;
        }
        expect(crossings).toBeGreaterThan(1);
        expect(a.cellX).toBe(Math.floor(a.x));
    });
});

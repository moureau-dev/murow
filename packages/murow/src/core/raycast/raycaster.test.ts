import { test, expect } from 'bun:test';
import { Raycaster } from './raycaster';
import { Hitbox } from '../hitbox/hitbox';
import { HitboxLibrary } from '../hitbox/hitbox-library';
import { Ray3D } from '../ray/ray-3d';

// Three entities in a line along +Z at z = 10, 20, 30, each a unit sphere.
function world() {
    const lib = new HitboxLibrary('3d').add('ball', new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 }));
    const px = [0, 0, 0], py = [0, 0, 0], pz = [10, 20, 30];
    const sx = [1, 1, 1], sy = [1, 1, 1], sz = [1, 1, 1];
    const arch = [0, 0, 0];

    const caster = new Raycaster()
        .lookup({
            query: () => [0, 1, 2],
            hitbox: (e) => lib.at(arch[e]),
        })
        .configure({
            position: () => ({ x: px, y: py, z: pz }),
            scale: () => ({ x: sx, y: sy, z: sz }),
        });

    return { caster, pz };
}

test('cast().hit() returns the nearest entity along the ray', () => {
    const { caster } = world();
    const ray = new Ray3D();
    ray.set(0, 0, 0, 0, 0, 1);
    const hit = caster.cast(ray).hit();
    expect(hit?.handle).toBe(0);          // z=10 sphere is nearest
    expect(hit?.part).toBe('body');
    expect(hit?.distance).toBeCloseTo(9); // radius 1, center z=10 -> entry at 9
});

test('hitAll returns every entity nearest-first', () => {
    const { caster } = world();
    const ray = new Ray3D();
    ray.set(0, 0, 0, 0, 0, 1);
    const all = caster.cast(ray).hitAll();
    expect(all.map((h) => h.handle)).toEqual([0, 1, 2]);
    expect(all.map((h) => Math.round(h.distance))).toEqual([9, 19, 29]);
});

test('filter and maxDistance narrow the result', () => {
    const { caster } = world();
    const ray = new Ray3D();
    ray.set(0, 0, 0, 0, 0, 1);

    expect(caster.cast(ray).hit({ filter: (e) => e !== 0 })?.handle).toBe(1);
    expect(caster.cast(ray).hit({ maxDistance: 15 })?.handle).toBe(0);
    expect(caster.cast(ray).hit({ maxDistance: 5 })).toBeNull();
});

test('a null hitbox skips the entity', () => {
    const lib = new HitboxLibrary('3d').add('ball', new Hitbox('3d').add('b', { shape: 'sphere', radius: 1 }));
    const caster = new Raycaster()
        .lookup({ query: () => [0, 1], hitbox: (e) => (e === 0 ? null : lib.at(0)) })
        .configure({
            position: () => ({ x: [0, 0], y: [0, 0], z: [10, 20] }),
            scale: () => ({ x: [1, 1], y: [1, 1], z: [1, 1] }),
        });
    const ray = new Ray3D();
    ray.set(0, 0, 0, 0, 0, 1);
    expect(caster.cast(ray).hit()?.handle).toBe(1); // entity 0 skipped despite being nearer
});

test('cast throws if not configured', () => {
    const ray = new Ray3D();
    ray.set(0, 0, 0, 0, 0, 1);
    expect(() => new Raycaster().cast(ray)).toThrow();
});

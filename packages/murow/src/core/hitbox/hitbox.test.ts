import { test, expect } from 'bun:test';
import { Hitbox } from './hitbox';
import { HitboxLibrary } from './hitbox-library';
import { testHitbox3D, testHitbox2D } from './test';
import { Ray3D } from '../ray/ray-3d';

test('Hitbox.add accumulates named parts immutably', () => {
    const a = new Hitbox('3d');
    const b = a.add('head', { shape: 'sphere', radius: 1 });
    expect(a.parts.length).toBe(0);          // original untouched
    expect(b.parts.length).toBe(1);
    expect(b.parts[0]).toEqual({ name: 'head', shape: 'sphere', radius: 1 });
});

test('HitboxLibrary resolves by name and index', () => {
    const head = new Hitbox('3d').add('h', { shape: 'sphere', radius: 1 });
    const lib = new HitboxLibrary('3d').add('humanoid', head).add('crate', new Hitbox('3d'));
    expect(lib.get('humanoid')).toBe(head);
    expect(lib.at(0)).toBe(head);
    expect(lib.indexOf('humanoid')).toBe(0);
    expect(lib.indexOf('crate')).toBe(1);
    expect(lib.keys()).toEqual(['humanoid', 'crate']);
});

test('HitboxLibrary rejects duplicate and unknown names', () => {
    const lib = new HitboxLibrary('3d').add('a', new Hitbox('3d'));
    expect(() => lib.add('a', new Hitbox('3d'))).toThrow();
    expect(() => lib.get('nope' as never)).toThrow();
});

test('testHitbox3D returns the nearest part struck', () => {
    const humanoid = new Hitbox('3d')
        .add('torso', { shape: 'cylinder', radius: 1, height: 4, offset: [0, 2, 0] })
        .add('head', { shape: 'sphere', radius: 0.8, offset: [0, 4.5, 0] });

    const ray = new Ray3D();
    // Aim at the head height from far -Z, looking +Z.
    ray.set(0, 4.5, -100, 0, 0, 1);
    const hit = testHitbox3D(ray, humanoid, 0, 0, 0, 1, 1, 1);
    expect(hit?.part).toBe('head');
});

test('testHitbox3D scales the hitbox by instance scale', () => {
    const hb = new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 });
    const ray = new Ray3D();
    ray.set(0, 0, -100, 0, 0, 1);
    // radius 1 scaled 3x -> entry at z = -3 from center 0 -> distance 97.
    const hit = testHitbox3D(ray, hb, 0, 0, 0, 3, 3, 3);
    expect(hit?.distance).toBeCloseTo(97);
});

test('testHitbox2D point-tests circle/rect with rotation', () => {
    const hb = new Hitbox('2d')
        .add('body', { shape: 'rect', size: [4, 1] });

    // unrotated 4x1 rect at origin: (1.5, 0) inside, (0, 0.8) outside.
    expect(testHitbox2D(hb, 0, 0, 1, 1, 0, 1.5, 0)?.part).toBe('body');
    expect(testHitbox2D(hb, 0, 0, 1, 1, 0, 0, 0.8)).toBeNull();

    // rotate 90deg: now 1 wide, 4 tall.
    const rot = Math.PI / 2;
    expect(testHitbox2D(hb, 0, 0, 1, 1, rot, 0, 1.8)?.part).toBe('body');
    expect(testHitbox2D(hb, 0, 0, 1, 1, rot, 1.8, 0)).toBeNull();
});

test('testHitbox2D capsule covers body and caps', () => {
    const hb = new Hitbox('2d').add('c', { shape: 'capsule', radius: 1, length: 6 });
    expect(testHitbox2D(hb, 0, 0, 1, 1, 0, 0.9, 2)?.part).toBe('c');   // body
    expect(testHitbox2D(hb, 0, 0, 1, 1, 0, 0, 3.9)?.part).toBe('c');   // cap
    expect(testHitbox2D(hb, 0, 0, 1, 1, 0, 0, 4.1)).toBeNull();        // past cap
});

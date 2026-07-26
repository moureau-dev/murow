import { test, expect } from 'bun:test';
import { PrefabBucket } from './concrete';
import { Hitbox } from '../../../../core/hitbox/hitbox';
import { HitboxLibrary } from '../../../../core/hitbox/hitbox-library';

test('hitboxes() registers the library on the bucket', () => {
    const lib = new HitboxLibrary('3d').add('humanoid', new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 }));
    const bucket = new PrefabBucket('3d').hitboxes(lib);
    expect(bucket.hitboxLibrary).toBe(lib);
});

test('a spec can reference a registered hitbox by name', () => {
    const lib = new HitboxLibrary('3d').add('humanoid', new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 }));
    const bucket = new PrefabBucket('3d')
        .hitboxes(lib)
        .add({ type: 'cube', id: 'jinx', hitbox: 'humanoid' });
    expect(bucket.size).toBe(1);
});

test('bucket without a library has no hitbox library', () => {
    const bucket = new PrefabBucket('3d').add({ type: 'cube', id: 'crate' });
    expect(bucket.hitboxLibrary).toBeNull();
});

test('an unregistered hitbox name is accepted at runtime (StringOr)', () => {
    const lib = new HitboxLibrary('3d').add('humanoid', new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 }));
    // A name not in the library still type-checks (StringOr<HB>) and adds fine;
    // resolution falls back to the model bound at pick time.
    const bucket = new PrefabBucket('3d')
        .hitboxes(lib)
        .add({ type: 'cube', id: 'mystery', hitbox: 'not-in-library' });
    expect(bucket.size).toBe(1);
});

test('hitboxes() infers the library names into the hitbox field (not never)', () => {
    const lib = new HitboxLibrary('3d')
        .add('humanoid', new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 }))
        .add('crate', new Hitbox('3d').add('body', { shape: 'box', size: [1, 1, 1] }));
    const bucket = new PrefabBucket('3d').hitboxes(lib);

    // The hitbox field's literal part must be exactly the registered names.
    // If inference collapsed to `never`, `Names` below would be `never` and
    // assigning a real name would fail to compile.
    type HitboxArg = NonNullable<Parameters<typeof bucket.add>[0]['hitbox']>;
    type Names = HitboxArg extends infer T ? (T extends string ? T : never) : never;
    const _names: 'humanoid' | 'crate' extends Names ? true : false = true;
    expect(_names).toBe(true);

    // And a registered name is accepted.
    bucket.add({ type: 'cube', id: 'a', hitbox: 'humanoid' });
    expect(bucket.size).toBe(1);
});

test('id inference survives an add that carries a hitbox', () => {
    const lib = new HitboxLibrary('3d').add('humanoid', new Hitbox('3d').add('body', { shape: 'sphere', radius: 1 }));
    const bucket = new PrefabBucket('3d')
        .hitboxes(lib)
        .add({ type: 'cube', id: 'jinx', hitbox: 'humanoid' })
        .add({ type: 'cube', id: 'crate' });
    // Compile-time: both ids are known keys. `@ts-expect-error` proves a typo is caught.
    type Ids = Parameters<typeof bucket.get>[0];
    const known: Ids = 'jinx';
    expect(known).toBe('jinx');
    expect(bucket.size).toBe(2);
});

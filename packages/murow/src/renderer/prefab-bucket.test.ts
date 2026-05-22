import { test, expect, describe } from 'bun:test';
import { PrefabBucket, type PrefabSpecBase, type PrefabBase, type PrefabParserMap } from './prefab-bucket';

// --- Test fixtures ---

interface TestSpec extends PrefabSpecBase {
    readonly type: 'test';
    readonly id: string;
    readonly payload: number;
}

interface TestPrefab extends PrefabBase {
    readonly type: 'test';
    readonly id: string;
    readonly doubled: number;
}

const parseDelays: Record<string, number> = {};
const parsers: PrefabParserMap<TestSpec, TestPrefab> = {
    test: async (spec) => {
        const delay = parseDelays[spec.id];
        if (delay) await new Promise(r => setTimeout(r, delay));
        return { type: 'test', id: spec.id, doubled: spec.payload * 2 };
    },
};

function makeBucket() {
    return new PrefabBucket<'3d', TestSpec, TestPrefab>('3d', parsers);
}

// --- Tests ---

describe('PrefabBucket', () => {
    describe('lifecycle', () => {
        test('starts unloaded with size 0', () => {
            const bucket = makeBucket();
            expect(bucket.loaded).toBe(false);
            expect(bucket.size).toBe(0);
        });

        test('add() registers a spec and bumps size', () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            expect(bucket.size).toBe(1);
            expect(bucket.loaded).toBe(false);
        });

        test('addAll() registers multiple specs', () => {
            const bucket = makeBucket()
                .addAll([
                    { type: 'test', id: 'a', payload: 1 },
                    { type: 'test', id: 'b', payload: 2 },
                ]);
            expect(bucket.size).toBe(2);
        });

        test('load() parses all pending specs', async () => {
            const bucket = makeBucket()
                .addAll([
                    { type: 'test', id: 'a', payload: 1 },
                    { type: 'test', id: 'b', payload: 2 },
                ]);

            await bucket.load();

            expect(bucket.loaded).toBe(true);
            expect(bucket.get('a').doubled).toBe(2);
            expect(bucket.get('b').doubled).toBe(4);
        });

        test('load() runs parses in parallel', async () => {
            parseDelays.a = 50;
            parseDelays.b = 50;
            parseDelays.c = 50;
            try {
                const bucket = makeBucket().addAll([
                    { type: 'test', id: 'a', payload: 1 },
                    { type: 'test', id: 'b', payload: 2 },
                    { type: 'test', id: 'c', payload: 3 },
                ]);

                const start = performance.now();
                await bucket.load();
                const elapsed = performance.now() - start;

                // Parallel should finish in ~50ms, not ~150ms; allow generous slack
                expect(elapsed).toBeLessThan(120);
            } finally {
                delete parseDelays.a;
                delete parseDelays.b;
                delete parseDelays.c;
            }
        });

        test('load() is idempotent — second call is a no-op', async () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            await bucket.load();
            await bucket.load();
            expect(bucket.get('a').doubled).toBe(2);
        });
    });

    describe('duplicate ids', () => {
        test('add() throws on duplicate id', () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            expect(() => bucket.add({ type: 'test', id: 'a', payload: 9 }))
                .toThrow(/duplicate id 'a'/);
        });

        test('addAll() throws on duplicate id within the batch', () => {
            const bucket = makeBucket();
            expect(() => bucket.addAll([
                { type: 'test', id: 'a', payload: 1 },
                { type: 'test', id: 'a', payload: 2 },
            ])).toThrow(/duplicate id 'a'/);
        });

        test('addAll() validates before committing — bucket stays empty on failure', () => {
            const bucket = makeBucket();
            try {
                bucket.addAll([
                    { type: 'test', id: 'a', payload: 1 },
                    { type: 'test', id: 'a', payload: 2 },
                ]);
            } catch { /* expected */ }
            expect(bucket.size).toBe(0);
        });

        test('addAll() rejects ids already in the bucket', () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            expect(() => bucket.addAll([
                { type: 'test', id: 'b', payload: 2 },
                { type: 'test', id: 'a', payload: 9 },
            ])).toThrow(/duplicate id 'a'/);
        });
    });

    describe('frozen after load', () => {
        test('add() throws after load()', async () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            await bucket.load();
            expect(() => bucket.add({ type: 'test', id: 'b', payload: 2 }))
                .toThrow(/frozen/);
        });

        test('addAll() throws after load()', async () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            await bucket.load();
            expect(() => bucket.addAll([{ type: 'test', id: 'b', payload: 2 }]))
                .toThrow(/frozen/);
        });
    });

    describe('get', () => {
        test('throws before load', () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            expect(() => bucket.get('a' as never)).toThrow(/before load/);
        });

        test('throws on unknown id', async () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 });
            await bucket.load();
            expect(() => bucket.get('missing' as never)).toThrow(/unknown prefab id 'missing'/);
        });

        test('returns the parsed prefab', async () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 5 });
            await bucket.load();
            const prefab = bucket.get('a');
            expect(prefab.type).toBe('test');
            expect(prefab.id).toBe('a');
            expect(prefab.doubled).toBe(10);
        });
    });

    describe('entries', () => {
        test('throws before load', () => {
            const bucket = makeBucket();
            expect(() => bucket.entries()).toThrow(/before load/);
        });

        test('returns all parsed prefabs in registration order', async () => {
            const bucket = makeBucket()
                .addAll([
                    { type: 'test', id: 'a', payload: 1 },
                    { type: 'test', id: 'b', payload: 2 },
                    { type: 'test', id: 'c', payload: 3 },
                ]);
            await bucket.load();
            const ids = bucket.entries().map(p => p.id);
            expect(ids).toEqual(['a', 'b', 'c']);
        });
    });

    describe('mode + parser registry', () => {
        test('exposes the mode passed to the constructor', () => {
            const b2d = new PrefabBucket<'2d', TestSpec, TestPrefab>('2d', parsers);
            const b3d = new PrefabBucket<'3d', TestSpec, TestPrefab>('3d', parsers);
            expect(b2d.mode).toBe('2d');
            expect(b3d.mode).toBe('3d');
        });

        test('load() throws on spec with no registered parser', async () => {
            const bucket = makeBucket()
                .add({ type: 'unknown' as 'test', id: 'a', payload: 1 });
            await expect(bucket.load()).rejects.toThrow(/no parser registered for type 'unknown'/);
        });

        test('parsers can be sync or async', async () => {
            const syncParsers: PrefabParserMap<TestSpec, TestPrefab> = {
                test: (spec) => ({ type: 'test', id: spec.id, doubled: spec.payload * 2 }),
            };
            const bucket = new PrefabBucket<'3d', TestSpec, TestPrefab>('3d', syncParsers)
                .add({ type: 'test', id: 'x', payload: 7 });
            await bucket.load();
            expect(bucket.get('x').doubled).toBe(14);
        });
    });

    describe('chaining', () => {
        test('add() returns the bucket so calls chain', () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 })
                .add({ type: 'test', id: 'b', payload: 2 })
                .add({ type: 'test', id: 'c', payload: 3 });
            expect(bucket.size).toBe(3);
        });

        test('add() and addAll() can be mixed in a chain', () => {
            const bucket = makeBucket()
                .add({ type: 'test', id: 'a', payload: 1 })
                .addAll([
                    { type: 'test', id: 'b', payload: 2 },
                    { type: 'test', id: 'c', payload: 3 },
                ])
                .add({ type: 'test', id: 'd', payload: 4 });
            expect(bucket.size).toBe(4);
        });
    });
});

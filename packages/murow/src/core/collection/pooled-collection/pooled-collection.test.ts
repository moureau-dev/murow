import { test, expect, describe } from 'bun:test';
import { Logger } from '../../../core/logger';
import type { SlotId } from '../../../core/slot-map';
import type { HandleBase } from '../handle-base';
import { PooledCollection } from './pooled-collection';

type TestId = SlotId<'test'>;

class TestHandle implements CollectionItem<TestId> {
    constructor(
        private readonly manager: TestCollection,
        readonly id: TestId,
    ) {}
    get alive(): boolean {
        return this.manager.has(this.id);
    }
    destroy(): void {
        this.manager.remove(this.id);
    }
}

class TestCollection extends PooledCollection<TestId, TestHandle, number> {
    constructor(capacity: number, logger: Logger = Logger.none) {
        super({ poolSize: capacity, capacity, logger });
    }
    add(): TestHandle | null {
        const allocated = this.allocateItem();
        return allocated ? allocated.item : null;
    }
    protected createItem(id: TestId): TestHandle {
        return new TestHandle(this, id);
    }
}

describe('PooledCollection', () => {
    test('add returns a live handle and get/has/count agree', () => {
        const c = new TestCollection(4);
        const h = c.add()!;
        expect(h.alive).toBe(true);
        expect(c.get(h.id)).toBe(h);
        expect(c.has(h.id)).toBe(true);
        expect(c.count).toBe(1);
        expect(c.capacity).toBe(4);
    });

    test('destroy is idempotent and makes the handle inert', () => {
        const c = new TestCollection(4);
        const h = c.add()!;
        h.destroy();
        expect(h.alive).toBe(false);
        expect(c.get(h.id)).toBeUndefined();
        expect(c.count).toBe(0);
        h.destroy();
        expect(c.count).toBe(0);
    });

    test('a reused slot yields a fresh handle and the old id is stale', () => {
        const c = new TestCollection(1);
        const a = c.add()!;
        a.destroy();
        const b = c.add()!;
        expect(b.id).not.toBe(a.id);
        expect(a.alive).toBe(false);
        expect(c.get(a.id)).toBeUndefined();
        expect(c.get(b.id)).toBe(b);
    });

    test('each iterates live handles in dense order', () => {
        const c = new TestCollection(4);
        const a = c.add()!;
        const b = c.add()!;
        const seen: number[] = [];
        c.each((h) => seen.push(h.id));
        expect(seen.length).toBe(2);
        expect(seen).toContain(a.id);
        expect(seen).toContain(b.id);
    });

    test('overflow logs and returns null', () => {
        const messages: string[] = [];
        const logger = new Logger({ sink: (level, message) => messages.push(`${level}:${message}`) });
        const c = new TestCollection(1, logger);
        expect(c.add()).not.toBeNull();
        expect(c.add()).toBeNull();
        expect(messages.some((m) => m.startsWith('error:'))).toBe(true);
    });

    test('clear removes everything and keeps the collection usable', () => {
        const c = new TestCollection(4);
        const h = c.add()!;
        c.clear();
        expect(c.count).toBe(0);
        expect(h.alive).toBe(false);
        expect(c.add()).not.toBeNull();
    });

    test('events fire for add, remove and clear', () => {
        const c = new TestCollection(4);
        const log: string[] = [];
        c.events.on('add', () => log.push('add'));
        c.events.on('remove', () => log.push('remove'));
        c.events.on('clear', () => log.push('clear'));

        const h = c.add()!;
        h.destroy();
        const h2 = c.add()!;
        c.clear();
        expect(log).toEqual(['add', 'remove', 'add', 'remove', 'clear']);
        expect(h2.alive).toBe(false);
    });
});

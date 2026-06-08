import { describe, test, expect } from 'bun:test';
import { PredictionLog, Reconciler } from './prediction';

describe('PredictionLog', () => {
    test('records in sequence order and reports pending', () => {
        const log = new PredictionLog<string>(8);
        log.record(1, 'a');
        log.record(2, 'b');
        log.record(3, 'c');
        expect(log.size).toBe(3);
        expect(log.pending()).toEqual(['a', 'b', 'c']);
    });

    test('dropThrough removes everything confirmed', () => {
        const log = new PredictionLog<string>(8);
        log.record(1, 'a');
        log.record(2, 'b');
        log.record(3, 'c');
        log.dropThrough(2);
        expect(log.pending()).toEqual(['c']);
    });

    test('caps to capacity, dropping the oldest', () => {
        const log = new PredictionLog<string>(2);
        log.record(1, 'a');
        log.record(2, 'b');
        log.record(3, 'c');
        expect(log.pending()).toEqual(['b', 'c']);
    });
});

describe('Reconciler', () => {
    test('restores, drops confirmed, then replays the rest in order', () => {
        const calls: string[] = [];
        const r = new Reconciler<string, { ack: number }>({
            bufferSize: 8,
            restore: () => calls.push('restore'),
            replay: (cmds) => calls.push('replay:' + cmds.join(',')),
        });
        r.record(1, 'a');
        r.record(2, 'b');
        r.record(3, 'c');
        r.reconcile(2, { ack: 2 });
        expect(calls).toEqual(['restore', 'replay:c']);
        expect(r.pending).toBe(1);
    });

    test('still restores and replays an empty set when all is confirmed', () => {
        const calls: string[] = [];
        const r = new Reconciler<string>({
            restore: () => calls.push('restore'),
            replay: (cmds) => calls.push('replay:' + cmds.length),
        });
        r.record(1, 'a');
        r.reconcile(5, undefined as void);
        expect(calls).toEqual(['restore', 'replay:0']);
        expect(r.pending).toBe(0);
    });
});

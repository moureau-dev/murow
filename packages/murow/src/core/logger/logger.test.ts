import { test, expect, describe, spyOn, afterEach } from 'bun:test';
import { Logger } from './logger';

afterEach(() => {
    (console.warn as unknown as { mockRestore?: () => void }).mockRestore?.();
    (console.info as unknown as { mockRestore?: () => void }).mockRestore?.();
    (console.error as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe('Logger', () => {
    test('tags console output with [murow]', () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        new Logger().warn('hello');
        expect(warn).toHaveBeenCalledWith('[murow] hello');
    });

    test('honours a custom prefix and forwards details', () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        new Logger({ prefix: 'net' }).warn('dropped', { id: 3 });
        expect(warn).toHaveBeenCalledWith('[net] dropped', { id: 3 });
    });

    test('routes to a custom sink with the level', () => {
        const records: unknown[][] = [];
        const log = new Logger({ sink: (level, message, details) => records.push([level, message, details]) });
        log.warn('a');
        log.info('b', { x: 1 });
        log.error('c');
        expect(records).toEqual([['warn', 'a', undefined], ['info', 'b', { x: 1 }], ['error', 'c', undefined]]);
    });

    test('Logger.none discards everything', () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        const error = spyOn(console, 'error').mockImplementation(() => {});
        Logger.none.warn('x');
        Logger.none.error('y');
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });
});

describe('Logger.resolve', () => {
    test('false / undefined -> none', () => {
        expect(Logger.resolve(false)).toBe(Logger.none);
        expect(Logger.resolve(undefined)).toBe(Logger.none);
    });

    test('a Logger passes through unchanged', () => {
        const custom = new Logger({ sink: () => {} });
        expect(Logger.resolve(custom)).toBe(custom);
    });

    test('true -> a console logger', () => {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        Logger.resolve(true).warn('hi');
        expect(warn).toHaveBeenCalledWith('[murow] hi');
    });
});

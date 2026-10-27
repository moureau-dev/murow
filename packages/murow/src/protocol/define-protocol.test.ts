import { describe, expect, test } from 'bun:test';
import { f32, u16, u32 } from '../core/binary-codec';
import { defineProtocol } from './define-protocol';
import { arrayOf, baseline } from './messages/define-snapshots';

describe('defineProtocol', () => {
    test('defines intents and rpcs and a stable fingerprint', () => {
        const a = defineProtocol({
            version: 1,
            intents: { move: { dx: f32, dz: f32 } },
            rpcs: { buy: { item: u16 } },
        });
        const b = defineProtocol({
            version: 1,
            intents: { move: { dx: f32, dz: f32 } },
            rpcs: { buy: { item: u16 } },
        });

        expect(a.intents.kindByName.move).toBe(1);
        expect(a.fingerprint).toBe(b.fingerprint);
    });

    test('version and field order change the fingerprint', () => {
        const base = defineProtocol({
            version: 1,
            intents: { move: { dx: f32, dz: f32 } },
            rpcs: {},
        });
        const version = defineProtocol({
            version: 2,
            intents: { move: { dx: f32, dz: f32 } },
            rpcs: {},
        });
        const order = defineProtocol({
            version: 1,
            intents: { move: { dz: f32, dx: f32 } },
            rpcs: {},
        });

        expect(version.fingerprint).not.toBe(base.fingerprint);
        expect(order.fingerprint).not.toBe(base.fingerprint);
    });

    test('message arrays and baseline markers are part of the fingerprint', () => {
        const plain = defineProtocol({
            version: 1,
            intents: {},
            rpcs: {},
            messages: { tiles: { cells: arrayOf({ index: u32, owner: u16 }) } },
        });
        const base = defineProtocol({
            version: 1,
            intents: {},
            rpcs: {},
            messages: { tiles: baseline({ cells: arrayOf({ index: u32, owner: u16 }) }) },
        });
        const narrower = defineProtocol({
            version: 1,
            intents: {},
            rpcs: {},
            messages: { tiles: { cells: arrayOf({ index: u32 }) } },
        });

        expect(base.fingerprint).not.toBe(plain.fingerprint);
        expect(narrower.fingerprint).not.toBe(plain.fingerprint);
    });

    test('rejects invalid versions', () => {
        expect(() => defineProtocol({ version: 0, intents: {}, rpcs: {} })).toThrow('positive integer');
    });
});

import { describe, test, expect } from 'bun:test';
import { u8, string } from 'murow/core/binary-codec';
import { defineRpcs } from './define-rpcs';

describe('defineRpcs', () => {
    test('registers each RPC with the underlying registry', () => {
        const rpcs = defineRpcs({
            matchCountdown: { secondsRemaining: u8 },
            buyItem: { itemId: string(16) },
        });
        expect(rpcs.registry.has('matchCountdown')).toBe(true);
        expect(rpcs.registry.has('buyItem')).toBe(true);
    });

    test('encodes and decodes roundtrip', () => {
        const rpcs = defineRpcs({
            matchCountdown: { secondsRemaining: u8 },
        });
        const buf = rpcs.registry.encode(rpcs.defs.matchCountdown, { secondsRemaining: 10 });
        const decoded = rpcs.registry.decode(buf);
        expect(decoded.method).toBe('matchCountdown');
        expect((decoded.data as any).secondsRemaining).toBe(10);
    });
});

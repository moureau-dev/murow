import { describe, expect, test } from 'bun:test';
import { ClientMessage, ServerMessage } from './messages';
import { packet, packetPayload, packetType, packetU32 } from './packet';
import { SessionRegistry } from './session';

describe('wire packet', () => {
    test('writes and reads a kind and payload', () => {
        const payload = new Uint8Array([1, 2, 3]);
        const out = packet(ServerMessage.Snapshot, payload);
        expect(out[0]).toBe(ServerMessage.Snapshot);
        expect(packetType(out)).toBe(ServerMessage.Snapshot);
        expect(Array.from(packetPayload(out))).toEqual([1, 2, 3]);
    });

    test('writes an empty packet', () => {
        const out = packet(ClientMessage.SyncAck);
        expect(out.length).toBe(1);
        expect(packetType(out)).toBe(ClientMessage.SyncAck);
        expect(packetPayload(out).length).toBe(0);
    });

    test('writes a u32 packet', () => {
        const out = packetU32(ServerMessage.AssignEntity, 0xdeadbeef);
        expect(out.length).toBe(5);
        expect(out[0]).toBe(ServerMessage.AssignEntity);
        expect(new DataView(out.buffer).getUint32(1, true)).toBe(0xdeadbeef);
    });
});

describe('SessionRegistry', () => {
    test('creates unique tokens and resumes a held session', () => {
        const sessions = new SessionRegistry<{ entity: number }>();
        const token = sessions.createToken();
        expect(token).not.toBe(sessions.createToken());
        expect(sessions.resume(token)).toBeUndefined();
        sessions.hold({ token, data: { entity: 7 }, graceMs: 1000, onExpire: () => {} });
        expect(sessions.resume(token)).toEqual({ entity: 7 });
        expect(sessions.resume(token)).toBeUndefined();
        sessions.clear();
    });

    test('expires a held session after the grace period', async () => {
        const sessions = new SessionRegistry<{ entity: number }>();
        const token = sessions.createToken();
        let expired = false;
        sessions.hold({ token, data: { entity: 3 }, graceMs: 5, onExpire: () => { expired = true; } });
        await Bun.sleep(20);
        expect(expired).toBe(true);
        expect(sessions.resume(token)).toBeUndefined();
        sessions.clear();
    });

    test('a full hold pool expires immediately', () => {
        const sessions = new SessionRegistry<{ entity: number }>({ capacity: 1 });
        const first = sessions.createToken();
        const second = sessions.createToken();
        sessions.hold({ token: first, data: { entity: 1 }, graceMs: 1000, onExpire: () => {} });
        let expired = false;
        sessions.hold({ token: second, data: { entity: 2 }, graceMs: 1000, onExpire: () => { expired = true; } });
        expect(expired).toBe(true);
        expect(sessions.resume(first)).toEqual({ entity: 1 });
        sessions.clear();
    });

    test('non-positive grace expires immediately', () => {
        const sessions = new SessionRegistry<{ entity: number }>();
        const token = sessions.createToken();
        let expired = false;
        sessions.hold({ token, data: { entity: 3 }, graceMs: 0, onExpire: () => { expired = true; } });
        expect(expired).toBe(true);
        expect(sessions.resume(token)).toBeUndefined();
    });
});

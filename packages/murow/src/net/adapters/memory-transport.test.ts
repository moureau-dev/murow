import { describe, test, expect } from 'bun:test';
import { MemoryServerTransport } from './memory-transport';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('MemoryServerTransport', () => {
    test('connectClient fires onConnection synchronously with peer + id, and tracks it', () => {
        const server = new MemoryServerTransport();
        let connectedId: string | null = null;
        server.onConnection((_peer, peerId) => { connectedId = peerId; });

        const { peerId } = server.connectClient();

        expect(connectedId).toBe(peerId);
        expect(server.getPeerIds()).toEqual([peerId]);
        expect(server.getPeer(peerId)).toBeDefined();
    });

    test('delivers messages both directions via microtask', async () => {
        const server = new MemoryServerTransport();
        const atServer: number[] = [];
        const atClient: number[] = [];

        server.onConnection((peer) => peer.onMessage((d) => atServer.push(d[0]!)));
        const { client, peerId } = server.connectClient();
        client.onMessage((d) => atClient.push(d[0]!));

        client.send(new Uint8Array([1]));
        server.getPeer(peerId)!.send(new Uint8Array([2]));

        expect(atServer).toEqual([]); // not delivered synchronously
        await flush();

        expect(atServer).toEqual([1]);
        expect(atClient).toEqual([2]);
    });

    test('client onOpen fires after connect', async () => {
        const server = new MemoryServerTransport();
        const { client } = server.connectClient();
        let opened = false;
        client.onOpen(() => { opened = true; });

        await flush();
        expect(opened).toBe(true);
    });

    test('send copies the buffer so callers may reuse it', async () => {
        const server = new MemoryServerTransport();
        const got: number[] = [];
        server.onConnection((peer) => peer.onMessage((d) => got.push(d[0]!)));
        const { client } = server.connectClient();

        const buf = new Uint8Array([7]);
        client.send(buf);
        buf[0] = 99; // mutate after send; the copy should be unaffected
        await flush();

        expect(got).toEqual([7]);
    });

    test('closing fires onClose + onDisconnection and removes the peer', () => {
        const server = new MemoryServerTransport();
        let disconnectedId: string | null = null;
        let serverSawClose = false;
        server.onDisconnection((id) => { disconnectedId = id; });
        server.onConnection((peer) => peer.onClose(() => { serverSawClose = true; }));

        const { client, peerId } = server.connectClient();
        client.close();

        expect(serverSawClose).toBe(true);
        expect(disconnectedId).toBe(peerId);
        expect(server.getPeerIds()).toEqual([]);
    });
});

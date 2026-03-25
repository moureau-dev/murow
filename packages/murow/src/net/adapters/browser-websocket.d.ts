import type { TransportAdapter } from "../types";
/**
 * Browser WebSocket transport adapter for ClientNetwork
 *
 * @example
 * ```ts
 * const transport = new BrowserWebSocketClientTransport("ws://localhost:3007");
 * const client = new ClientNetwork({ transport, ... });
 * ```
 */
export declare class BrowserWebSocketClientTransport implements TransportAdapter {
    private ws;
    private openHandler;
    private messageHandler;
    private closeHandler;
    private errorHandler;
    private isOpen;
    private pendingMessages;
    constructor(url: string);
    send(data: Uint8Array): void;
    onMessage(handler: (data: Uint8Array) => void): void;
    onOpen(handler: () => void): void;
    onClose(handler: () => void): void;
    onError(handler: (error: Error) => void): void;
    close(): void;
}

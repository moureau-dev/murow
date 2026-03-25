/**
 * Browser WebSocket transport adapter for ClientNetwork
 *
 * @example
 * ```ts
 * const transport = new BrowserWebSocketClientTransport("ws://localhost:3007");
 * const client = new ClientNetwork({ transport, ... });
 * ```
 */
export class BrowserWebSocketClientTransport {
    constructor(url) {
        this.openHandler = null;
        this.messageHandler = null;
        this.closeHandler = null;
        this.errorHandler = null;
        this.isOpen = false;
        this.pendingMessages = [];
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';
        this.ws.onopen = () => {
            this.isOpen = true;
            // Flush any pending messages
            for (const msg of this.pendingMessages) {
                this.ws.send(msg);
            }
            this.pendingMessages = [];
            if (this.openHandler) {
                this.openHandler();
            }
            ;
        };
        this.ws.onmessage = (event) => {
            if (this.messageHandler && event.data instanceof ArrayBuffer) {
                this.messageHandler(new Uint8Array(event.data));
            }
        };
        this.ws.onclose = () => {
            this.isOpen = false;
            if (this.closeHandler) {
                this.closeHandler();
            }
        };
        this.ws.onerror = () => {
            if (this.errorHandler) {
                this.errorHandler(new Error('WebSocket error'));
            }
        };
    }
    send(data) {
        if (this.isOpen && this.ws.readyState === WebSocket.OPEN) {
            // WebSocket.send() copies the buffer, so this is safe
            this.ws.send(data);
        }
        else if (this.ws.readyState === WebSocket.CONNECTING) {
            // Queue messages sent before connection is established
            this.pendingMessages.push(data);
        }
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    onOpen(handler) {
        this.openHandler = handler;
    }
    onClose(handler) {
        this.closeHandler = handler;
    }
    onError(handler) {
        this.errorHandler = handler;
    }
    close() {
        this.ws.close();
    }
}

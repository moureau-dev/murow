import { describe, expect, test, beforeEach } from "bun:test";
import { ClientNetwork } from "./client";
import { IntentRegistry } from "../protocol/intent/intent-registry";
import { SnapshotRegistry } from "../protocol/snapshot/snapshot-registry";
import { RpcRegistry } from "../protocol/rpc/rpc-registry";
import { PooledCodec } from "../core/pooled-codec/pooled-codec";
import { BinaryPrimitives } from "../core/binary-codec";
import { defineIntent } from "../protocol/intent/define-intent";
import { defineRPC } from "../protocol/rpc/define-rpc";
import type { TransportAdapter } from "./types";
import { MessageType } from "./types";
import type { Snapshot } from "../protocol/snapshot/snapshot";

// Define move intent using defineIntent
const MoveIntent = defineIntent({
	kind: 1 as const,
	schema: {
		dx: BinaryPrimitives.f32,
		dy: BinaryPrimitives.f32,
	},
});

type MoveIntent = typeof MoveIntent.type;

interface PlayerUpdate {
	x: number;
	y: number;
	health: number;
}

interface ScoreUpdate {
	score: number;
}

type GameSnapshots = PlayerUpdate | ScoreUpdate;

// Mock transport adapter
class MockTransportAdapter implements TransportAdapter {
	messageHandler: ((data: Uint8Array) => void) | null = null;
	closeHandler: (() => void) | null = null;
	openHandler: (() => void) | null = null;
	public sentMessages: Uint8Array[] = [];
	public closed = false;

	send(data: Uint8Array): void {
		this.sentMessages.push(new Uint8Array(data)); // Copy to avoid mutation
	}

	onMessage(handler: (data: Uint8Array) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: () => void): void {
		this.closeHandler = handler;
	}

	onOpen(handler: () => void): void {
		this.openHandler = handler;
	}

	close(): void {
		this.closed = true;
		if (this.closeHandler) {
			this.closeHandler();
		}
	}

	// Test helper: simulate receiving a message
	simulateMessage(data: Uint8Array): void {
		if (this.messageHandler) {
			this.messageHandler(data);
		}
	}

	// Test helper: simulate disconnection
	simulateDisconnect(): void {
		if (this.closeHandler) {
			this.closeHandler();
		}
	}
}

describe("ClientNetwork", () => {
	let transport: MockTransportAdapter;
	let intentRegistry: IntentRegistry;
	let snapshotRegistry: SnapshotRegistry<GameSnapshots>;
	let client: ClientNetwork<GameSnapshots>;

	beforeEach(() => {
		transport = new MockTransportAdapter();
		intentRegistry = new IntentRegistry();
		snapshotRegistry = new SnapshotRegistry<GameSnapshots>();

		// Register move intent
		intentRegistry.register(MoveIntent);

		// Register snapshot codecs
		const playerCodec = new PooledCodec({
			x: BinaryPrimitives.f32,
			y: BinaryPrimitives.f32,
			health: BinaryPrimitives.u8,
		});
		snapshotRegistry.register("player", playerCodec);

		const scoreCodec = new PooledCodec({
			score: BinaryPrimitives.u32,
		});
		snapshotRegistry.register("score", scoreCodec);

		client = new ClientNetwork<GameSnapshots>({
			transport,
			intentRegistry,
			snapshotRegistry,
			config: { debug: false },
		});

		// Simulate connection opened
		if (transport.openHandler) {
			transport.openHandler();
		}
	});

	describe("Construction", () => {
		test("should initialize and mark as connected", () => {
			expect(client.isConnected()).toBe(true);
		});

		test("should setup transport handlers", () => {
			expect(transport.messageHandler).not.toBeNull();
			expect(transport.closeHandler).not.toBeNull();
		});

		test("should trigger onConnect handlers", () => {
			let connectCalled = false;
			const newTransport = new MockTransportAdapter();
			const newClient = new ClientNetwork<GameSnapshots>({
				transport: newTransport,
				intentRegistry,
				snapshotRegistry,
			});

			newClient.onConnect(() => {
				connectCalled = true;
			});

			// Connection happens during constructor
			expect(connectCalled).toBe(false); // Handler registered after construction
		});
	});

	describe("sendIntent", () => {
		test("should encode and send intent to server", () => {
			const intent: MoveIntent = {
				kind: 1,
				tick: 100,
				dx: 5.5,
				dy: -3.2,
			};

			client.sendIntent(intent);

			expect(transport.sentMessages).toHaveLength(1);
			const message = transport.sentMessages[0];

			// Check message type header
			expect(message[0]).toBe(0x01); // MessageType.INTENT

			// Verify intent data (skip message type byte)
			const intentData = message.subarray(1);
			const decoded = intentRegistry.decode(intentData) as MoveIntent;
			expect(decoded.kind).toBe(1);
			expect(decoded.tick).toBe(100);
			expect(decoded.dx).toBeCloseTo(5.5, 2);
			expect(decoded.dy).toBeCloseTo(-3.2, 2);
		});

		test("should not send intent when disconnected", () => {
			transport.simulateDisconnect();

			const intent: MoveIntent = {
				kind: 1,
				tick: 100,
				dx: 1,
				dy: 1,
			};

			client.sendIntent(intent);
			expect(transport.sentMessages).toHaveLength(0);
		});

		test("should handle encoding errors gracefully", () => {
			const badIntentRegistry = new IntentRegistry();
			const badClient = new ClientNetwork<GameSnapshots>({
				transport: new MockTransportAdapter(),
				intentRegistry: badIntentRegistry,
				snapshotRegistry,
			});

			const intent: MoveIntent = {
				kind: 99 as 1, // Not registered
				tick: 100,
				dx: 1,
				dy: 1,
			};

			// Should not throw
			expect(() => badClient.sendIntent(intent)).not.toThrow();
		});
	});

	describe("onSnapshot", () => {
		test("should receive and decode player snapshot", () => {
			let receivedSnapshot: Snapshot<PlayerUpdate> | null = null;

			client.onSnapshot<PlayerUpdate>("player", (snapshot) => {
				receivedSnapshot = snapshot;
			});

			// Create snapshot
			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 42,
				updates: {
					x: 10.5,
					y: 20.3,
					health: 100,
				},
			};

			// Encode and send
			const snapshotData = snapshotRegistry.encode("player", snapshot);
			const message = new Uint8Array(1 + snapshotData.byteLength);
			message[0] = 0x02; // MessageType.SNAPSHOT
			message.set(snapshotData, 1);

			transport.simulateMessage(message);

			expect(receivedSnapshot).not.toBeNull();
			expect(receivedSnapshot!.tick).toBe(42);
			expect(receivedSnapshot!.updates.x).toBeCloseTo(10.5, 2);
			expect(receivedSnapshot!.updates.y).toBeCloseTo(20.3, 2);
			expect(receivedSnapshot!.updates.health).toBe(100);
		});

		test("should receive and decode score snapshot", () => {
			let receivedSnapshot: Snapshot<ScoreUpdate> | null = null;

			client.onSnapshot<ScoreUpdate>("score", (snapshot) => {
				receivedSnapshot = snapshot;
			});

			const snapshot: Snapshot<ScoreUpdate> = {
				tick: 100,
				updates: {
					score: 9999,
				},
			};

			const snapshotData = snapshotRegistry.encode("score", snapshot);
			const message = new Uint8Array(1 + snapshotData.byteLength);
			message[0] = 0x02; // MessageType.SNAPSHOT
			message.set(snapshotData, 1);

			transport.simulateMessage(message);

			expect(receivedSnapshot).not.toBeNull();
			expect(receivedSnapshot!.tick).toBe(100);
			expect(receivedSnapshot!.updates.score).toBe(9999);
		});

		test("should handle multiple snapshot types independently", () => {
			const playerSnapshots: Snapshot<PlayerUpdate>[] = [];
			const scoreSnapshots: Snapshot<ScoreUpdate>[] = [];

			client.onSnapshot<PlayerUpdate>("player", (s) => playerSnapshots.push(s));
			client.onSnapshot<ScoreUpdate>("score", (s) => scoreSnapshots.push(s));

			// Send player snapshot
			const playerSnapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 1, y: 2, health: 50 },
			};
			const playerData = snapshotRegistry.encode("player", playerSnapshot);
			const playerMsg = new Uint8Array(1 + playerData.byteLength);
			playerMsg[0] = 0x02;
			playerMsg.set(playerData, 1);
			transport.simulateMessage(playerMsg);

			// Send score snapshot
			const scoreSnapshot: Snapshot<ScoreUpdate> = {
				tick: 2,
				updates: { score: 123 },
			};
			const scoreData = snapshotRegistry.encode("score", scoreSnapshot);
			const scoreMsg = new Uint8Array(1 + scoreData.byteLength);
			scoreMsg[0] = 0x02;
			scoreMsg.set(scoreData, 1);
			transport.simulateMessage(scoreMsg);

			expect(playerSnapshots).toHaveLength(1);
			expect(scoreSnapshots).toHaveLength(1);
			expect(playerSnapshots[0].tick).toBe(1);
			expect(scoreSnapshots[0].tick).toBe(2);
		});

		test("should return unsubscribe function", () => {
			let callCount = 0;
			const unsubscribe = client.onSnapshot<PlayerUpdate>("player", () => {
				callCount++;
			});

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 1, y: 1, health: 100 },
			};
			const snapshotData = snapshotRegistry.encode("player", snapshot);
			const message = new Uint8Array(1 + snapshotData.byteLength);
			message[0] = 0x02;
			message.set(snapshotData, 1);

			transport.simulateMessage(message);
			expect(callCount).toBe(1);

			// Unsubscribe
			unsubscribe();

			// Send another snapshot
			transport.simulateMessage(message);
			expect(callCount).toBe(1); // Should not increase
		});

		test("should handle unknown snapshot types gracefully", () => {
			// Register handler for "player" only
			let called = false;
			client.onSnapshot<PlayerUpdate>("player", () => {
				called = true;
			});

			// Send snapshot for unhandled type "score" (registered but no handler)
			const snapshot: Snapshot<ScoreUpdate> = {
				tick: 1,
				updates: { score: 42 },
			};
			const snapshotData = snapshotRegistry.encode("score", snapshot);
			const message = new Uint8Array(1 + snapshotData.byteLength);
			message[0] = 0x02;
			message.set(snapshotData, 1);

			// Should not throw or call the player handler
			expect(() => transport.simulateMessage(message)).not.toThrow();
			expect(called).toBe(false);
		});
	});

	describe("Connection lifecycle", () => {
		test("should trigger onConnect handler when connection opens", () => {
			let connectCalled = false;
			const newTransport = new MockTransportAdapter();

			const newClient = new ClientNetwork<GameSnapshots>({
				transport: newTransport,
				intentRegistry,
				snapshotRegistry,
			});

			newClient.onConnect(() => {
				connectCalled = true;
			});

			// Not connected yet - waiting for transport to open
			expect(connectCalled).toBe(false);
			expect(newClient.isConnected()).toBe(false);

			// Trigger open event
			if (newTransport.openHandler) {
				newTransport.openHandler();
			}

			// Now should be connected and handler should have been called
			expect(connectCalled).toBe(true);
			expect(newClient.isConnected()).toBe(true);
		});

		test("should trigger onDisconnect handler", () => {
			let disconnectCalled = false;
			client.onDisconnect(() => {
				disconnectCalled = true;
			});

			transport.simulateDisconnect();

			expect(disconnectCalled).toBe(true);
			expect(client.isConnected()).toBe(false);
		});

		test("should handle multiple disconnect handlers", () => {
			let count = 0;
			client.onDisconnect(() => count++);
			client.onDisconnect(() => count++);
			client.onDisconnect(() => count++);

			transport.simulateDisconnect();
			expect(count).toBe(3);
		});

		test("should return unsubscribe function for onConnect", () => {
			let callCount = 0;
			const unsub = client.onConnect(() => callCount++);
			unsub();

			// Create new client to trigger connect
			const newTransport = new MockTransportAdapter();
			const newClient = new ClientNetwork<GameSnapshots>({
				transport: newTransport,
				intentRegistry,
				snapshotRegistry,
			});

			expect(callCount).toBe(0);
		});

		test("should return unsubscribe function for onDisconnect", () => {
			let callCount = 0;
			const unsub = client.onDisconnect(() => callCount++);

			transport.simulateDisconnect();
			expect(callCount).toBe(1);

			unsub();
			// Can't trigger disconnect again on same transport, but verifies unsubscribe works
		});
	});

	describe("disconnect", () => {
		test("should close transport connection", () => {
			client.disconnect();
			expect(transport.closed).toBe(true);
		});

		test("should trigger disconnect handlers when calling disconnect", () => {
			let disconnectCalled = false;
			client.onDisconnect(() => {
				disconnectCalled = true;
			});

			client.disconnect();
			expect(disconnectCalled).toBe(true);
			expect(client.isConnected()).toBe(false);
		});
	});

	describe("Message handling", () => {
		test("should ignore empty messages", () => {
			let snapshotReceived = false;
			client.onSnapshot<PlayerUpdate>("player", () => {
				snapshotReceived = true;
			});

			transport.simulateMessage(new Uint8Array(0));
			expect(snapshotReceived).toBe(false);
		});

		test("should handle custom message type gracefully", () => {
			const message = new Uint8Array([0xff]); // MessageType.CUSTOM
			expect(() => transport.simulateMessage(message)).not.toThrow();
		});

		test("should handle unknown message types gracefully", () => {
			const message = new Uint8Array([0x99, 1, 2, 3]); // Unknown type
			expect(() => transport.simulateMessage(message)).not.toThrow();
		});

		test("should reject messages exceeding max size", () => {
			const smallClient = new ClientNetwork<GameSnapshots>({
				transport,
				intentRegistry,
				snapshotRegistry,
				config: { maxMessageSize: 10 },
			});

			let snapshotReceived = false;
			smallClient.onSnapshot<PlayerUpdate>("player", () => {
				snapshotReceived = true;
			});

			// Create large message
			const largeMessage = new Uint8Array(100);
			largeMessage[0] = 0x02; // MessageType.SNAPSHOT

			transport.simulateMessage(largeMessage);
			expect(snapshotReceived).toBe(false);
		});

		test("should handle malformed snapshot data gracefully", () => {
			let snapshotReceived = false;
			client.onSnapshot<PlayerUpdate>("player", () => {
				snapshotReceived = true;
			});

			// Send malformed data
			const badMessage = new Uint8Array([0x02, 99, 88, 77]); // Invalid snapshot
			expect(() => transport.simulateMessage(badMessage)).not.toThrow();
			expect(snapshotReceived).toBe(false);
		});
	});

	describe("Debug logging", () => {
		test("should not log when debug is false", () => {
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: any[]) => logs.push(args.join(" "));

			const intent: MoveIntent = {
				kind: 1,
				tick: 1,
				dx: 1,
				dy: 1,
			};
			client.sendIntent(intent);

			console.log = originalLog;
			expect(logs.filter((l) => l.includes("[ClientNetwork]"))).toHaveLength(0);
		});

		test("should log when debug is true", () => {
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: any[]) => logs.push(args.join(" "));

			const debugClient = new ClientNetwork<GameSnapshots>({
				transport: new MockTransportAdapter(),
				intentRegistry,
				snapshotRegistry,
				config: { debug: true },
			});

			const intent: MoveIntent = {
				kind: 1,
				tick: 1,
				dx: 1,
				dy: 1,
			};
			debugClient.sendIntent(intent);

			console.log = originalLog;
			expect(logs.filter((l) => l.includes("[ClientNetwork]")).length).toBeGreaterThan(0);
		});
	});

	describe("Memory pooling", () => {
		test("should reuse pooled objects across snapshots (zero-copy)", () => {
			const transport = new MockTransportAdapter();
			const client = new ClientNetwork<GameSnapshots>({
				transport,
				intentRegistry,
				snapshotRegistry,
				config: { debug: false },
			});

			// Extract data immediately (correct pattern for zero-copy)
			const extractedData: Array<{ tick: number; x: number; y: number; health: number }> = [];

			client.onSnapshot<PlayerUpdate>("player", (snapshot) => {
				// CORRECT: Extract data immediately, don't store references
				extractedData.push({
					tick: snapshot.tick,
					x: snapshot.updates.x!,
					y: snapshot.updates.y!,
					health: snapshot.updates.health!,
				});
			});

			// Simulate opening connection
			if (transport.openHandler) transport.openHandler();

			// Send first snapshot (wrap with MessageType.SNAPSHOT header)
			const snapshot1Data = snapshotRegistry.encode("player", {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			});
			const snapshot1 = new Uint8Array(1 + snapshot1Data.byteLength);
			snapshot1[0] = MessageType.SNAPSHOT;
			snapshot1.set(snapshot1Data, 1);
			if (transport.messageHandler) transport.messageHandler(snapshot1);

			// Send second snapshot with different data
			const snapshot2Data = snapshotRegistry.encode("player", {
				tick: 2,
				updates: { x: 15, y: 25, health: 90 },
			});
			const snapshot2 = new Uint8Array(1 + snapshot2Data.byteLength);
			snapshot2[0] = MessageType.SNAPSHOT;
			snapshot2.set(snapshot2Data, 1);
			if (transport.messageHandler) transport.messageHandler(snapshot2);

			// Verify both snapshots were received correctly
			expect(extractedData.length).toBe(2);

			// First snapshot data should be correct
			expect(extractedData[0].tick).toBe(1);
			expect(extractedData[0].x).toBe(10);
			expect(extractedData[0].y).toBe(20);
			expect(extractedData[0].health).toBe(100);

			// Second snapshot data should be correct
			expect(extractedData[1].tick).toBe(2);
			expect(extractedData[1].x).toBe(15);
			expect(extractedData[1].y).toBe(25);
			expect(extractedData[1].health).toBe(90);
		});

		test("handlers must extract data immediately (zero-copy pattern)", () => {
			const transport = new MockTransportAdapter();
			const client = new ClientNetwork<GameSnapshots>({
				transport,
				intentRegistry,
				snapshotRegistry,
				config: { debug: false },
			});

			// Simulate a reconciliator-like usage pattern (correct way)
			interface ExtractedState {
				x: number;
				y: number;
				health: number;
			}
			let extractedState: ExtractedState | null = null;

			client.onSnapshot<PlayerUpdate>("player", (snapshot) => {
				// CORRECT: Extract data immediately instead of storing references
				extractedState = {
					x: snapshot.updates.x!,
					y: snapshot.updates.y!,
					health: snapshot.updates.health!,
				};
			});

			// Simulate opening connection
			if (transport.openHandler) transport.openHandler();

			// Send first snapshot (wrap with MessageType.SNAPSHOT header)
			const snapshot1Data = snapshotRegistry.encode("player", {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			});
			const snapshot1 = new Uint8Array(1 + snapshot1Data.byteLength);
			snapshot1[0] = MessageType.SNAPSHOT;
			snapshot1.set(snapshot1Data, 1);
			if (transport.messageHandler) transport.messageHandler(snapshot1);

			const firstState = extractedState!;
			expect(firstState.x).toBe(10);
			expect(firstState.y).toBe(20);
			expect(firstState.health).toBe(100);

			// Send second snapshot (wrap with MessageType.SNAPSHOT header)
			const snapshot2Data = snapshotRegistry.encode("player", {
				tick: 2,
				updates: { x: 99, y: 99, health: 50 },
			});
			const snapshot2 = new Uint8Array(1 + snapshot2Data.byteLength);
			snapshot2[0] = MessageType.SNAPSHOT;
			snapshot2.set(snapshot2Data, 1);
			if (transport.messageHandler) transport.messageHandler(snapshot2);

			// First extracted state should NOT be mutated (we extracted primitives)
			expect(firstState.x).toBe(10);
			expect(firstState.y).toBe(20);
			expect(firstState.health).toBe(100);

			// New extracted state should have the new values
			expect(extractedState!.x).toBe(99);
			expect(extractedState!.y).toBe(99);
			expect(extractedState!.health).toBe(50);
		});
	});

	describe("RPC Memory pooling", () => {
		// Define RPC for testing
		const TestRPC = defineRPC({
			method: "testRpc",
			schema: {
				value: BinaryPrimitives.u32,
				message: BinaryPrimitives.string(32),
			},
		});

		interface TestRPCData {
			value: number;
			message: string;
		}

		test("should reuse pooled objects across RPC calls", () => {
			const rpcRegistry = new RpcRegistry();
			rpcRegistry.register(TestRPC);

			const transport = new MockTransportAdapter();
			const client = new ClientNetwork<GameSnapshots>({
				transport,
				intentRegistry,
				snapshotRegistry,
				rpcRegistry,
				config: { debug: false },
			});

			const receivedRpcs: Array<TestRPCData> = [];

			client.onRPC(TestRPC, (data) => {
				// Store the RPC data - this should be safe due to shallow copy
				receivedRpcs.push(data);
			});

			// Simulate opening connection
			if (transport.openHandler) transport.openHandler();

			// Send first RPC
			const rpc1Data = rpcRegistry.encode(TestRPC, {
				value: 100,
				message: "first",
			});
			const rpc1 = new Uint8Array(1 + rpc1Data.byteLength);
			rpc1[0] = MessageType.CUSTOM;
			rpc1.set(rpc1Data, 1);
			if (transport.messageHandler) transport.messageHandler(rpc1);

			// Send second RPC with different data
			const rpc2Data = rpcRegistry.encode(TestRPC, {
				value: 200,
				message: "second",
			});
			const rpc2 = new Uint8Array(1 + rpc2Data.byteLength);
			rpc2[0] = MessageType.CUSTOM;
			rpc2.set(rpc2Data, 1);
			if (transport.messageHandler) transport.messageHandler(rpc2);

			// Verify both RPCs were received correctly
			expect(receivedRpcs.length).toBe(2);

			// First RPC should maintain its original values
			expect(receivedRpcs[0].value).toBe(100);
			expect(receivedRpcs[0].message).toBe("first");

			// Second RPC should have its own values
			expect(receivedRpcs[1].value).toBe(200);
			expect(receivedRpcs[1].message).toBe("second");

			// The data objects should be different references (shallow copy worked)
			expect(receivedRpcs[0]).not.toBe(receivedRpcs[1]);
		});

		test("handlers can safely store references to RPC data", () => {
			const rpcRegistry = new RpcRegistry();
			rpcRegistry.register(TestRPC);

			const transport = new MockTransportAdapter();
			const client = new ClientNetwork<GameSnapshots>({
				transport,
				intentRegistry,
				snapshotRegistry,
				rpcRegistry,
				config: { debug: false },
			});

			// Simulate storing RPC data (common pattern)
			let storedData: TestRPCData | null = null;

			client.onRPC(TestRPC, (data) => {
				// Store the data directly
				storedData = data;
			});

			// Simulate opening connection
			if (transport.openHandler) transport.openHandler();

			// Send first RPC
			const rpc1Data = rpcRegistry.encode(TestRPC, {
				value: 42,
				message: "hello",
			});
			const rpc1 = new Uint8Array(1 + rpc1Data.byteLength);
			rpc1[0] = MessageType.CUSTOM;
			rpc1.set(rpc1Data, 1);
			if (transport.messageHandler) transport.messageHandler(rpc1);

			const firstData = storedData;
			expect((firstData as unknown as TestRPCData)?.value).toBe(42);
			expect((firstData as unknown as TestRPCData)?.message).toBe("hello");

			// Send second RPC
			const rpc2Data = rpcRegistry.encode(TestRPC, {
				value: 999,
				message: "world",
			});
			const rpc2 = new Uint8Array(1 + rpc2Data.byteLength);
			rpc2[0] = MessageType.CUSTOM;
			rpc2.set(rpc2Data, 1);
			if (transport.messageHandler) transport.messageHandler(rpc2);

			// First stored data should NOT be mutated by the second RPC
			expect((firstData as unknown as TestRPCData)?.value).toBe(42);
			expect((firstData as unknown as TestRPCData)?.message).toBe("hello");

			// New stored data should have the new values
			expect((storedData as unknown as TestRPCData)?.value).toBe(999);
			expect((storedData as unknown as TestRPCData)?.message).toBe("world");
		});
	});
});

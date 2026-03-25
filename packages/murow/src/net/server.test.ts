import { describe, expect, test, beforeEach } from "bun:test";
import { ServerNetwork } from "./server";
import { IntentRegistry } from "../protocol/intent/intent-registry";
import { SnapshotRegistry } from "../protocol/snapshot/snapshot-registry";
import { PooledCodec } from "../core/pooled-codec/pooled-codec";
import { BinaryPrimitives } from "../core/binary-codec";
import { defineIntent } from "../protocol/intent/define-intent";
import type { TransportAdapter, ServerTransportAdapter } from "./types";
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

// Mock peer transport
class MockPeerTransport implements TransportAdapter {
	messageHandler: ((data: Uint8Array) => void) | null = null;
	private closeHandler: (() => void) | null = null;
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
}

// Mock server transport
class MockServerTransport implements ServerTransportAdapter<MockPeerTransport> {
	private connectionHandler: ((peer: MockPeerTransport, peerId: string) => void) | null = null;
	private disconnectionHandler: ((peerId: string) => void) | null = null;
	private peers = new Map<string, MockPeerTransport>();
	public closed = false;

	onConnection(handler: (peer: MockPeerTransport, peerId: string) => void): void {
		this.connectionHandler = handler;
	}

	onDisconnection(handler: (peerId: string) => void): void {
		this.disconnectionHandler = handler;
	}

	getPeer(peerId: string): MockPeerTransport | undefined {
		return this.peers.get(peerId);
	}

	getPeerIds(): string[] {
		return Array.from(this.peers.keys());
	}

	close(): void {
		this.closed = true;
	}

	// Test helpers
	simulateConnection(peerId: string): MockPeerTransport {
		const peer = new MockPeerTransport();
		this.peers.set(peerId, peer);
		if (this.connectionHandler) {
			this.connectionHandler(peer, peerId);
		}
		return peer;
	}

	simulateDisconnection(peerId: string): void {
		this.peers.delete(peerId);
		if (this.disconnectionHandler) {
			this.disconnectionHandler(peerId);
		}
	}
}

describe("ServerNetwork", () => {
	let transport: MockServerTransport;
	let intentRegistry: IntentRegistry;
	let server: ServerNetwork<MockPeerTransport, GameSnapshots>;

	beforeEach(() => {
		transport = new MockServerTransport();
		intentRegistry = new IntentRegistry();

		// Register move intent
		intentRegistry.register(MoveIntent);

		server = new ServerNetwork<MockPeerTransport, GameSnapshots>({
			transport,
			intentRegistry,
			createPeerSnapshotRegistry: () => {
				const registry = new SnapshotRegistry<GameSnapshots>();

				const playerCodec = new PooledCodec({
					x: BinaryPrimitives.f32,
					y: BinaryPrimitives.f32,
					health: BinaryPrimitives.u8,
				});
				registry.register("player", playerCodec);

				const scoreCodec = new PooledCodec({
					score: BinaryPrimitives.u32,
				});
				registry.register("score", scoreCodec);

				return registry;
			},
			config: { debug: false },
		});
	});

	describe("Peer connection lifecycle", () => {
		test("should handle new peer connection", () => {
			const peer = transport.simulateConnection("peer1");

			expect(server.getPeerIds()).toEqual(["peer1"]);
			expect(server.getPeerState("peer1")).toBeDefined();
			expect(server.getPeerSnapshotRegistry("peer1")).toBeDefined();
		});

		test("should create peer-specific snapshot registry", () => {
			transport.simulateConnection("peer1");
			transport.simulateConnection("peer2");

			const registry1 = server.getPeerSnapshotRegistry("peer1");
			const registry2 = server.getPeerSnapshotRegistry("peer2");

			expect(registry1).toBeDefined();
			expect(registry2).toBeDefined();
			expect(registry1).not.toBe(registry2); // Each peer has own registry
		});

		test("should trigger onConnection handlers", () => {
			const connectedPeers: string[] = [];
			server.onConnection((peerId) => {
				connectedPeers.push(peerId);
			});

			transport.simulateConnection("peer1");
			transport.simulateConnection("peer2");

			expect(connectedPeers).toEqual(["peer1", "peer2"]);
		});

		test("should setup message handler for peer", () => {
			const peer = transport.simulateConnection("peer1");
			expect(peer.messageHandler).not.toBeNull();
		});

		test("should initialize peer state correctly", () => {
			transport.simulateConnection("peer1");
			const state = server.getPeerState("peer1");

			expect(state).toBeDefined();
			expect(state!.peerId).toBe("peer1");
			expect(state!.lastSentTick).toBe(0);
			expect(state!.connectedAt).toBeGreaterThan(0);
			expect(state!.metadata).toEqual({});
		});

		test("should handle peer disconnection", () => {
			transport.simulateConnection("peer1");
			expect(server.getPeerIds()).toHaveLength(1);

			transport.simulateDisconnection("peer1");
			expect(server.getPeerIds()).toHaveLength(0);
			expect(server.getPeerState("peer1")).toBeUndefined();
			expect(server.getPeerSnapshotRegistry("peer1")).toBeUndefined();
		});

		test("should trigger onDisconnection handlers", () => {
			const disconnectedPeers: string[] = [];
			server.onDisconnection((peerId) => {
				disconnectedPeers.push(peerId);
			});

			transport.simulateConnection("peer1");
			transport.simulateConnection("peer2");
			transport.simulateDisconnection("peer1");

			expect(disconnectedPeers).toEqual(["peer1"]);
			expect(server.getPeerIds()).toEqual(["peer2"]);
		});

		test("should handle multiple connection/disconnection handlers", () => {
			let connectCount = 0;
			let disconnectCount = 0;

			server.onConnection(() => connectCount++);
			server.onConnection(() => connectCount++);
			server.onDisconnection(() => disconnectCount++);
			server.onDisconnection(() => disconnectCount++);

			transport.simulateConnection("peer1");
			transport.simulateDisconnection("peer1");

			expect(connectCount).toBe(2);
			expect(disconnectCount).toBe(2);
		});
	});

	describe("Intent handling", () => {
		test("should receive and decode intent from peer", () => {
			const receivedIntents: Array<{ peerId: string; intent: MoveIntent }> = [];
			server.onIntent<MoveIntent>(MoveIntent, (peerId, intent) => {
				receivedIntents.push({ peerId, intent });
			});

			const peer = transport.simulateConnection("peer1");

			// Encode intent
			const intent: MoveIntent = {
				kind: 1,
				tick: 42,
				dx: 10.5,
				dy: -5.3,
			};
			const intentData = intentRegistry.encode(intent);

			// Wrap with message type header
			const message = new Uint8Array(1 + intentData.byteLength);
			message[0] = 0x01; // MessageType.INTENT
			message.set(intentData, 1);

			peer.simulateMessage(message);

			expect(receivedIntents).toHaveLength(1);
			expect(receivedIntents[0].peerId).toBe("peer1");
			expect(receivedIntents[0].intent.kind).toBe(1);
			expect(receivedIntents[0].intent.tick).toBe(42);
			expect(receivedIntents[0].intent.dx).toBeCloseTo(10.5, 2);
			expect(receivedIntents[0].intent.dy).toBeCloseTo(-5.3, 2);
		});

		test("should handle intents from multiple peers", () => {
			const receivedIntents: Array<{ peerId: string; intent: MoveIntent }> = [];
			server.onIntent<MoveIntent>(MoveIntent, (peerId, intent) => {
				receivedIntents.push({ peerId, intent });
			});

			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");

			// Send intent from peer1
			const intent1: MoveIntent = { kind: 1, tick: 1, dx: 1, dy: 1 };
			const intentData1 = intentRegistry.encode(intent1);
			const message1 = new Uint8Array(1 + intentData1.byteLength);
			message1[0] = 0x01;
			message1.set(intentData1, 1);
			peer1.simulateMessage(message1);

			// Send intent from peer2
			const intent2: MoveIntent = { kind: 1, tick: 2, dx: 2, dy: 2 };
			const intentData2 = intentRegistry.encode(intent2);
			const message2 = new Uint8Array(1 + intentData2.byteLength);
			message2[0] = 0x01;
			message2.set(intentData2, 1);
			peer2.simulateMessage(message2);

			expect(receivedIntents).toHaveLength(2);
			expect(receivedIntents[0].peerId).toBe("peer1");
			expect(receivedIntents[1].peerId).toBe("peer2");
		});

		test("should handle missing intent handler gracefully", () => {
			const peer = transport.simulateConnection("peer1");

			const intent: MoveIntent = { kind: 1, tick: 1, dx: 1, dy: 1 };
			const intentData = intentRegistry.encode(intent);
			const message = new Uint8Array(1 + intentData.byteLength);
			message[0] = 0x01;
			message.set(intentData, 1);

			// No handler registered - should not throw
			expect(() => peer.simulateMessage(message)).not.toThrow();
		});

		test("should handle malformed intent data gracefully", () => {
			server.onIntent<MoveIntent>(MoveIntent, () => {});
			const peer = transport.simulateConnection("peer1");

			// Send malformed intent
			const badMessage = new Uint8Array([0x01, 99, 88, 77]);
			expect(() => peer.simulateMessage(badMessage)).not.toThrow();
		});
	});

	describe("sendSnapshotToPeer", () => {
		test("should send snapshot to specific peer", () => {
			const peer = transport.simulateConnection("peer1");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 100,
				updates: {
					x: 50.5,
					y: 100.2,
					health: 80,
				},
			};

			server.sendSnapshotToPeer("peer1", "player", snapshot);

			expect(peer.sentMessages).toHaveLength(1);
			const message = peer.sentMessages[0];

			// Check message type header
			expect(message[0]).toBe(0x02); // MessageType.SNAPSHOT

			// Decode and verify
			const snapshotData = message.subarray(1);
			const registry = server.getPeerSnapshotRegistry("peer1")!;
			const decoded = registry.decode<PlayerUpdate>(snapshotData);

			expect(decoded.type).toBe("player");
			expect(decoded.snapshot.tick).toBe(100);
			expect(decoded.snapshot.updates.x).toBeCloseTo(50.5, 2);
			expect(decoded.snapshot.updates.y).toBeCloseTo(100.2, 2);
			expect(decoded.snapshot.updates.health).toBe(80);
		});

		test("should update peer lastSentTick", () => {
			transport.simulateConnection("peer1");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 100,
				updates: { x: 1, y: 2, health: 100 },
			};

			server.sendSnapshotToPeer("peer1", "player", snapshot);

			const state = server.getPeerState("peer1");
			expect(state!.lastSentTick).toBe(100);
		});

		test("should handle sending to unknown peer gracefully", () => {
			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 100,
				updates: { x: 1, y: 2, health: 100 },
			};

			// Should not throw
			expect(() => server.sendSnapshotToPeer("unknown", "player", snapshot)).not.toThrow();
		});

		test("should throw if peer has no snapshot registry", () => {
			// This shouldn't happen in normal usage, but test defensive code
			const peer = transport.simulateConnection("peer1");

			// Manually remove registry to simulate edge case
			(server as any).peerSnapshotRegistries.delete("peer1");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 100,
				updates: { x: 1, y: 2, health: 100 },
			};

			expect(() => server.sendSnapshotToPeer("peer1", "player", snapshot)).toThrow(
				"No snapshot registry registered for peer: peer1"
			);
		});
	});

	describe("broadcastSnapshot", () => {
		test("should send snapshot to all connected peers", () => {
			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");
			const peer3 = transport.simulateConnection("peer3");

			const snapshot: Snapshot<ScoreUpdate> = {
				tick: 50,
				updates: { score: 9999 },
			};

			server.broadcastSnapshot("score", snapshot);

			expect(peer1.sentMessages).toHaveLength(1);
			expect(peer2.sentMessages).toHaveLength(1);
			expect(peer3.sentMessages).toHaveLength(1);

			// Verify all peers received same snapshot
			for (const peer of [peer1, peer2, peer3]) {
				const message = peer.sentMessages[0];
				expect(message[0]).toBe(0x02); // MessageType.SNAPSHOT
			}
		});

		test("should use peer-specific registries for encoding", () => {
			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 100,
				updates: { x: 10, y: 20, health: 100 },
			};

			server.broadcastSnapshot("player", snapshot);

			// Each peer should receive encoded snapshot
			const registry1 = server.getPeerSnapshotRegistry("peer1")!;
			const registry2 = server.getPeerSnapshotRegistry("peer2")!;

			const decoded1 = registry1.decode<PlayerUpdate>(peer1.sentMessages[0].subarray(1));
			const decoded2 = registry2.decode<PlayerUpdate>(peer2.sentMessages[0].subarray(1));

			expect(decoded1.snapshot.tick).toBe(100);
			expect(decoded2.snapshot.tick).toBe(100);
		});

		test("should respect filter function", () => {
			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");
			const peer3 = transport.simulateConnection("peer3");

			const snapshot: Snapshot<ScoreUpdate> = {
				tick: 50,
				updates: { score: 100 },
			};

			// Only send to peer2 and peer3
			server.broadcastSnapshot("score", snapshot, (peerId) => peerId !== "peer1");

			expect(peer1.sentMessages).toHaveLength(0);
			expect(peer2.sentMessages).toHaveLength(1);
			expect(peer3.sentMessages).toHaveLength(1);
		});

		test("should handle empty peer list gracefully", () => {
			const snapshot: Snapshot<ScoreUpdate> = {
				tick: 1,
				updates: { score: 0 },
			};

			// No peers connected - should not throw
			expect(() => server.broadcastSnapshot("score", snapshot)).not.toThrow();
		});
	});

	describe("broadcastSnapshotWithCustomization", () => {
		test("should customize snapshot for each peer", () => {
			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");

			const baseSnapshot: Snapshot<PlayerUpdate> = {
				tick: 100,
				updates: { x: 10, y: 20, health: 100 },
			};

			// Customize: double the x coordinate for each peer
			server.broadcastSnapshotWithCustomization("player", baseSnapshot, (peerId, snapshot) => {
				return {
					tick: snapshot.tick,
					updates: {
						...snapshot.updates,
						x: snapshot.updates.x! * 2,
					},
				};
			});

			const registry1 = server.getPeerSnapshotRegistry("peer1")!;
			const registry2 = server.getPeerSnapshotRegistry("peer2")!;

			const decoded1 = registry1.decode<PlayerUpdate>(peer1.sentMessages[0].subarray(1));
			const decoded2 = registry2.decode<PlayerUpdate>(peer2.sentMessages[0].subarray(1));

			expect(decoded1.snapshot.updates.x).toBeCloseTo(20, 2); // 10 * 2
			expect(decoded2.snapshot.updates.x).toBeCloseTo(20, 2); // 10 * 2
		});

		test("should allow different customization per peer", () => {
			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");

			const baseSnapshot: Snapshot<ScoreUpdate> = {
				tick: 100,
				updates: { score: 100 },
			};

			// Give peer1 double score, peer2 triple score
			server.broadcastSnapshotWithCustomization("score", baseSnapshot, (peerId, snapshot) => {
				const multiplier = peerId === "peer1" ? 2 : 3;
				return {
					tick: snapshot.tick,
					updates: {
						score: snapshot.updates.score! * multiplier,
					},
				};
			});

			const registry1 = server.getPeerSnapshotRegistry("peer1")!;
			const registry2 = server.getPeerSnapshotRegistry("peer2")!;

			const decoded1 = registry1.decode<ScoreUpdate>(peer1.sentMessages[0].subarray(1));
			const decoded2 = registry2.decode<ScoreUpdate>(peer2.sentMessages[0].subarray(1));

			expect(decoded1.snapshot.updates.score).toBe(200); // 100 * 2
			expect(decoded2.snapshot.updates.score).toBe(300); // 100 * 3
		});
	});

	describe("Peer metadata", () => {
		test("should set and retrieve peer metadata", () => {
			transport.simulateConnection("peer1");

			server.setPeerMetadata("peer1", "username", "Alice");
			server.setPeerMetadata("peer1", "team", "blue");

			const state = server.getPeerState("peer1");
			expect(state!.metadata["username"]).toBe("Alice");
			expect(state!.metadata["team"]).toBe("blue");
		});

		test("should handle setting metadata for unknown peer", () => {
			// Should not throw
			expect(() => server.setPeerMetadata("unknown", "key", "value")).not.toThrow();
		});
	});

	describe("Peer queries", () => {
		test("should return all peer IDs", () => {
			transport.simulateConnection("peer1");
			transport.simulateConnection("peer2");
			transport.simulateConnection("peer3");

			const peerIds = server.getPeerIds();
			expect(peerIds).toHaveLength(3);
			expect(peerIds).toContain("peer1");
			expect(peerIds).toContain("peer2");
			expect(peerIds).toContain("peer3");
		});

		test("should return empty array when no peers", () => {
			expect(server.getPeerIds()).toEqual([]);
		});

		test("should return undefined for unknown peer state", () => {
			expect(server.getPeerState("unknown")).toBeUndefined();
		});

		test("should return undefined for unknown peer registry", () => {
			expect(server.getPeerSnapshotRegistry("unknown")).toBeUndefined();
		});
	});

	describe("Message handling", () => {
		test("should ignore empty messages", () => {
			const peer = transport.simulateConnection("peer1");
			expect(() => peer.simulateMessage(new Uint8Array(0))).not.toThrow();
		});

		test("should handle custom message type", () => {
			const peer = transport.simulateConnection("peer1");
			const message = new Uint8Array([0xff, 1, 2, 3]); // MessageType.CUSTOM
			expect(() => peer.simulateMessage(message)).not.toThrow();
		});

		test("should handle unknown message types", () => {
			const peer = transport.simulateConnection("peer1");
			const message = new Uint8Array([0x99, 1, 2, 3]); // Unknown type
			expect(() => peer.simulateMessage(message)).not.toThrow();
		});

		test("should reject messages exceeding max size", () => {
			const smallServer = new ServerNetwork<MockPeerTransport, GameSnapshots>({
				transport,
				intentRegistry,
				createPeerSnapshotRegistry: () => new SnapshotRegistry<GameSnapshots>(),
				config: { maxMessageSize: 10 },
			});

			const intentsReceived: MoveIntent[] = [];
			smallServer.onIntent<MoveIntent>(MoveIntent, (_, intent) => {
				intentsReceived.push(intent);
			});

			const peer = transport.simulateConnection("peer1");

			// Create large message
			const largeMessage = new Uint8Array(100);
			largeMessage[0] = 0x01; // MessageType.INTENT

			peer.simulateMessage(largeMessage);
			expect(intentsReceived).toHaveLength(0);
		});
	});

	describe("close", () => {
		test("should close server transport", () => {
			server.close();
			expect(transport.closed).toBe(true);
		});
	});

	describe("Debug logging", () => {
		test("should not log when debug is false", () => {
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: any[]) => logs.push(args.join(" "));

			transport.simulateConnection("peer1");

			console.log = originalLog;
			expect(logs.filter((l) => l.includes("[ServerNetwork]"))).toHaveLength(0);
		});

		test("should log when debug is true", () => {
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: any[]) => logs.push(args.join(" "));

			const debugServer = new ServerNetwork<MockPeerTransport, GameSnapshots>({
				transport,
				intentRegistry,
				createPeerSnapshotRegistry: () => new SnapshotRegistry<GameSnapshots>(),
				config: { debug: true },
			});

			transport.simulateConnection("peer1");

			console.log = originalLog;
			expect(logs.filter((l) => l.includes("[ServerNetwork]")).length).toBeGreaterThan(0);
		});
	});

	describe("Delta detection with sendSnapshotToPeerIfChanged", () => {
		test("should send snapshot on first call (no previous hash)", () => {
			const peer = transport.simulateConnection("peer1");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			};

			const wasSent = server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot);

			expect(wasSent).toBe(true);
			expect(peer.sentMessages.length).toBe(1);
		});

		test("should not send snapshot if data unchanged", () => {
			const peer = transport.simulateConnection("peer1");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			};

			// First send
			server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot);
			expect(peer.sentMessages.length).toBe(1);

			// Second send with same data (different tick, same updates)
			const snapshot2: Snapshot<PlayerUpdate> = {
				tick: 2,
				updates: { x: 10, y: 20, health: 100 },
			};

			const wasSent = server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot2);

			expect(wasSent).toBe(false);
			expect(peer.sentMessages.length).toBe(1); // Still only 1 message
		});

		test("should send snapshot if data changed", () => {
			const peer = transport.simulateConnection("peer1");

			const snapshot1: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			};

			server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot1);
			expect(peer.sentMessages.length).toBe(1);

			// Send with changed position
			const snapshot2: Snapshot<PlayerUpdate> = {
				tick: 2,
				updates: { x: 15, y: 20, health: 100 }, // x changed
			};

			const wasSent = server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot2);

			expect(wasSent).toBe(true);
			expect(peer.sentMessages.length).toBe(2);
		});

		test("should track hashes separately per peer", () => {
			const peer1 = transport.simulateConnection("peer1");
			const peer2 = transport.simulateConnection("peer2");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			};

			// Send to peer1
			const sent1 = server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot);
			expect(sent1).toBe(true);
			expect(peer1.sentMessages.length).toBe(1);

			// Send same snapshot to peer2 - should send because peer2 hasn't received it
			const sent2 = server.sendSnapshotToPeerIfChanged("peer2", "player", snapshot);
			expect(sent2).toBe(true);
			expect(peer2.sentMessages.length).toBe(1);

			// Send again to peer1 - should not send (duplicate)
			const sent3 = server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot);
			expect(sent3).toBe(false);
			expect(peer1.sentMessages.length).toBe(1);
		});

		test("should track hashes separately per snapshot type", () => {
			const peer = transport.simulateConnection("peer1");

			const playerSnapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			};

			const scoreSnapshot: Snapshot<ScoreUpdate> = {
				tick: 1,
				updates: { score: 50 },
			};

			// Send player snapshot
			server.sendSnapshotToPeerIfChanged("peer1", "player", playerSnapshot);
			expect(peer.sentMessages.length).toBe(1);

			// Send score snapshot - different type, should send
			server.sendSnapshotToPeerIfChanged("peer1", "score", scoreSnapshot);
			expect(peer.sentMessages.length).toBe(2);

			// Send player snapshot again - should not send (duplicate)
			const sent = server.sendSnapshotToPeerIfChanged("peer1", "player", playerSnapshot);
			expect(sent).toBe(false);
			expect(peer.sentMessages.length).toBe(2);
		});

		test("should cleanup hashes on peer disconnect", () => {
			const peer = transport.simulateConnection("peer1");

			const snapshot: Snapshot<PlayerUpdate> = {
				tick: 1,
				updates: { x: 10, y: 20, health: 100 },
			};

			// Send snapshot
			server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot);
			expect(peer.sentMessages.length).toBe(1);

			// Disconnect
			transport.simulateDisconnection("peer1");

			// Reconnect with same ID
			const newPeer = transport.simulateConnection("peer1");

			// Should send again (hash was cleared on disconnect)
			const wasSent = server.sendSnapshotToPeerIfChanged("peer1", "player", snapshot);
			expect(wasSent).toBe(true);
			expect(newPeer.sentMessages.length).toBe(1);
		});
	});
});

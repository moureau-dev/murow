import { describe, it, expect } from "bun:test";
import { defineRPC } from "./define-rpc";
import { BinaryCodec } from "../../core/binary-codec";
import { RpcRegistry } from "./rpc-registry";

describe("defineRPC", () => {
	describe("type inference", () => {
		it("should infer correct type from schema", () => {
			const MatchCountdown = defineRPC({
				method: 'matchCountdown',
				schema: {
					secondsRemaining: BinaryCodec.u8,
				},
			});

			type MatchCountdown = typeof MatchCountdown.type;

			// Create an instance to verify type inference
			const countdown: MatchCountdown = {
				secondsRemaining: 10,
			};

			expect(countdown.secondsRemaining).toBe(10);
		});

		it("should support RPCs with different field types", () => {
			const BuyItem = defineRPC({
				method: 'buyItem',
				schema: {
					itemId: BinaryCodec.string(32),
					quantity: BinaryCodec.u16,
					price: BinaryCodec.f32,
				},
			});

			type BuyItem = typeof BuyItem.type;

			const purchase: BuyItem = {
				itemId: 'long_sword',
				quantity: 5,
				price: 100.5,
			};

			expect(purchase.itemId).toBe('long_sword');
			expect(purchase.quantity).toBe(5);
			expect(purchase.price).toBe(100.5);
		});

		it("should support empty RPCs (no parameters)", () => {
			const Ping = defineRPC({
				method: 'ping',
				schema: {},
			});

			type Ping = typeof Ping.type;

			const ping: Ping = {};

			expect(ping).toEqual({});
		});
	});

	describe("codec generation", () => {
		it("should generate a codec that can encode/decode", () => {
			const TestRpc = defineRPC({
				method: 'test',
				schema: {
					value: BinaryCodec.u32,
				},
			});

			type TestRpc = typeof TestRpc.type;

			const data: TestRpc = { value: 42 };
			const encoded = TestRpc.codec.encode(data);

			expect(encoded).toBeInstanceOf(Uint8Array);

			const decoded = TestRpc.codec.decode(encoded);
			expect(decoded.value).toBe(42);
		});

		it("should encode/decode complex types", () => {
			const PlayerInfo = defineRPC({
				method: 'playerInfo',
				schema: {
					playerId: BinaryCodec.u32,
					name: BinaryCodec.string(64),
					level: BinaryCodec.u8,
					health: BinaryCodec.f32,
				},
			});

			type PlayerInfo = typeof PlayerInfo.type;

			const data: PlayerInfo = {
				playerId: 12345,
				name: 'TestPlayer',
				level: 50,
				health: 85.5,
			};

			const encoded = PlayerInfo.codec.encode(data);
			const decoded = PlayerInfo.codec.decode(encoded);

			expect(decoded.playerId).toBe(12345);
			expect(decoded.name).toBe('TestPlayer');
			expect(decoded.level).toBe(50);
			expect(decoded.health).toBeCloseTo(85.5, 1);
		});
	});

	describe("integration with RpcRegistry", () => {
		it("should work with RpcRegistry", () => {
			const Notification = defineRPC({
				method: 'notification',
				schema: {
					message: BinaryCodec.string(128),
					priority: BinaryCodec.u8,
				},
			});

			type Notification = typeof Notification.type;

			const registry = new RpcRegistry();
			registry.register(Notification);

			const data: Notification = {
				message: 'Test notification',
				priority: 1,
			};

			const encoded = registry.encode(Notification, data);
			const decoded = registry.decode(encoded);

			expect(decoded.method).toBe('notification');
			expect(decoded.data.message).toBe('Test notification');
			expect(decoded.data.priority).toBe(1);
		});
	});
});

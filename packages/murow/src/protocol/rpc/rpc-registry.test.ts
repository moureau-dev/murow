import { describe, it, expect, beforeEach } from "bun:test";
import { RpcRegistry } from "./rpc-registry";
import { defineRPC } from "./define-rpc";
import { BinaryCodec } from "../../core/binary-codec";

// Define RPCs for testing
const MockRpc = defineRPC({
	method: 'mockRpc',
	schema: {
		value: BinaryCodec.u32,
	},
});

const AnotherRpc = defineRPC({
	method: 'anotherRpc',
	schema: {
		data: BinaryCodec.string(64),
	},
});

type MockRpcType = typeof MockRpc.type;
type AnotherRpcType = typeof AnotherRpc.type;

describe("RpcRegistry", () => {
	let registry: RpcRegistry;

	beforeEach(() => {
		registry = new RpcRegistry();
	});

	describe("register", () => {
		it("should register an RPC", () => {
			registry.register(MockRpc);
			expect(registry.has('mockRpc')).toBe(true);
		});

		it("should throw error when registering duplicate method", () => {
			registry.register(MockRpc);
			expect(() => registry.register(MockRpc)).toThrow(
				'RPC "mockRpc" is already registered'
			);
		});

		it("should allow registering multiple different RPCs", () => {
			registry.register(MockRpc);
			registry.register(AnotherRpc);
			expect(registry.has('mockRpc')).toBe(true);
			expect(registry.has('anotherRpc')).toBe(true);
		});

		it("should assign sequential method IDs", () => {
			registry.register(MockRpc);
			registry.register(AnotherRpc);

			expect(registry.getMethodId('mockRpc')).toBe(0);
			expect(registry.getMethodId('anotherRpc')).toBe(1);
		});
	});

	describe("encode", () => {
		it("should encode an RPC using registered codec", () => {
			registry.register(MockRpc);
			const data: MockRpcType = { value: 42 };
			const buf = registry.encode(MockRpc, data);

			expect(buf).toBeInstanceOf(Uint8Array);
			expect(buf.byteLength).toBeGreaterThan(2); // At least methodId (2 bytes) + data
		});

		it("should throw error when encoding unregistered RPC", () => {
			const data: MockRpcType = { value: 42 };
			expect(() => registry.encode(MockRpc, data)).toThrow(
				'RPC "mockRpc" is not registered'
			);
		});

		it("should encode different RPC types correctly", () => {
			registry.register(MockRpc);
			registry.register(AnotherRpc);

			const data1: MockRpcType = { value: 42 };
			const data2: AnotherRpcType = { data: "test" };

			const buf1 = registry.encode(MockRpc, data1);
			const buf2 = registry.encode(AnotherRpc, data2);

			expect(buf1).toBeInstanceOf(Uint8Array);
			expect(buf2).toBeInstanceOf(Uint8Array);
			expect(buf1[0]).not.toBe(buf2[0]); // Different method IDs
		});
	});

	describe("decode", () => {
		it("should decode an RPC using registered codec", () => {
			registry.register(MockRpc);
			const data: MockRpcType = { value: 42 };
			const encoded = registry.encode(MockRpc, data);
			const decoded = registry.decode(encoded);

			expect(decoded.method).toBe('mockRpc');
			expect(decoded.data.value).toBe(42);
		});

		it("should throw error when decoding unknown method ID", () => {
			// Create buffer with invalid method ID
			const buf = new Uint8Array([0xFF, 0xFF]);

			expect(() => registry.decode(buf)).toThrow(
				'Unknown RPC method ID: 65535'
			);
		});

		it("should throw error when buffer is too small", () => {
			const buf = new Uint8Array([0x00]); // Only 1 byte, needs at least 2

			expect(() => registry.decode(buf)).toThrow(
				'Buffer too small for RPC message'
			);
		});

		it("should roundtrip encode/decode correctly", () => {
			registry.register(MockRpc);
			registry.register(AnotherRpc);

			const data1: MockRpcType = { value: 12345 };
			const data2: AnotherRpcType = { data: "hello world" };

			const encoded1 = registry.encode(MockRpc, data1);
			const encoded2 = registry.encode(AnotherRpc, data2);

			const decoded1 = registry.decode(encoded1);
			const decoded2 = registry.decode(encoded2);

			expect(decoded1.method).toBe('mockRpc');
			expect(decoded1.data.value).toBe(12345);

			expect(decoded2.method).toBe('anotherRpc');
			expect(decoded2.data.data).toBe('hello world');
		});
	});

	describe("getMethods", () => {
		it("should return empty array when no RPCs registered", () => {
			expect(registry.getMethods()).toEqual([]);
		});

		it("should return all registered method names", () => {
			registry.register(MockRpc);
			registry.register(AnotherRpc);

			const methods = registry.getMethods();
			expect(methods).toContain('mockRpc');
			expect(methods).toContain('anotherRpc');
			expect(methods.length).toBe(2);
		});
	});

	describe("getMethodId", () => {
		it("should return undefined for unregistered method", () => {
			expect(registry.getMethodId('unknown')).toBeUndefined();
		});

		it("should return correct method ID", () => {
			registry.register(MockRpc);
			expect(registry.getMethodId('mockRpc')).toBe(0);
		});
	});
});

import { describe, it, expect } from "bun:test";
import { defineIntent } from "./define-intent";
import { BinaryCodec } from "../../core/binary-codec";
import { IntentRegistry } from "./intent-registry";


describe("defineIntent", () => {
  enum Intents {
    Move = 1,
    Attack,
    Chat,
    Jump,
    Rotate,
  }

  describe("type inference", () => {
    it("should infer correct type from schema with automatic tick", () => {

      const MoveIntent = defineIntent({
        kind: Intents.Move,
        schema: {
          dx: BinaryCodec.f32,
          dy: BinaryCodec.f32,
        },
      });

      type MoveIntent = typeof MoveIntent.type;

      // Create an instance to verify type inference
      const move: MoveIntent = {
        kind: Intents.Move,
        tick: 100,
        dx: 1.5,
        dy: -2.0,
      };

      expect(move.kind).toBe(Intents.Move);
      expect(move.tick).toBe(100);
      expect(move.dx).toBe(1.5);
      expect(move.dy).toBe(-2.0);
    });

    it("should enforce kind literal type", () => {
      const AttackIntent = defineIntent({
        kind: Intents.Attack,
        schema: {
          targetId: BinaryCodec.u32,
          damage: BinaryCodec.f32,
        },
      });

      expect(AttackIntent.kind).toBe(Intents.Attack);

      type AttackIntent = typeof AttackIntent.type;
      const attack: AttackIntent = {
        kind: Intents.Attack, // Must be exactly what Intents.Attack is
        tick: 200,
        targetId: 999,
        damage: 50.5,
      };

      expect(attack.kind).toBe(Intents.Attack);
    });

    it("should support intents with different field types", () => {
      const ChatIntent = defineIntent({
        kind: Intents.Chat,
        schema: {
          playerId: BinaryCodec.u8,
          messageLength: BinaryCodec.u16,
        },
      });

      type ChatIntent = typeof ChatIntent.type;

      const chat: ChatIntent = {
        kind: Intents.Chat,
        tick: 500,
        playerId: 5,
        messageLength: 128,
      };

      expect(chat.playerId).toBe(5);
      expect(chat.messageLength).toBe(128);
    });
  });

  describe("codec generation", () => {
    it("should create a working codec", () => {
      const MoveIntent = defineIntent({
        kind: Intents.Move,
        schema: {
          dx: BinaryCodec.f32,
          dy: BinaryCodec.f32,
        },
      });

      type MoveIntent = typeof MoveIntent.type;

      const move: MoveIntent = {
        kind: Intents.Move,
        tick: 100,
        dx: 1.5,
        dy: -2.0,
      };

      const encoded = MoveIntent.codec.encode(move);
      const decoded = MoveIntent.codec.decode(encoded);

      expect(decoded.kind).toBe(move.kind);
      expect(decoded.tick).toBe(move.tick);
      expect(decoded.dx).toBeCloseTo(move.dx, 5);
      expect(decoded.dy).toBeCloseTo(move.dy, 5);
    });

    it("should include kind field in encoded data", () => {
      const JumpIntent = defineIntent({
        kind: Intents.Jump,
        schema: {
          height: BinaryCodec.f32,
        },
      });

      type JumpIntent = typeof JumpIntent.type;

      const jump: JumpIntent = {
        kind: Intents.Jump,
        tick: 50,
        height: 10.5,
      };

      const encoded = JumpIntent.codec.encode(jump);

      // First byte should be the kind (7)
      expect(encoded[0]).toBe(Intents.Jump);
    });

    it("should handle multiple round trips", () => {
      const RotateIntent = defineIntent({
        kind: Intents.Rotate,
        schema: {
          angle: BinaryCodec.f32,
        },
      });

      type RotateIntent = typeof RotateIntent.type;

      const original: RotateIntent = {
        kind: Intents.Rotate,
        tick: 999,
        angle: 3.14159,
      };

      for (let i = 0; i < 10; i++) {
        const encoded = RotateIntent.codec.encode(original);
        const decoded = RotateIntent.codec.decode(encoded);

        expect(decoded.kind).toBe(original.kind);
        expect(decoded.tick).toBe(original.tick);
        expect(decoded.angle).toBeCloseTo(original.angle, 5);
      }
    });
  });

  describe("integration with IntentRegistry", () => {
    it("should register and work with IntentRegistry", () => {
      const registry = new IntentRegistry();

      const MoveIntent = defineIntent({
        kind: 1 as const,
        schema: {
          dx: BinaryCodec.f32,
          dy: BinaryCodec.f32,
        },
      });

      const AttackIntent = defineIntent({
        kind: 2 as const,
        schema: {
          targetId: BinaryCodec.u32,
        },
      });

      type MoveIntent = typeof MoveIntent.type;
      type AttackIntent = typeof AttackIntent.type;

      // Register using defineIntent objects
      registry.register(MoveIntent);
      registry.register(AttackIntent);

      const move: MoveIntent = {
        kind: MoveIntent.kind,
        tick: 100,
        dx: 5.0,
        dy: -3.0,
      };

      const attack: AttackIntent = {
        kind: AttackIntent.kind,
        tick: 101,
        targetId: 42,
      };

      // Encode using registry
      const moveEncoded = registry.encode(move);
      const attackEncoded = registry.encode(attack);

      // Decode using registry
      const moveDecoded = registry.decode(moveEncoded);
      const attackDecoded = registry.decode(attackEncoded);

      expect(moveDecoded.kind).toBe(1);
      expect(moveDecoded.tick).toBe(100);
      expect((moveDecoded as any).dx).toBeCloseTo(5.0, 5);
      expect((moveDecoded as any).dy).toBeCloseTo(-3.0, 5);

      expect(attackDecoded.kind).toBe(2);
      expect(attackDecoded.tick).toBe(101);
      expect((attackDecoded as any).targetId).toBe(42);
    });

    it("should prevent duplicate registrations", () => {
      const registry = new IntentRegistry();

      const Intent1 = defineIntent({
        kind: 5 as const,
        schema: {},
      });

      const Intent2 = defineIntent({
        kind: 5 as const, // Same kind
        schema: {},
      });

      registry.register(Intent1);

      expect(() => {
        registry.register(Intent2);
      }).toThrow("Intent kind 5 is already registered");
    });
  });

  describe("complex intents", () => {
    it("should handle intents with many fields", () => {
      const PlayerStateIntent = defineIntent({
        kind: 99 as const,
        schema: {
          playerId: BinaryCodec.u32,
          x: BinaryCodec.f32,
          y: BinaryCodec.f32,
          z: BinaryCodec.f32,
          velocityX: BinaryCodec.f32,
          velocityY: BinaryCodec.f32,
          velocityZ: BinaryCodec.f32,
          health: BinaryCodec.u8,
          mana: BinaryCodec.u8,
        },
      });

      type PlayerStateIntent = typeof PlayerStateIntent.type;

      const state: PlayerStateIntent = {
        kind: 99,
        tick: 1000,
        playerId: 123,
        x: 10.5,
        y: 20.3,
        z: 30.1,
        velocityX: 1.0,
        velocityY: 0.5,
        velocityZ: -0.2,
        health: 100,
        mana: 50,
      };

      const encoded = PlayerStateIntent.codec.encode(state);
      const decoded = PlayerStateIntent.codec.decode(encoded);

      expect(decoded.kind).toBe(state.kind);
      expect(decoded.tick).toBe(state.tick);
      expect(decoded.playerId).toBe(state.playerId);
      expect(decoded.x).toBeCloseTo(state.x, 5);
      expect(decoded.y).toBeCloseTo(state.y, 5);
      expect(decoded.z).toBeCloseTo(state.z, 5);
      expect(decoded.velocityX).toBeCloseTo(state.velocityX, 5);
      expect(decoded.velocityY).toBeCloseTo(state.velocityY, 5);
      expect(decoded.velocityZ).toBeCloseTo(state.velocityZ, 5);
      expect(decoded.health).toBe(state.health);
      expect(decoded.mana).toBe(state.mana);
    });

    it("should handle minimal intents with only tick", () => {
      const PingIntent = defineIntent({
        kind: 255 as const,
        schema: {}, // No additional fields, only kind and tick
      });

      type PingIntent = typeof PingIntent.type;

      const ping: PingIntent = {
        kind: 255,
        tick: 12345,
      };

      const encoded = PingIntent.codec.encode(ping);
      const decoded = PingIntent.codec.decode(encoded);

      expect(decoded.kind).toBe(255);
      expect(decoded.tick).toBe(12345);
    });
  });

  describe("edge cases", () => {
    it("should handle zero values", () => {
      const ZeroIntent = defineIntent({
        kind: 0 as const,
        schema: {
          value: BinaryCodec.f32,
        },
      });

      type ZeroIntent = typeof ZeroIntent.type;

      const zero: ZeroIntent = {
        kind: 0,
        tick: 0,
        value: 0,
      };

      const encoded = ZeroIntent.codec.encode(zero);
      const decoded = ZeroIntent.codec.decode(encoded);

      expect(decoded.kind).toBe(0);
      expect(decoded.tick).toBe(0);
      expect(decoded.value).toBe(0);
    });

    it("should handle maximum values for numeric types", () => {
      const MaxIntent = defineIntent({
        kind: 255 as const,
        schema: {
          maxU8: BinaryCodec.u8,
          maxU16: BinaryCodec.u16,
          maxU32: BinaryCodec.u32,
        },
      });

      type MaxIntent = typeof MaxIntent.type;

      const max: MaxIntent = {
        kind: 255,
        tick: 0xFFFFFFFF,
        maxU8: 255,
        maxU16: 65535,
        maxU32: 0xFFFFFFFF,
      };

      const encoded = MaxIntent.codec.encode(max);
      const decoded = MaxIntent.codec.decode(encoded);

      expect(decoded.kind).toBe(255);
      expect(decoded.tick).toBe(0xFFFFFFFF);
      expect(decoded.maxU8).toBe(255);
      expect(decoded.maxU16).toBe(65535);
      expect(decoded.maxU32).toBe(0xFFFFFFFF);
    });

    it("should allow custom tick encoding", () => {
      const CustomTickIntent = defineIntent({
        kind: 100 as const,
        schema: {
          tick: BinaryCodec.u16, // Override default u32 with u16
          action: BinaryCodec.u8,
        },
      });

      type CustomTickIntent = typeof CustomTickIntent.type;

      const intent: CustomTickIntent = {
        kind: 100,
        tick: 5000, // Max u16 is 65535
        action: 42,
      };

      const encoded = CustomTickIntent.codec.encode(intent);
      const decoded = CustomTickIntent.codec.decode(encoded);

      expect(decoded.kind).toBe(100);
      expect(decoded.tick).toBe(5000);
      expect(decoded.action).toBe(42);

      // Verify the encoded size is smaller (u16 instead of u32 for tick)
      // kind (1) + tick (2) + action (1) = 4 bytes
      expect(encoded.length).toBe(4);
    });
  });
});

import type { Intent } from "./intent";
import type { Schema } from "../../core/binary-codec";
import { BinaryCodec } from "../../core/binary-codec";
import type { Codec } from "./intent-registry";

/**
 * Configuration for defining an intent type.
 * @template K The intent kind (numeric literal type)
 * @template S The schema type describing the intent's data fields
 */
export interface IntentDefinition<K extends number, S extends Record<string, any>> {
  /** Numeric identifier for this intent type */
  kind: K;
  /**
   * Schema describing the intent's data fields (excluding kind which is added automatically).
   * If 'tick' is not provided, it will default to BinaryCodec.u32.
   * You can override the tick encoding by including it in the schema.
   */
  schema: S;
}

/**
 * Infers the TypeScript type from an intent schema.
 * The schema already includes 'kind' (added automatically) and should include 'tick'.
 * @template K The intent kind (numeric literal type)
 * @template S The schema type (includes tick, but kind is added automatically)
 */
export type InferIntentType<K extends number, S extends Record<string, any>> = {
  kind: K;
  tick: number;
} & {
  [P in keyof S]: S[P] extends { read(dv: DataView, o: number): infer R } ? R : never;
};

/**
 * Helper type to extract just the data fields from a DefinedIntent (excluding kind and tick).
 * This is useful for APIs that work with intent data without the metadata fields.
 *
 * @example
 * ```ts
 * const MoveIntent = defineIntent({
 *   kind: 1,
 *   schema: { vx: BinaryCodec.f32, vy: BinaryCodec.f32 }
 * });
 *
 * type MoveData = IntentDataOnly<typeof MoveIntent>; // { vx: number, vy: number }
 * ```
 */
export type IntentDataOnly<T> =
  T extends DefinedIntent<infer _K, infer U extends Intent>
    ? Omit<U, 'kind' | 'tick'>
    : never;

/**
 * Result of defineIntent - provides both the type and codec.
 * @template K The intent kind literal
 * @template T The inferred intent type
 */
export interface DefinedIntent<K extends number, T extends Intent> {
  /** The TypeScript type for this intent (use with `typeof IntentName.type`) */
  type: T;
  /** The codec instance for encoding/decoding this intent */
  codec: Codec<T>;
  /** The kind identifier for this intent */
  kind: K;
}

/**
 * Simple codec implementation that uses BinaryCodec for encoding/decoding.
 * @template T The intent type
 */
class IntentCodec<T extends Intent> implements Codec<T> {
  constructor(private schema: Schema<T>) {}

  encode(value: T): Uint8Array {
    return BinaryCodec.encode(this.schema, value);
  }

  decode(buf: Uint8Array): T {
    // Create a target object with nil values
    const target = {} as T;
    for (const key of Object.keys(this.schema) as (keyof T)[]) {
      const field = this.schema[key];
      target[key] = field.toNil() as T[keyof T];
    }
    return BinaryCodec.decode(this.schema, buf, target);
  }
}

/**
 * Define a type-safe intent with automatic schema generation.
 *
 * This helper ensures that your intent's TypeScript interface and binary schema
 * stay in sync by deriving the type from the schema definition.
 *
 * The `kind` and `tick` fields are automatically added to the schema:
 * - `kind`: u8 codec (always FIRST byte - required for IntentRegistry.decode)
 * - `tick`: u32 codec (default, can be overridden by including it in your schema)
 *
 * IMPORTANT: If you use PooledCodec directly instead of defineIntent(), you MUST
 * ensure `kind: BinaryPrimitives.u8` is the FIRST field in your schema, or
 * IntentRegistry.decode() will fail.
 *
 * @template K The intent kind (numeric literal)
 * @template S The schema type
 * @param definition Intent configuration with kind and schema
 * @returns A DefinedIntent object with type, codec, and kind
 *
 * @example Using enums (recommended for managing multiple intents)
 * ```ts
 * // Define all your intent kinds in one place
 * enum IntentKind {
 *   Move = 1,
 *   Attack = 2,
 *   Jump = 3,
 *   Chat = 4,
 * }
 *
 * const MoveIntent = defineIntent({
 *   kind: IntentKind.Move,
 *   schema: {
 *     dx: BinaryCodec.f32,
 *     dy: BinaryCodec.f32,
 *   }
 * });
 *
 * const AttackIntent = defineIntent({
 *   kind: IntentKind.Attack,
 *   schema: {
 *     targetId: BinaryCodec.u32,
 *     damage: BinaryCodec.f32,
 *   }
 * });
 *
 * // Use the inferred types
 * type MoveIntent = typeof MoveIntent.type;
 * type AttackIntent = typeof AttackIntent.type;
 *
 * // Register with IntentRegistry
 * const registry = new IntentRegistry();
 * registry.register(MoveIntent.kind, MoveIntent.codec);
 * registry.register(AttackIntent.kind, AttackIntent.codec);
 *
 * // Create instances - tick is automatically available
 * const move: MoveIntent = {
 *   kind: IntentKind.Move,
 *   tick: 100,
 *   dx: 1.5,
 *   dy: -2.0,
 * };
 * ```
 *
 * @example Using literal types (simple cases)
 * ```ts
 * const MoveIntent = defineIntent({
 *   kind: 1 as const,
 *   schema: {
 *     dx: BinaryCodec.f32,
 *     dy: BinaryCodec.f32,
 *   }
 * });
 *
 * type MoveIntent = typeof MoveIntent.type;
 * ```
 *
 * @example Custom tick encoding
 * ```ts
 * const SmallIntent = defineIntent({
 *   kind: IntentKind.Small,
 *   schema: {
 *     tick: BinaryCodec.u16, // Override default u32 with u16
 *     action: BinaryCodec.u8,
 *   }
 * });
 * ```
 */
export function defineIntent<
  K extends number,
  S extends Record<string, any>
>(
  definition: IntentDefinition<K, S>
): DefinedIntent<K, InferIntentType<K, S>> {
  type IntentType = InferIntentType<K, S>;

  // Create the full schema with kind and tick fields
  // Add tick with default u32 if not provided by user
  const fullSchema = {
    kind: BinaryCodec.u8,
    tick: BinaryCodec.u32, // Default tick encoding
    ...definition.schema, // User can override tick if needed
  } as Schema<IntentType>;

  // Create the codec using BinaryCodec directly
  const codec = new IntentCodec<IntentType>(fullSchema);

  return {
    type: undefined as any as IntentType, // Phantom type for inference
    codec,
    kind: definition.kind,
  };
}

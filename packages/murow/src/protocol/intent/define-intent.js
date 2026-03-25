import { BinaryCodec } from "../../core/binary-codec";
/**
 * Simple codec implementation that uses BinaryCodec for encoding/decoding.
 * @template T The intent type
 */
class IntentCodec {
    constructor(schema) {
        this.schema = schema;
    }
    encode(value) {
        return BinaryCodec.encode(this.schema, value);
    }
    decode(buf) {
        // Create a target object with nil values
        const target = {};
        for (const key of Object.keys(this.schema)) {
            const field = this.schema[key];
            target[key] = field.toNil();
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
export function defineIntent(definition) {
    // Create the full schema with kind and tick fields
    // Add tick with default u32 if not provided by user
    const fullSchema = {
        kind: BinaryCodec.u8,
        tick: BinaryCodec.u32, // Default tick encoding
        ...definition.schema, // User can override tick if needed
    };
    // Create the codec using BinaryCodec directly
    const codec = new IntentCodec(fullSchema);
    return {
        type: undefined, // Phantom type for inference
        codec,
        kind: definition.kind,
    };
}

/**
 * Intent system for client-to-server actions.
 *
 * Intents are player/AI actions that need to be:
 * 1. Encoded efficiently (binary)
 * 2. Sent over network
 * 3. Decoded on the other end
 * 4. Processed deterministically
 *
 * @example Using defineIntent with enums (recommended)
 * ```ts
 * import { defineIntent, IntentRegistry } from './protocol/intent';
 * import { BinaryCodec } from '../core/binary-codec';
 *
 * // 1. Define all your intent kinds in one place
 * enum IntentKind {
 *   Move = 1,
 *   Attack = 2,
 *   Jump = 3,
 * }
 *
 * // 2. Define your intents with automatic type inference
 * // kind and tick are added automatically!
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
 * // 3. Extract the types
 * type MoveIntent = typeof MoveIntent.type;
 * type AttackIntent = typeof AttackIntent.type;
 *
 * // 4. Create registry and register
 * const registry = new IntentRegistry();
 * registry.register(MoveIntent.kind, MoveIntent.codec);
 * registry.register(AttackIntent.kind, AttackIntent.codec);
 *
 * // 5. Create instances with full type safety
 * const move: MoveIntent = {
 *   kind: IntentKind.Move,
 *   tick: 100, // tick is automatically available
 *   dx: 1.5,
 *   dy: -2.0,
 * };
 *
 * // 6. Encode/decode
 * const buf = registry.encode(move);
 * const decoded = registry.decode(buf);
 * ```
 *
 * @example Manual definition (legacy)
 * ```ts
 * import { Intent, IntentRegistry } from './protocol/intent';
 * import { PooledCodec } from '../core/pooled-codec';
 * import { BinaryCodec } from '../core/binary-codec';
 *
 * // 1. Define your intent type
 * interface MoveIntent extends Intent {
 *   kind: 1;
 *   tick: number;
 *   dx: number;
 *   dy: number;
 * }
 *
 * // 2. Create registry and register once (reuse this instance)
 * const registry = new IntentRegistry();
 * registry.register(1, new PooledCodec({
 *   kind: BinaryCodec.u8,
 *   tick: BinaryCodec.u32,
 *   dx: BinaryCodec.f32,
 *   dy: BinaryCodec.f32,
 * }));
 *
 * // 3. Encode/decode
 * const buf = registry.encode(intent);
 * const decoded = registry.decode(buf);
 * ```
 */

export type { Intent } from "./intent";
export { IntentRegistry } from "./intent-registry";
export { defineIntent } from "./define-intent";
export type { DefinedIntent, InferIntentType, IntentDataOnly } from "./define-intent";

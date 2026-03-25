/**
 * Protocol Layer - Type-safe networking primitives
 *
 * This layer enforces:
 * - Type-safe intent definitions (use defineIntent helper)
 * - Type-safe snapshot definitions (Snapshot<YourState>)
 * - Memory-efficient encoding (use BinaryCodec from core)
 *
 * You provide:
 * - Your intent types (via defineIntent)
 * - Your state types
 * - Your schemas (for binary encoding)
 *
 * @example Using defineIntent with enums (recommended)
 * ```ts
 * import { defineIntent, IntentRegistry } from './protocol';
 * import { BinaryCodec } from './core/binary-codec';
 *
 * // Define all your intent kinds in one place
 * enum IntentKind {
 *   Move = 1,
 *   Attack = 2,
 *   Jump = 3,
 * }
 *
 * // Define intents with automatic type inference
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
 * type MoveIntent = typeof MoveIntent.type;
 * type AttackIntent = typeof AttackIntent.type;
 *
 * // Register and use
 * const intentRegistry = new IntentRegistry();
 * intentRegistry.register(MoveIntent.kind, MoveIntent.codec);
 * intentRegistry.register(AttackIntent.kind, AttackIntent.codec);
 *
 * const move: MoveIntent = {
 *   kind: IntentKind.Move,
 *   tick: 100, // tick is automatically available
 *   dx: 1.5,
 *   dy: -2.0,
 * };
 *
 * const buf = intentRegistry.encode(move);
 * const decoded = intentRegistry.decode(IntentKind.Move, buf);
 * ```
 *
 * @example Manual definition (legacy)
 * ```ts
 * // Define your types
 * interface MoveIntent extends Intent {
 *   kind: 1;
 *   tick: number;
 *   dx: number;
 *   dy: number;
 * }
 *
 * interface GameState {
 *   players: Record<number, { x: number; y: number }>;
 * }
 *
 * // Create codecs once (reuse these!)
 * const intentRegistry = new IntentRegistry();
 * intentRegistry.register(1, new PooledCodec(moveSchema));
 *
 * const snapshotCodec = new SnapshotCodec<GameState>(
 *   new PooledCodec(stateSchema)
 * );
 *
 * // Use them
 * const buf = intentRegistry.encode(intent);
 * const snapshot = snapshotCodec.decode(buf);
 * ```
 */

export * from "./intent";
export * from "./snapshot";
export * from "./rpc";

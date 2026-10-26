/**
 * Shared manager types.
 *
 * The home for cross-backend renderer types that every manager uses: branded
 * ids for the collection managers, the renderer handle namespace, and the
 * public spawn/option types. Backend-agnostic by construction.
 */
import type { SlotId } from 'murow/core/slot-map';

// 3D
export type InstanceId = SlotId<'instance'>;
export type MaterialId = SlotId<'material'>;
export type LightId = SlotId<'light'>;
export type LayerId = SlotId<'decal-layer'>;
export type DecalId = SlotId<'decal'>;
export type EmitterId = SlotId<'emitter'>;

// 2D
export type SpriteId = SlotId<'sprite'>;
export type SheetId = SlotId<'sheet'>;

// Shared
export type CameraId = SlotId<'camera'>;

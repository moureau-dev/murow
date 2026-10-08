import type { SlotId } from 'murow/core/slot-map';

/**
 * Branded id aliases, one per collection manager. Branded `number`s keep an id
 * from one manager out of another, and a plain `number` is not assignable, so
 * ids cross a boundary (ECS, snapshot, wire) through a cast.
 */
export type InstanceId = SlotId<'instance'>;
export type MaterialId = SlotId<'material'>;
export type LightId = SlotId<'light'>;
export type LayerId = SlotId<'decal-layer'>;
export type DecalId = SlotId<'decal'>;
export type EmitterId = SlotId<'emitter'>;

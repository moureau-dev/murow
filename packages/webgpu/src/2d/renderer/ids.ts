import type { SlotId } from 'murow/core/slot-map';

/**
 * Branded id aliases, one per 2D collection manager. Branded `number`s keep an
 * id from one manager out of another, and a plain `number` is not assignable,
 * so ids cross a boundary (ECS, snapshot, wire) through a cast.
 */
export type SpriteId = SlotId<'sprite'>;
export type SheetId = SlotId<'sheet'>;

/**
 * Base interface for all game intents.
 *
 * Intents represent player or AI actions that need to be processed by the game simulation.
 * They are timestamped with a tick number for deterministic replay and synchronization.
 */
export interface Intent {
  /** The game tick at which this intent should be processed */
  tick: number;
  /** Numeric identifier for the intent type (used for codec lookup) */
  kind: number;
}

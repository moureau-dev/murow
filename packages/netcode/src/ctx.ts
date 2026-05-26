import type { Entity, World } from 'murow/ecs';
import type { SimpleRNG } from 'murow/core/simple-rng';

export interface PredictionContext {
    world: World;
    entity: Entity;
    tick: number;
    /** Seconds since last tick. */
    deltaTime: number;
    /** Deterministic per-tick RNG. Don't use Math.random in predictions. */
    rng: SimpleRNG;
}

export interface Peer {
    peerId: string;
    /** -1 until `server.assignEntity` is called. */
    entity: Entity | -1;
}

export interface ServerHandlerContext extends PredictionContext {
    peer: Peer;
    /** Tick the client claimed they were on when they sent the intent. */
    clientTick: number;
    /** Rewind world state to `clientTick` for the duration of `fn`. */
    lagCompensated<T>(fn: () => T): T;
}

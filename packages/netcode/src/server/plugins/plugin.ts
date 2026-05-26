import type { Entity, World } from 'murow/ecs';
import type { Peer, ServerHandlerContext } from '../../ctx';

export interface ServerPlugin {
    readonly name: string;
    onMount?(server: any): void;
    onUnmount?(server: any): void;
    onTick?(world: World, deltaTime: number): void;
    /** Observe-only. Return value is ignored. */
    onIntent?(
        peer: Peer,
        kind: number,
        name: string,
        payload: unknown,
        ctx: ServerHandlerContext,
    ): void;
    /**
     * Filter `dirtyEntities` down to those visible to `peer`. Push
     * visible entities onto `out` (pre-cleared by the engine). Plugins
     * compose in registration order on the same scratch array.
     */
    filterSnapshot?(
        peer: Peer,
        world: World,
        dirtyEntities: ReadonlyArray<Entity>,
        out: Entity[],
    ): void;
    onDisconnect?(peer: Peer): void;
}

export interface ClientPlugin {
    readonly name: string;
    onMount?(client: any): void;
    onUnmount?(client: any): void;
    onTick?(world: World, deltaTime: number): void;
    onSnapshot?(tick: number): void;
}

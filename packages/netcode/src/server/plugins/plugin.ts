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
     * Push the entities visible to `peer` onto `out` (pre-cleared by the
     * engine). Each plugin is consulted against the full dirty set; a
     * component's `sync.interest` selects which plugin governs it (`'global'`
     * components bypass plugins and force their entity into the snapshot).
     */
    filterSnapshot?(
        peer: Peer,
        world: World,
        dirtyEntities: ReadonlyArray<Entity>,
        out: Entity[],
    ): void;
    /**
     * Optional spatial fast path. Push the entities near `peer` onto `out` in
     * O(nearby). When present, the engine iterates this per peer instead of the
     * whole dirty set. Implement `covers` too so non-spatial entities are not
     * dropped (the engine unions the dirty entities `covers` returns false for).
     */
    nearby?(peer: Peer, world: World, out: Entity[]): void;
    /** Whether this plugin spatially manages `eid` (false = pass-through). */
    covers?(world: World, eid: Entity): boolean;
    onDisconnect?(peer: Peer): void;
}

export interface ClientPlugin {
    readonly name: string;
    onMount?(client: any): void;
    onUnmount?(client: any): void;
    onTick?(world: World, deltaTime: number): void;
    onSnapshot?(tick: number): void;
}

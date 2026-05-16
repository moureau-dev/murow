import {
    FixedTicker,
    BinaryCodec,
    defineIntent,
    IntentRegistry,
    SnapshotRegistry,
    EventSystem,
    PooledCodec,
    defineRPC,
    RpcRegistry,
    GameLoop,
    GameLoopType
} from "murow";

/* ================================
   Constants
================================ */
export const WORLD_WIDTH = 800;
export const WORLD_HEIGHT = 600;
export const PLAYER_SIZE = 20;
export const PLAYER_SPEED = 200;
export const TICK_RATE = 16;
export const WS_PORT = 3007;

/* ================================
   Intents
================================ */
export enum IntentKind {
    Move = 0x1,
}

export enum Method {
    SpawnPlayer = 'spawn',
    PlayerSpawned = 'player-spawned',
}

export namespace Intents {
    export const Move = defineIntent({
        kind: IntentKind.Move,
        schema: {
            vx: BinaryCodec.i8, // -1, 0, 1
            vy: BinaryCodec.i8,
        },
    });

    export type Move = typeof Move.type;
}

export namespace RPCs {
    export const SpawnPlayer = defineRPC({
        method: Method.SpawnPlayer,
        schema: {
            id: BinaryCodec.string(16),
        },
    });

    export const PlayerSpawned = defineRPC({
        method: Method.PlayerSpawned,
        schema: {
            id: BinaryCodec.string(16),
            x: BinaryCodec.f32,
            y: BinaryCodec.f32,
            color: BinaryCodec.string(16),
        },
    });
}

/* ================================
   Types
================================ */
export type Player = {
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    color: string;
};

export type GameStateUpdate = Array<{
    id: string;
    x: number;
    y: number;
    color: string;
}>;

/* ================================
   Simulation
================================ */
export class Simulation<T extends GameLoopType> {
    readonly players = new Map<string, Player>();
    readonly loop: GameLoop<T>;

    constructor(type: T) {
        this.loop = new GameLoop<T>({
            type,
            tickRate: TICK_RATE
        });
    }

    /** Spawn a new player */
    spawn(id: string): Player {
        const player: Player = {
            id,
            x: WORLD_WIDTH / 2,
            y: WORLD_HEIGHT / 2,
            vx: 0,
            vy: 0,
            color: randomColor(),
        };

        this.players.set(id, player);
        return player;
    }

    /** Remove a player */
    remove(id: string) {
        this.players.delete(id);
    }

    /** Apply an intent (client or replay) */
    applyVelocity(id: string, intent: Omit<Intents.Move, 'kind' | 'tick'>) {
        const player = this.players.get(id);
        if (!player) return;

        const { vx, vy } = intent;

        if (vx === 0 && vy === 0) {
            player.vx = 0;
            player.vy = 0;
            return;
        }

        const len = Math.hypot(vx, vy);
        player.vx = (vx / len) * PLAYER_SPEED;
        player.vy = (vy / len) * PLAYER_SPEED;
    }

    /** Advance simulation by 1 tick */
    step(dt = 1 / TICK_RATE) {
        for (const p of this.players.values()) {
            p.x += p.vx * dt;
            p.y += p.vy * dt;

            // Clamp
            p.x = Math.max(PLAYER_SIZE / 2, Math.min(WORLD_WIDTH - PLAYER_SIZE / 2, p.x));
            p.y = Math.max(PLAYER_SIZE / 2, Math.min(WORLD_HEIGHT - PLAYER_SIZE / 2, p.y));
        }
    }

    /** Authoritative snapshot */
    getSnapshot(): GameStateUpdate {
        return Array.from(this.players.values()).map(p => ({
            id: p.id,
            x: p.x,
            y: p.y,
            color: p.color,
        }));
    }
}

/* ================================
   Registries
================================ */

export function createIntentRegistry(): IntentRegistry {
    const reg = new IntentRegistry();
    reg.register(Intents.Move);
    return reg;
}

export function createSnapshotRegistry(): SnapshotRegistry<GameStateUpdate> {
    const reg = new SnapshotRegistry<GameStateUpdate>();

    reg.register(
        "gameState",
        PooledCodec.array({
            id: BinaryCodec.string(64),
            x: BinaryCodec.f32,
            y: BinaryCodec.f32,
            color: BinaryCodec.string(16),
        })
    );

    return reg;
}



export function createRpcRegistry() {
    const reg = new RpcRegistry();
    reg.register(RPCs.SpawnPlayer);
    reg.register(RPCs.PlayerSpawned);
    return reg;
}

/* ================================
   Utils
================================ */
function randomColor() {
    const colors = [
        "#FF6B6B",
        "#4ECDC4",
        "#45B7D1",
        "#FFA07A",
        "#98D8C8",
        "#F7DC6F",
        "#BB8FCE",
    ];
    return colors[(Math.random() * colors.length) | 0];
}

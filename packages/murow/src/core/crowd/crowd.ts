import { SpatialHash } from '../spatial';
import type { NavMesh, NavType } from '../navmesh';

interface Vec2 {
    x: number;
    y: number;
}

export interface CrowdOptions<TType extends NavType = NavType> {
    /** Pathfinder the crowd asks for routes. */
    navmesh: NavMesh<TType, any>;
    /** Maximum number of agents. */
    capacity?: number;
    /** Default agent radius (units). */
    radius?: number;
    /** Default max speed (units/sec). */
    speed?: number;
    /** Separation strength. Default 1. */
    separation?: number;
    /** Distance (units) at which a waypoint counts as reached. Default 0.5. */
    waypointRadius?: number;
    /** Waypoints stored per agent. Longer paths are downsampled. Default 64. */
    maxWaypoints?: number;
}

export interface AgentOptions {
    x?: number;
    y?: number;
    radius?: number;
    speed?: number;
}

export interface AgentHandleBase {
    readonly id: number;
    readonly alive: boolean;
    readonly x: number;
    readonly y: number;
    readonly arrived: boolean;
    readonly hasGoal: boolean;
    readonly paused: boolean;
    speed: number;
    radius: number;
    setGoal(x: number, y: number): void;
    clearGoal(): void;
    stop(): void;
    resume(): void;
    teleport(x: number, y: number): void;
    destroy(): void;
}

export interface GridAgentHandle extends AgentHandleBase {
    /** Grid cell the agent is in (navmesh grid). */
    readonly cellX: number;
    readonly cellY: number;
    /** True when the last `update` moved the agent into a different cell. */
    readonly cellChanged: boolean;
}

export type AgentHandle<TType extends NavType = NavType> =
    TType extends 'grid' ? GridAgentHandle : AgentHandleBase;

/**
 * A set of moving agents over a NavMesh. Each tick an agent re-paths when its
 * goal changes or the navmesh version bumps, follows its waypoints, and is pushed
 * apart from its neighbors. 2D, matching the navmesh.
 */
export class Crowd<TType extends NavType = NavType> {
    readonly navmesh: NavMesh<TType, any>;
    readonly capacity: number;

    private readonly defaultRadius: number;
    private readonly defaultSpeed: number;
    private readonly separation: number;
    private readonly waypointRadius: number;
    private readonly maxWaypoints: number;
    private readonly cellSize: number;
    private readonly trackCells: boolean;

    private readonly live: Uint8Array;
    private readonly versions: Uint32Array;
    private readonly freeStack: Int32Array;
    private freeTop: number;
    private _count = 0;

    private readonly x: Float32Array;
    private readonly y: Float32Array;
    private readonly vx: Float32Array;
    private readonly vy: Float32Array;
    private readonly goalX: Float32Array;
    private readonly goalY: Float32Array;
    private readonly hasGoal: Uint8Array;
    private readonly arrived: Uint8Array;
    private readonly paused: Uint8Array;
    private readonly needsPath: Uint8Array;
    private readonly pathNavVersion: Int32Array;
    private readonly cursor: Int32Array;
    private readonly pathCount: Int32Array;
    private readonly speed: Float32Array;
    private readonly radius: Float32Array;
    private readonly cellX: Int32Array;
    private readonly cellY: Int32Array;
    private readonly cellChanged: Uint8Array;
    private readonly pathData: Float32Array;

    private readonly index: SpatialHash;
    private readonly box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    private readonly neighbors: number[] = [];
    private readonly req = { from: { x: 0, y: 0 }, to: { x: 0, y: 0 } };
    private readonly eachBox = { id: 0 };
    private eachHandle: AgentHandle<TType> | null = null;

    constructor(options: CrowdOptions<TType>) {
        const capacity = this.capacity = options.capacity ?? 256;
        this.navmesh = options.navmesh;
        this.defaultRadius = options.radius ?? 0.5;
        this.defaultSpeed = options.speed ?? 4;
        this.separation = options.separation ?? 1;
        this.waypointRadius = options.waypointRadius ?? 0.5;
        this.maxWaypoints = options.maxWaypoints ?? 64;
        this.cellSize = options.navmesh.cellSize;
        this.trackCells = options.navmesh.type === 'grid';

        this.live = new Uint8Array(capacity);
        this.versions = new Uint32Array(capacity).fill(1);
        this.freeStack = new Int32Array(capacity);
        for (let i = 0; i < capacity; i++) this.freeStack[i] = i;
        this.freeTop = capacity;

        this.x = new Float32Array(capacity);
        this.y = new Float32Array(capacity);
        this.vx = new Float32Array(capacity);
        this.vy = new Float32Array(capacity);
        this.goalX = new Float32Array(capacity);
        this.goalY = new Float32Array(capacity);
        this.hasGoal = new Uint8Array(capacity);
        this.arrived = new Uint8Array(capacity);
        this.paused = new Uint8Array(capacity);
        this.needsPath = new Uint8Array(capacity);
        this.pathNavVersion = new Int32Array(capacity).fill(-1);
        this.cursor = new Int32Array(capacity);
        this.pathCount = new Int32Array(capacity);
        this.speed = new Float32Array(capacity);
        this.radius = new Float32Array(capacity);
        this.cellX = new Int32Array(capacity);
        this.cellY = new Int32Array(capacity);
        this.cellChanged = new Uint8Array(capacity);
        this.pathData = new Float32Array(capacity * this.maxWaypoints * 2);

        const cell = Math.max(1e-4, this.defaultRadius * 2);
        this.index = new SpatialHash({ cellSize: cell, capacity, buckets: bucketSize(capacity) });
    }

    get count(): number {
        return this._count;
    }

    add(options?: AgentOptions): AgentHandle<TType> | null {
        if (this.freeTop === 0) return null;
        const slot = this.freeStack[--this.freeTop]!;
        this.live[slot] = 1;
        this.x[slot] = options?.x ?? 0;
        this.y[slot] = options?.y ?? 0;
        this.speed[slot] = options?.speed ?? this.defaultSpeed;
        this.radius[slot] = options?.radius ?? this.defaultRadius;
        this.vx[slot] = 0;
        this.vy[slot] = 0;
        this.hasGoal[slot] = 0;
        this.arrived[slot] = 0;
        this.paused[slot] = 0;
        this.needsPath[slot] = 0;
        this.pathCount[slot] = 0;
        this.cursor[slot] = 0;
        this._count++;

        const box = this.box;
        box.minX = box.maxX = this.x[slot]!;
        box.minY = box.maxY = this.y[slot]!;
        this.index.insert(slot, box);

        if (this.trackCells) {
            this.cellX[slot] = Math.floor(this.x[slot]! / this.cellSize);
            this.cellY[slot] = Math.floor(this.y[slot]! / this.cellSize);
        }
        this.cellChanged[slot] = 0;

        return this.makeHandle({ id: this.pack(slot) });
    }

    remove(handleOrId: AgentHandle | number): void {
        const slot = this.slot(handleOrId);
        if (slot === -1) return;
        this.release(slot);
    }

    clear(): void {
        for (let slot = 0; slot < this.capacity; slot++) if (this.live[slot] === 1) this.release(slot);
    }

    each(cb: (agent: AgentHandle<TType>) => void): void {
        const handle = this.eachHandle ??= this.makeHandle(this.eachBox);
        for (let slot = 0; slot < this.capacity; slot++) {
            if (this.live[slot] !== 1) continue;
            this.eachBox.id = this.pack(slot);
            cb(handle);
        }
    }

    update(deltaTime: number): void {
        const nav = this.navmesh;
        const version = nav.version;

        // Refresh the neighbor index from current positions.
        const box = this.box;
        for (let slot = 0; slot < this.capacity; slot++) {
            if (this.live[slot] === 0) continue;
            box.minX = box.maxX = this.x[slot]!;
            box.minY = box.maxY = this.y[slot]!;
            this.index.insert(slot, box);
        }

        for (let slot = 0; slot < this.capacity; slot++) {
            if (this.live[slot] === 0 || this.paused[slot] === 1 || this.hasGoal[slot] === 0) continue;

            // Re-path on a new goal or an obstacle change.
            if (this.needsPath[slot] === 1 || this.pathNavVersion[slot] !== version) {
                const req = this.req;
                req.from.x = this.x[slot]!;
                req.from.y = this.y[slot]!;
                req.to.x = this.goalX[slot]!;
                req.to.y = this.goalY[slot]!;
                const path = nav.findPath(req) as Vec2[] | Promise<Vec2[]>;
                if (Array.isArray(path)) {
                    this.store(slot, path);
                    this.pathNavVersion[slot] = version;
                    this.needsPath[slot] = 0;
                    this.arrived[slot] = 0;
                }
            }

            let dx = 0;
            let dy = 0;

            // Follow the current waypoint.
            const count = this.pathCount[slot]!;
            if (this.cursor[slot]! < count) {
                const at = (slot * this.maxWaypoints + this.cursor[slot]!) * 2;
                const tx = this.pathData[at]!;
                const ty = this.pathData[at + 1]!;
                const wx = tx - this.x[slot]!;
                const wy = ty - this.y[slot]!;
                const dist = Math.hypot(wx, wy);
                if (dist <= this.waypointRadius) {
                    this.cursor[slot] = this.cursor[slot]! + 1;
                    if (this.cursor[slot]! >= count) this.arrived[slot] = 1;
                } else {
                    const speed = this.speed[slot]!;
                    dx = (wx / dist) * speed;
                    dy = (wy / dist) * speed;
                }
            }

            // Separation from neighbors.
            if (this.separation !== 0) {
                const r = this.radius[slot]!;
                const reach = r * 2;
                box.minX = this.x[slot]! - reach;
                box.minY = this.y[slot]! - reach;
                box.maxX = this.x[slot]! + reach;
                box.maxY = this.y[slot]! + reach;
                const neighbors = this.neighbors;
                this.index.query(box, neighbors);
                let px = 0;
                let py = 0;
                for (let n = 0; n < neighbors.length; n++) {
                    const other = neighbors[n]!;
                    if (other === slot) continue;
                    const ox = this.x[slot]! - this.x[other]!;
                    const oy = this.y[slot]! - this.y[other]!;
                    const d2 = ox * ox + oy * oy;
                    if (d2 > 1e-6 && d2 < reach * reach) {
                        px += ox / d2;
                        py += oy / d2;
                    }
                }
                dx += px * this.separation;
                dy += py * this.separation;
            }

            const speed = this.speed[slot]!;
            const mag = Math.hypot(dx, dy);
            if (mag > speed) { const s = speed / mag; dx *= s; dy *= s; }
            this.vx[slot] = dx;
            this.vy[slot] = dy;
            this.x[slot] = this.x[slot]! + dx * deltaTime;
            this.y[slot] = this.y[slot]! + dy * deltaTime;
        }

        if (this.trackCells) {
            for (let slot = 0; slot < this.capacity; slot++) {
                if (this.live[slot] === 1) this.refreshCell(slot);
            }
        }
    }

    // --- handle plumbing -------------------------------------------------------

    private makeHandle(box: { id: number }): AgentHandle<TType> {
        const crowd = this;
        const s0 = () => crowd.slot(box.id);
        return {
            get id() { return box.id; },
            get alive() { return s0() !== -1; },
            get x() { const s = s0(); return s === -1 ? 0 : crowd.x[s]!; },
            get y() { const s = s0(); return s === -1 ? 0 : crowd.y[s]!; },
            get arrived() { const s = s0(); return s !== -1 && crowd.arrived[s] === 1; },
            get hasGoal() { const s = s0(); return s !== -1 && crowd.hasGoal[s] === 1; },
            get paused() { const s = s0(); return s !== -1 && crowd.paused[s] === 1; },
            get cellX() { const s = s0(); return s === -1 ? 0 : crowd.cellX[s]!; },
            get cellY() { const s = s0(); return s === -1 ? 0 : crowd.cellY[s]!; },
            get cellChanged() { const s = s0(); return s !== -1 && crowd.cellChanged[s] === 1; },
            get speed() { const s = s0(); return s === -1 ? 0 : crowd.speed[s]!; },
            set speed(v: number) { const s = s0(); if (s !== -1) crowd.speed[s] = v; },
            get radius() { const s = s0(); return s === -1 ? 0 : crowd.radius[s]!; },
            set radius(v: number) { const s = s0(); if (s !== -1) crowd.radius[s] = v; },
            setGoal(gx: number, gy: number) {
                const s = s0();
                if (s === -1) return;
                crowd.goalX[s] = gx;
                crowd.goalY[s] = gy;
                crowd.hasGoal[s] = 1;
                crowd.needsPath[s] = 1;
                crowd.arrived[s] = 0;
            },
            clearGoal() {
                const s = s0();
                if (s === -1) return;
                crowd.hasGoal[s] = 0;
                crowd.pathCount[s] = 0;
                crowd.cursor[s] = 0;
                crowd.vx[s] = 0;
                crowd.vy[s] = 0;
            },
            stop() { const s = s0(); if (s !== -1) crowd.paused[s] = 1; },
            resume() { const s = s0(); if (s !== -1) crowd.paused[s] = 0; },
            teleport(nx: number, ny: number) {
                const s = s0();
                if (s === -1) return;
                crowd.x[s] = nx;
                crowd.y[s] = ny;
                crowd.vx[s] = 0;
                crowd.vy[s] = 0;
                crowd.needsPath[s] = 1;
                const b = crowd.box;
                b.minX = b.maxX = nx;
                b.minY = b.maxY = ny;
                crowd.index.insert(s, b);
                if (crowd.trackCells) crowd.refreshCell(s);
            },
            destroy() { const s = s0(); if (s !== -1) crowd.release(s); },
        } as AgentHandle<TType>;
    }

    private pack(slot: number): number {
        return slot + this.versions[slot]! * this.capacity;
    }

    private slot(handleOrId: number | AgentHandle): number {
        const id = typeof handleOrId === 'number' ? handleOrId : handleOrId.id;
        const slot = id % this.capacity;
        const version = (id - slot) / this.capacity;
        return this.live[slot] === 1 && this.versions[slot] === version ? slot : -1;
    }

    private release(slot: number): void {
        if (slot === -1 || this.live[slot] === 0) return;
        this.live[slot] = 0;
        this.versions[slot] = this.versions[slot]! + 1;
        this.freeStack[this.freeTop++] = slot;
        this.index.remove(slot);
        this._count--;
    }

    private refreshCell(slot: number): void {
        const cx = Math.floor(this.x[slot]! / this.cellSize);
        const cy = Math.floor(this.y[slot]! / this.cellSize);
        if (cx !== this.cellX[slot] || cy !== this.cellY[slot]) {
            this.cellX[slot] = cx;
            this.cellY[slot] = cy;
            this.cellChanged[slot] = 1;
        } else {
            this.cellChanged[slot] = 0;
        }
    }

    private store(slot: number, path: Vec2[]): void {
        const max = this.maxWaypoints;
        const n = path.length;
        const count = Math.min(n, max);
        const base = slot * max * 2;
        if (n <= max) {
            for (let i = 0; i < n; i++) {
                this.pathData[base + i * 2] = path[i]!.x;
                this.pathData[base + i * 2 + 1] = path[i]!.y;
            }
        } else {
            const step = n / max;
            for (let i = 0; i < max - 1; i++) {
                const p = path[Math.floor(i * step)]!;
                this.pathData[base + i * 2] = p.x;
                this.pathData[base + i * 2 + 1] = p.y;
            }
            const last = path[n - 1]!;
            this.pathData[base + (max - 1) * 2] = last.x;
            this.pathData[base + (max - 1) * 2 + 1] = last.y;
        }
        this.pathCount[slot] = count;
        this.cursor[slot] = 0;
    }
}

function bucketSize(capacity: number): number {
    let buckets = 1024;
    const want = Math.max(1024, capacity);
    while (buckets < want && buckets < (1 << 20)) buckets <<= 1;
    return buckets;
}

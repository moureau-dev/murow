import type { CollectionEvents } from 'murow/core/collection';
import type { Handles } from '../../handles';
import { PooledCollection } from 'murow/core/collection';
import type { RawRenderPassEncoder } from 'murow/gpu';
import type { BeamId, RibbonId, TrailId } from '../../types';
import { RibbonBatch } from './ribbon-batch';
import { BeamItem, RibbonItem, TrailItem } from './items';
import type {
    BeamOptions,
    LineOptions,
    RibbonManagerCapacity,
    RibbonManagerDeps,
    RibbonOptions,
    TrailOptions,
} from './types';

interface PoolDeps {
    readonly batch: RibbonBatch;
    readonly capacity: number;
    readonly logger: RibbonManagerDeps['logger'];
}

class RibbonPool extends PooledCollection<RibbonId, RibbonItem, number> {
    private pending: LineOptions | RibbonOptions | null = null;

    constructor(private readonly deps: PoolDeps) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger, name: 'ribbons' });
    }

    create(options: LineOptions | RibbonOptions): RibbonItem {
        this.pending = options;
        try {
            return this.allocateItem().item;
        } finally {
            this.pending = null;
        }
    }

    protected createItem(id: RibbonId): RibbonItem {
        return new RibbonItem(id, this, this.deps.batch, this.pending!);
    }
}

class TrailPool extends PooledCollection<TrailId, TrailItem, number> {
    private pending: TrailOptions | null = null;
    private pendingMaxPoints = 0;
    private usedPoints = 0;
    private readonly reserved: Int32Array;
    private readonly maxTrailPoints: number;
    private readonly maxTotalTrailPoints: number;

    constructor(
        private readonly deps: PoolDeps,
        maxTrailPoints: number,
        maxTotalTrailPoints: number,
    ) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger, name: 'trails' });
        this.maxTrailPoints = Math.max(2, maxTrailPoints | 0);
        this.maxTotalTrailPoints = Math.max(this.maxTrailPoints, maxTotalTrailPoints | 0);
        this.reserved = new Int32Array(deps.capacity);
    }

    get totalPoints(): number {
        return this.usedPoints;
    }

    create(options: TrailOptions = {}): TrailItem {
        const requested = Math.max(1, Math.floor(options.maxPoints ?? Math.min(64, this.maxTrailPoints)));
        if (requested > this.maxTrailPoints) {
            const message = `trail maxPoints (${requested}) exceeds maxTrailPoints (${this.maxTrailPoints})`;
            this.deps.logger.error(message);
            throw new Error(message);
        }
        if (this.usedPoints + requested > this.maxTotalTrailPoints) {
            const message = `trail point budget (${this.maxTotalTrailPoints}) reached`;
            this.deps.logger.error(message);
            throw new Error(message);
        }

        this.pending = { ...options, maxPoints: requested };
        this.pendingMaxPoints = requested;
        try {
            const allocated = this.allocateItem();
            this.reserved[allocated.slot] = requested;
            this.usedPoints += requested;
            return allocated.item;
        } finally {
            this.pending = null;
            this.pendingMaxPoints = 0;
        }
    }

    protected createItem(id: TrailId): TrailItem {
        return new TrailItem(id, this, this.deps.batch, this.pending!, this.maxTrailPoints);
    }

    protected destroySlot(slot: number): void {
        const reserved = this.reserved[slot] ?? 0;
        this.reserved[slot] = 0;
        this.usedPoints = Math.max(0, this.usedPoints - reserved);
    }
}

class BeamPool extends PooledCollection<BeamId, BeamItem, number> {
    private pending: BeamOptions | null = null;

    constructor(private readonly deps: PoolDeps) {
        super({ poolSize: deps.capacity, capacity: deps.capacity, logger: deps.logger, name: 'beams' });
    }

    create(options: BeamOptions = {}): BeamItem {
        this.pending = options;
        try {
            return this.allocateItem().item;
        } finally {
            this.pending = null;
        }
    }

    protected createItem(id: BeamId): BeamItem {
        return new BeamItem(id, this, this.deps.batch, this.pending!);
    }
}

/**
 * Public strip manager. Lines, ribbons, trails, and beams share one dynamic
 * geometry batch and one draw pass, with independent handle pools.
 */
export class RibbonManager {
    readonly capacity: RibbonManagerCapacity;
    private readonly batch: RibbonBatch;
    private readonly ribbons: RibbonPool;
    private readonly trails: TrailPool;
    private readonly beams: BeamPool;

    private readonly writeRibbon = (item: RibbonItem): void => item.write(this.frameAlpha);
    private readonly writeTrail = (item: TrailItem): void => item.write(this.frameAlpha);
    private readonly writeBeam = (item: BeamItem): void => item.write(this.frameAlpha);
    private readonly simulateTrail = (item: TrailItem): void => item.simulate(this.frameDelta);
    private readonly simulateBeam = (item: BeamItem): void => item.advance(this.frameDelta);
    private frameAlpha = 1;
    private frameDelta = 0;

    constructor(private readonly deps: RibbonManagerDeps) {
        this.capacity = deps.capacity;
        this.batch = new RibbonBatch({
            runtime: deps.runtime,
            device: deps.device,
            format: deps.format,
            maxVertices: deps.capacity.maxVertices,
            logger: deps.logger,
            resolveTexture: deps.resolveTexture,
        });
        const poolDeps: PoolDeps = {
            batch: this.batch,
            capacity: 0,
            logger: deps.logger,
        };
        this.ribbons = new RibbonPool({ ...poolDeps, capacity: deps.capacity.maxRibbons });
        this.trails = new TrailPool(
            { ...poolDeps, capacity: deps.capacity.maxTrails },
            deps.capacity.maxTrailPoints,
            deps.capacity.maxTotalTrailPoints,
        );
        this.beams = new BeamPool({ ...poolDeps, capacity: deps.capacity.maxBeams });
    }

    get ribbonEvents(): CollectionEvents<Handles.RibbonHandle> { return this.ribbons.events as unknown as CollectionEvents<Handles.RibbonHandle>; }
    get trailEvents(): CollectionEvents<Handles.TrailHandle> { return this.trails.events as unknown as CollectionEvents<Handles.TrailHandle>; }
    get beamEvents(): CollectionEvents<Handles.BeamHandle> { return this.beams.events as unknown as CollectionEvents<Handles.BeamHandle>; }

    get ribbonCount(): number { return this.ribbons.count; }
    get trailCount(): number { return this.trails.count; }
    get beamCount(): number { return this.beams.count; }
    get ribbonCapacity(): number { return this.ribbons.capacity; }
    get trailCapacity(): number { return this.trails.capacity; }
    get beamCapacity(): number { return this.beams.capacity; }
    get trailPointCount(): number { return this.trails.totalPoints; }
    get vertexCapacity(): number { return this.batch.vertexCapacity; }
    get vertexUsage(): number { return this.batch.vertexUsage; }
    get indexUsage(): number { return this.batch.indexUsage; }
    get stripCount(): number { return this.batch.stripCount; }
    get droppedStrips(): number { return this.batch.dropped; }

    /** Add a raw line. */
    addLine(options: LineOptions): Handles.LineHandle {
        return this.ribbons.create({ ...options, layer: this.resolveLayer(options.layer) });
    }

    /** Add a raw ribbon. */
    add(options: RibbonOptions): Handles.RibbonHandle {
        return this.ribbons.create({ ...options, layer: this.resolveLayer(options.layer) });
    }

    /** Create a time-history trail. */
    createTrail(options: TrailOptions = {}): Handles.TrailHandle {
        return this.trails.create({ ...options, layer: this.resolveLayer(options.layer) });
    }

    /** Create a two-endpoint beam. */
    createBeam(options: BeamOptions = {}): Handles.BeamHandle {
        return this.beams.create({ ...options, layer: this.resolveLayer(options.layer) });
    }

    /** Age trails and advance beam texture scroll. The renderer calls this. */
    simulate(deltaTime: number): void {
        this.frameDelta = deltaTime;
        this.trails.each(this.simulateTrail);
        this.beams.each(this.simulateBeam);
    }

    /**
     * Build and draw every strip for one view. Call after the main mesh pass.
     * The renderer calls this once per active camera.
     */
    draw(
        pass: RawRenderPassEncoder,
        viewProj: Float32Array,
        cameraPosition: ArrayLike<number>,
        right: ArrayLike<number>,
        up: ArrayLike<number>,
        alpha: number,
        layerMask = 0xffffffff,
    ): void {
        if (this.ribbons.count === 0 && this.trails.count === 0 && this.beams.count === 0) return;
        this.frameAlpha = alpha;
        this.batch.begin(viewProj, cameraPosition, right, up, alpha, layerMask);
        this.ribbons.each(this.writeRibbon);
        this.trails.each(this.writeTrail);
        this.beams.each(this.writeBeam);
        this.batch.end(pass);
    }

    private resolveLayer(layer: number | string | undefined): number {
        if (layer === undefined) return this.deps.layers?.defaultBit ?? 1;
        if (typeof layer === 'number') return layer >>> 0;
        return this.deps.layers?.resolveLayer(layer) ?? 1;
    }

    clear(): void {
        this.ribbons.clear();
        this.trails.clear();
        this.beams.clear();
    }

    destroy(): void {
        this.ribbons.destroy();
        this.trails.destroy();
        this.beams.destroy();
        this.batch.destroy();
    }
}

import type { BeamId, RibbonId, TrailId } from '../../types';
import type { AppendStripOptions, RibbonBatch } from './ribbon-batch';
import type {
    BeamHandle,
    BeamOptions,
    LineOptions,
    RibbonBlend,
    RibbonColor,
    RibbonGradient,
    RibbonHandle,
    RibbonOptions,
    RibbonWidth,
    TrailHandle,
    TrailOptions,
} from './types';

const DEFAULT_COLOR: RibbonColor = [1, 1, 1, 1];
const DEFAULT_GRADIENT: RibbonGradient = [[1, 1, 1, 1], [1, 1, 1, 0]];
const DEFAULT_TRAIL_POINTS = 64;

interface RibbonPoolHost<Id extends number> {
    has(id: Id): boolean;
    remove(id: Id): void;
}

function copyColor(color: RibbonColor): RibbonColor {
    return [color[0], color[1], color[2], color[3]];
}

function copyGradient(color: RibbonGradient): RibbonGradient {
    return [copyColor(color[0]), copyColor(color[1])];
}

function isGradient(color: RibbonColor | RibbonGradient): color is RibbonGradient {
    return Array.isArray(color[0]);
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** A raw line or ribbon strip. */
export class RibbonItem implements RibbonHandle {
    readonly id: RibbonId;
    readonly maxPoints: number;
    enabled = true;
    private readonly pool: RibbonPoolHost<RibbonId>;
    private readonly batch: RibbonBatch;
    private points: Float32Array;
    private readonly prevPoints: Float32Array;
    private readonly scratch: Float32Array;
    private pointCount = 0;
    private prevPointCount = 0;
    private width: RibbonWidth;
    private color: RibbonColor | RibbonGradient;
    private texture: string | null;
    private blend: RibbonBlend;
    private opacity = 1;
    private readonly depthTest: boolean;
    private readonly facing: 'camera' | 'up';
    private readonly uvScale: number;
    private readonly layer: number;
    private readonly closed: boolean;
    private readonly drawOptions: AppendStripOptions;

    constructor(
        id: RibbonId,
        pool: RibbonPoolHost<RibbonId>,
        batch: RibbonBatch,
        options: LineOptions | RibbonOptions,
    ) {
        this.id = id;
        this.pool = pool;
        this.batch = batch;
        const initialPoints = options.points === undefined ? 0 : Math.ceil(options.points.length / 3);
        this.maxPoints = Math.max(2, options.maxPoints ?? Math.max(1024, initialPoints));
        this.points = new Float32Array(this.maxPoints * 3);
        this.prevPoints = new Float32Array(this.maxPoints * 3);
        this.scratch = new Float32Array(this.maxPoints * 3);
        this.width = options.width ?? 0.05;
        this.color = options.color === undefined ? DEFAULT_COLOR : copyColorOrGradient(options.color);
        this.texture = options.texture ?? null;
        this.blend = options.blend ?? 'alpha';
        this.depthTest = options.depthTest !== false;
        this.facing = options.facing ?? 'camera';
        this.uvScale = options.uvScale ?? 1;
        this.layer = typeof options.layer === 'number' ? options.layer : 1;
        this.closed = options.closed === true;
        this.drawOptions = {
            width: this.width,
            color: this.color,
            texture: this.texture,
            blend: this.blend,
            depthTest: this.depthTest,
            facing: this.facing,
            closed: this.closed,
            uvScale: this.uvScale,
            layer: this.layer,
        };
        if (options.points !== undefined) this.setPoints(options.points);
    }

    get alive(): boolean {
        return this.pool.has(this.id);
    }

    setPoints(points: ArrayLike<number>): void {
        const count = Math.floor(points.length / 3);
        if (count > this.maxPoints) {
            throw new Error(`Ribbon setPoints exceeds maxPoints (${this.maxPoints})`);
        }
        const oldCount = this.pointCount;
        if (oldCount > 0) {
            this.prevPoints.set(this.points.subarray(0, oldCount * 3));
            this.prevPointCount = oldCount;
        }
        for (let i = 0; i < count * 3; i++) this.points[i] = points[i]!;
        this.pointCount = count;
        if (oldCount === 0) {
            this.prevPoints.set(this.points.subarray(0, count * 3));
            this.prevPointCount = count;
        }
    }

    setColor(r: number, g: number, b: number, a: number): void {
        this.color = [r, g, b, a];
    }

    setWidth(width: RibbonWidth): void {
        this.width = width;
    }

    setOpacity(alpha: number): void {
        this.opacity = Math.max(0, Math.min(1, alpha));
    }

    setTexture(id: string | null): void {
        this.texture = id;
    }

    setBlend(blend: RibbonBlend): void {
        this.blend = blend;
    }

    /** @internal */
    write(alpha: number): void {
        if (!this.enabled || this.pointCount < 2) return;
        let source = this.points;
        if (alpha < 0.999 && this.prevPointCount === this.pointCount) {
            const count = this.pointCount;
            for (let i = 0; i < count; i++) {
                const o = i * 3;
                this.scratch[o] = lerp(this.prevPoints[o]!, this.points[o]!, alpha);
                this.scratch[o + 1] = lerp(this.prevPoints[o + 1]!, this.points[o + 1]!, alpha);
                this.scratch[o + 2] = lerp(this.prevPoints[o + 2]!, this.points[o + 2]!, alpha);
            }
            source = this.scratch;
        }
        const d = this.drawOptions;
        d.width = this.width;
        d.color = this.color;
        d.texture = this.texture;
        d.blend = this.blend;
        d.opacity = this.opacity;
        this.batch.appendStrip(source, this.pointCount, d);
    }

    destroy(): void {
        if (this.alive) this.pool.remove(this.id);
    }
}

/** A time-history ribbon attached to a moving head. */
export class TrailItem implements TrailHandle {
    readonly id: TrailId;
    readonly maxPoints: number;
    lifetime: number;
    enabled = true;
    private readonly pool: RibbonPoolHost<TrailId>;
    private readonly batch: RibbonBatch;
    private minDistance: number;
    private width: RibbonWidth;
    private color: RibbonGradient;
    private texture: string | null;
    private blend: RibbonBlend;
    private opacity = 1;
    private readonly depthTest: boolean;
    private readonly facing: 'camera' | 'up';
    private readonly uvScale: number;
    private readonly layer: number;
    private readonly drawOptions: AppendStripOptions;
    private readonly points: Float32Array;
    private readonly ages: Float32Array;
    private readonly scratch: Float32Array;
    private readonly scratchAlphas: Float32Array;
    private count = 0;
    private hasHead = false;
    private prevX = 0;
    private prevY = 0;
    private prevZ = 0;
    private currX = 0;
    private currY = 0;
    private currZ = 0;
    private commitX = 0;
    private commitY = 0;
    private commitZ = 0;
    private hasCommit = false;

    constructor(
        id: TrailId,
        pool: RibbonPoolHost<TrailId>,
        batch: RibbonBatch,
        options: TrailOptions,
        maxTrailPoints: number,
    ) {
        this.id = id;
        this.pool = pool;
        this.batch = batch;
        const requested = options.maxPoints ?? Math.min(DEFAULT_TRAIL_POINTS, maxTrailPoints);
        if (requested > maxTrailPoints) {
            throw new Error(`Trail maxPoints (${requested}) exceeds maxTrailPoints (${maxTrailPoints})`);
        }
        this.maxPoints = Math.max(2, requested);
        this.lifetime = Math.max(1e-3, options.lifetime ?? 0.5);
        this.minDistance = Math.max(0, options.minDistance ?? 0.05);
        this.width = options.width ?? [0.15, 0];
        this.color = options.color === undefined ? copyGradient(DEFAULT_GRADIENT) : copyGradient(options.color);
        this.texture = options.texture ?? null;
        this.blend = options.blend ?? 'alpha';
        this.depthTest = options.depthTest !== false;
        this.facing = options.facing ?? 'camera';
        this.uvScale = options.uvScale ?? 1;
        this.layer = typeof options.layer === 'number' ? options.layer : 1;
        this.points = new Float32Array(this.maxPoints * 3);
        this.ages = new Float32Array(this.maxPoints);
        this.scratch = new Float32Array((this.maxPoints + 1) * 3);
        this.scratchAlphas = new Float32Array(this.maxPoints + 1);
        this.drawOptions = {
            width: this.width,
            color: this.color,
            texture: this.texture,
            blend: this.blend,
            depthTest: this.depthTest,
            facing: this.facing,
            uvScale: this.uvScale,
            alphas: this.scratchAlphas,
            layer: this.layer,
        };
    }

    get alive(): boolean {
        return this.pool.has(this.id);
    }

    get pointCount(): number {
        return this.count + (this.hasHead ? 1 : 0);
    }

    setHead(x: number, y: number, z: number): void {
        if (!this.enabled) return;
        if (!this.hasHead) {
            this.hasHead = true;
            this.prevX = this.currX = x;
            this.prevY = this.currY = y;
            this.prevZ = this.currZ = z;
            return;
        }

        this.prevX = this.currX; this.prevY = this.currY; this.prevZ = this.currZ;
        this.currX = x; this.currY = y; this.currZ = z;

        if (!this.hasCommit) {
            this.pushPoint(this.prevX, this.prevY, this.prevZ);
            this.commitX = this.prevX; this.commitY = this.prevY; this.commitZ = this.prevZ;
            this.hasCommit = true;
            return;
        }

        const dx = this.prevX - this.commitX;
        const dy = this.prevY - this.commitY;
        const dz = this.prevZ - this.commitZ;
        if (dx * dx + dy * dy + dz * dz >= this.minDistance * this.minDistance) {
            this.pushPoint(this.prevX, this.prevY, this.prevZ);
            this.commitX = this.prevX; this.commitY = this.prevY; this.commitZ = this.prevZ;
        }
    }

    setWidth(width: RibbonWidth): void {
        this.width = width;
    }

    setLifetime(seconds: number): void {
        this.lifetime = Math.max(1e-3, seconds);
    }

    setMinDistance(distance: number): void {
        this.minDistance = Math.max(0, distance);
    }

    teleport(x: number, y: number, z: number): void {
        this.count = 0;
        this.hasCommit = false;
        this.hasHead = true;
        this.prevX = this.currX = x;
        this.prevY = this.currY = y;
        this.prevZ = this.currZ = z;
    }

    setOpacity(alpha: number): void {
        this.opacity = Math.max(0, Math.min(1, alpha));
    }

    setTexture(id: string | null): void {
        this.texture = id;
    }

    setBlend(blend: RibbonBlend): void {
        this.blend = blend;
    }

    setColor(start: RibbonColor, end: RibbonColor): void {
        this.color = [copyColor(start), copyColor(end)];
    }

    clear(): void {
        this.count = 0;
        this.hasHead = false;
        this.hasCommit = false;
    }

    simulate(deltaTime: number): void {
        if (this.count === 0) return;
        let drop = 0;
        for (let i = 0; i < this.count; i++) {
            this.ages[i]! += deltaTime;
            if (this.ages[i]! > this.lifetime) drop = i + 1;
        }
        if (drop > 0) {
            const remaining = this.count - drop;
            this.points.copyWithin(0, drop * 3, this.count * 3);
            this.ages.copyWithin(0, drop, this.count);
            this.count = remaining;
        }
    }

    /** @internal */
    write(alpha: number): void {
        if (!this.enabled || !this.hasHead || this.count === 0) return;

        let total = 0;
        for (let i = 0; i < this.count; i++) {
            this.scratch[total * 3] = this.points[i * 3]!;
            this.scratch[total * 3 + 1] = this.points[i * 3 + 1]!;
            this.scratch[total * 3 + 2] = this.points[i * 3 + 2]!;
            this.scratchAlphas[total] = 1 - Math.min(1, this.ages[i]! / this.lifetime);
            total++;
        }

        const hx = lerp(this.prevX, this.currX, alpha);
        const hy = lerp(this.prevY, this.currY, alpha);
        const hz = lerp(this.prevZ, this.currZ, alpha);
        const lx = this.scratch[(total - 1) * 3]!;
        const ly = this.scratch[(total - 1) * 3 + 1]!;
        const lz = this.scratch[(total - 1) * 3 + 2]!;
        const dx = hx - lx;
        const dy = hy - ly;
        const dz = hz - lz;
        if (total === 0 || dx * dx + dy * dy + dz * dz > 1e-10) {
            this.scratch[total * 3] = hx;
            this.scratch[total * 3 + 1] = hy;
            this.scratch[total * 3 + 2] = hz;
            this.scratchAlphas[total] = 1;
            total++;
        }

        if (total < 2) return;
        const d = this.drawOptions;
        d.width = this.width;
        d.color = this.color;
        d.texture = this.texture;
        d.blend = this.blend;
        d.opacity = this.opacity;
        this.batch.appendStrip(this.scratch, total, d);
    }

    destroy(): void {
        if (this.alive) this.pool.remove(this.id);
    }

    private pushPoint(x: number, y: number, z: number): void {
        if (this.count === this.maxPoints) {
            this.points.copyWithin(0, 3, this.maxPoints * 3);
            this.ages.copyWithin(0, 1, this.maxPoints);
            this.count--;
        }
        const i = this.count;
        this.points[i * 3] = x;
        this.points[i * 3 + 1] = y;
        this.points[i * 3 + 2] = z;
        this.ages[i] = 0;
        this.count++;
    }
}

/** A two-endpoint ribbon with optional UV scroll and noise. */
export class BeamItem implements BeamHandle {
    readonly id: BeamId;
    enabled = true;
    private readonly pool: RibbonPoolHost<BeamId>;
    private readonly batch: RibbonBatch;
    private fromX = 0; private fromY = 0; private fromZ = 0;
    private toX = 0; private toY = 0; private toZ = 0;
    private prevFromX = 0; private prevFromY = 0; private prevFromZ = 0;
    private prevToX = 0; private prevToY = 0; private prevToZ = 0;
    private hasEndpoints = false;
    private width: number;
    private color: RibbonColor;
    private texture: string | null;
    private blend: RibbonBlend;
    private opacity = 1;
    private readonly depthTest: boolean;
    private readonly facing: 'camera' | 'up';
    private readonly uvScale: number;
    private readonly layer: number;
    private readonly drawOptions: AppendStripOptions;
    private uvScroll: number;
    private readonly segments: number;
    private noise: number;
    private noiseFrequency: number;
    private noiseSpeed: number;
    private readonly scratch: Float32Array;
    private time = 0;

    constructor(
        id: BeamId,
        pool: RibbonPoolHost<BeamId>,
        batch: RibbonBatch,
        options: BeamOptions,
    ) {
        this.id = id;
        this.pool = pool;
        this.batch = batch;
        this.width = options.width ?? 0.15;
        this.color = options.color === undefined ? [1, 1, 1, 1] : copyColor(options.color);
        this.texture = options.texture ?? null;
        this.blend = options.blend ?? 'additive';
        this.depthTest = options.depthTest !== false;
        this.facing = options.facing ?? 'camera';
        this.uvScale = options.uvScale ?? 1;
        this.layer = typeof options.layer === 'number' ? options.layer : 1;
        this.drawOptions = {
            width: this.width,
            color: this.color,
            texture: this.texture,
            blend: this.blend,
            depthTest: this.depthTest,
            facing: this.facing,
            uvScale: this.uvScale,
            layer: this.layer,
        };
        this.uvScroll = options.uvScroll ?? 0;
        this.segments = Math.max(1, Math.floor(options.segments ?? 1));
        this.noise = Math.max(0, options.noise ?? 0);
        this.noiseFrequency = Math.max(0, options.noiseFrequency ?? 2);
        this.noiseSpeed = Math.max(0, options.noiseSpeed ?? 1);
        this.scratch = new Float32Array((this.segments + 1) * 3);
    }

    get alive(): boolean {
        return this.pool.has(this.id);
    }

    set(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number): void {
        if (this.hasEndpoints) {
            this.prevFromX = this.fromX; this.prevFromY = this.fromY; this.prevFromZ = this.fromZ;
            this.prevToX = this.toX; this.prevToY = this.toY; this.prevToZ = this.toZ;
        } else {
            this.prevFromX = fromX; this.prevFromY = fromY; this.prevFromZ = fromZ;
            this.prevToX = toX; this.prevToY = toY; this.prevToZ = toZ;
            this.hasEndpoints = true;
        }
        this.fromX = fromX; this.fromY = fromY; this.fromZ = fromZ;
        this.toX = toX; this.toY = toY; this.toZ = toZ;
    }

    setWidth(width: number): void {
        this.width = width;
    }

    setNoise(amount: number): void {
        this.noise = Math.max(0, amount);
    }

    setUvScroll(speed: number): void {
        this.uvScroll = speed;
    }

    setNoiseSpeed(speed: number): void {
        this.noiseSpeed = Math.max(0, speed);
    }

    setNoiseFrequency(frequency: number): void {
        this.noiseFrequency = Math.max(0, frequency);
    }

    setOpacity(alpha: number): void {
        this.opacity = Math.max(0, Math.min(1, alpha));
    }

    setTexture(id: string | null): void {
        this.texture = id;
    }

    setBlend(blend: RibbonBlend): void {
        this.blend = blend;
    }

    setColor(r: number, g: number, b: number, a: number): void {
        this.color = [r, g, b, a];
    }

    /** @internal */
    advance(deltaTime: number): void {
        this.time += deltaTime;
    }

    /** @internal */
    write(alpha: number): void {
        if (!this.enabled || !this.hasEndpoints) return;
        const fromX = lerp(this.prevFromX, this.fromX, alpha);
        const fromY = lerp(this.prevFromY, this.fromY, alpha);
        const fromZ = lerp(this.prevFromZ, this.fromZ, alpha);
        const toX = lerp(this.prevToX, this.toX, alpha);
        const toY = lerp(this.prevToY, this.toY, alpha);
        const toZ = lerp(this.prevToZ, this.toZ, alpha);
        const dx = toX - fromX;
        const dy = toY - fromY;
        const dz = toZ - fromZ;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-8) return;

        const ux = dx / len;
        const uy = dy / len;
        const uz = dz / len;
        let px = uy * 0 - uz * 1;
        let py = uz * 0 - ux * 0;
        let pz = ux * 1 - uy * 0;
        if (Math.abs(px) + Math.abs(py) + Math.abs(pz) < 1e-6) {
            px = 1; py = 0; pz = 0;
        } else {
            const pl = Math.hypot(px, py, pz);
            px /= pl; py /= pl; pz /= pl;
        }

        const count = this.segments + 1;
        for (let i = 0; i < count; i++) {
            const t = i / this.segments;
            const envelope = Math.sin(Math.PI * t);
            // Smooth wave. `noiseSpeed = 0` stands still and breathes instead of
            // crawling from one endpoint to the other.
            const phase = this.time * this.noiseSpeed;
            const breathe = 0.85 + 0.15 * Math.sin(this.time * 1.7);
            const wobble = this.noise * envelope * breathe * (
                Math.sin(t * Math.PI * 2 * this.noiseFrequency - phase * 1.6) * 0.75 +
                Math.sin(t * Math.PI * 2 * this.noiseFrequency * 2.0 + phase * 0.9) * 0.25
            );
            this.scratch[i * 3] = fromX + dx * t + px * wobble;
            this.scratch[i * 3 + 1] = fromY + dy * t + py * wobble;
            this.scratch[i * 3 + 2] = fromZ + dz * t + pz * wobble;
        }

        const d = this.drawOptions;
        d.width = this.width;
        d.color = this.color;
        d.texture = this.texture;
        d.blend = this.blend;
        d.opacity = this.opacity;
        d.uvOffset = this.time * this.uvScroll;
        this.batch.appendStrip(this.scratch, count, d);
    }

    destroy(): void {
        if (this.alive) this.pool.remove(this.id);
    }
}

function copyColorOrGradient(color: RibbonColor | RibbonGradient): RibbonColor | RibbonGradient {
    return isGradient(color) ? copyGradient(color) : copyColor(color);
}

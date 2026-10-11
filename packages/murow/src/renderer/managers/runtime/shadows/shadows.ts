import type { ShadowSystem, ShadowDrawBatch } from './shadow-system';
import type { SpotShadowSystem } from './spot-shadow-system';
import type { PointShadowSystem } from './point-shadow-system';
import type { InstanceManager } from '../instances';
import type { MaterialManager } from '../materials';
import type { LightManager } from '../lights';
import type { CameraManager } from '../camera';
import type { RendererCore } from '../../core/renderer-core';
import { Frustum } from '../../internals/frustum';
import { SparseBatcher } from 'murow/core/sparse-batcher';
import { DYNAMIC_MESH_FLOATS, STATIC_MESH_FLOATS, SKINNED_STATIC_MESH_FLOATS } from '../../../../core/types';
import {
    DYN_CURR_PX, DYN_CURR_PY, DYN_CURR_PZ,
    STAT_SX, STAT_SY, STAT_SZ,
    SSTAT_SX, SSTAT_SY, SSTAT_SZ, SSTAT_MATERIAL_ID,
} from '../instances/offsets';

/** Whether a sphere is within any light's range (a cheap caster cull). */
function inAnySpotRange(
    casters: readonly { px: number; py: number; pz: number; range: number }[],
    count: number,
    cx: number, cy: number, cz: number, radius: number,
): boolean {
    for (let k = 0; k < count; k++) {
        const s = casters[k]!;
        const dx = cx - s.px, dy = cy - s.py, dz = cz - s.pz;
        const r = s.range + radius;
        if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
    return false;
}

/**
 * Dependencies shared by the three shadow caster managers. Each sub-manager
 * gathers its own casters from `instances`, filters them through `materials`,
 * and reads the passing lights from `lights`.
 */
export interface ShadowCasterDeps {
    instances: InstanceManager;
    materials: MaterialManager;
    lights: LightManager;
    camera: CameraManager;
    core: RendererCore;
    /** Monotonic counter bumped when an instance or skinned pose changes. */
    motionVersion(): number;
}

/** The single directional (sun) shadow map. */
export class DirectionalShadowManager {
    private readonly lightFrustum = new Frustum();
    private lastMotion = -1;
    private readonly batches: ShadowDrawBatch[] = [];
    private readonly skinnedBatches: ShadowDrawBatch[] = [];
    private readonly slots: Uint32Array<ArrayBuffer>;
    private readonly skinnedSlots: Uint32Array<ArrayBuffer>;

    constructor(private readonly system: ShadowSystem, private readonly deps: ShadowCasterDeps) {
        this.slots = new Uint32Array(deps.instances.capacity);
        this.skinnedSlots = new Uint32Array(deps.instances.skinnedStore.slots.capacity);
    }

    /** Whether the directional shadow pass runs. */
    get enabled(): boolean { return this.system.enabled; }
    set enabled(value: boolean) { this.system.enabled = value; }

    /** Orthographic half-extent fitted around the camera. */
    get distance(): number { return this.system.distance; }
    set distance(value: number) { this.system.distance = value; }

    /** Depth comparison bias. */
    get bias(): number { return this.system.bias; }
    set bias(value: number) { this.system.bias = value; }

    /** PCF penumbra width in texels. */
    get softness(): number { return this.system.softness; }
    set softness(value: number) { this.system.softness = value; }

    /** Shadow map resolution (square). Assigning rebuilds the map and rebinds materials. */
    get resolution(): number { return this.system.resolution; }
    set resolution(value: number) { this.system.resolution = value; }

    /** @internal Recompute the sun's ortho box; returns true when it changed. */
    update(sunDir: readonly [number, number, number], focus: readonly [number, number, number]): boolean {
        return this.system.update(sunDir, focus);
    }

    /** @internal The sun's view-projection matrix, for caster culling. */
    get viewProjection(): Float32Array { return this.system.viewProjection; }

    /** @internal Register the callback fired when the map is rebuilt. */
    setResolutionHook(fn: () => void): void { this.system.setResolutionHook(fn); }

    /** @internal Upload this pass's caster slot indices. */
    setSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        this.system.setSlots(slots, count);
    }

    /** @internal Upload this pass's skinned caster slot indices. */
    setSkinnedSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        this.system.setSkinnedSlots(slots, count);
    }

    /**
     * @internal Gather the casters (all live instances minus those outside the
     * light box) and record the directional pass. Skips the pass when the box
     * and caster poses are unchanged.
     */
    render(encoder: GPUCommandEncoder): void {
        const { instances, materials, core, camera, lights } = this.deps;
        const boxChanged = this.system.update(lights.sunDirection, camera.position);
        if (!this.system.enabled) return;
        const motion = this.deps.motionVersion();
        if (!boxChanged && motion === this.lastMotion) return;
        this.lastMotion = motion;

        this.lightFrustum.setFromViewProjection(this.system.viewProjection);
        const sb = this.batches;
        sb.length = 0;
        const slots = this.slots;
        const dyn = instances.store.dynamicData;
        const stat = instances.store.staticData;
        let slotCount = 0;
        instances.store.batcher.each((modelId, batchSlots, batchCount, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            if (materialId > 0) {
                const m = materials.library.get(materialId);
                if (!m || m.transparent || !materials.library.casts(materialId)) return;
            }
            const model = core.models.get(modelId);
            if (!model) return;
            const baseRadius = model.boundingRadius;
            const offset = slotCount;
            for (let i = 0; i < batchCount; i++) {
                const slot = batchSlots[i]!;
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * STATIC_MESH_FLOATS;
                const cx = dyn[base + DYN_CURR_PX];
                const cy = dyn[base + DYN_CURR_PY];
                const cz = dyn[base + DYN_CURR_PZ];
                const sx = stat[sBase + STAT_SX];
                const sy = stat[sBase + STAT_SY];
                const sz = stat[sBase + STAT_SZ];
                const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                if (this.lightFrustum.intersectsSphere(cx, cy, cz, baseRadius * maxScale)) {
                    slots[slotCount++] = slot;
                }
            }
            if (slotCount > offset) sb.push({ modelId, offset, count: slotCount - offset });
        });
        this.system.setSlots(slots, slotCount);

        const skb = this.skinnedBatches;
        skb.length = 0;
        const sslots = this.skinnedSlots;
        const sDyn = instances.skinnedStore.dynamicData;
        const sStat = instances.skinnedStore.staticData;
        let sSlotCount = 0;
        instances.skinnedStore.batcher.each((modelId, batchSlots, batchCount) => {
            const model = core.models.get(modelId);
            if (!model) return;
            const skinModel = model.skinIndex >= 0 ? core.models.skinnedModel(model.skinIndex) : null;
            const baseRadius = skinModel?.boundingRadius ?? 10;
            const offset = sSlotCount;
            for (let i = 0; i < batchCount; i++) {
                const slot = batchSlots[i]!;
                const mid = sStat[slot * SKINNED_STATIC_MESH_FLOATS + SSTAT_MATERIAL_ID]!;
                if (mid > 0) {
                    const m = materials.library.get(mid);
                    if (!m || m.transparent || !materials.library.casts(mid)) continue;
                }
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * SKINNED_STATIC_MESH_FLOATS;
                const cx = sDyn[base + DYN_CURR_PX];
                const cy = sDyn[base + DYN_CURR_PY];
                const cz = sDyn[base + DYN_CURR_PZ];
                const sx = sStat[sBase + SSTAT_SX];
                const sy = sStat[sBase + SSTAT_SY];
                const sz = sStat[sBase + SSTAT_SZ];
                const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                if (this.lightFrustum.intersectsSphere(cx, cy, cz, baseRadius * maxScale)) {
                    sslots[sSlotCount++] = slot;
                }
            }
            if (sSlotCount > offset) skb.push({ modelId, offset, count: sSlotCount - offset });
        });
        this.system.setSkinnedSlots(sslots, sSlotCount);

        this.system.encode(encoder, sb, (id) => core.models.get(id) as any, skb);
    }
}

/** The spot-light shadow pass (a texture array of N maps). */
export class SpotShadowManager {
    private lastHash = NaN;
    private lastMotion = -1;
    private readonly batches: ShadowDrawBatch[] = [];
    private readonly skinnedBatches: ShadowDrawBatch[] = [];
    private readonly slots: Uint32Array<ArrayBuffer>;
    private readonly skinnedSlots: Uint32Array<ArrayBuffer>;

    constructor(private readonly system: SpotShadowSystem, private readonly deps: ShadowCasterDeps) {
        this.slots = new Uint32Array(deps.instances.capacity);
        this.skinnedSlots = new Uint32Array(deps.instances.skinnedStore.slots.capacity);
    }

    get enabled(): boolean { return this.system.enabled; }
    set enabled(value: boolean) { this.system.enabled = value; }

    /** Max casting spot lights per frame. Fixed at init time. */
    get capacity(): number { return this.system.maxShadows; }

    get resolution(): number { return this.system.resolution; }
    set resolution(value: number) { this.system.resolution = value; }

    get bias(): number { return this.system.bias; }
    set bias(value: number) { this.system.bias = value; }

    /** @internal Upload this pass's caster slot indices. */
    setSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        this.system.setSlots(slots, count);
    }

    /** @internal Upload this pass's skinned caster slot indices. */
    setSkinnedSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        this.system.setSkinnedSlots(slots, count);
    }

    /**
     * @internal Assign shadow slots, gather the casters inside the spot range
     * spheres, and record the spot pass. Skips the pass when the casters and
     * poses are unchanged.
     */
    render(encoder: GPUCommandEncoder): void {
        const { instances, materials, core, lights } = this.deps;
        const casterCount = lights.assignSpotShadows(this.system.maxShadows);
        if (casterCount <= 0) {
            this.lastHash = NaN;
            return;
        }
        const casters = lights.spotCasters;
        let hash = casterCount;
        for (let i = 0; i < casterCount; i++) {
            const s = casters[i]!;
            hash = (hash * 31 + ((s.px * 7 + s.py * 13 + s.pz * 17 + s.dx * 19 + s.dy * 23 + s.dz * 29 + s.angle * 31 + s.range * 37) | 0)) | 0;
        }
        const motion = this.deps.motionVersion();
        if (hash === this.lastHash && motion === this.lastMotion) return;
        this.lastHash = hash;
        this.lastMotion = motion;

        const spb = this.batches;
        spb.length = 0;
        const spts = this.slots;
        const dyn = instances.store.dynamicData;
        const stat = instances.store.staticData;
        let sptCount = 0;
        instances.store.batcher.each((modelId, batchSlots, batchCount, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            if (materialId > 0) {
                const m = materials.library.get(materialId);
                if (!m || m.transparent || !materials.library.casts(materialId)) return;
            }
            const model = core.models.get(modelId);
            if (!model) return;
            const baseRadius = model.boundingRadius;
            const offset = sptCount;
            for (let i = 0; i < batchCount; i++) {
                const slot = batchSlots[i]!;
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * STATIC_MESH_FLOATS;
                const cx = dyn[base + DYN_CURR_PX];
                const cy = dyn[base + DYN_CURR_PY];
                const cz = dyn[base + DYN_CURR_PZ];
                const sx = stat[sBase + STAT_SX];
                const sy = stat[sBase + STAT_SY];
                const sz = stat[sBase + STAT_SZ];
                const ms = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                const radius = baseRadius * ms;
                if (inAnySpotRange(casters, casterCount, cx, cy, cz, radius)) spts[sptCount++] = slot;
            }
            if (sptCount > offset) spb.push({ modelId, offset, count: sptCount - offset });
        });
        this.system.setSlots(spts, sptCount);

        const sskb = this.skinnedBatches;
        sskb.length = 0;
        const ssslots = this.skinnedSlots;
        const sDyn = instances.skinnedStore.dynamicData;
        const sStat = instances.skinnedStore.staticData;
        let sskCount = 0;
        instances.skinnedStore.batcher.each((modelId, batchSlots, batchCount) => {
            const model = core.models.get(modelId);
            if (!model) return;
            const skinModel = model.skinIndex >= 0 ? core.models.skinnedModel(model.skinIndex) : null;
            const baseRadius = skinModel?.boundingRadius ?? 10;
            const offset = sskCount;
            for (let i = 0; i < batchCount; i++) {
                const slot = batchSlots[i]!;
                const mid = sStat[slot * SKINNED_STATIC_MESH_FLOATS + SSTAT_MATERIAL_ID]!;
                if (mid > 0) {
                    const m = materials.library.get(mid);
                    if (!m || m.transparent || !materials.library.casts(mid)) continue;
                }
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * SKINNED_STATIC_MESH_FLOATS;
                const cx = sDyn[base + DYN_CURR_PX];
                const cy = sDyn[base + DYN_CURR_PY];
                const cz = sDyn[base + DYN_CURR_PZ];
                const sx = sStat[sBase + SSTAT_SX];
                const sy = sStat[sBase + SSTAT_SY];
                const sz = sStat[sBase + SSTAT_SZ];
                const ms = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                if (inAnySpotRange(casters, casterCount, cx, cy, cz, baseRadius * ms)) ssslots[sskCount++] = slot;
            }
            if (sskCount > offset) sskb.push({ modelId, offset, count: sskCount - offset });
        });
        this.system.setSkinnedSlots(ssslots, sskCount);

        this.system.render(encoder, spb, (id) => core.models.get(id) as any, casters, sskb);
    }
}

/** The point-light cube shadow pass (a cube array of M maps). */
export class PointShadowManager {
    private lastHash = NaN;
    private lastMotion = -1;
    private readonly batches: ShadowDrawBatch[] = [];
    private readonly skinnedBatches: ShadowDrawBatch[] = [];
    private readonly slots: Uint32Array<ArrayBuffer>;
    private readonly skinnedSlots: Uint32Array<ArrayBuffer>;

    constructor(private readonly system: PointShadowSystem, private readonly deps: ShadowCasterDeps) {
        this.slots = new Uint32Array(deps.instances.capacity);
        this.skinnedSlots = new Uint32Array(deps.instances.skinnedStore.slots.capacity);
    }

    get enabled(): boolean { return this.system.enabled; }
    set enabled(value: boolean) { this.system.enabled = value; }

    /** Max casting point lights per frame. Fixed at init time. */
    get capacity(): number { return this.system.maxShadows; }

    get resolution(): number { return this.system.resolution; }

    get bias(): number { return this.system.bias; }
    set bias(value: number) { this.system.bias = value; }

    /** @internal Upload this pass's caster slot indices. */
    setSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        this.system.setSlots(slots, count);
    }

    /** @internal Upload this pass's skinned caster slot indices. */
    setSkinnedSlots(slots: Uint32Array<ArrayBuffer>, count: number): void {
        this.system.setSkinnedSlots(slots, count);
    }

    /**
     * @internal Assign cube slots, gather the casters inside the point range
     * spheres, and record the point pass. Skips the pass when the casters and
     * poses are unchanged.
     */
    render(encoder: GPUCommandEncoder): void {
        const { instances, materials, core, lights } = this.deps;
        const casterCount = lights.assignPointShadows(this.system.maxShadows);
        if (casterCount <= 0) {
            this.lastHash = NaN;
            return;
        }
        const casters = lights.pointCasters;
        let hash = casterCount;
        for (let i = 0; i < casterCount; i++) {
            const s = casters[i]!;
            hash = (hash * 31 + ((s.px * 7 + s.py * 13 + s.pz * 17 + s.range * 37) | 0)) | 0;
        }
        const motion = this.deps.motionVersion();
        if (hash === this.lastHash && motion === this.lastMotion) return;
        this.lastHash = hash;
        this.lastMotion = motion;

        const ppb = this.batches;
        ppb.length = 0;
        const ppts = this.slots;
        const dyn = instances.store.dynamicData;
        const stat = instances.store.staticData;
        let pptCount = 0;
        instances.store.batcher.each((modelId, batchSlots, batchCount, key) => {
            const materialId = (key / SparseBatcher.MAX_SHEETS) | 0;
            if (materialId > 0) {
                const m = materials.library.get(materialId);
                if (!m || m.transparent || !materials.library.casts(materialId)) return;
            }
            const model = core.models.get(modelId);
            if (!model) return;
            const baseRadius = model.boundingRadius;
            const offset = pptCount;
            for (let i = 0; i < batchCount; i++) {
                const slot = batchSlots[i]!;
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * STATIC_MESH_FLOATS;
                const cx = dyn[base + DYN_CURR_PX];
                const cy = dyn[base + DYN_CURR_PY];
                const cz = dyn[base + DYN_CURR_PZ];
                const sx = stat[sBase + STAT_SX];
                const sy = stat[sBase + STAT_SY];
                const sz = stat[sBase + STAT_SZ];
                const ms = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                if (inAnySpotRange(casters, casterCount, cx, cy, cz, baseRadius * ms)) ppts[pptCount++] = slot;
            }
            if (pptCount > offset) ppb.push({ modelId, offset, count: pptCount - offset });
        });
        this.system.setSlots(ppts, pptCount);

        const pskb = this.skinnedBatches;
        pskb.length = 0;
        const psslots = this.skinnedSlots;
        const sDyn = instances.skinnedStore.dynamicData;
        const sStat = instances.skinnedStore.staticData;
        let pskCount = 0;
        instances.skinnedStore.batcher.each((modelId, batchSlots, batchCount) => {
            const model = core.models.get(modelId);
            if (!model) return;
            const skinModel = model.skinIndex >= 0 ? core.models.skinnedModel(model.skinIndex) : null;
            const baseRadius = skinModel?.boundingRadius ?? 10;
            const offset = pskCount;
            for (let i = 0; i < batchCount; i++) {
                const slot = batchSlots[i]!;
                const mid = sStat[slot * SKINNED_STATIC_MESH_FLOATS + SSTAT_MATERIAL_ID]!;
                if (mid > 0) {
                    const m = materials.library.get(mid);
                    if (!m || m.transparent || !materials.library.casts(mid)) continue;
                }
                const base = slot * DYNAMIC_MESH_FLOATS;
                const sBase = slot * SKINNED_STATIC_MESH_FLOATS;
                const cx = sDyn[base + DYN_CURR_PX];
                const cy = sDyn[base + DYN_CURR_PY];
                const cz = sDyn[base + DYN_CURR_PZ];
                const sx = sStat[sBase + SSTAT_SX];
                const sy = sStat[sBase + SSTAT_SY];
                const sz = sStat[sBase + SSTAT_SZ];
                const ms = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
                if (inAnySpotRange(casters, casterCount, cx, cy, cz, baseRadius * ms)) psslots[pskCount++] = slot;
            }
            if (pskCount > offset) pskb.push({ modelId, offset, count: pskCount - offset });
        });
        this.system.setSkinnedSlots(psslots, pskCount);

        this.system.render(encoder, ppb, (id) => core.models.get(id) as any, casters, pskb);
    }
}

/** Dependencies of `ShadowManager`. */
export interface ShadowManagerDeps extends ShadowCasterDeps {
    directional: ShadowSystem;
    spot: SpotShadowSystem;
    point: PointShadowSystem;
}

/**
 * ShadowManager is a container manager over the three shadow passes. It owns no
 * GPU resources itself; `directional`/`spot`/`point` expose that pass's
 * settings, gather their own casters, and record their own pass.
 */
export class ShadowManager {
    readonly directional: DirectionalShadowManager;
    readonly spot: SpotShadowManager;
    readonly point: PointShadowManager;

    constructor(deps: ShadowManagerDeps) {
        this.directional = new DirectionalShadowManager(deps.directional, deps);
        this.spot = new SpotShadowManager(deps.spot, deps);
        this.point = new PointShadowManager(deps.point, deps);
    }

    /** Master kill switch for every shadow pass. */
    get enabled(): boolean {
        return this.directional.enabled;
    }
    set enabled(value: boolean) {
        this.directional.enabled = value;
        this.spot.enabled = value;
        this.point.enabled = value;
    }

    /** Default shadow map resolution (the directional map). */
    get resolution(): number { return this.directional.resolution; }
    set resolution(value: number) { this.directional.resolution = value; }
}

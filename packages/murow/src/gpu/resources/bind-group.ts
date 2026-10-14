/**
 * Bind group layouts and bind groups.
 *
 * A layout is a named, ordered set of binding slots. Declaration order is the
 * binding number. The layout is the single source of truth for both codegen and
 * the pipeline layout; a layout handle is opaque per backend.
 *
 * Pure data plus a small amount of bookkeeping. No device.
 */
import type { GpuType } from '../types';
import type { GpuStruct } from '../schema/struct';
import type { Field } from '../schema/field';
import { sampler as samplerType, texture as textureType, type TextureDim } from '../ir/types';
import { binding as bindingNode } from '../ir/builders';
import { ShaderValue } from '../dsl/value';
import { BindGroupLayout, binding as bindingEntry, type BindingType } from '../descriptors/bind-group';

/** Role of a binding slot. */
export type BindingKind = 'uniform' | 'storage' | 'texture' | 'sampler';

/** Description of one named binding slot. */
export interface BindingSpec {
    /** A uniform block. */
    readonly uniform?: GpuStruct;
    /** A storage buffer. Runtime-sized when its array has no count. */
    readonly storage?: Field<any, any> | GpuStruct;
    /** Read-write storage. */
    readonly readwrite?: boolean;
    /** A sampled texture, by sample type. */
    readonly texture?: string;
    /** A depth texture (`texture_depth_2d`), read with `textureLoad`. */
    readonly depthTexture?: boolean;
    /** A storage texture (`texture_storage_2d<format, access>`). */
    readonly storageTexture?: { readonly format: string; readonly access?: 'read' | 'write' | 'read-write' };
    /** Texture view dimension for a texture slot. Default `2d`. */
    readonly viewDimension?: string;
    /** A sampler, by type. */
    readonly sampler?: string;
}

/** A resolved binding slot. */
export interface BindingSlot {
    /** Slot name used in shader bodies. */
    readonly name: string;
    /** Binding number within the group. */
    readonly binding: number;
    /** Slot role. */
    readonly kind: BindingKind;
    /** IR type of the bound resource. */
    readonly type: GpuType;
    /** Whether a storage slot is read-write. */
    readonly readwrite: boolean;
}

/** The GPU type behind a binding spec. Storage arrays are runtime-sized. */
function bindingType(spec: BindingSpec): GpuType {
    if (spec.uniform) return spec.uniform.type;
    if (spec.storage) {
        const type = (spec.storage as { type: GpuType }).type;
        return type.kind === 'array' && type.count !== null ? { ...type, count: null } : type;
    }
    if (spec.texture) {
        return textureType('f32', textureDim(spec.viewDimension), 'sample', sampleTypeOf(spec.texture));
    }
    if (spec.depthTexture) return textureType('f32', textureDim(spec.viewDimension), 'sample', { depth: true });
    if (spec.storageTexture) {
        return textureType('f32', textureDim(spec.viewDimension), spec.storageTexture.access ?? 'write', {
            format: spec.storageTexture.format,
        });
    }
    return samplerType(false);
}

/** Map a view dimension string to a texture dimension. */
function textureDim(dim: string | undefined): TextureDim {
    switch (dim) {
        case '1d':
        case '3d':
        case 'cube':
        case '2d-array':
        case 'cube-array':
            return dim;
        default:
            return '2d';
    }
}

/** Sample-type options for a sampled texture, from its declared sample type. */
function sampleTypeOf(texture: unknown): { sampleType?: string } {
    return texture === 'unfilterable-float' || texture === 'sint' || texture === 'uint'
        ? { sampleType: texture as string }
        : {};
}

/** The role of a binding spec. */
function bindingKind(spec: BindingSpec): BindingKind {
    if (spec.uniform) return 'uniform';
    if (spec.storage) return 'storage';
    if (spec.texture || spec.depthTexture || spec.storageTexture) return 'texture';
    return 'sampler';
}

/**
 * A named, ordered bind group layout. Slots are bound by declaration order, so
 * the slot at index `i` is binding `i`.
 */
export class GpuBindGroupLayout<S extends Record<string, BindingSpec> = Record<string, BindingSpec>> {
    /** Compile-time-only record of binding specs. Never read at runtime. */
    declare readonly __spec?: S;
    /** Bind group index, assigned when a program is linked. */
    group: number;
    /** Slots in declaration order. */
    readonly slots: readonly BindingSlot[];

    private readonly index: Record<string, number> = Object.create(null);

    constructor(spec: S, group = 0) {
        this.group = group;
        const slots: BindingSlot[] = [];
        for (const name of Object.keys(spec)) {
            const entry = (spec as Record<string, BindingSpec>)[name]!;
            this.index[name] = slots.length;
            slots.push({
                name,
                binding: slots.length,
                kind: bindingKind(entry),
                type: bindingType(entry),
                readwrite: entry.readwrite === true,
            });
        }
        this.slots = slots;
    }

    /** IR-valued view of every slot, for shader bodies that read `layout.$.name`. */
    get $(): Record<string, ShaderValue> {
        const out: Record<string, ShaderValue> = {};
        for (const slot of this.slots) {
            const node = bindingNode(slot.type, this.group, slot.binding);
            if (slot.readwrite) (node as { access?: string }).access = 'read_write';
            out[slot.name] = new ShaderValue({ node });
        }
        return out;
    }

    /** Slot with a name, or undefined. */
    slot(name: string): BindingSlot | undefined {
        const at = this.index[name];
        return at === undefined ? undefined : this.slots[at];
    }

    /** Whether a slot name exists. */
    has(name: string): boolean {
        return name in this.index;
    }

    /** The plain device-facing descriptor for this layout. */
    toDescriptor(): BindGroupLayout {
        const entries = this.slots.map((slot) => {
            const readwrite = slot.kind === 'storage' && slot.readwrite;
            // Storage textures (and read-write storage) are compute-only in WebGPU:
            // write-only/read-write storage textures must not be visible to a vertex stage.
            const computeOnly = readwrite
                || (slot.type.kind === 'texture' && slot.type.access !== 'sample');
            return bindingEntry({
                name: slot.name,
                binding: slot.binding,
                type: descriptorType(slot),
                gpuType: slot.type,
                visibility: computeOnly ? { compute: true } : { vertex: true, fragment: true, compute: true },
            });
        });
        return new BindGroupLayout({ entries });
    }
}

/** Map a slot to the descriptor binding kind. */
function descriptorType(slot: BindingSlot): BindingType {
    switch (slot.kind) {
        case 'uniform':
            return 'uniform';
        case 'storage':
            return slot.readwrite ? 'storage' : 'readonly-storage';
        case 'texture':
            return 'texture';
        case 'sampler':
            return 'sampler';
    }
}

/** A bound group: a layout plus resolved resources. Opaque per backend. */
export class GpuBindGroup {
    constructor(
        /** Layout this group was built from. */
        readonly layout: GpuBindGroupLayout,
        /** Backend resource map, by slot name. */
        readonly resources: Record<string, unknown>,
    ) {}
}

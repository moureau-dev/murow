/**
 * Engine shader environment for the `murow/gpu` facade.
 *
 * Turns a bind group layout handle into an IR-producing view. Reading a slot
 * builds a `binding`/`access` node with the slot's struct type, so shader
 * bodies that reference `meshLayout.$.uniforms` resolve without a device.
 *
 * Pure. No device, no allocations in hot paths.
 */
import { ShaderValue } from 'murow/gpu/dsl';
import {
    binding,
    sampler as samplerType,
    texture as textureType,
    type GpuType,
    type TextureDim,
} from 'murow/gpu/ir';
import { typeOf } from './data';
import type { LayoutHandle, PlainBindGroupLayoutDescriptor, PlainBindingEntry } from './root';

/** An object shaped like a layout accessor, with `$` yielding IR values. */
export interface LayoutView {
    readonly $: Record<string, ShaderValue>;
}

/** Options accepted by {@link layoutView}. */
export interface LayoutViewOptions {
    readonly descriptor: PlainBindGroupLayoutDescriptor;
    readonly group: number;
}

/** Build an IR-producing `$` accessor from a plain layout descriptor. */
export function layoutView(options: LayoutViewOptions): LayoutView {
    const accessors: Record<string, ShaderValue> = {};
    for (const entry of options.descriptor.entries) {
        if (!entry.name) continue;
        const node = binding(entryType(entry), options.group, entry.binding);
        if (isMutableStorage(entry)) (node as { access?: string }).access = 'read_write';
        accessors[entry.name] = new ShaderValue({ node });
    }
    return { $: accessors };
}

/** Build an IR-producing view from a layout handle at the given group. */
export function handleView(handle: LayoutHandle, group: number): LayoutView {
    const view = layoutView({ descriptor: handle.__descriptor, group });
    for (const name of Object.keys(view.$)) {
        (view.$[name] as unknown as { __handle?: LayoutHandle }).__handle = handle;
    }
    return view;
}

function entryType(entry: PlainBindingEntry): GpuType {
    const resource = entry.resource;
    if (resource.uniform !== undefined) return typeOf(resource.uniform);
    if (resource.storage !== undefined) return runtimeSized(typeOf(resource.storage));
    if (resource['read-only-storage'] !== undefined) return runtimeSized(typeOf(resource['read-only-storage']));
    if (resource.readonlyStorage !== undefined) return runtimeSized(typeOf(resource.readonlyStorage));
    if (resource.texture !== undefined) {
        const value = resource.texture;
        const dim = (typeof value === 'object' && value?.viewDimension) || resource.viewDimension || '2d';
        return textureType('f32', dimToIr(dim), 'sample');
    }
    if (resource.sampler !== undefined) return samplerType(false);
    return samplerType(false);
}

/** Whether a layout entry is a read-write storage buffer. */
export function isMutableStorage(entry: PlainBindingEntry): boolean {
    if (entry.resource.storage === undefined) return false;
    return entry.resource.access === 'mutable' || entry.resource.readwrite === true;
}

/** Storage buffers expose top-level arrays as runtime-sized, as WebGPU requires. */
function runtimeSized(type: GpuType): GpuType {
    if (type.kind === 'array' && type.count !== null) return { ...type, count: null };
    return type;
}

function dimToIr(dim: string): TextureDim {
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

/**
 * The GPU context: a backend plus a device.
 *
 * This is the composition root a renderer holds. It compiles programs through
 * the backend and allocates resources through the device. Resource classes stay
 * typed and schema-aware; the device contract stays small.
 *
 * `GpuContext` is backend- and API-agnostic. A platform module pairs it with a
 * backend spec and a device factory.
 */
import type { GpuDevice, BufferUsage } from '../device/gpu-device';
import { GpuBuffer, type BufferSchema } from '../resources/buffer';
import { GpuBindGroup, GpuBindGroupLayout, type BindingSpec } from '../resources/bind-group';
import { GpuBackend, type GpuCompiledShader } from './gpu-backend';
import type { GpuProgram } from '../shader/gpu-program';

/** Options accepted by {@link GpuContext}. */
export interface GpuContextOptions {
    /** The configured code generator. */
    readonly backend: GpuBackend;
    /** The device to allocate and record through. */
    readonly device: GpuDevice;
}

/** A backend paired with a device, with typed resource factories. */
export class GpuContext {
    /** The configured backend. */
    readonly backend: GpuBackend;
    /** The device. */
    readonly device: GpuDevice;

    constructor(options: GpuContextOptions) {
        this.backend = options.backend;
        this.device = options.device;
    }

    /** Compile a linked program to target source. */
    compile(program: GpuProgram): GpuCompiledShader {
        return this.backend.compile(program);
    }

    /** Allocate a schema-typed buffer. */
    createBuffer<T>(schema: BufferSchema<T>, usage: BufferUsage = 'uniform'): GpuBuffer<T> {
        return new GpuBuffer<T>(this.device, schema, usage);
    }

    /** Declare a named bind group layout. */
    createBindGroupLayout(spec: Record<string, BindingSpec>, group = 0): GpuBindGroupLayout {
        return new GpuBindGroupLayout(spec, group);
    }

    /** Bind resources to a layout, by slot name. */
    createBindGroup(layout: GpuBindGroupLayout, resources: Record<string, unknown>): GpuBindGroup {
        const entries = layout.slots.map((slot) => ({ name: slot.name, resource: resources[slot.name] }));
        this.device.createBindGroup(layout.toDescriptor(), entries);
        return new GpuBindGroup(layout, resources);
    }

    /** Release every resource owned by the device. */
    destroy(): void {
        this.device.destroy();
    }
}

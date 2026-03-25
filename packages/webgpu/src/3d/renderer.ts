/**
 * WebGPU3DRenderer — instanced 3D model renderer backed by TypeGPU.
 *
 * Skeleton implementation. The full 3D pipeline (lighting, shadows, materials)
 * will be built out incrementally.
 */
import tgpu from 'typegpu';
import type { TgpuRoot, TgpuBuffer } from 'typegpu';
import * as d from 'typegpu/data';
import { Base3DRenderer } from 'murow';
import type { Camera3DState, Renderer3DOptions } from 'murow';
import { FreeList } from 'murow';
import {
    DYNAMIC_3D_FLOATS_PER_INSTANCE,
    STATIC_3D_FLOATS_PER_INSTANCE,
} from '../core/constants';
import { DynamicInstance3D, StaticInstance3D } from '../core/types';
import { Camera3D } from '../camera/camera-3d';

export class WebGPU3DRenderer extends Base3DRenderer {
    private root!: TgpuRoot;
    private device!: GPUDevice;
    private context!: GPUCanvasContext;
    private format!: GPUTextureFormat;

    private dynamicData!: Float32Array;
    private staticData!: Float32Array;
    private freeList!: FreeList;

    private dynamicBuffer!: TgpuBuffer<any>;
    private staticBuffer!: TgpuBuffer<any>;

    readonly camera: Camera3D;

    constructor(canvas: HTMLCanvasElement, options: Renderer3DOptions) {
        super(canvas, options);
        this.camera = new Camera3D();
        this.freeList = new FreeList(options.maxModels);
        this.dynamicData = new Float32Array(options.maxModels * DYNAMIC_3D_FLOATS_PER_INSTANCE);
        this.staticData = new Float32Array(options.maxModels * STATIC_3D_FLOATS_PER_INSTANCE);
    }

    async init(): Promise<void> {
        this.root = await tgpu.init();
        this.device = this.root.device;

        this.context = this.canvas.getContext('webgpu')!;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: 'premultiplied',
        });

        this._width = this.canvas.width;
        this._height = this.canvas.height;
        this.camera.aspect = this._width / this._height;

        const dynArrayType = d.arrayOf(DynamicInstance3D, this.maxModels);
        const statArrayType = d.arrayOf(StaticInstance3D, this.maxModels);

        this.dynamicBuffer = this.root.createBuffer(dynArrayType).$usage('storage');
        this.staticBuffer = this.root.createBuffer(statArrayType).$usage('storage');

        this._initialized = true;
    }

    render(_alpha: number): void {
        if (!this._initialized) return;
        // TODO: full 3D render pipeline
        // For now, just clear the canvas
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: {
                    r: this._clearColor[0],
                    g: this._clearColor[1],
                    b: this._clearColor[2],
                    a: this._clearColor[3],
                },
            }],
        });
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    destroy(): void {
        this.dynamicBuffer?.destroy();
        this.staticBuffer?.destroy();
        this.root?.destroy();
    }
}

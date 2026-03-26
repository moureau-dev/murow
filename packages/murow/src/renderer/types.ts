/**
 * Base renderer types and interfaces.
 * These abstractions allow different rendering backends (WebGPU, PixiJS, Three.js)
 * to share the same API surface.
 */

export type ClearColor = [r: number, g: number, b: number, a: number];

export interface RendererOptions {
    clearColor?: ClearColor;
    /** Automatically resize the canvas and reconfigure the GPU context on window resize. */
    autoResize?: boolean;
}

export interface Renderer2DOptions extends RendererOptions {
    maxSprites: number;
}

export interface Renderer3DOptions extends RendererOptions {
    maxModels: number;
    enableLighting?: boolean;
}

export interface Camera2DState {
    x: number;
    y: number;
    zoom: number;
    rotation: number;
}

export interface Camera3DState {
    position: [x: number, y: number, z: number];
    target: [x: number, y: number, z: number];
    up: [x: number, y: number, z: number];
    fov: number;
    near: number;
    far: number;
    aspect: number;
}

export interface SpritesheetSource {
    image: string;
    frameWidth?: number;
    frameHeight?: number;
    data?: string;
}

export interface SpriteOptions {
    sheet: SpritesheetHandle;
    sprite?: number;
    x?: number;
    y?: number;
    layer?: number;
    scaleX?: number;
    scaleY?: number;
    rotation?: number;
    opacity?: number;
    flipX?: boolean;
    flipY?: boolean;
    tint?: [r: number, g: number, b: number, a: number];
}

export interface SpritesheetHandle {
    readonly id: number;
    readonly frameCount: number;
    getUV(spriteIndex: number): SpriteUV;
}

export interface SpriteUV {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export interface SpriteHandle {
    readonly slot: number;
    x: number;
    y: number;
    rotation: number;
    scaleX: number;
    scaleY: number;
    opacity: number;
    layer: number;
    flipX: boolean;
    flipY: boolean;
}

/**
 * Base renderer types and interfaces.
 * These abstractions allow different rendering backends (WebGPU, PixiJS, Three.js)
 * to share the same API surface.
 */
import type { Ray2D } from '../core/ray/ray-2d';
import type { Ray3D } from '../core/ray/ray-3d';

export type ClearColor = [r: number, g: number, b: number, a: number];

/** Normalized screen rect for a camera view. Origin is the top-left. */
export interface CameraRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** View settings shared by 2D and 3D cameras. */
export interface CameraViewOptions {
    /** Normalized screen rect. Defaults to the full canvas. */
    rect?: Partial<CameraRect>;
    /** Render layers this camera draws. Names resolve through `renderer.layers`. */
    mask?: number | string | readonly string[];
    /** Draw this camera. Default true. */
    enabled?: boolean;
    /** Draw order, ascending. Default 0. */
    priority?: number;
    /** Clear color, `false` to load the existing target, or omitted for the renderer clear color. */
    clearColor?: ClearColor | false;
    /** Clear depth before drawing. Default true. */
    clearDepth?: boolean;
    /** Debug label. */
    name?: string;
}

export interface RendererOptions {
    clearColor?: ClearColor;
    /** Automatically resize the canvas and reconfigure the GPU context on window resize. */
    autoResize?: boolean;
}

export interface Renderer2DOptions extends RendererOptions {
    /**
     * Sprite instance budget. Optional when a prefab bucket is provided —
     * the renderer will derive a sensible default from `maxInstances`.
     */
    maxSprites?: number;
}

export interface Renderer3DOptions extends RendererOptions {
    /**
     * How many instances you intend to spawn at once. Sizes both the
     * non-skinned instance pool directly and seeds the default for the
     * skinned-instance budget. Optional when a prefab bucket is provided -
     * the renderer derives a sensible default from the bucket.
     */
    maxInstances?: number;
    enableLighting?: boolean;
}

export interface Camera2DState {
    id: number;
    x: number;
    y: number;
    zoom: number;
    rotation: number;
    /** Render layers this camera draws. */
    mask: number;
    rect: CameraRect;
    enabled: boolean;
    priority: number;
    clearColor?: ClearColor | false;
    clearDepth: boolean;
    name: string;
    setPosition(x: number, y: number): void;
    move(x: number, y: number): void;
    screenToWorld(screenX: number, screenY: number): [number, number];
}

export interface Camera3DState {
    id: number;
    position: [x: number, y: number, z: number];
    target: [x: number, y: number, z: number];
    up: [x: number, y: number, z: number];
    fov: number;
    near: number;
    far: number;
    aspect: number;
    movement: 'local' | 'grounded' | 'global';
    /** Render layers this camera draws. */
    mask: number;
    rect: CameraRect;
    enabled: boolean;
    priority: number;
    clearColor?: ClearColor | false;
    clearDepth: boolean;
    name: string;
    setPosition(x: number, y: number, z: number): void;
    move(right: number, up: number, forward: number): void;
    screenToRay(screenX: number, screenY: number): Ray3D;
}

export interface SpritesheetSource {
    image: string;
    frameWidth?: number;
    frameHeight?: number;
    data?: string;
}

export interface SpriteOptions {
    sheet: SpritesheetHandle;
    /** Frame index into the spritesheet. Defaults to 0. */
    sprite?: number;
    /** World position. Defaults to `[0, 0]`. */
    position?: readonly [x: number, y: number];
    layer?: number;
    /**
     * Render layer for this sprite. A name resolves through `renderer.layers`;
     * a number is used as the bit directly. Defaults to the sheet prefab's
     * layer, then to the registry's default layer.
     */
    renderLayer?: string | number;
    /** Per-axis scale. Pass a single number to scale uniformly. Defaults to `[1, 1]`. */
    scale?: number | readonly [x: number, y: number];
    /** Rotation in radians. Defaults to 0. */
    rotation?: number;
    opacity?: number;
    flipX?: boolean;
    flipY?: boolean;
    tint?: readonly [r: number, g: number, b: number, a: number];
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
    readonly id: number;
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

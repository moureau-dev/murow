/**
 * Camera2D — orthographic camera for the 2D renderer.
 * Produces a 3x3 column-major matrix padded to 12 floats (std140).
 * Supports prev/curr state for frame interpolation.
 */
import { lerp } from "murow/core/lerp";
import type { Camera2DState } from 'murow/renderer';
import type { CameraRect, CameraViewOptions, ClearColor } from '../../../types';
import type { CameraId } from '../../types';
import { CameraEffectList } from './camera-effect';

export interface Camera2DOptions {
    /** Capacity of the camera-effect chain. Default 20. */
    maxEffects?: number;
}

/** Creation options for a camera added to a renderer's camera registry. */
export interface Camera2DCreateOptions extends CameraViewOptions {
    x?: number;
    y?: number;
    zoom?: number;
    rotation?: number;
    width?: number;
    height?: number;
    maxEffects?: number;
}

export class Camera2D implements Camera2DState {
    /** Registry-assigned id, or -1 when the camera is not registered. */
    id: CameraId = -1 as CameraId;
    x: number = 0;
    y: number = 0;
    zoom: number = 1;
    rotation: number = 0;
    /** Render layers this camera draws. Default: every layer. */
    mask: number = 0xffffffff;
    /** Normalized screen rect. Default: the full canvas. */
    rect: CameraRect = { x: 0, y: 0, width: 1, height: 1 };
    /** Draw this camera. */
    enabled: boolean = true;
    /** Draw order, ascending. */
    priority: number = 0;
    /** Clear color, `false` to load, or `undefined` for the renderer clear color. */
    clearColor: ClearColor | false | undefined = undefined;
    /** Clear depth before drawing. */
    clearDepth: boolean = true;
    /** Debug label. */
    name: string = '';
    /** Ordered fullscreen camera effects. Non-empty enables the off-screen path. */
    readonly effects: CameraEffectList;

    private _prevX = 0;
    private _prevY = 0;
    private _prevZoom = 1;
    private _prevRotation = 0;

    private _renderX = 0;
    private _renderY = 0;
    private _renderZoom = 1;
    private _renderRotation = 0;

    private _width: number;
    private _height: number;

    /** Column-major 3x3 matrix stored as 12 floats (std140 padded) */
    private _matrix = new Float32Array(12);

    constructor(width: number, height: number, options: Camera2DOptions = {}) {
        this._width = width;
        this._height = height;
        this.effects = new CameraEffectList(options.maxEffects ?? 20);
    }

    get width(): number { return this._width; }
    get height(): number { return this._height; }

    setViewport(width: number, height: number): void {
        this._width = width;
        this._height = height;
    }

    setPosition(x: number, y: number): void {
        this.x = x;
        this.y = y;
    }

    move(x: number, y: number): void {
        this.x += x;
        this.y += y;
    }

    private _worldPoint: [number, number] = [0, 0];

    /**
     * Unproject a screen coordinate to a world-space position.
     * Uses current (non-interpolated) camera state.
     * Returns a pre-allocated tuple — copy if you need to store it.
     */
    screenToWorld(screenX: number, screenY: number): [number, number] {
        const ndcX = (2 * screenX / this._width) - 1;
        const ndcY = 1 - (2 * screenY / this._height);

        // Inverse of the camera's scale+rotation transform.
        // Camera maps world→clip: clipX = sx*cos*(wx-cx) - sy*sin*(wy-cy)
        //                         clipY = sx*sin*(wx-cx) + sy*cos*(wy-cy)
        // Solved for wx, wy:
        const cos = this.rotation ? Math.cos(-this.rotation) : 1;
        const sin = this.rotation ? Math.sin(-this.rotation) : 0;
        const sx = this.zoom / (this._width * 0.5);
        const sy = this.zoom / (this._height * 0.5);

        this._worldPoint[0] = this.x + (ndcX * cos + ndcY * sin) / sx;
        this._worldPoint[1] = this.y + (ndcY * cos - ndcX * sin) / sy;
        return this._worldPoint;
    }

    /**
     * Smoothly move the camera toward a target position.
     * Call each tick. The camera lerps toward (targetX, targetY) by the given factor.
     * @param targetX  World X to follow
     * @param targetY  World Y to follow
     * @param smoothing  0-1. 1 = snap instantly, 0.1 = lazy follow. Default 1.
     */
    follow(targetX: number, targetY: number, smoothing: number = 1): void {
        this.x = lerp(this.x, targetX, smoothing);
        this.y = lerp(this.y, targetY, smoothing);
    }

    /**
     * Store current state as previous. Call before each tick.
     */
    /** Remove this camera from its registry. No-op when not registered. */
    destroy(): void {}

    storePrevious(): void {
        this._prevX = this.x;
        this._prevY = this.y;
        this._prevZoom = this.zoom;
        this._prevRotation = this.rotation;
    }

    /**
     * Interpolate between previous and current state. Call before rendering.
     */
    interpolate(alpha: number): void {
        this._renderX = lerp(this._prevX, this.x, alpha);
        this._renderY = lerp(this._prevY, this.y, alpha);
        this._renderZoom = lerp(this._prevZoom, this.zoom, alpha);
        this._renderRotation = lerp(this._prevRotation, this.rotation, alpha);
    }

    /**
     * Build the view-projection matrix using interpolated state.
     * Orthographic: maps world coords to clip space [-1,1].
     */
    getMatrix(): Float32Array {
        const m = this._matrix;
        const z = this._renderZoom;
        const hw = this._width * 0.5;
        const hh = this._height * 0.5;

        const cos = Math.cos(-this._renderRotation);
        const sin = Math.sin(-this._renderRotation);

        const sx = z / hw;
        const sy = z / hh;

        // Column 0
        m[0] = sx * cos;
        m[1] = sx * sin;
        m[2] = 0;
        m[3] = 0;

        // Column 1
        m[4] = -sy * sin;
        m[5] = sy * cos;
        m[6] = 0;
        m[7] = 0;

        // Column 2 (translation)
        m[8] = -(this._renderX * m[0] + this._renderY * m[4]);
        m[9] = -(this._renderX * m[1] + this._renderY * m[5]);
        m[10] = 1;
        m[11] = 0;

        return m;
    }
}

/** Apply creation options to a 2D camera. */
export function applyCamera2DCreateOptions(camera: Camera2D, options: Camera2DCreateOptions): void {
    if (options.x !== undefined) camera.x = options.x;
    if (options.y !== undefined) camera.y = options.y;
    if (options.zoom !== undefined) camera.zoom = options.zoom;
    if (options.rotation !== undefined) camera.rotation = options.rotation;
    if (options.width !== undefined && options.height !== undefined) {
        camera.setViewport(options.width, options.height);
    }
    if (options.rect) {
        camera.rect.x = options.rect.x ?? camera.rect.x;
        camera.rect.y = options.rect.y ?? camera.rect.y;
        camera.rect.width = options.rect.width ?? camera.rect.width;
        camera.rect.height = options.rect.height ?? camera.rect.height;
    }
    if (options.enabled !== undefined) camera.enabled = options.enabled;
    if (options.priority !== undefined) camera.priority = options.priority;
    camera.clearColor = options.clearColor;
    if (options.clearDepth !== undefined) camera.clearDepth = options.clearDepth;
    if (options.name !== undefined) camera.name = options.name;
}

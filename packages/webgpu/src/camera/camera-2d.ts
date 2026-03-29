/**
 * Camera2D — orthographic camera for the 2D renderer.
 * Produces a 3x3 column-major matrix padded to 12 floats (std140).
 * Supports prev/curr state for frame interpolation.
 */
import { lerp } from "murow/core/lerp";
import type { Camera2DState } from 'murow/renderer/types';

export class Camera2D implements Camera2DState {
    x: number = 0;
    y: number = 0;
    zoom: number = 1;
    rotation: number = 0;

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

    constructor(width: number, height: number) {
        this._width = width;
        this._height = height;
    }

    get width(): number { return this._width; }
    get height(): number { return this._height; }

    setViewport(width: number, height: number): void {
        this._width = width;
        this._height = height;
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

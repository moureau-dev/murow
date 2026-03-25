/**
 * Camera2D — orthographic camera for the 2D renderer.
 * Produces a 3×2 matrix (stored as Float32Array(6)) for the GPU uniform.
 * Handles canvas resize automatically.
 */
import type { Camera2DState } from "murow";

export class Camera2D implements Camera2DState {
    x: number = 0;
    y: number = 0;
    zoom: number = 1;
    rotation: number = 0;

    private _width: number;
    private _height: number;
    private _dirty: boolean = true;

    /** Column-major 3x3 matrix stored as 12 floats (std140 padded) */
    private _matrix = new Float32Array(12);

    constructor(width: number, height: number) {
        this._width = width;
        this._height = height;
    }

    get width(): number { return this._width; }
    get height(): number { return this._height; }

    /**
     * Update viewport dimensions (called by renderer on resize).
     */
    setViewport(width: number, height: number): void {
        this._width = width;
        this._height = height;
        this._dirty = true;
    }

    /**
     * Build the view-projection matrix.
     * Orthographic: maps world coords to clip space [-1,1].
     *
     * Returns a 3x3 column-major matrix padded to 12 floats for std140.
     * Layout: [col0.x, col0.y, col0.z, pad, col1.x, col1.y, col1.z, pad, col2.x, col2.y, col2.z, pad]
     */
    getMatrix(): Float32Array {
        const m = this._matrix;
        const z = this.zoom;
        const hw = this._width * 0.5;
        const hh = this._height * 0.5;

        const cos = Math.cos(-this.rotation);
        const sin = Math.sin(-this.rotation);

        const sx = z / hw;
        const sy = z / hh;

        // Column 0
        m[0] = sx * cos;
        m[1] = sx * sin;
        m[2] = 0;
        m[3] = 0; // pad

        // Column 1
        m[4] = -sy * sin;
        m[5] = sy * cos;
        m[6] = 0;
        m[7] = 0; // pad

        // Column 2 (translation)
        m[8] = -(this.x * m[0] + this.y * m[4]);
        m[9] = -(this.x * m[1] + this.y * m[5]);
        m[10] = 1;
        m[11] = 0; // pad

        this._dirty = false;
        return m;
    }

    get dirty(): boolean { return this._dirty; }
    markDirty(): void { this._dirty = true; }
}

/**
 * Camera3D — perspective camera for the 3D renderer.
 * Produces view and projection matrices as Float32Array(16) each.
 */
import type { Camera3DState } from "murow";

export class Camera3D implements Camera3DState {
    position: [number, number, number] = [0, 5, -10];
    target: [number, number, number] = [0, 0, 0];
    up: [number, number, number] = [0, 1, 0];
    fov: number = 60;
    near: number = 0.1;
    far: number = 1000;
    aspect: number = 1;

    private _viewMatrix = new Float32Array(16);
    private _projMatrix = new Float32Array(16);
    private _vpMatrix = new Float32Array(16);

    /**
     * Build the view matrix (lookAt).
     */
    getViewMatrix(): Float32Array {
        lookAt(this._viewMatrix, this.position, this.target, this.up);
        return this._viewMatrix;
    }

    /**
     * Build the perspective projection matrix.
     */
    getProjectionMatrix(): Float32Array {
        perspective(this._projMatrix, this.fov * (Math.PI / 180), this.aspect, this.near, this.far);
        return this._projMatrix;
    }

    /**
     * Build the combined view-projection matrix.
     */
    getViewProjectionMatrix(): Float32Array {
        this.getViewMatrix();
        this.getProjectionMatrix();
        mat4Multiply(this._vpMatrix, this._projMatrix, this._viewMatrix);
        return this._vpMatrix;
    }

    setAspect(width: number, height: number): void {
        this.aspect = width / height;
    }
}

// --- Inline math (no allocations, no dependencies) ---

function lookAt(out: Float32Array, eye: number[], center: number[], up: number[]): void {
    let fx = center[0] - eye[0];
    let fy = center[1] - eye[1];
    let fz = center[2] - eye[2];

    let len = 1 / Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx *= len; fy *= len; fz *= len;

    let sx = fy * up[2] - fz * up[1];
    let sy = fz * up[0] - fx * up[2];
    let sz = fx * up[1] - fy * up[0];

    len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len > 0) {
        len = 1 / len;
        sx *= len; sy *= len; sz *= len;
    }

    const ux = sy * fz - sz * fy;
    const uy = sz * fx - sx * fz;
    const uz = sx * fy - sy * fx;

    out[0] = sx;  out[1] = ux;  out[2] = -fx; out[3] = 0;
    out[4] = sy;  out[5] = uy;  out[6] = -fy; out[7] = 0;
    out[8] = sz;  out[9] = uz;  out[10] = -fz; out[11] = 0;
    out[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
    out[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    out[14] = (fx * eye[0] + fy * eye[1] + fz * eye[2]);
    out[15] = 1;
}

function perspective(out: Float32Array, fovRad: number, aspect: number, near: number, far: number): void {
    const f = 1 / Math.tan(fovRad * 0.5);
    const rangeInv = 1 / (near - far);

    out[0] = f / aspect; out[1] = 0; out[2] = 0;  out[3] = 0;
    out[4] = 0;          out[5] = f; out[6] = 0;  out[7] = 0;
    out[8] = 0;          out[9] = 0; out[10] = (near + far) * rangeInv; out[11] = -1;
    out[12] = 0;         out[13] = 0; out[14] = 2 * near * far * rangeInv; out[15] = 0;
}

function mat4Multiply(out: Float32Array, a: Float32Array, b: Float32Array): void {
    for (let i = 0; i < 4; i++) {
        const ai0 = a[i], ai1 = a[i + 4], ai2 = a[i + 8], ai3 = a[i + 12];
        out[i]      = ai0 * b[0]  + ai1 * b[1]  + ai2 * b[2]  + ai3 * b[3];
        out[i + 4]  = ai0 * b[4]  + ai1 * b[5]  + ai2 * b[6]  + ai3 * b[7];
        out[i + 8]  = ai0 * b[8]  + ai1 * b[9]  + ai2 * b[10] + ai3 * b[11];
        out[i + 12] = ai0 * b[12] + ai1 * b[13] + ai2 * b[14] + ai3 * b[15];
    }
}

/**
 * Camera3D — perspective camera for the 3D renderer.
 * Produces view and projection matrices as Float32Array(16) each.
 * Supports prev/curr state for frame interpolation.
 */
import { lerp, type Camera3DState } from "murow/core";

export class Camera3D implements Camera3DState {
    position: [number, number, number] = [0, 5, -10];
    target: [number, number, number] = [0, 0, 0];
    up: [number, number, number] = [0, 1, 0];
    fov: number = 60;
    near: number = 0.1;
    far: number = 1000;
    aspect: number = 1;

    // Previous state for interpolation (stored before each tick)
    private _prevPosition: [number, number, number] = [0, 5, -10];
    private _prevTarget: [number, number, number] = [0, 0, 0];

    // Interpolated state used for rendering
    private _renderPosition: [number, number, number] = [0, 5, -10];
    private _renderTarget: [number, number, number] = [0, 0, 0];

    private _viewMatrix = new Float32Array(16);
    private _projMatrix = new Float32Array(16);
    private _vpMatrix = new Float32Array(16);

    /**
     * Store current position/target as previous. Call before each tick.
     */
    storePrevious(): void {
        this._prevPosition[0] = this.position[0];
        this._prevPosition[1] = this.position[1];
        this._prevPosition[2] = this.position[2];
        this._prevTarget[0] = this.target[0];
        this._prevTarget[1] = this.target[1];
        this._prevTarget[2] = this.target[2];
    }

    /**
     * Interpolate between previous and current state. Call before rendering.
     */
    interpolate(alpha: number): void {
        this._renderPosition[0] = lerp(this._prevPosition[0], this.position[0], alpha);
        this._renderPosition[1] = lerp(this._prevPosition[1], this.position[1], alpha);
        this._renderPosition[2] = lerp(this._prevPosition[2], this.position[2], alpha);
        this._renderTarget[0] = lerp(this._prevTarget[0], this.target[0], alpha);
        this._renderTarget[1] = lerp(this._prevTarget[1], this.target[1], alpha);
        this._renderTarget[2] = lerp(this._prevTarget[2], this.target[2], alpha);
    }

    /**
     * Build the view matrix (lookAt) using interpolated state.
     */
    getViewMatrix(): Float32Array {
        lookAt(this._viewMatrix, this._renderPosition, this._renderTarget, this.up);
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

    /**
     * Move the camera in local space. Zero allocations.
     * @param right   Movement along the camera's right axis (positive = right)
     * @param up      Movement along the camera's up axis (positive = up)
     * @param forward Movement along the camera's forward axis (positive = toward target)
     */
    move(right: number, up: number, forward: number): void {
        // Ensure view matrix is current
        this.getViewMatrix();
        const m = this._viewMatrix;

        // View matrix rows = camera axes (transposed from lookAt columns)
        // Row 0 = right:   m[0], m[4], m[8]
        // Row 1 = up:      m[1], m[5], m[9]
        // Row 2 = -forward: m[2], m[6], m[10]
        const dx = m[0] * right + m[1] * up - m[2] * forward;
        const dy = m[4] * right + m[5] * up - m[6] * forward;
        const dz = m[8] * right + m[9] * up - m[10] * forward;

        this.position[0] += dx;
        this.position[1] += dy;
        this.position[2] += dz;
        this.target[0] += dx;
        this.target[1] += dy;
        this.target[2] += dz;
    }

    /**
     * Orbit around the target point. Zero allocations.
     * @param yawDelta   Horizontal rotation in radians (positive = rotate right)
     * @param pitchDelta Vertical rotation in radians (positive = rotate up)
     */
    orbit(yawDelta: number, pitchDelta: number): void {
        // Offset from target to camera
        let ox = this.position[0] - this.target[0];
        let oy = this.position[1] - this.target[1];
        let oz = this.position[2] - this.target[2];

        // Current spherical coords
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        let yaw = Math.atan2(ox, oz);
        let pitch = Math.asin(oy / dist);

        yaw += yawDelta;
        pitch += pitchDelta;
        pitch = Math.max(-Math.PI * 0.49, Math.min(Math.PI * 0.49, pitch));

        // Back to cartesian
        this.position[0] = this.target[0] + Math.sin(yaw) * Math.cos(pitch) * dist;
        this.position[1] = this.target[1] + Math.sin(pitch) * dist;
        this.position[2] = this.target[2] + Math.cos(yaw) * Math.cos(pitch) * dist;
    }

    /**
     * Zoom by adjusting distance to target. Zero allocations.
     * @param delta Positive = zoom in, negative = zoom out
     */
    zoom(delta: number): void {
        let ox = this.position[0] - this.target[0];
        let oy = this.position[1] - this.target[1];
        let oz = this.position[2] - this.target[2];
        const dist = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const newDist = Math.max(0.1, dist - delta);
        const scale = newDist / dist;
        this.position[0] = this.target[0] + ox * scale;
        this.position[1] = this.target[1] + oy * scale;
        this.position[2] = this.target[2] + oz * scale;
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

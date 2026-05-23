/**
 * Shared 3D math utilities for the WebGPU renderer.
 * All functions operate on Float32Arrays with explicit offsets — zero allocations in hot paths.
 */

/**
 * Write a 4x4 identity matrix into `dst` at `offset`.
 */
export function mat4Identity(dst: Float32Array, offset: number): void {
    dst[offset]      = 1; dst[offset + 1]  = 0; dst[offset + 2]  = 0; dst[offset + 3]  = 0;
    dst[offset + 4]  = 0; dst[offset + 5]  = 1; dst[offset + 6]  = 0; dst[offset + 7]  = 0;
    dst[offset + 8]  = 0; dst[offset + 9]  = 0; dst[offset + 10] = 1; dst[offset + 11] = 0;
    dst[offset + 12] = 0; dst[offset + 13] = 0; dst[offset + 14] = 0; dst[offset + 15] = 1;
}

/**
 * Create a new 4x4 identity matrix.
 */
export function mat4IdentityNew(): Float32Array {
    const m = new Float32Array(16);
    m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
    return m;
}

/**
 * Write a column-major 4x4 matrix from TRS (translation, quaternion rotation, scale)
 * into `dst` at `offset`.
 */
export function trsToMat4(
    tx: number, ty: number, tz: number,
    qx: number, qy: number, qz: number, qw: number,
    sx: number, sy: number, sz: number,
    dst: Float32Array, offset: number,
): void {
    const xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const wx = qw * qx, wy = qw * qy, wz = qw * qz;

    dst[offset]      = (1 - 2 * (yy + zz)) * sx;
    dst[offset + 1]  = 2 * (xy + wz) * sx;
    dst[offset + 2]  = 2 * (xz - wy) * sx;
    dst[offset + 3]  = 0;
    dst[offset + 4]  = 2 * (xy - wz) * sy;
    dst[offset + 5]  = (1 - 2 * (xx + zz)) * sy;
    dst[offset + 6]  = 2 * (yz + wx) * sy;
    dst[offset + 7]  = 0;
    dst[offset + 8]  = 2 * (xz + wy) * sz;
    dst[offset + 9]  = 2 * (yz - wx) * sz;
    dst[offset + 10] = (1 - 2 * (xx + yy)) * sz;
    dst[offset + 11] = 0;
    dst[offset + 12] = tx;
    dst[offset + 13] = ty;
    dst[offset + 14] = tz;
    dst[offset + 15] = 1;
}

/**
 * Build a column-major 4x4 matrix from a glTF node's TRS or matrix property.
 * Allocates and returns a new Float32Array(16).
 */
export function nodeToMat4(node: { translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }): Float32Array {
    const m = new Float32Array(16);
    if (node.matrix) {
        m.set(node.matrix);
        return m;
    }
    const t = node.translation ?? [0, 0, 0];
    const r = node.rotation ?? [0, 0, 0, 1];
    const s = node.scale ?? [1, 1, 1];
    trsToMat4(t[0], t[1], t[2], r[0], r[1], r[2], r[3], s[0], s[1], s[2], m, 0);
    return m;
}

// Pre-allocated temp buffer for mat4Mul to avoid aliasing issues
const _mulTemp = new Float32Array(16);

/**
 * 4x4 matrix multiply: dst[dO..+16] = a[aO..+16] * b[bO..+16]. Column-major.
 * Safe when a, b, dst overlap (uses internal temp buffer).
 */
export function mat4Mul(
    a: Float32Array, aO: number,
    b: Float32Array, bO: number,
    dst: Float32Array, dO: number,
): void {
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            _mulTemp[j * 4 + i] =
                a[aO + i]     * b[bO + j * 4]     +
                a[aO + 4 + i] * b[bO + j * 4 + 1] +
                a[aO + 8 + i] * b[bO + j * 4 + 2] +
                a[aO + 12 + i] * b[bO + j * 4 + 3];
        }
    }
    dst.set(_mulTemp, dO);
}

/**
 * 4x4 matrix multiply that allocates and returns a new Float32Array(16).
 * Use for load-time operations, not per-frame hot paths.
 */
export function mat4MulNew(a: Float32Array, b: Float32Array): Float32Array {
    const o = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            o[j * 4 + i] =
                a[i]     * b[j * 4]     +
                a[4 + i] * b[j * 4 + 1] +
                a[8 + i] * b[j * 4 + 2] +
                a[12 + i] * b[j * 4 + 3];
        }
    }
    return o;
}

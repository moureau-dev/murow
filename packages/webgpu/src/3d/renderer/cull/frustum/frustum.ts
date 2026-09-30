/**
 * Frustum — six normalized clipping planes extracted from a view-projection
 * matrix, used for bounding-sphere visibility tests.
 */
export class Frustum {
    private readonly planes = new Float32Array(24);

    /**
     * Extract the 6 planes from a column-major view-projection matrix.
     * Each plane is `[a, b, c, d]` where `ax + by + cz + d >= 0` means inside.
     */
    setFromViewProjection(vp: Float32Array): void {
        const p = this.planes;

        // Left:   row3 + row0
        p[0]  = vp[3] + vp[0];  p[1]  = vp[7] + vp[4];  p[2]  = vp[11] + vp[8];  p[3]  = vp[15] + vp[12];
        // Right:  row3 - row0
        p[4]  = vp[3] - vp[0];  p[5]  = vp[7] - vp[4];  p[6]  = vp[11] - vp[8];  p[7]  = vp[15] - vp[12];
        // Bottom: row3 + row1
        p[8]  = vp[3] + vp[1];  p[9]  = vp[7] + vp[5];  p[10] = vp[11] + vp[9];  p[11] = vp[15] + vp[13];
        // Top:    row3 - row1
        p[12] = vp[3] - vp[1];  p[13] = vp[7] - vp[5];  p[14] = vp[11] - vp[9];  p[15] = vp[15] - vp[13];
        // Near:   row3 + row2
        p[16] = vp[3] + vp[2];  p[17] = vp[7] + vp[6];  p[18] = vp[11] + vp[10]; p[19] = vp[15] + vp[14];
        // Far:    row3 - row2
        p[20] = vp[3] - vp[2];  p[21] = vp[7] - vp[6];  p[22] = vp[11] - vp[10]; p[23] = vp[15] - vp[14];

        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const len = Math.sqrt(p[o] * p[o] + p[o + 1] * p[o + 1] + p[o + 2] * p[o + 2]);
            if (len > 0) {
                const inv = 1 / len;
                p[o] *= inv; p[o + 1] *= inv; p[o + 2] *= inv; p[o + 3] *= inv;
            }
        }
    }

    /** True if a bounding sphere is inside or intersects the frustum. */
    intersectsSphere(x: number, y: number, z: number, radius: number): boolean {
        const p = this.planes;
        for (let i = 0; i < 6; i++) {
            const o = i * 4;
            const dist = p[o] * x + p[o + 1] * y + p[o + 2] * z + p[o + 3];
            if (dist < -radius) return false;
        }
        return true;
    }
}

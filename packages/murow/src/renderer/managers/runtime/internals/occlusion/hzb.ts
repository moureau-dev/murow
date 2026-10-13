/**
 * Hzb — a CPU hierarchical depth buffer and the AABB visibility test built on
 * it. This is the backend-agnostic reference for occlusion culling: a runtime
 * without a compute path can use it directly, and the GPU port is validated
 * against it. Depth is WebGPU-style (0 = near, 1 = far) and each pyramid level
 * stores the maximum depth of its children, so a coarser level is always more
 * conservative.
 *
 * The base level is allocated once by the constructor; `build` refills it in
 * place. `aabbVisible` reads only scalar locals, so a per-instance query loop
 * allocates nothing.
 */

/** A max-reduced depth pyramid. Level 0 is the base depth, each next level halves. */
export class Hzb {
    /** Base-level width in texels. */
    readonly width: number;
    /** Base-level height in texels. */
    readonly height: number;
    /** Depth levels, nearest first. Level 0 has `width` x `height` texels. */
    readonly levels: Float32Array[];
    /** Width of each level. */
    readonly levelWidths: Int32Array;
    /** Height of each level. */
    readonly levelHeights: Int32Array;

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;

        const levels: Float32Array[] = [];
        const levelWidths: number[] = [];
        const levelHeights: number[] = [];
        let w = width;
        let h = height;
        for (;;) {
            levels.push(new Float32Array(w * h));
            levelWidths.push(w);
            levelHeights.push(h);
            if (w === 1 && h === 1) break;
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }

        this.levels = levels;
        this.levelWidths = Int32Array.from(levelWidths);
        this.levelHeights = Int32Array.from(levelHeights);
        this.clear(1);
    }

    /** Reset every level to `value` (default far). */
    clear(value = 1): void {
        const levels = this.levels;
        for (let i = 0; i < levels.length; i++) levels[i]!.fill(value);
    }

    /** Write one base-level texel (used by tests and a CPU rasterizer). */
    set(x: number, y: number, depth: number): void {
        this.levels[0]![y * this.width + x] = depth;
    }

    /** Read one base-level texel. */
    get(x: number, y: number): number {
        return this.levels[0]![y * this.width + x]!;
    }

    /** Copy a base-level depth slice (truncated to the buffer) and max-reduce upward. */
    build(depth: Float32Array): void {
        const base = this.levels[0]!;
        const n = depth.length < base.length ? depth.length : base.length;
        for (let i = 0; i < n; i++) base[i] = depth[i]!;
        this.reduce();
    }

    /** Re-derive every level above the base by max-reduction. */
    reduce(): void {
        const levels = this.levels;
        const levelWidths = this.levelWidths;
        const levelHeights = this.levelHeights;
        for (let l = 1; l < levels.length; l++) {
            const src = levels[l - 1]!;
            const dst = levels[l]!;
            const sw = levelWidths[l - 1]!;
            const sh = levelHeights[l - 1]!;
            const dw = levelWidths[l]!;
            const dh = levelHeights[l]!;
            for (let y = 0; y < dh; y++) {
                const y0 = y * 2;
                const y1 = y0 + 1;
                for (let x = 0; x < dw; x++) {
                    const x0 = x * 2;
                    const x1 = x0 + 1;
                    let m = src[y0 * sw + x0]!;
                    if (x1 < sw) {
                        const v = src[y0 * sw + x1]!;
                        if (v > m) m = v;
                    }
                    if (y1 < sh) {
                        const v = src[y1 * sw + x0]!;
                        if (v > m) m = v;
                        if (x1 < sw) {
                            const v2 = src[y1 * sw + x1]!;
                            if (v2 > m) m = v2;
                        }
                    }
                    dst[y * dw + x] = m;
                }
            }
        }
    }
}

/** Clamp `v` to the integer range `[lo, hi]`. */
function clampInt(v: number, lo: number, hi: number): number {
    return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Conservative world-AABB occlusion test against a depth pyramid. `vp` is a
 * column-major view-projection mapping world space to clip space (WebGPU depth
 * convention). The AABB is described by its center and half-extents. Returns
 * true when the box should be drawn, false only when the pyramid proves it is
 * hidden behind nearer geometry.
 *
 * Pass `occlusion = false` to force a visible result (the per-instance opt-out).
 */
export function aabbVisible(
    hzb: Hzb,
    vp: Float32Array,
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    occlusion = true,
): boolean {
    if (!occlusion) return true;

    let minU = Infinity, maxU = -Infinity;
    let minV = Infinity, maxV = -Infinity;
    let zmin = Infinity;

    for (let i = 0; i < 8; i++) {
        const x = cx + ((i & 1) !== 0 ? hx : -hx);
        const y = cy + ((i & 2) !== 0 ? hy : -hy);
        const z = cz + ((i & 4) !== 0 ? hz : -hz);

        const px = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!;
        const py = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!;
        const pz = vp[2]! * x + vp[6]! * y + vp[10]! * z + vp[14]!;
        const pw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!;

        // Behind the eye: cannot prove occlusion, keep the box.
        if (pw <= 1e-6) return true;

        const nx = px / pw;
        const ny = py / pw;
        const nz = pz / pw;

        const u = nx * 0.5 + 0.5;
        const v = ny * 0.5 + 0.5;
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        if (nz < zmin) zmin = nz;
    }

    // Straddling or in front of the near plane is never provably hidden.
    if (zmin < 0) return true;
    // Fully outside the NDC rectangle: leave it to frustum culling.
    if (maxU < 0 || minU > 1 || maxV < 0 || minV > 1) return true;

    const u0 = minU < 0 ? 0 : minU;
    const u1 = maxU > 1 ? 1 : maxU;
    const v0 = minV < 0 ? 0 : minV;
    const v1 = maxV > 1 ? 1 : maxV;

    // Pick the finest level whose footprint still spans at most 2x2 tiles.
    let level = 0;
    let c0 = 0, c1 = 0, r0 = 0, r1 = 0;
    for (;;) {
        const lw = hzb.levelWidths[level]!;
        const lh = hzb.levelHeights[level]!;
        c0 = clampInt(Math.floor(u0 * lw), 0, lw - 1);
        c1 = clampInt(Math.ceil(u1 * lw) - 1, 0, lw - 1);
        r0 = clampInt(Math.floor(v0 * lh), 0, lh - 1);
        r1 = clampInt(Math.ceil(v1 * lh) - 1, 0, lh - 1);
        const spanX = c1 - c0 + 1;
        const spanY = r1 - r0 + 1;
        if (level + 1 < hzb.levels.length && (spanX > 2 || spanY > 2)) {
            level++;
            continue;
        }
        break;
    }

    const buf = hzb.levels[level]!;
    const lw = hzb.levelWidths[level]!;
    let maxOcc = 0;
    for (let r = r0; r <= r1; r++) {
        const row = r * lw;
        for (let c = c0; c <= c1; c++) {
            const d = buf[row + c]!;
            if (d > maxOcc) maxOcc = d;
        }
    }

    // Hidden only when the nearest box depth is farther than every occluder.
    return zmin <= maxOcc;
}

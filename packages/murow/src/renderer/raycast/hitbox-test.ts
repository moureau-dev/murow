import type { Ray3D } from '../../core/ray/ray-3d';
import type { Hitbox2D, Hitbox3D } from '../prefab-bucket/specs';

/**
 * 3D pick test: places `hitbox` at world center `(cx,cy,cz)`, grown by
 * per-axis scale `(sx,sy,sz)` (offset scales too), and entry-tests it
 * against `ray`. Single-radius shapes inflate by the largest relevant
 * axis so the hitbox encloses a non-uniformly scaled visual rather than
 * clipping inside it. Returns ray-`t` or `null`.
 */
export function testHitbox3DRay(
    ray: Ray3D,
    hitbox: Hitbox3D,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
): number | null {
    const off = hitbox.offset;
    const hx = off ? cx + off[0] * sx : cx;
    const hy = off ? cy + off[1] * sy : cy;
    const hz = off ? cz + off[2] * sz : cz;

    if (hitbox.shape === 'sphere') {
        const maxScale = sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz);
        return ray.entrySphere(hx, hy, hz, hitbox.radius * maxScale);
    }
    if (hitbox.shape === 'box') {
        return ray.entryBox(
            hx, hy, hz,
            hitbox.size[0] * 0.5 * sx,
            hitbox.size[1] * 0.5 * sy,
            hitbox.size[2] * 0.5 * sz,
        );
    }
    const maxXZ = sx > sz ? sx : sz;
    return ray.entryCylinder(hx, hy, hz, hitbox.radius * maxXZ, hitbox.height * sy);
}

/**
 * 2D pick test: is world point `(wx,wy)` inside `hitbox`, placed at sprite
 * center `(cx,cy)`, grown by `(sx,sy)`, and rotated by `rot` radians? The
 * point is rotated into the sprite's local frame, then tested against the
 * unrotated shape. Returns `true` on a hit.
 */
export function testHitbox2DPoint(
    hitbox: Hitbox2D,
    cx: number, cy: number,
    sx: number, sy: number,
    rot: number,
    wx: number, wy: number,
): boolean {
    const off = hitbox.offset;
    const ox = off ? cx + off[0] * sx : cx;
    const oy = off ? cy + off[1] * sy : cy;

    let lx = wx - ox;
    let ly = wy - oy;
    if (rot !== 0) {
        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);
        const rx = lx * cos - ly * sin;
        const ly2 = lx * sin + ly * cos;
        lx = rx;
        ly = ly2;
    }

    if (hitbox.shape === 'circle') {
        const maxScale = sx > sy ? sx : sy;
        const r = hitbox.radius * maxScale;
        return lx * lx + ly * ly <= r * r;
    }
    if (hitbox.shape === 'rect') {
        const hx = hitbox.size[0] * 0.5 * sx;
        const hy = hitbox.size[1] * 0.5 * sy;
        return lx >= -hx && lx <= hx && ly >= -hy && ly <= hy;
    }
    return pointInCapsule(lx, ly, hitbox.radius * ((sx > sy ? sx : sy)), hitbox.length * sy);
}

/**
 * Point inside a vertical (Y-axis) capsule centered at the local origin:
 * a `len`-tall segment with hemispherical caps of radius `r`. Clamp the
 * point's Y to the segment, then it's a circle test against that clamp.
 */
function pointInCapsule(lx: number, ly: number, r: number, len: number): boolean {
    const half = len * 0.5;
    const cy = ly > half ? half : (ly < -half ? -half : ly);
    const dy = ly - cy;
    return lx * lx + dy * dy <= r * r;
}

/**
 * 2D pick test for a sprite with no declared hitbox: the rendered quad,
 * a `sx` by `sy` rect centered at `(cx,cy)`, rotated by `rot`.
 */
export function testQuad2DPoint(
    cx: number, cy: number,
    sx: number, sy: number,
    rot: number,
    wx: number, wy: number,
): boolean {
    let lx = wx - cx;
    let ly = wy - cy;
    if (rot !== 0) {
        const cos = Math.cos(-rot);
        const sin = Math.sin(-rot);
        const rx = lx * cos - ly * sin;
        const ly2 = lx * sin + ly * cos;
        lx = rx;
        ly = ly2;
    }
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    return lx >= -hx && lx <= hx && ly >= -hy && ly <= hy;
}

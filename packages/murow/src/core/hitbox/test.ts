import type { Ray3D } from '../ray/ray-3d';
import type { Hitbox, HitboxPart } from './hitbox';

/** Nearest part struck plus where. The `point` is filled in 3D only. */
export interface PartHit {
    part: string;
    distance: number;
    point: [number, number, number];
}

/**
 * A 3D part resolved to world space: its center after offset, and the
 * half-extents after per-axis scale. Single-radius shapes (sphere,
 * cylinder) inflate by the largest relevant axis so they enclose a
 * non-uniformly scaled visual rather than clipping inside it. The single
 * source of placement truth shared by picking and debug rendering.
 */
export interface PlacedPart {
    cx: number; cy: number; cz: number;
    hx: number; hy: number; hz: number;
}

const placed: PlacedPart = { cx: 0, cy: 0, cz: 0, hx: 0, hy: 0, hz: 0 };

/** Place a 3D part at world center `(cx,cy,cz)` grown by scale `(sx,sy,sz)`. Reused output. */
export function placePart3D(
    part: HitboxPart<'3d'>,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
): PlacedPart {
    const off = part.offset;
    placed.cx = off ? cx + off[0] * sx : cx;
    placed.cy = off ? cy + off[1] * sy : cy;
    placed.cz = off ? cz + off[2] * sz : cz;

    if (part.shape === 'sphere') {
        const r = part.radius * (sx > sy ? (sx > sz ? sx : sz) : (sy > sz ? sy : sz));
        placed.hx = placed.hy = placed.hz = r;
    } else if (part.shape === 'box') {
        placed.hx = part.size[0] * 0.5 * sx;
        placed.hy = part.size[1] * 0.5 * sy;
        placed.hz = part.size[2] * 0.5 * sz;
    } else {
        const r = part.radius * (sx > sz ? sx : sz);
        placed.hx = placed.hz = r;
        placed.hy = part.height * 0.5 * sy;
    }
    return placed;
}

const scratch: PartHit = { part: '', distance: 0, point: [0, 0, 0] };

/**
 * Entry-test a ray against a 3D hitbox placed at world center `(cx,cy,cz)`
 * and grown by per-axis scale `(sx,sy,sz)`. Returns the nearest part the
 * ray enters (a reused object, valid until the next call) or `null`.
 */
export function testHitbox3D(
    ray: Ray3D,
    hitbox: Hitbox<'3d'>,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
): PartHit | null {
    let bestT = Infinity;
    let bestName: string | null = null;

    for (const part of hitbox.parts) {
        const p = placePart3D(part, cx, cy, cz, sx, sy, sz);

        let t: number | null;
        if (part.shape === 'sphere') {
            t = ray.entrySphere(p.cx, p.cy, p.cz, p.hx);
        } else if (part.shape === 'box') {
            t = ray.entryBox(p.cx, p.cy, p.cz, p.hx, p.hy, p.hz);
        } else {
            t = ray.entryCylinder(p.cx, p.cy, p.cz, p.hx, p.hy * 2);
        }

        if (t !== null && t < bestT) {
            bestT = t;
            bestName = part.name;
        }
    }

    if (bestName === null) return null;
    scratch.part = bestName;
    scratch.distance = bestT;
    scratch.point[0] = ray.origin[0] + ray.direction[0] * bestT;
    scratch.point[1] = ray.origin[1] + ray.direction[1] * bestT;
    scratch.point[2] = ray.origin[2] + ray.direction[2] * bestT;
    return scratch;
}

/**
 * Point-test against a 2D hitbox at center `(cx,cy)`, scaled `(sx,sy)`,
 * rotated by `rot` radians. The world point is rotated into the hitbox's
 * local frame, then tested against each part. Returns the first part
 * containing the point (a reused object) or `null`.
 */
export function testHitbox2D(
    hitbox: Hitbox<'2d'>,
    cx: number, cy: number,
    sx: number, sy: number,
    rot: number,
    wx: number, wy: number,
): PartHit | null {
    const cos = rot !== 0 ? Math.cos(-rot) : 1;
    const sin = rot !== 0 ? Math.sin(-rot) : 0;

    for (const part of hitbox.parts) {
        const off = part.offset;
        const ox = off ? cx + off[0] * sx : cx;
        const oy = off ? cy + off[1] * sy : cy;

        const dx = wx - ox, dy = wy - oy;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;

        let inside: boolean;
        if (part.shape === 'circle') {
            const r = part.radius * (sx > sy ? sx : sy);
            inside = lx * lx + ly * ly <= r * r;
        } else if (part.shape === 'rect') {
            inside = inHalfExtents(lx, ly, part.size[0] * 0.5 * sx, part.size[1] * 0.5 * sy);
        } else {
            const r = part.radius * (sx > sy ? sx : sy);
            const half = part.length * 0.5 * sy;
            const clampedY = ly > half ? half : (ly < -half ? -half : ly);
            const ody = ly - clampedY;
            inside = lx * lx + ody * ody <= r * r;
        }

        if (inside) {
            scratch.part = part.name;
            scratch.distance = 0;
            scratch.point[0] = wx;
            scratch.point[1] = wy;
            return scratch;
        }
    }
    return null;
}

/**
 * Point inside a sprite's rendered quad: an `sx` by `sy` rect centered at
 * `(cx,cy)`, rotated by `rot`. The default pick bound for a sprite with no
 * declared hitbox.
 */
export function pointInQuad2D(
    cx: number, cy: number,
    sx: number, sy: number,
    rot: number,
    wx: number, wy: number,
): boolean {
    const dx = wx - cx, dy = wy - cy;
    if (rot === 0) return inHalfExtents(dx, dy, sx * 0.5, sy * 0.5);
    const cos = Math.cos(-rot), sin = Math.sin(-rot);
    return inHalfExtents(dx * cos - dy * sin, dx * sin + dy * cos, sx * 0.5, sy * 0.5);
}

function inHalfExtents(lx: number, ly: number, hx: number, hy: number): boolean {
    return lx >= -hx && lx <= hx && ly >= -hy && ly <= hy;
}

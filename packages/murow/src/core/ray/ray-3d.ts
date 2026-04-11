/**
 * Ray3D — a 3D ray defined by an origin and a normalized direction.
 * Zero allocations per intersection test.
 *
 * All intersection methods return the parametric distance `t` along the ray
 * to the first hit point, or `null` if there is no intersection.
 * A hit point can be retrieved via `ray.at(t)`.
 */
export class Ray3D {
    origin: [number, number, number] = [0, 0, 0];
    direction: [number, number, number] = [0, 0, 1];

    private _point: [number, number, number] = [0, 0, 0];

    /**
     * Set origin and direction. Direction is normalized automatically.
     */
    set(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): void {
        this.origin[0] = ox;
        this.origin[1] = oy;
        this.origin[2] = oz;
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len > 0) {
            this.direction[0] = dx / len;
            this.direction[1] = dy / len;
            this.direction[2] = dz / len;
        }
    }

    /**
     * Returns the point at distance `t` along the ray.
     * Reuses an internal buffer — copy if you need to store the result.
     */
    at(t: number): [number, number, number] {
        this._point[0] = this.origin[0] + this.direction[0] * t;
        this._point[1] = this.origin[1] + this.direction[1] * t;
        this._point[2] = this.origin[2] + this.direction[2] * t;
        return this._point;
    }

    /**
     * Intersection with a plane defined by normal (nx, ny, nz) and offset d (n·x = d).
     * Returns `t` at the hit point, `null` if the ray is parallel or hits behind the origin.
     */
    intersectsPlane(nx: number, ny: number, nz: number, d: number): number | null {
        const denom = nx * this.direction[0] + ny * this.direction[1] + nz * this.direction[2];
        if (Math.abs(denom) < 1e-10) return null;
        const t = (d - (nx * this.origin[0] + ny * this.origin[1] + nz * this.origin[2])) / denom;
        return t >= 0 ? t : null;
    }

    /**
     * Intersection with a sphere at (cx, cy, cz) with radius r.
     * Returns `t` at the entry point (or exit if origin is inside), `null` if no hit.
     */
    intersectsSphere(cx: number, cy: number, cz: number, r: number): number | null {
        const fx = this.origin[0] - cx;
        const fy = this.origin[1] - cy;
        const fz = this.origin[2] - cz;
        const b = 2 * (fx * this.direction[0] + fy * this.direction[1] + fz * this.direction[2]);
        const c = fx * fx + fy * fy + fz * fz - r * r;
        const disc = b * b - 4 * c;
        if (disc < 0) return null;
        const sqrtDisc = Math.sqrt(disc);
        const t0 = (-b - sqrtDisc) / 2;
        const t1 = (-b + sqrtDisc) / 2;
        if (t0 >= 0) return t0;
        if (t1 >= 0) return t1;
        return null;
    }

    /**
     * Intersection with an axis-aligned bounding box.
     * Returns `t` at the entry point, `null` if no hit.
     */
    intersectsAABB(
        minX: number, minY: number, minZ: number,
        maxX: number, maxY: number, maxZ: number,
    ): number | null {
        let tMin = -Infinity;
        let tMax = Infinity;

        const axes: [number, number, number, number, number][] = [
            [this.direction[0], this.origin[0], minX, maxX, 0],
            [this.direction[1], this.origin[1], minY, maxY, 1],
            [this.direction[2], this.origin[2], minZ, maxZ, 2],
        ];

        for (const [d, o, mn, mx] of axes) {
            if (Math.abs(d) < 1e-10) {
                if (o < mn || o > mx) return null;
            } else {
                const inv = 1 / d;
                let t0 = (mn - o) * inv;
                let t1 = (mx - o) * inv;
                if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
                tMin = Math.max(tMin, t0);
                tMax = Math.min(tMax, t1);
            }
            if (tMin > tMax) return null;
        }

        if (tMax < 0) return null;
        return tMin >= 0 ? tMin : tMax;
    }

    /**
     * Intersection with a triangle using the Möller–Trumbore algorithm.
     * Returns `t` at the hit point, `null` if no hit.
     */
    intersectsTriangle(
        ax: number, ay: number, az: number,
        bx: number, by: number, bz: number,
        cx: number, cy: number, cz: number,
    ): number | null {
        const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
        const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

        const dx = this.direction[0], dy = this.direction[1], dz = this.direction[2];

        // h = D × e2
        const hx = dy * e2z - dz * e2y;
        const hy = dz * e2x - dx * e2z;
        const hz = dx * e2y - dy * e2x;

        const a = e1x * hx + e1y * hy + e1z * hz;
        if (Math.abs(a) < 1e-10) return null;

        const f = 1 / a;
        const sx = this.origin[0] - ax;
        const sy = this.origin[1] - ay;
        const sz = this.origin[2] - az;

        const u = f * (sx * hx + sy * hy + sz * hz);
        if (u < 0 || u > 1) return null;

        // q = s × e1
        const qx = sy * e1z - sz * e1y;
        const qy = sz * e1x - sx * e1z;
        const qz = sx * e1y - sy * e1x;

        const v = f * (dx * qx + dy * qy + dz * qz);
        if (v < 0 || u + v > 1) return null;

        const t = f * (e2x * qx + e2y * qy + e2z * qz);
        return t >= 0 ? t : null;
    }
}

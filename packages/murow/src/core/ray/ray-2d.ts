/**
 * Ray2D — a 2D ray defined by an origin and a normalized direction.
 * Zero allocations per intersection test.
 *
 * All intersection methods return the parametric distance `t` along the ray
 * to the first hit point, or `null` if there is no intersection.
 * A hit point can be retrieved via `ray.at(t)`.
 */
export class Ray2D {
    origin: [number, number] = [0, 0];
    direction: [number, number] = [1, 0];

    private _point: [number, number] = [0, 0];

    /**
     * Set origin and direction. Direction is normalized automatically.
     */
    set(ox: number, oy: number, dx: number, dy: number): void {
        this.origin[0] = ox;
        this.origin[1] = oy;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
            this.direction[0] = dx / len;
            this.direction[1] = dy / len;
        }
    }

    /**
     * Returns the point at distance `t` along the ray.
     * Reuses an internal buffer — copy if you need to store the result.
     */
    at(t: number): [number, number] {
        this._point[0] = this.origin[0] + this.direction[0] * t;
        this._point[1] = this.origin[1] + this.direction[1] * t;
        return this._point;
    }

    /**
     * Intersection with a line segment from (ax, ay) to (bx, by).
     * Returns `t` if the ray hits the segment, `null` otherwise.
     */
    intersectsSegment(ax: number, ay: number, bx: number, by: number): number | null {
        const dx = this.direction[0];
        const dy = this.direction[1];
        const ex = bx - ax;
        const ey = by - ay;

        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-10) return null;

        const fx = ax - this.origin[0];
        const fy = ay - this.origin[1];

        const t = (fx * ey - fy * ex) / denom;
        const u = (fx * dy - fy * dx) / denom;

        if (t < 0 || u < 0 || u > 1) return null;
        return t;
    }

    /**
     * Intersection with a circle at (cx, cy) with radius r.
     * Returns `t` at the entry point (or exit if origin is inside), `null` if no hit.
     */
    intersectsCircle(cx: number, cy: number, r: number): number | null {
        const fx = this.origin[0] - cx;
        const fy = this.origin[1] - cy;
        const b = 2 * (fx * this.direction[0] + fy * this.direction[1]);
        const c = fx * fx + fy * fy - r * r;
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
    intersectsAABB(minX: number, minY: number, maxX: number, maxY: number): number | null {
        let tMin = -Infinity;
        let tMax = Infinity;

        if (Math.abs(this.direction[0]) < 1e-10) {
            if (this.origin[0] < minX || this.origin[0] > maxX) return null;
        } else {
            const idx = 1 / this.direction[0];
            let t0 = (minX - this.origin[0]) * idx;
            let t1 = (maxX - this.origin[0]) * idx;
            if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
            tMin = Math.max(tMin, t0);
            tMax = Math.min(tMax, t1);
        }

        if (Math.abs(this.direction[1]) < 1e-10) {
            if (this.origin[1] < minY || this.origin[1] > maxY) return null;
        } else {
            const idy = 1 / this.direction[1];
            let t0 = (minY - this.origin[1]) * idy;
            let t1 = (maxY - this.origin[1]) * idy;
            if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
            tMin = Math.max(tMin, t0);
            tMax = Math.min(tMax, t1);
        }

        if (tMin > tMax || tMax < 0) return null;
        return tMin >= 0 ? tMin : tMax;
    }
}

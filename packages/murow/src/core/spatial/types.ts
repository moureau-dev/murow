/** Axis-aligned box in 2D. A point is a box with `min === max`. */
export interface AABB {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** Axis-aligned box in 3D. */
export interface AABB3 {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

/** Whether two 2D boxes overlap (touching counts). */
export function aabbIntersects(a: AABB, b: AABB): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Whether a 2D point is inside `box` (touching counts). */
export function aabbContainsPoint(box: AABB, x: number, y: number): boolean {
    return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

/** Whether two 3D boxes overlap (touching counts). */
export function aabb3Intersects(a: AABB3, b: AABB3): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX
        && a.minY <= b.maxY && a.maxY >= b.minY
        && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * Orientation for decals. The engine's `plane` prefab faces `+Z`, and instance
 * transforms apply scale, then rotate Z, Y, X (i.e. `Rx*Ry*Rz`). So to lay a
 * quad on a surface with normal `n`, we solve `Rx*Ry*(0,0,1) = n` and use the
 * Z rotation as an in-plane spin (`roll`).
 *
 * Pure math, no GPU — unit-tested in `orientation.test.ts`.
 */
export type Euler = readonly [x: number, y: number, z: number];

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Euler `[rx, ry, rz]` (radians) that points a `+Z` quad along `normal`,
 * spun by `roll` around the normal.
 */
export function decalEuler(nx: number, ny: number, nz: number, roll = 0): Euler {
    const len = Math.hypot(nx, ny, nz) || 1;
    const x = nx / len, y = ny / len, z = nz / len;
    // Rx*Ry*(0,0,1) = (sin(ry), -sin(rx)cos(ry), cos(rx)cos(ry)).
    const ry = Math.asin(clamp(x, -1, 1));
    const rx = Math.atan2(-y, z);
    return [rx, ry, roll];
}

/** Apply an `Rx*Ry*Rz` Euler rotation to a vector (used by the tests). */
export function applyEulerXYZ(e: Euler, vx: number, vy: number, vz: number): [number, number, number] {
    const cx = Math.cos(e[0]), sx = Math.sin(e[0]);
    const cy = Math.cos(e[1]), sy = Math.sin(e[1]);
    const cz = Math.cos(e[2]), sz = Math.sin(e[2]);
    // Rz
    const x1 = cz * vx - sz * vy;
    const y1 = sz * vx + cz * vy;
    const z1 = vz;
    // Ry
    const x2 = cy * x1 + sy * z1;
    const y2 = y1;
    const z2 = -sy * x1 + cy * z1;
    // Rx
    const x3 = x2;
    const y3 = cx * y2 - sx * z2;
    const z3 = sx * y2 + cx * z2;
    return [x3, y3, z3];
}

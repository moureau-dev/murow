import type { MeshInstanceOptions } from '../../types';

/** Resolve the tuple-shape transform options into flat scalars + defaults. */
export function resolveTransform(opts: MeshInstanceOptions<any>) {
    const [px, py, pz] = opts.position ?? [0, 0, 0];
    const [rx, ry, rz] = opts.rotation ?? [0, 0, 0];
    const s = opts.scale;
    const [sx, sy, sz] = typeof s === 'number' ? [s, s, s] : (s ?? [1, 1, 1]);
    const [cr, cg, cb] = opts.color ?? [1, 1, 1];
    return { px, py, pz, rx, ry, rz, sx, sy, sz, cr, cg, cb };
}

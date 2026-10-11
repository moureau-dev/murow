/**
 * Game-specific shader utilities.
 *
 * Each export is a plain JavaScript function so it can run on the CPU (used by
 * `lightContribution`/`tonemap` tests and by consumers) and, for the two that
 * shader bodies call, also lower to a `murow/gpu` call node. The WGSL source for
 * those helpers is injected by the WebGPU backend when the call appears.
 */
import { call, vec as vecType } from 'murow/gpu/ir';
import { ShaderValue, toExpr } from 'murow/gpu/dsl';
import type { IrExpr } from 'murow/gpu/ir';

/** Vector-ish value accepted by the CPU paths. */
interface VecLike {
    readonly x: number;
    readonly y: number;
    readonly z?: number;
    readonly w?: number;
}

/** Whether a value is a `murow/gpu` IR expression. */
function isIr(value: unknown): value is IrExpr {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { kind?: unknown }).kind === 'string' &&
        typeof (value as { type?: { kind?: unknown } }).type === 'object'
    );
}

/** Rotate a 2D point around the origin by `angle` radians. */
export function rotate2d(point: VecLike, angle: number): { x: number; y: number } {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
        x: point.x * c - point.y * s,
        y: point.x * s + point.y * c,
    };
}

/** Transform a 2D world position to clip space using a 3x3 column-major matrix. */
export function worldToClip2d(worldPos: VecLike, cameraMatrix: any): { x: number; y: number; z: number; w: number } {
    const columns = cameraMatrix?.columns;
    const m = columns ? [columns[0], columns[1], columns[2]] : cameraMatrix;
    const x = m[0].x * worldPos.x + m[1].x * worldPos.y + m[2].x;
    const y = m[0].y * worldPos.x + m[1].y * worldPos.y + m[2].y;
    return { x, y, z: 0, w: 1 };
}

/** Transform a 3D world position to clip space using a 4x4 column-major matrix. */
export function worldToClip3d(worldPos: VecLike, vpMatrix: any): { x: number; y: number; z: number; w: number } {
    const columns = vpMatrix?.columns;
    const m = columns ? [columns[0], columns[1], columns[2], columns[3]] : vpMatrix;
    const x = m[0].x * worldPos.x + m[1].x * worldPos.y + m[2].x * worldPos.z + m[3].x;
    const y = m[0].y * worldPos.x + m[1].y * worldPos.y + m[2].y * worldPos.z + m[3].y;
    const z = m[0].z * worldPos.x + m[1].z * worldPos.y + m[2].z * worldPos.z + m[3].z;
    const w = m[0].w * worldPos.x + m[1].w * worldPos.y + m[2].w * worldPos.z + m[3].w;
    return { x, y, z, w };
}

/** Remap a value from one range to another. */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
    const t = (value - inMin) / (inMax - inMin);
    return outMin + t * (outMax - outMin);
}

/** Build a 2D scale+rotation matrix (column-major) from scale and angle. */
export function scaleRotate2d(scale: VecLike, angle: number): number[] {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [scale.x * c, scale.x * s, -(scale.y * s), scale.y * c];
}

/** Inverse lerp: given a value in [min, max], return its t in [0, 1]. */
export function inverseLerp(min: number, max: number, value: number): number {
    const t = (value - min) / (max - min);
    return Math.min(1, Math.max(0, t));
}

/** Diffuse contribution of one point or spot light. */
export function lightContribution(...args: any[]): any {
    if (args.some(isIr)) {
        return new ShaderValue({
            node: call(vecType('f32', 3), 'lightContribution', args.map(toExpr)),
        });
    }
    const [pos, axis, color, params, normal, worldPos] = args as [VecLike, VecLike, VecLike, VecLike, VecLike, VecLike];
    const intensity = params.x;
    const range = params.y;
    const innerCos = params.z;
    const outerCos = params.w ?? 0;

    const toLight = { x: pos.x - worldPos.x, y: pos.y - worldPos.y, z: pos.z - worldPos.z };
    const dist = length3(toLight);
    const dir = normalize3(toLight);
    const lambert = Math.max(dot3(normal, dir), 0);
    const atten = clamp(1 - dist / Math.max(range, 0.0001), 0, 1);
    const falloff = atten * atten;

    const axisLen = length3(axis);
    const isSpot = axisLen > 0.0001;
    const safeAxis = isSpot ? axis : { x: 0, y: 0, z: 1 };
    const cosAngle = dot3(normalize3(safeAxis), { x: -dir.x, y: -dir.y, z: -dir.z });
    const spotCone = smoothstep(outerCos, innerCos, cosAngle);
    const cone = isSpot ? spotCone : 1;
    const scale = lambert * falloff * cone * intensity;
    return { x: color.x * scale, y: color.y * scale, z: color.z * scale };
}

/** Reinhard tone map. */
export function tonemap(c: any): any {
    if (isIr(c)) {
        return new ShaderValue({ node: call(vecType('f32', 3), 'tonemap', [toExpr(c)]) });
    }
    const value = c as VecLike;
    return {
        x: value.x / (1 + value.x),
        y: value.y / (1 + value.y),
        z: value.z / (1 + value.z),
    };
}

function length3(v: VecLike): number {
    const z = v.z ?? 0;
    return Math.sqrt(v.x * v.x + v.y * v.y + z * z);
}

function normalize3(v: VecLike): { x: number; y: number; z: number } {
    const len = length3(v) || 1;
    return { x: v.x / len, y: v.y / len, z: (v.z ?? 0) / len };
}

function dot3(a: VecLike, b: VecLike): number {
    return a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
}

function clamp(v: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

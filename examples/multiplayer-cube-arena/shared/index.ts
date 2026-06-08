export * from './constants';
export * from './components';
export * from './protocol';
export * from './predictions';
export * from "./arena";

/** Clamps value to bounds */
export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

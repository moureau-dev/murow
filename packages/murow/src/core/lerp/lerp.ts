/**
 * @description
 * Performs linear interpolation between two values.
 *
 * Linear interpolation (lerp) calculates a value between a start and end point
 * based on a normalized interpolation factor (t). When t = 0, the result equals
 * the start value; when t = 1, the result equals the end value. Values of t
 * between 0 and 1 produce intermediate results.
 *
 * @remarks
 * - This function does not clamp the interpolation factor. Values of t outside
 *   the range [0, 1] will extrapolate beyond the start and end values.
 * - For clamped interpolation, combine with a clamp function on the t parameter.
 * - Commonly used for smooth animations, camera movements, and value transitions.
 *
 * @param start - The starting value (when t = 0)
 * @param end - The ending value (when t = 1)
 * @param t - The interpolation factor, typically in the range [0, 1]
 *
 * @returns {number} The interpolated value between start and end
 *
 * @example
 * ```typescript
 * // Basic interpolation
 * lerp(0, 100, 0.5);   // Returns 50
 * lerp(0, 100, 0);     // Returns 0
 * lerp(0, 100, 1);     // Returns 100
 *
 * // Animation example
 * const startPos = 0;
 * const endPos = 100;
 * const progress = 0.75;
 * const currentPos = lerp(startPos, endPos, progress); // Returns 75
 *
 * // Extrapolation (t outside [0, 1])
 * lerp(0, 100, 1.5);   // Returns 150
 * lerp(0, 100, -0.5);  // Returns -50
 * ```
 */
export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

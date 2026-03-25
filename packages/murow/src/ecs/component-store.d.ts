import { Component } from "./component";
/**
 * Stores component data using separate TypedArrays per field (SoA - Structure of Arrays).
 * Alternative to DataView-based storage for comparison.
 *
 * Tradeoffs:
 * + Faster individual field access (native typed array operations)
 * + Better for column-major access patterns
 * + SIMD-friendly (can vectorize single-field operations)
 * - Worse cache locality for row-major access (whole component reads)
 * - More memory fragmentation (separate arrays)
 * - Slightly higher memory overhead (each TypedArray has its own header)
 */
export declare class ComponentStore<T extends object> {
    private arrays;
    private stride;
    private component;
    private maxEntities;
    private reusableObject;
    private fields;
    private fieldKeys;
    private fieldIndexMap;
    constructor(component: Component<T>, maxEntities: number);
    /**
     * Get component data for an entity.
     *
     * ⚠️ IMPORTANT: Returns a REUSED object that is overwritten on the next get() call.
     */
    get(entityId: number): Readonly<T>;
    /**
     * Get a mutable copy of component data.
     */
    getMutable(entityId: number): T;
    /**
     * Copy component data into a provided object.
     */
    copyTo(entityId: number, target: T): void;
    /**
     * Set component data for an entity.
     */
    set(entityId: number, data: T): void;
    /**
     * Update specific fields of a component.
     * Optimized to avoid Object.keys() allocation in hot path.
     */
    update(entityId: number, partial: Partial<T>): void;
    /**
     * Clear component data for an entity (set to default values)
     */
    clear(entityId: number): void;
    /**
     * Get direct access to the underlying arrays.
     * Advanced use only - for SIMD operations, batch processing, etc.
     */
    getRawArrays(): readonly (Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array)[];
    /**
     * Get a specific field's array directly.
     * Useful for vectorized operations on a single field across all entities.
     */
    getFieldArray(fieldName: keyof T): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array;
    /**
     * Get the stride in bytes (for compatibility with DataView version).
     */
    getStride(): number;
}

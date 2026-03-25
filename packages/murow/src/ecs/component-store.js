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
export class ComponentStore {
    constructor(component, maxEntities) {
        this.component = component;
        this.maxEntities = maxEntities;
        this.stride = component.size;
        // Pre-compute field metadata
        this.fieldKeys = component.fieldNames;
        this.fields = [];
        this.fieldIndexMap = {};
        this.arrays = [];
        // Create separate typed array for each field
        for (let i = 0; i < this.fieldKeys.length; i++) {
            const key = this.fieldKeys[i];
            const field = component.schema[key];
            this.fields.push(field);
            this.fieldIndexMap[key] = i;
            // Allocate appropriate typed array based on field type
            switch (field.size) {
                case 4:
                    // Could be f32, i32, or u32 - check field type
                    if (field.read.toString().includes("getFloat32")) {
                        this.arrays.push(new Float32Array(maxEntities));
                    }
                    else if (field.read.toString().includes("getInt32")) {
                        this.arrays.push(new Int32Array(maxEntities));
                    }
                    else {
                        this.arrays.push(new Uint32Array(maxEntities));
                    }
                    break;
                case 2:
                    this.arrays.push(new Uint16Array(maxEntities));
                    break;
                case 1:
                    this.arrays.push(new Uint8Array(maxEntities));
                    break;
                default:
                    // Fallback to Uint8Array with multiple elements
                    this.arrays.push(new Uint8Array(maxEntities * field.size));
            }
        }
        // Create single reusable object
        this.reusableObject = {};
        for (let i = 0; i < this.fieldKeys.length; i++) {
            this.reusableObject[this.fieldKeys[i]] = this.fields[i].toNil();
        }
    }
    /**
     * Get component data for an entity.
     *
     * ⚠️ IMPORTANT: Returns a REUSED object that is overwritten on the next get() call.
     */
    get(entityId) {
        const length = this.fields.length;
        // Unrolled loop for common cases
        if (length === 2) {
            this.reusableObject[this.fieldKeys[0]] = this.arrays[0][entityId];
            this.reusableObject[this.fieldKeys[1]] = this.arrays[1][entityId];
        }
        else if (length === 3) {
            this.reusableObject[this.fieldKeys[0]] = this.arrays[0][entityId];
            this.reusableObject[this.fieldKeys[1]] = this.arrays[1][entityId];
            this.reusableObject[this.fieldKeys[2]] = this.arrays[2][entityId];
        }
        else if (length === 4) {
            this.reusableObject[this.fieldKeys[0]] = this.arrays[0][entityId];
            this.reusableObject[this.fieldKeys[1]] = this.arrays[1][entityId];
            this.reusableObject[this.fieldKeys[2]] = this.arrays[2][entityId];
            this.reusableObject[this.fieldKeys[3]] = this.arrays[3][entityId];
        }
        else {
            // Generic loop for other sizes
            for (let i = 0; i < length; i++) {
                this.reusableObject[this.fieldKeys[i]] = this.arrays[i][entityId];
            }
        }
        return this.reusableObject;
    }
    /**
     * Get a mutable copy of component data.
     */
    getMutable(entityId) {
        const copy = {};
        this.copyTo(entityId, copy);
        return copy;
    }
    /**
     * Copy component data into a provided object.
     */
    copyTo(entityId, target) {
        for (let i = 0; i < this.fields.length; i++) {
            target[this.fieldKeys[i]] = this.arrays[i][entityId];
        }
    }
    /**
     * Set component data for an entity.
     */
    set(entityId, data) {
        const length = this.fields.length;
        // Unrolled loop for common cases
        if (length === 2) {
            this.arrays[0][entityId] = data[this.fieldKeys[0]];
            this.arrays[1][entityId] = data[this.fieldKeys[1]];
        }
        else if (length === 3) {
            this.arrays[0][entityId] = data[this.fieldKeys[0]];
            this.arrays[1][entityId] = data[this.fieldKeys[1]];
            this.arrays[2][entityId] = data[this.fieldKeys[2]];
        }
        else if (length === 4) {
            this.arrays[0][entityId] = data[this.fieldKeys[0]];
            this.arrays[1][entityId] = data[this.fieldKeys[1]];
            this.arrays[2][entityId] = data[this.fieldKeys[2]];
            this.arrays[3][entityId] = data[this.fieldKeys[3]];
        }
        else {
            // Generic loop for other sizes
            for (let i = 0; i < length; i++) {
                this.arrays[i][entityId] = data[this.fieldKeys[i]];
            }
        }
    }
    /**
     * Update specific fields of a component.
     * Optimized to avoid Object.keys() allocation in hot path.
     */
    update(entityId, partial) {
        // Direct iteration
        for (const key in partial) {
            const i = this.fieldIndexMap[key];
            this.arrays[i][entityId] = partial[key];
        }
    }
    /**
     * Clear component data for an entity (set to default values)
     */
    clear(entityId) {
        for (let i = 0; i < this.fields.length; i++) {
            this.arrays[i][entityId] = this.fields[i].toNil();
        }
    }
    /**
     * Get direct access to the underlying arrays.
     * Advanced use only - for SIMD operations, batch processing, etc.
     */
    getRawArrays() {
        return this.arrays;
    }
    /**
     * Get a specific field's array directly.
     * Useful for vectorized operations on a single field across all entities.
     */
    getFieldArray(fieldName) {
        const index = this.fieldIndexMap[fieldName];
        return this.arrays[index];
    }
    /**
     * Get the stride in bytes (for compatibility with DataView version).
     */
    getStride() {
        return this.stride;
    }
}

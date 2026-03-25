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
export class ComponentStore<T extends object> {
  private arrays: (Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array)[];
  private stride: number; // Component size in bytes (for compatibility)
  private component: Component<T>;
  private maxEntities: number;

  // Single reusable object for get() - zero allocations!
  private reusableObject: T;

  // Pre-computed field metadata for fast access
  private fields: any[];
  private fieldKeys: (keyof T)[];
  private fieldIndexMap: Record<string, number>;

  constructor(component: Component<T>, maxEntities: number) {
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
      this.fieldIndexMap[key as string] = i;

      // Allocate appropriate typed array based on field type
      switch (field.size) {
        case 4:
          // Could be f32, i32, or u32 - check field type
          if (field.read.toString().includes("getFloat32")) {
            this.arrays.push(new Float32Array(maxEntities));
          } else if (field.read.toString().includes("getInt32")) {
            this.arrays.push(new Int32Array(maxEntities));
          } else {
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
    this.reusableObject = {} as T;
    for (let i = 0; i < this.fieldKeys.length; i++) {
      this.reusableObject[this.fieldKeys[i]] = this.fields[i].toNil();
    }
  }

  /**
   * Get component data for an entity.
   *
   * ⚠️ IMPORTANT: Returns a REUSED object that is overwritten on the next get() call.
   */
  get(entityId: number): Readonly<T> {
    const length = this.fields.length;

    // Unrolled loop for common cases
    if (length === 2) {
      this.reusableObject[this.fieldKeys[0]] = this.arrays[0][entityId] as any;
      this.reusableObject[this.fieldKeys[1]] = this.arrays[1][entityId] as any;
    } else if (length === 3) {
      this.reusableObject[this.fieldKeys[0]] = this.arrays[0][entityId] as any;
      this.reusableObject[this.fieldKeys[1]] = this.arrays[1][entityId] as any;
      this.reusableObject[this.fieldKeys[2]] = this.arrays[2][entityId] as any;
    } else if (length === 4) {
      this.reusableObject[this.fieldKeys[0]] = this.arrays[0][entityId] as any;
      this.reusableObject[this.fieldKeys[1]] = this.arrays[1][entityId] as any;
      this.reusableObject[this.fieldKeys[2]] = this.arrays[2][entityId] as any;
      this.reusableObject[this.fieldKeys[3]] = this.arrays[3][entityId] as any;
    } else {
      // Generic loop for other sizes
      for (let i = 0; i < length; i++) {
        this.reusableObject[this.fieldKeys[i]] = this.arrays[i][entityId] as any;
      }
    }

    return this.reusableObject as Readonly<T>;
  }

  /**
   * Get a mutable copy of component data.
   */
  getMutable(entityId: number): T {
    const copy = {} as T;
    this.copyTo(entityId, copy);
    return copy;
  }

  /**
   * Copy component data into a provided object.
   */
  copyTo(entityId: number, target: T): void {
    for (let i = 0; i < this.fields.length; i++) {
      target[this.fieldKeys[i]] = this.arrays[i][entityId] as any;
    }
  }

  /**
   * Set component data for an entity.
   */
  set(entityId: number, data: T): void {
    const length = this.fields.length;

    // Unrolled loop for common cases
    if (length === 2) {
      this.arrays[0][entityId] = data[this.fieldKeys[0]] as any;
      this.arrays[1][entityId] = data[this.fieldKeys[1]] as any;
    } else if (length === 3) {
      this.arrays[0][entityId] = data[this.fieldKeys[0]] as any;
      this.arrays[1][entityId] = data[this.fieldKeys[1]] as any;
      this.arrays[2][entityId] = data[this.fieldKeys[2]] as any;
    } else if (length === 4) {
      this.arrays[0][entityId] = data[this.fieldKeys[0]] as any;
      this.arrays[1][entityId] = data[this.fieldKeys[1]] as any;
      this.arrays[2][entityId] = data[this.fieldKeys[2]] as any;
      this.arrays[3][entityId] = data[this.fieldKeys[3]] as any;
    } else {
      // Generic loop for other sizes
      for (let i = 0; i < length; i++) {
        this.arrays[i][entityId] = data[this.fieldKeys[i]] as any;
      }
    }
  }

  /**
   * Update specific fields of a component.
   * Optimized to avoid Object.keys() allocation in hot path.
   */
  update(entityId: number, partial: Partial<T>): void {
    // Direct iteration
    for (const key in partial) {
      const i = this.fieldIndexMap[key];
      this.arrays[i][entityId] = partial[key as keyof T] as any;
    }
  }

  /**
   * Clear component data for an entity (set to default values)
   */
  clear(entityId: number): void {
    for (let i = 0; i < this.fields.length; i++) {
      this.arrays[i][entityId] = this.fields[i].toNil();
    }
  }

  /**
   * Get direct access to the underlying arrays.
   * Advanced use only - for SIMD operations, batch processing, etc.
   */
  getRawArrays(): readonly (Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array)[] {
    return this.arrays;
  }

  /**
   * Get a specific field's array directly.
   * Useful for vectorized operations on a single field across all entities.
   */
  getFieldArray(fieldName: keyof T): Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array {
    const index = this.fieldIndexMap[fieldName as string];
    return this.arrays[index];
  }

  /**
   * Get the stride in bytes (for compatibility with DataView version).
   */
  getStride(): number {
    return this.stride;
  }
}

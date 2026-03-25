import { PooledCodec } from "../core/pooled-codec";
/**
 * Calculate the byte size of a schema
 */
function calculateSchemaSize(schema) {
    let size = 0;
    for (const key of Object.keys(schema)) {
        size += schema[key].size;
    }
    return size;
}
/**
 * Define a component type with its binary schema.
 *
 * @example
 * ```typescript
 * const Transform = defineComponent('Transform', {
 *   x: BinaryCodec.f32,
 *   y: BinaryCodec.f32,
 *   rotation: BinaryCodec.f32,
 * });
 *
 * const Health = defineComponent('Health', {
 *   current: BinaryCodec.u16,
 *   max: BinaryCodec.u16,
 * });
 * ```
 */
export function defineComponent(name, schema) {
    const size = calculateSchemaSize(schema);
    const fieldNames = Object.keys(schema);
    const fieldCount = fieldNames.length;
    // Create PooledCodec for array serialization
    const arrayCodec = PooledCodec.array(schema);
    return {
        name,
        schema,
        size,
        fieldCount,
        fieldNames,
        arrayCodec,
    };
}

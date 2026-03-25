import { Schema } from "../core/binary-codec";
import { PooledCodec, ArrayField } from "../core/pooled-codec";

/**
 * Metadata for a component definition
 */
export interface ComponentMeta<T extends object> {
  /** Schema defining the component's binary layout */
  schema: Schema<T>;

  /** Unique name for this component type */
  name: string;

  /** Size of the component in bytes */
  size: number;

  /** Number of fields in the schema */
  fieldCount: number;

  /** Field names in order */
  fieldNames: (keyof T)[];

  /** Codec for array serialization */
  arrayCodec: ArrayField<T>;
}

/**
 * Component type returned by defineComponent
 */
export type Component<T extends object = any> = ComponentMeta<T> & {
  /** Type marker for TypeScript inference */
  __type?: T;

  /** Internal: Index assigned by World when registered */
  __worldIndex?: number;
};

/**
 * Infer the data type from a Component
 */
export type InferComponentType<C> = C extends Component<infer T> ? T : never;

/**
 * Calculate the byte size of a schema
 */
function calculateSchemaSize<T extends object>(schema: Schema<T>): number {
  let size = 0;
  for (const key of Object.keys(schema) as (keyof T)[]) {
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
export function defineComponent<T extends object>(
  name: string,
  schema: Schema<T>
): Component<T> {
  const size = calculateSchemaSize(schema);
  const fieldNames = Object.keys(schema) as (keyof T)[];
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

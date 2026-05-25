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

  /**
   * Opaque metadata attached by higher-level packages (e.g. `murow/netcode`
   * stores `SyncSpec` here to mark a component as networked). Core never
   * interprets this; readers narrow it to the shape they own.
   */
  __sync?: unknown;
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
 * Descriptor form of `defineComponent`. Pass `{ schema, sync }` to attach
 * opaque sync metadata (consumed by `murow/netcode` to mark the component
 * as networked).
 */
export interface ComponentDescriptor<T extends object> {
  schema: Schema<T>;
  sync: unknown;
}

/**
 * Define a component type with its binary schema.
 *
 * Two call shapes are supported:
 * - Bare schema (the common case): `defineComponent(name, schema)`
 * - Descriptor with sync metadata: `defineComponent(name, { schema, sync })`
 *
 * The descriptor form attaches `__sync` to the returned component. Core
 * doesn't interpret `__sync`; it's read by higher-level packages such as
 * `murow/netcode`. The check for descriptor form is `'schema' in arg &&
 * 'sync' in arg`, which is unambiguous because real component field names
 * never collide with both keys at once.
 *
 * @example Bare schema
 * ```typescript
 * const Transform = defineComponent('Transform', {
 *   x: BinaryCodec.f32,
 *   y: BinaryCodec.f32,
 *   rotation: BinaryCodec.f32,
 * });
 * ```
 *
 * @example Descriptor with sync
 * ```typescript
 * const Position = defineComponent('Position', {
 *   schema: { x: f32, y: f32 },
 *   sync: { rate: 'every-tick', interest: 'aoi' },
 * });
 * ```
 */
export function defineComponent<T extends object>(
  name: string,
  schema: Schema<T>
): Component<T>;
export function defineComponent<T extends object>(
  name: string,
  def: ComponentDescriptor<T>
): Component<T>;
export function defineComponent<T extends object>(
  name: string,
  arg: Schema<T> | ComponentDescriptor<T>
): Component<T> {
  const isDescriptor =
    typeof arg === 'object' &&
    arg !== null &&
    'schema' in arg &&
    'sync' in arg;

  const schema: Schema<T> = (isDescriptor ? (arg as ComponentDescriptor<T>).schema : arg) as Schema<T>;
  const sync = isDescriptor ? (arg as ComponentDescriptor<T>).sync : undefined;

  const size = calculateSchemaSize(schema);
  const fieldNames = Object.keys(schema) as (keyof T)[];
  const fieldCount = fieldNames.length;

  // Create PooledCodec for array serialization
  const arrayCodec = PooledCodec.array(schema);

  const component: Component<T> = {
    name,
    schema,
    size,
    fieldCount,
    fieldNames,
    arrayCodec,
  };
  if (sync !== undefined) component.__sync = sync;
  return component;
}

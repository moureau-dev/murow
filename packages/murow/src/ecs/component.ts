import { Schema, type ArrayFromField } from "../core/binary-codec";
import { PooledCodec, ArrayField } from "../core/pooled-codec";

/**
 * Metadata for a component definition.
 *
 * The second type parameter `S` carries the precise schema literal type
 * (e.g. `{ x: Field<number, Float32Array>, y: Field<number, Uint8Array> }`)
 * so that `world.fields(component)` can return a per-field typed-array
 * map without casts. Defaults to the loose `Schema<T>` for compatibility
 * with callers that don't preserve the narrow schema.
 */
export interface ComponentMeta<T extends object, S extends Schema<T> = Schema<T>> {
  /** Schema defining the component's binary layout */
  schema: S;

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
 * Component type returned by defineComponent.
 *
 * `T` is the value-shape inferred from the schema. `S` is the precise
 * schema literal type, used by `world.fields()` to return per-field
 * typed-array maps with exact element types (Float32Array vs Uint8Array
 * vs ...). When omitted, `S` defaults to the loose `Schema<T>` and
 * `world.fields()` falls back to a broad TypedArray union per field.
 */
export type Component<
  T extends object = any,
  S extends Schema<T> = Schema<T>,
> = ComponentMeta<T, S> & {
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
export type InferComponentType<C> = C extends Component<infer T, any> ? T : never;

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
export interface ComponentDescriptor<T extends object, S extends Schema<T> = Schema<T>> {
  schema: S;
  sync: unknown;
}

/**
 * Helper: derive the value-shape `T` from a narrowly-typed schema literal.
 * Each entry must be a `Field<T[K], any>`, and we extract the `T[K]` per key.
 */
type InferSchemaShape<S> = {
  [K in keyof S]: S[K] extends import("../core/binary-codec").Field<infer V, any> ? V : never;
};

/**
 * Resolves a component field to an error-branded type unless its value is a
 * scalar (number or boolean), so composite fields fail at the call site.
 */
type ScalarFieldGuard<F> =
  F extends import("../core/binary-codec").Field<infer V, any>
    ? ([V] extends [number | boolean] ? unknown : { readonly __error: "component fields must be scalar (number or boolean); model vectors as separate fields" })
    : unknown;

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
 * The schema literal type is preserved through inference so that
 * `world.fields(component)` returns precisely-typed typed arrays per
 * field (Float32Array vs Uint8Array vs Uint16Array etc.) without casts.
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
export function defineComponent<S extends Record<string, import("../core/binary-codec").Field<any, any>>>(
  name: string,
  schema: S & { [K in keyof S]: ScalarFieldGuard<S[K]> }
): Component<InferSchemaShape<S> & object, S extends Schema<InferSchemaShape<S> & object> ? S : never>;
export function defineComponent<S extends Record<string, import("../core/binary-codec").Field<any, any>>>(
  name: string,
  def: { schema: S & { [K in keyof S]: ScalarFieldGuard<S[K]> }; sync: unknown }
): Component<InferSchemaShape<S> & object, S extends Schema<InferSchemaShape<S> & object> ? S : never>;
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

  for (const key of fieldNames) {
    const nil = schema[key].toNil();
    if (typeof nil !== "number" && typeof nil !== "boolean") {
      throw new Error(
        `defineComponent("${name}"): field "${String(key)}" must be a scalar (number or boolean). ` +
        `Composite fields are not supported by the store; model vectors as separate fields (e.g. x, y, z).`,
      );
    }
  }

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

export type FieldsOf<C extends Component<any, any>> =
  C extends Component<any, infer S>
    ? Readonly<{ [K in keyof S]: ArrayFromField<S[K]> }>
    : never;

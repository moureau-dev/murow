/**
 * PrefabBucket — typed registry of reusable spawn templates.
 *
 * Pass `'2d'` or `'3d'` to the constructor to pick the spec/prefab universe.
 * Parsers are wired implicitly; user code only sees `add`, `addAll`, `load`, `get`.
 *
 * ```ts
 * const bucket = new PrefabBucket('3d')
 *     .add({ type: 'gltf', id: 'minion', url: '/minion.glb' })
 *     .add({ type: 'grid', id: 'floor', size: 20, step: 0.33, lineWidth: 0.001 });
 *
 * await bucket.load();
 *
 * bucket.get('minion');  // typed as GltfPrefab — `.animations`, `.jointCount`, …
 * bucket.get('floor');   // typed as GridPrefab — `.size`, `.step`, `.lineWidth`
 * bucket.get('typo');    // ❌ TS error: '"typo"' not in '"minion" | "floor"'
 * ```
 */

import { BasePrefabBucket, type StringOr } from './index';
import { parsers2d, parsers3d } from './parsers';
import { generateId } from '../../core/generate-id';
import type {
    CompositePrefab,
    PartOffset,
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
    PrefabFor,
} from './specs';

// Mode → spec/prefab mapping. Keeps the public type signature compact.
type SpecForMode<M> = M extends '3d' ? Prefab3DSpec : Prefab2DSpec;
type PrefabUnionForMode<M> = M extends '3d' ? Prefab3D : Prefab2D;

/**
 * Registry of prefab specs and their parsed variants. The bucket tracks the mapping of
 * spec `id` strings to their parsed prefab types, so `get` narrows to the correct
 * prefab type based on the provided id. The bucket is mutable; call `add`/`addAll`
 * to register new specs and their prefab types. Call `load` to parse all registered
 * specs and populate the bucket's internal prefab registry.
 */
export class PrefabBucket<
    M extends '2d' | '3d' = '3d',
    Specs extends Record<string, SpecForMode<M>> = {},
> extends BasePrefabBucket<M, SpecForMode<M>, PrefabUnionForMode<M>, Specs> {
    constructor(mode: M) {
        const parsers = mode === '3d' ? parsers3d : parsers2d;
        super(mode, parsers as any);
    }

    /**
     * Add a spec. Chains return the subclass type so the bucket variable's
     * static type accumulates id→spec mappings, enabling `get` to narrow.
     */
    add<const S extends SpecForMode<M>>(
        spec: S,
    ): PrefabBucket<M, Specs & { [K in S['id']]: S }> {
        return super.add(spec) as unknown as PrefabBucket<M, Specs & { [K in S['id']]: S }>;
    }

    addAll<const Ss extends readonly SpecForMode<M>[]>(
        specs: Ss,
    ): PrefabBucket<M, Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }> {
        return super.addAll(specs) as unknown as PrefabBucket<
            M,
            Specs & { [K in Ss[number]['id']]: Extract<Ss[number], { id: K }> }
        >;
    }

    /**
     * Return the parsed prefab variant for this id. Narrow type — `get('minion')`
     * returns `GltfPrefab` (with `.animations`, `.jointCount`), not the union.
     *
     * Accepts any string at runtime but autocompletes known ids.
     */
    get<
        K extends keyof Specs & string,
        R = PrefabFor<Specs[K]>,
    >(id: StringOr<K>): R {
        return super.get(id as K) as R;
    }

    /**
     * Register a named group of part specs. Each part is added as a top-level
     * prefab with id `<groupName>.<partId>` (or `<groupName>.<auto-hex>` when
     * the part omitted `id`). A `composite` prefab is also created at id
     * `groupName`, with the parts wired up via their `offset` for spawning.
     *
     * ```ts
     * bucket.addGroup('campfire', [
     *   { type: 'gltf', id: 'logs', src: '/logs.glb' },
     *   { type: 'cube', id: 'flame', size: 0.3, offset: { position: [0, 0.3, 0] } },
     *   { type: 'cube', size: 0.5, offset: { position: [0, 0.8, 0] } },  // auto id
     * ]);
     *
     * await bucket.load();
     *
     * bucket.get('campfire');             // composite (spawnable as one)
     * bucket.get('campfire.logs');        // the part directly
     * bucket.getGroup('campfire').prefabs; // both parts
     * ```
     */
    addGroup(name: string, parts: readonly GroupPartInput<M>[]): this {
        if (name.includes('.')) throw new Error(`PrefabBucket.addGroup: group name '${name}' is invalid - '.' is reserved for group paths`);
        if ((this as unknown as { groups: Map<string, string[]> }).groups.has(name)) {
            throw new Error(`PrefabBucket.addGroup: duplicate group '${name}'`);
        }

        const partIds: string[] = [];
        const compositeParts: { partId: string; offset?: PartOffset }[] = [];

        for (const part of parts) {
            const userId = (part as { id?: string }).id;
            if (userId !== undefined && userId.includes('.')) {
                throw new Error(`PrefabBucket.addGroup: part id '${userId}' is invalid - '.' is reserved for group paths`);
            }
            const partId = userId !== undefined
                ? `${name}.${userId}`
                : generateId({ prefix: `${name}.`, size: name.length + 1 + 8 });

            // Strip `offset` so it doesn't leak into the stored spec.
            const { offset, ...rest } = part as { offset?: PartOffset } & Record<string, unknown>;
            (this as unknown as { addUnchecked: (s: SpecForMode<M>) => unknown }).addUnchecked({ ...rest, id: partId } as SpecForMode<M>);
            partIds.push(partId);
            compositeParts.push(offset ? { partId, offset } : { partId });
        }

        // The group itself is a composite prefab at id = groupName.
        super.add({ type: 'composite', id: name, parts: compositeParts } as unknown as SpecForMode<M>);

        (this as unknown as { groups: Map<string, string[]> }).groups.set(name, partIds);
        return this;
    }

    /**
     * Look up a group registered via `addGroup`. Returns the parts in order
     * and an `asComposite()` helper that returns the composite prefab created
     * for the group (equivalent to `bucket.get(groupName)`).
     */
    getGroup(name: string): { prefabs: Prefab3D[]; asComposite(): CompositePrefab } {
        const groups = (this as unknown as { groups: Map<string, string[]> }).groups;
        const ids = groups.get(name);
        if (!ids) throw new Error(`PrefabBucket.getGroup: unknown group '${name}'`);
        const prefabs = ids.map((id) => this.get(id) as unknown as Prefab3D);
        const self = this;
        return {
            prefabs,
            asComposite: () => self.get(name) as unknown as CompositePrefab,
        };
    }
}

/**
 * Part spec accepted by `addGroup`: a regular 3D spec with `id` optional
 * (auto-generated when absent) and a new `offset` field.
 */
type GroupPartInput<M extends '2d' | '3d'> = M extends '3d'
    ? { [K in Prefab3DSpec as K['type']]: Omit<K, 'id'> & { id?: string; offset?: PartOffset } }[Prefab3DSpec['type']]
    : never;

/** Convenience aliases for explicit mode typing (e.g. function params). */
export type PrefabBucket2D<Specs extends Record<string, Prefab2DSpec> = {}> = PrefabBucket<'2d', Specs>;
export type PrefabBucket3D<Specs extends Record<string, Prefab3DSpec> = {}> = PrefabBucket<'3d', Specs>;

export type {
    CompositePrefab,
    CompositeSpec,
    CubePrefab,
    CubeSpec,
    GltfPrefab,
    GltfSpec,
    GridPrefab,
    GridSpec,
    Hitbox2D,
    Hitbox3D,
    PartOffset,
    Prefab2D,
    Prefab2DSpec,
    Prefab3D,
    Prefab3DSpec,
    PrefabFor,
    SpritesheetPrefab,
    SpritesheetSpec,
} from './specs';

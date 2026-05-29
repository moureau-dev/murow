import { Hitbox } from './hitbox';

/**
 * HitboxLibrary — a named, mode-typed registry of `Hitbox` definitions.
 *
 * The canonical set of collision archetypes a game uses, declared once in
 * shared code and read by the renderer (client picking), game logic, and a
 * headless server alike. Resolves by name (`get`, serializable/authoring)
 * or by index (`at`, for ECS components that store a numeric archetype).
 *
 * `add` accumulates the name union, so `bucket.hitboxes(lib)` can offer the
 * registered names as an autocompleting, typo-checked literal type.
 */
export class HitboxLibrary<M extends '2d' | '3d' = '3d', Names extends string = never> {
    private readonly names: string[] = [];
    private readonly boxes: Hitbox<M>[] = [];
    private readonly index = new Map<string, number>();

    constructor(readonly mode: M) {}

    /** Register a hitbox under `name`. Returns a library whose type carries the new name. */
    add<const N extends string>(name: N, hitbox: Hitbox<M>): HitboxLibrary<M, Names | N> {
        if (this.index.has(name)) throw new Error(`Hitbox '${name}' already registered`);
        this.index.set(name, this.boxes.length);
        this.names.push(name);
        this.boxes.push(hitbox);
        return this as unknown as HitboxLibrary<M, Names | N>;
    }

    /** Resolve by name. Throws on an unknown name. */
    get(name: Names): Hitbox<M> {
        const i = this.index.get(name);
        if (i === undefined) throw new Error(`Hitbox '${name}' not registered`);
        return this.boxes[i];
    }

    /** Resolve by index — the fast path for ECS components storing a numeric archetype. */
    at(index: number): Hitbox<M> {
        return this.boxes[index];
    }

    /** Numeric index for a name, for storing on an entity. Throws on an unknown name. */
    indexOf(name: Names): number {
        const i = this.index.get(name);
        if (i === undefined) throw new Error(`Hitbox '${name}' not registered`);
        return i;
    }

    /** Registered names, in insertion order. */
    keys(): readonly string[] {
        return this.names;
    }
}

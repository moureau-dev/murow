/**
 * Hitbox — a named set of collision shapes in model-local space.
 *
 * Declared once and shared across every prefab/instance that uses it. Pure
 * data: no GPU, no per-instance state. The renderer picks against it; game
 * logic and a headless server run authoritative hit tests against the same
 * object. Shapes are scaled by instance scale at test time.
 *
 * The mode parameter (`'2d'` | `'3d'`) gates which shapes `add` accepts and
 * accumulates the part-name union so consumers can narrow `hit.part`.
 */

export type Shape3D =
    | { readonly shape: 'sphere'; readonly radius: number; readonly offset?: readonly [number, number, number] }
    | { readonly shape: 'box'; readonly size: readonly [number, number, number]; readonly offset?: readonly [number, number, number] }
    | { readonly shape: 'cylinder'; readonly radius: number; readonly height: number; readonly offset?: readonly [number, number, number] };

export type Shape2D =
    | { readonly shape: 'circle'; readonly radius: number; readonly offset?: readonly [number, number] }
    | { readonly shape: 'rect'; readonly size: readonly [number, number]; readonly offset?: readonly [number, number] }
    | { readonly shape: 'capsule'; readonly radius: number; readonly length: number; readonly offset?: readonly [number, number] };

export type ShapeForMode<M extends '2d' | '3d'> = M extends '3d' ? Shape3D : Shape2D;

export type HitboxPart<M extends '2d' | '3d'> = { readonly name: string } & ShapeForMode<M>;

export class Hitbox<M extends '2d' | '3d' = '3d', Names extends string = never> {
    readonly parts: readonly HitboxPart<M>[];

    constructor(readonly mode: M, parts: readonly HitboxPart<M>[] = []) {
        this.parts = parts;
    }

    /** Add a named shape. Returns a new Hitbox whose type carries the added name. */
    add<const N extends string>(name: N, shape: ShapeForMode<M>): Hitbox<M, Names | N> {
        return new Hitbox(this.mode, [...this.parts, { name, ...shape } as HitboxPart<M>]);
    }
}

/**
 * TextureBucket — typed registry of texture resources.
 *
 * Textures are loaded from `TextureSpec` and produce `TexturePrefab`
 * instances holding the decoded `HTMLImageElement`. Use the bucket's
 * `add()`, `load()`, and `get()` lifecycle identical to PrefabBucket.
 *
 * ```ts
 * const textures = new TextureBucket()
 *   .add({ type: 'texture', id: 'brick', src: '/brick.png' })
 *   .add({ type: 'texture', id: 'wood',  src: '/wood.png' });
 *
 * await textures.load();
 * textures.get('brick');  // TexturePrefab { parsed: HTMLImageElement }
 * ```
 */

import { Bucket } from '../bucket/bucket';
import type { TexturePrefab, TextureSpec } from '../../prefab-bucket/specs';

const textureParser = async (spec: TextureSpec): Promise<TexturePrefab> => {
    const img = new Image();
    img.src = spec.src;
    await img.decode();
    return {
        type: 'texture',
        id: spec.id,
        src: spec.src,
        parsed: img,
        metadata: (spec as unknown as Record<string, unknown>).metadata as Record<string, unknown> ?? {},
        hitbox: undefined,
    } as unknown as TexturePrefab;
};

/**
 * Bucket specialised for textures. Accepts only `TextureSpec` variants,
 * returns `TexturePrefab` variants. Ids are type-narrowed so
 * `textures.get('typo')` is a compile-time error.
 */
export class TextureBucket<
    Specs extends Record<string, TextureSpec> = {},
> extends Bucket<TextureSpec, TexturePrefab, Specs> {

    constructor() {
        super({ texture: textureParser });
    }

    /**
     * Add a single texture spec. Overridden to return the subclass type so
     * chaining through AssetBucket callbacks accumulates specs.
     */
    add<const S extends TextureSpec>(
        spec: S,
    ): TextureBucket<Specs & Record<S['id'], S>> {
        return super.add(spec) as unknown as TextureBucket<Specs & Record<S['id'], S>>;
    }
}

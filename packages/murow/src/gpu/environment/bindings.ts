/**
 * Standard bind group and binding numbers.
 *
 * The engine reserves group 0 for per-view data and group 1 for material and
 * texture data. `StandardBindings` records those slots; a backend or a custom
 * material may construct an override with different numbers.
 */

/** Named parameters for `new StandardBindings(...)`. */
export interface StandardBindingsOptions {
    readonly sceneGroup?: number;
    readonly sceneBinding?: number;
    readonly lightsGroup?: number;
    readonly lightsBinding?: number;
    readonly skinnedLightsBinding?: number;
    readonly materialGroup?: number;
    readonly materialBinding?: number;
    readonly textureStart?: number;
}

/**
 * The binding slots used by the built-in shader environment.
 *
 * Scene uniforms live at group 0 binding 0. The light storage buffer lives at
 * group 0 binding 4, or binding 5 for skinned meshes. Material uniforms live at
 * group 1 binding 0, and textures begin at group 1 binding 1, one texture and
 * one sampler per pair.
 */
export class StandardBindings {
    readonly sceneGroup: number;
    readonly sceneBinding: number;
    readonly lightsGroup: number;
    readonly lightsBinding: number;
    readonly skinnedLightsBinding: number;
    readonly materialGroup: number;
    readonly materialBinding: number;
    readonly textureStart: number;

    constructor(options: StandardBindingsOptions = {}) {
        this.sceneGroup = options.sceneGroup ?? 0;
        this.sceneBinding = options.sceneBinding ?? 0;
        this.lightsGroup = options.lightsGroup ?? 0;
        this.lightsBinding = options.lightsBinding ?? 4;
        this.skinnedLightsBinding = options.skinnedLightsBinding ?? 5;
        this.materialGroup = options.materialGroup ?? 1;
        this.materialBinding = options.materialBinding ?? 0;
        this.textureStart = options.textureStart ?? 1;
    }

    /** Light buffer binding, `5` for skinned meshes and `4` otherwise. */
    lights(skinned = false): number {
        return skinned ? this.skinnedLightsBinding : this.lightsBinding;
    }

    /** Binding number of texture pair `index`: one texture then one sampler. */
    texture(index: number): number {
        return this.textureStart + index * 2;
    }
}

/** The default engine binding map. */
export const defaultBindings = new StandardBindings();

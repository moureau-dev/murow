// Core types
export * from "./types";

// Base renderer contracts (abstract)
export * from "./base/renderer";
export * from "./base/renderer-2d";
export * from "./base/renderer-3d";

// Math helpers
export * from "./math";

// glTF — parsing + skeletal animation (renderer-agnostic CPU data path)
export * from "./gltf/skin-parser";
export * from "./gltf/parser";
export { SkeletalAnimation } from "./gltf/skeletal-animation";
export type { SkeletalClip, SkeletalAnimState, PlayOptions } from "./gltf/skeletal-animation";

// Spritesheet — pure UV math + image loading
export * from "./spritesheet/helpers";
export * from "./spritesheet/parser";

// Prefab types (parsers, spec/prefab bases) + spec union
export * from "./buckets/prefab/utility";
export * from "./buckets/prefab/utility/specs";

// Buckets — typed registries (Bucket, PrefabBucket, TextureBucket, AssetBucket)
export {
    Bucket,
    PrefabBucket,
    AssetBucket,
    TextureBucket,
    type PrefabBucket2D,
    type PrefabBucket3D,
    type BucketSpecBase,
    type BucketPrefabBase,
} from "./buckets";

// Raycast — abstract pick / ray-test contract
export * from "./raycast";

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

// PrefabBucket — generic base + concrete (2D/3D) subclass with prewired parsers
export * from "./buckets/prefab/utility";
export * from "./buckets/prefab/utility/specs";
export { PrefabBucket } from "./buckets/prefab/utility/concrete";
export type { PrefabBucket2D, PrefabBucket3D } from "./buckets/prefab/utility/concrete";

// Buckets — typed registries (Bucket, PrefabBucket, TextureBucket, AssetBucket)
export {
    Bucket,
    AssetBucket,
    TextureBucket,
    type BucketSpecBase,
    type BucketPrefabBase,
} from "./buckets";

// Raycast — abstract pick / ray-test contract
export * from "./raycast";

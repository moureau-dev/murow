export {
    InstanceManager,
    type InstanceManagerDeps,
    type MainPassBatch,
    type SkinnedMainPassBatch,
} from './instances';
export { setPrefabHandle, isPrefab3D, resolvePrefabHandle } from './prefab-handle';
export { DEFAULT_INSTANCE_CAPACITY, DEFAULT_SKINNED_INSTANCE_CAPACITY } from './defaults';
export { InstanceStore, type InstanceStoreDeps } from './instance-store';
export { SkinnedInstanceStore, type SkinnedInstanceStoreDeps, type SkinModelLike } from './skinned-instance-store';
export { resolveTransform } from './transform';
export * from './offsets';

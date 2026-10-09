import type { Handles } from '../../handles';

/**
 * Placeholder material view on raw store handles. The `InstanceManager`
 * replaces it with a real, instance-bound view in `installHandle`.
 */
export const EMPTY_MATERIALS = {
    get: () => undefined,
    has: () => false,
    add: () => { /* replaced by the manager */ },
    remove: () => { /* replaced by the manager */ },
    all: [],
} as unknown as Handles.InstanceMaterials;

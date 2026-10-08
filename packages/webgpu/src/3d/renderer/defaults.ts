import { DEFAULT_INSTANCE_CAPACITY } from './managers/instances/defaults';
import { DEFAULT_MATERIAL_CAPACITY } from './managers/materials/defaults';
import { DEFAULT_LIGHT_CAPACITY } from './managers/lights/defaults';

/**
 * Default renderer-level capacities. Opt-in subsystems default to `0`, so
 * enabling them is explicit. `options` accepts a partial and merges with this.
 */
export const DEFAULT_CAPACITIES = {
    instances: DEFAULT_INSTANCE_CAPACITY,
    materials: DEFAULT_MATERIAL_CAPACITY,
    lights: DEFAULT_LIGHT_CAPACITY,
    decals: 0,
    particles: { maxEmitters: 0, maxParticles: 0 },
    shadows: { spot: 0, point: 0 },
} as const;

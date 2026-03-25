import { SystemBuilder, ExecutableSystem } from "./system-builder";
import { World } from "./world";

/**
 * Systems API for a World.
 *
 * The world extends this class to provide system building capabilities.
 *
 * **Performance Comparison** (50K entities benchmark):
 * - Raw API: 8.94ms (baseline - fastest)
 * - Hybrid API: 15.65ms (1.75x slower - recommended!)
 * - Ergonomic API: 18.79ms (2.1x slower - most convenient)
 *
 * **Recommendation:**
 * Use the hybrid API pattern (see examples below) for the best balance of
 * performance and ergonomics. It's only ~75% slower than raw while maintaining
 * the convenience of the system builder.
 */
export class WorldSystems {
  /** Registered systems that run automatically with runSystems() */
  private registeredSystems: ExecutableSystem[] = [];

  /**
   * Create a new system builder for ergonomic system definition.
   *
   * @example
   * Basic usage (ergonomic but ~2x slower):
   * ```typescript
   * world.addSystem()
   *   .query(Transform2D, Velocity)
   *   .fields([
   *     { transform: ['x', 'y'] },
   *     { velocity: ['vx', 'vy'] }
   *   ])
   *   .run((entity, deltaTime) => {
   *     entity.transform_x += entity.velocity_vx * deltaTime;
   *     entity.transform_y += entity.velocity_vy * deltaTime;
   *   });
   * ```
   *
   * @example
   * Performance mode (raw speed, still ergonomic):
   * ```typescript
   * world.addSystem()
   *   .query(Transform2D, Velocity)
   *   .fields([
   *     { transform: ['x', 'y'] },
   *     { velocity: ['vx', 'vy'] }
   *   ])
   *   .run((entity, deltaTime) => {
   *     // Destructure arrays for direct access (fast!)
   *     const {eid, transform_x_array: tx, transform_y_array: ty,
   *            velocity_vx_array: vx, velocity_vy_array: vy} = entity;
   *     tx[eid] += vx[eid] * deltaTime;
   *     ty[eid] += vy[eid] * deltaTime;
   *   });
   * ```
   */
  addSystem(): SystemBuilder {
    return new SystemBuilder(this as any as World, [], undefined, undefined);
  }

  /**
   * Run all registered systems with the given deltaTime.
   * Systems are executed in registration order.
   *
   * @param deltaTime - Time delta to pass to each system
   */
  runSystems(deltaTime: number): void {
    for (let i = 0; i < this.registeredSystems.length; i++) {
      this.registeredSystems[i]!.execute(deltaTime);
    }
  }

  /**
   * Register a system for automatic execution.
   * @internal - Called by SystemBuilder
   */
  _registerSystem(system: ExecutableSystem): void {
    this.registeredSystems.push(system);
  }
}


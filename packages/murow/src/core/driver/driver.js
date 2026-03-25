import { ImmediateDriver, RafDriver, TimeoutDriver } from "./drivers";
// Re-export driver classes for testing and direct usage
export { ImmediateDriver, RafDriver, TimeoutDriver };
/**
 * Factory function to create a loop driver for the specified environment.
 *
 * @param type - The environment type
 *   - `'client'`: Browser RAF driver (60 FPS, syncs with display)
 *   - `'server'`: Node.js setImmediate driver (maximum performance)
 *   - `'server-timeout'`: Node.js setTimeout driver (balanced with I/O)
 * @param update - Callback function invoked each frame with delta time in seconds
 * @returns A configured LoopDriver instance ready to start
 *
 * @example
 * ```typescript
 * // Client
 * const clientDriver = createDriver('client', (dt) => {
 *   game.update(dt);
 *   renderer.render();
 * });
 * clientDriver.start();
 *
 * // Server (maximum performance)
 * const serverDriver = createDriver('server', (dt) => {
 *   simulation.tick(dt);
 * });
 * serverDriver.start();
 *
 * // Server (balanced with I/O)
 * const balancedDriver = createDriver('server-timeout', (dt) => {
 *   simulation.tick(dt);
 *   handleNetworkIO();
 * });
 * balancedDriver.start();
 * ```
 */
export function createDriver(type, update) {
    if (type === 'server-immediate') {
        return new ImmediateDriver(update);
    }
    else if (type === 'server-timeout') {
        return new TimeoutDriver(update);
    }
    else {
        return new RafDriver(update);
    }
}

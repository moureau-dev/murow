import { ImmediateDriver, RafDriver, TimeoutDriver } from "./drivers";

// Re-export driver classes for testing and direct usage
export { ImmediateDriver, RafDriver, TimeoutDriver };

/**
 * Interface for game loop drivers that handle frame updates.
 * Drivers are responsible for scheduling and executing the game loop
 * at the appropriate rate for their environment (client or server).
 */
export interface LoopDriver {
    /** Starts the game loop */
    start(): void;
    /** Stops the game loop */
    stop(): void;
    /** Internal loop iteration method */
    loop(): void;
    /** Update callback invoked each frame with delta time in seconds */
    update(dt: number): void;
}

/**
 * Type of driver to use for the game loop.
 * - `'client'`: Uses requestAnimationFrame for browser environments (syncs with display refresh rate)
 * - `'server-immediate'`: Uses setImmediate for Node.js environments (runs as fast as possible, maximum performance)
 * - `'server-timeout'`: Uses setTimeout with 1ms delay for Node.js environments (balanced performance with better I/O responsiveness)
 */
export type DriverType = 'server-immediate' | 'client' | 'server-timeout';

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
export function createDriver(type: DriverType, update: (dt: number) => void) {
    if (type === 'server-immediate') {
        return new ImmediateDriver(update);
    } else if (type === 'server-timeout') {
        return new TimeoutDriver(update);
    } else {
        return new RafDriver(update);
    }
}

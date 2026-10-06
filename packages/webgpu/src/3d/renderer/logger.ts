import type { RendererLogger } from 'murow/renderer';

const NOOP_LOGGER: RendererLogger = { warn() {} };

/**
 * Resolve a renderer's `debug` option into a logger:
 * `true` -> default console logger (`[murow] …`), a `RendererLogger` -> itself,
 * `false`/undefined -> no-op.
 */
export function resolveRendererLogger(debug: boolean | RendererLogger | undefined): RendererLogger {
    if (!debug) return NOOP_LOGGER;
    if (debug === true) {
        return {
            warn(message, details) {
                if (details) console.warn(`[murow] ${message}`, details);
                else console.warn(`[murow] ${message}`);
            },
            info(message, details) {
                if (details) console.info(`[murow] ${message}`, details);
                else console.info(`[murow] ${message}`);
            },
        };
    }
    return debug;
}

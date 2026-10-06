/**
 * Minimal logging contract for renderer diagnostics. Implement it to route
 * Murow's development warnings into your own logger; pass `true` where a
 * renderer accepts a `debug` option to use the default console logger.
 */
export interface RendererLogger {
    /** Non-fatal diagnostic. `details` carries structured context. */
    warn(message: string, details?: Record<string, unknown>): void;
    /** Optional informational channel. */
    info?(message: string, details?: Record<string, unknown>): void;
}

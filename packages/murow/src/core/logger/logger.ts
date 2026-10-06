export type LoggerLevel = 'warn' | 'info' | 'error';

/** Destination for log records. The default writes to the console. */
export type LoggerSink = (level: LoggerLevel, message: string, details?: Record<string, unknown>) => void;

export interface LoggerOptions {
    /** Tag prepended by the default console sink. Default `'murow'`. */
    readonly prefix?: string;
    /** Custom sink. Defaults to the console. */
    readonly sink?: LoggerSink;
}

function consoleSink(prefix: string): LoggerSink {
    const tag = `[${prefix}]`;
    return (level, message, details) => {
        const text = `${tag} ${message}`;
        const write = level === 'error' ? console.error : level === 'info' ? console.info : console.warn;
        if (details) write(text, details);
        else write(text);
    };
}

/**
 * Structured logger shared across Murow. Defaults to the console tagged with
 * `[prefix]`; pass a `sink` to route records elsewhere, or subclass and
 * override `warn`/`info`/`error`.
 *
 * ```ts
 * const log = new Logger();                       // [murow] …
 * const quiet = Logger.none;                      // discards
 * const log2 = Logger.resolve(debugOption);       // boolean | Logger -> Logger
 * ```
 */
export class Logger {
    /** A logger that discards every record. */
    static readonly none: Logger = new Logger({ sink: () => {} });

    readonly prefix: string;
    private readonly sink: LoggerSink;

    constructor(options: LoggerOptions = {}) {
        this.prefix = options.prefix ?? 'murow';
        this.sink = options.sink ?? consoleSink(this.prefix);
    }

    /** Non-fatal diagnostic. `details` carries structured context. */
    warn(message: string, details?: Record<string, unknown>): void {
        this.sink('warn', message, details);
    }

    /** Informational record. */
    info(message: string, details?: Record<string, unknown>): void {
        this.sink('info', message, details);
    }

    /** Error record. */
    error(message: string, details?: Record<string, unknown>): void {
        this.sink('error', message, details);
    }

    /**
     * Resolve a `debug` option into a logger: `true` builds a console logger,
     * a `Logger` is returned as-is, `false`/`undefined` yields `Logger.none`.
     */
    static resolve(debug: boolean | Logger | undefined, prefix = 'murow'): Logger {
        if (!debug) return Logger.none;
        if (debug === true) return new Logger({ prefix });
        return debug;
    }
}

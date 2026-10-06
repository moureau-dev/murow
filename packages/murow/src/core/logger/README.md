# Logger

Structured logging shared across Murow. One class, defaulting to console output.

```ts
import { Logger } from 'murow/core';

const log = new Logger();                 // [murow] …  -> console
log.warn('particle pool saturated', { maxParticles: 4096 });

const net = new Logger({ prefix: 'net' });          // [net] …
const send = new Logger({ sink: (level, msg, data) => telemetry[level](msg, data) });
const quiet = Logger.none;                           // discards
const resolved = Logger.resolve(debugOption);        // boolean | Logger -> Logger
```

- `new Logger({ prefix?, sink? })` — `prefix` tags the default console output; `sink(level, message, details?)` routes records elsewhere. Subclass and override `warn`/`info`/`error` for anything richer.
- `Logger.none` — a shared no-op logger.
- `Logger.resolve(debug, prefix?)` — `true` → console logger, `Logger` → itself, `false`/`undefined` → `Logger.none`. Use it to accept a `debug?: boolean | Logger` option.

`details` is passed as structured data (not string-concatenated) so sinks can treat it as metadata.

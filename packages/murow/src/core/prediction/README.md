# Prediction (PredictionLog + Reconciler)

Client-side rollback-replay for optimistic, authority-corrected simulation. Record commands you applied locally; when an authority confirms up to a sequence, restore its state, drop the confirmed commands, and replay the rest on top.

Domain-agnostic: the command type, how to restore authoritative state, and how to replay a command are all supplied by the caller. The classic use is server-authoritative multiplayer (local input prediction), but the pattern fits any optimistic-then-corrected flow.

## Features

- `PredictionLog`: a bounded, sequence-ordered log of unconfirmed commands.
- `Reconciler`: restore -> drop confirmed -> replay the rest, via callbacks.
- Bounded history: the oldest commands are dropped past the buffer size.
- Generic over the command and a per-reconcile context; zero dependencies.

## Usage

```typescript
import { Reconciler } from './prediction';

const reconciler = new Reconciler<MoveCmd, ServerSnapshot>({
    bufferSize: 64,
    restore: (snapshot) => world.loadAuthoritative(snapshot),  // rewind to server state
    replay: (cmds) => cmds.forEach((c) => applyMove(c)),       // re-apply unconfirmed input
});

// As you send input, record what you applied locally.
reconciler.record(sequence, moveCmd);

// When an authoritative snapshot arrives, reconcile against the confirmed sequence.
function onSnapshot(snapshot: ServerSnapshot) {
    reconciler.reconcile(snapshot.ackSequence, snapshot);
}
```

## API

### PredictionLog

- `record(sequence, cmd)`: append a command (pushed in ascending sequence).
- `dropThrough(sequence)`: drop every entry with sequence <= the confirmed one.
- `pending()`: the still-unconfirmed commands, in order.
- `size`, `clear()`.

### Reconciler

- `record(sequence, cmd)`: track a locally-applied command.
- `reconcile(ackSequence, ctx)`: run `restore(ctx)`, drop commands <= `ackSequence`, then `replay(pending, ctx)`.
- `pending`: count of unconfirmed commands.
- `clear()`.

## Notes

`reconcile` always calls `restore` then `replay` (even when nothing is pending), so consumers can rely on the callbacks firing once per snapshot. The context passed to `reconcile` is handed to both callbacks unchanged, which is the place to carry per-snapshot data (the authoritative state, which entities were reset, the confirmed tick).

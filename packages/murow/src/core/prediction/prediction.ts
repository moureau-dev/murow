/**
 * Bounded, sequence-ordered log of locally-applied commands awaiting
 * confirmation. Records are pushed in ascending sequence; `dropThrough`
 * removes everything the authority has confirmed.
 */
export class PredictionLog<Cmd> {
    private entries: { sequence: number; cmd: Cmd }[] = [];

    constructor(private capacity: number = 64) {}

    get size(): number {
        return this.entries.length;
    }

    /** Record a command with its sequence. Commands must be recorded in ascending sequence. */
    record(sequence: number, cmd: Cmd): void {
        this.entries.push({ sequence, cmd });
        while (this.entries.length > this.capacity) this.entries.shift();
    }

    /** Drop every entry with sequence <= the confirmed sequence. */
    dropThrough(sequence: number): void {
        let cut = 0;
        while (cut < this.entries.length && this.entries[cut].sequence <= sequence) cut++;
        if (cut > 0) this.entries.splice(0, cut);
    }

    /** The commands still awaiting confirmation, in order. */
    pending(): Cmd[] {
        const out = new Array<Cmd>(this.entries.length);
        for (let i = 0; i < this.entries.length; i++) out[i] = this.entries[i].cmd;
        return out;
    }

    clear(): void {
        this.entries.length = 0;
    }
}

export interface ReconcilerOptions<Cmd, Ctx> {
    /** Max unconfirmed commands kept; older ones are dropped. Default 64. */
    bufferSize?: number;
    /** Load authoritative state. Runs before confirmed commands are dropped. */
    restore: (ctx: Ctx) => void;
    /** Re-apply the still-unconfirmed commands on top of the restored state. */
    replay: (cmds: Cmd[], ctx: Ctx) => void;
}

/**
 * Client-side rollback-replay: record locally-applied commands, and when the
 * authority confirms up to a sequence, restore its state, drop the confirmed
 * commands, and replay the rest. Domain-agnostic; the caller supplies what a
 * command is, how to restore, and how to replay via callbacks.
 */
export class Reconciler<Cmd, Ctx = void> {
    private log: PredictionLog<Cmd>;
    private restore: (ctx: Ctx) => void;
    private replay: (cmds: Cmd[], ctx: Ctx) => void;

    constructor(opts: ReconcilerOptions<Cmd, Ctx>) {
        this.log = new PredictionLog<Cmd>(opts.bufferSize ?? 64);
        this.restore = opts.restore;
        this.replay = opts.replay;
    }

    record(sequence: number, cmd: Cmd): void {
        this.log.record(sequence, cmd);
    }

    get pending(): number {
        return this.log.size;
    }

    clear(): void {
        this.log.clear();
    }

    reconcile(ackSequence: number, ctx: Ctx): void {
        this.restore(ctx);
        this.log.dropThrough(ackSequence);
        this.replay(this.log.pending(), ctx);
    }
}

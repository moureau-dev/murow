/**
 * Bounded, sequence-ordered log of locally-applied commands awaiting
 * confirmation. Records are pushed in ascending sequence; `dropThrough`
 * removes everything the authority has confirmed.
 */
export class PredictionLog<Cmd> {
    /** Live window is `[head, sequences.length)`. Parallel arrays: no per-record object. */
    private sequences: number[] = [];
    private cmds: Cmd[] = [];
    private head = 0;
    /** Reused return buffer for `pending()` — valid only until the next call. */
    private readonly scratch: Cmd[] = [];

    constructor(private capacity: number = 64) {}

    get size(): number {
        return this.sequences.length - this.head;
    }

    /** Record a command with its sequence. Commands must be recorded in ascending sequence. */
    record(sequence: number, cmd: Cmd): void {
        this.sequences.push(sequence);
        this.cmds.push(cmd);
        if (this.sequences.length - this.head > this.capacity) {
            this.head++;
            this.reclaim();
        }
    }

    /** Drop every entry with sequence <= the confirmed sequence. */
    dropThrough(sequence: number): void {
        const len = this.sequences.length;
        while (this.head < len && this.sequences[this.head]! <= sequence) this.head++;
        this.reclaim();
    }

    /**
     * The commands still awaiting confirmation, in order. The returned array is
     * internal and reused across calls — do not retain it.
     */
    pending(): Cmd[] {
        const out = this.scratch;
        out.length = 0;
        for (let i = this.head; i < this.cmds.length; i++) out.push(this.cmds[i]!);
        return out;
    }

    clear(): void {
        this.sequences.length = 0;
        this.cmds.length = 0;
        this.head = 0;
    }

    /** Drop the consumed prefix; reset when everything is consumed. */
    private reclaim(): void {
        if (this.head === 0) return;
        if (this.head === this.sequences.length) {
            this.clear();
        } else if (this.head >= 64) {
            this.sequences.splice(0, this.head);
            this.cmds.splice(0, this.head);
            this.head = 0;
        }
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

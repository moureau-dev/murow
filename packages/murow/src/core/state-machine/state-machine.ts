import { SlotStore } from "../slot-map";
import { EventSystem } from "../events";
import { SimpleRNG } from "../simple-rng";
import type { Field } from "../binary-codec";

const DEFAULT_SEED = 0x6d7572;
const MAX_STATES = 256;

type Schema = Record<string, Field<any>>;
type StatesSpec = Record<string, Schema>;

type FieldValue<F> = F extends Field<infer T, any> ? T : never;
type SchemaValues<Sc extends Schema> = { -readonly [K in keyof Sc]: FieldValue<Sc[K]> };
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;
type StateFields<S extends StatesSpec> = UnionToIntersection<{ [K in keyof S]: SchemaValues<S[K]> }[keyof S]>;

/**
 * Per-entity cursor over the machine's columns. Reused for the entity's
 * lifetime; reading a field returns that entity's value, writing sets it.
 */
export type Handle<S extends StatesSpec> = HandleBase<S> & StateFields<S>;

interface HandleBase<S extends StatesSpec> {
    readonly id: number;
    readonly state: keyof S & string;
    readonly stateId: number;
    readonly ticksInState: number;
    is(state: keyof S & string): boolean;
    change(to: (keyof S & string) | number, payload?: number): void;
}

interface Handlers<H> {
    enter?(handle: H, payload: number): void;
    update?(handle: H): void;
    exit?(handle: H): void;
}

interface ChangeEvent {
    id: number;
    from: number;
    to: number;
}

type ChangeEvents = [["change", ChangeEvent]];

interface StateMachineOptions<S extends StatesSpec> {
    initial: keyof S & string;
    states: S;
    capacity?: number;
    maxId?: number;
    rng?: SimpleRNG;
}

interface Column {
    field: Field<any>;
    dv: DataView;
    size: number;
}

/**
 * Fixed-capacity, zero-GC state machine over many entities. State and
 * per-state data live in binary columns indexed by a stable slot; one machine
 * definition drives every entity. Behavior is registered per state with `add`
 * and runs during `tick`. Depends only on `SlotStore`, `EventSystem`,
 * `SimpleRNG`, and `BinaryCodec` fields.
 */
export class StateMachine<S extends StatesSpec> {
    /** State name to numeric id. */
    readonly id: { readonly [K in keyof S & string]: number };
    readonly rng: SimpleRNG;
    /** Transition channel, emitted whenever any entity changes state. */
    readonly events = new EventSystem<ChangeEvents>({ events: ["change"] });

    private readonly names: (keyof S & string)[];
    private readonly initialId: number;
    private readonly store: SlotStore<number, any>;
    private readonly stateCol: Uint8Array;
    private readonly prevCol: Uint8Array;
    private readonly enteredCol: Uint32Array;
    private readonly cols: Record<string, Column>;
    private readonly fieldsByState: string[][];
    private readonly enterFns: ((handle: any, payload: number) => void)[][];
    private readonly updateFns: ((handle: any) => void)[][];
    private readonly exitFns: ((handle: any) => void)[][];
    private readonly Handle: new (id: number) => Handle<S>;

    private now = 0;
    private ticking = false;
    private readonly dead: number[] = [];
    private readonly ev: ChangeEvent = { id: 0, from: 0, to: 0 };

    constructor(opts: StateMachineOptions<S>) {
        this.rng = opts.rng ?? new SimpleRNG(DEFAULT_SEED);
        const capacity = opts.capacity ?? 1024;

        this.names = Object.keys(opts.states) as (keyof S & string)[];
        if (this.names.length > MAX_STATES) {
            throw new Error(`StateMachine: at most ${MAX_STATES} states (got ${this.names.length})`);
        }

        const id = {} as Record<keyof S & string, number>;
        this.names.forEach((n, i) => (id[n] = i));
        this.id = id;
        this.initialId = id[opts.initial];

        this.store = new SlotStore(capacity, opts.maxId ?? capacity);
        this.stateCol = new Uint8Array(capacity);
        this.prevCol = new Uint8Array(capacity);
        this.enteredCol = new Uint32Array(capacity);

        this.cols = {};
        this.fieldsByState = [];
        for (const name of this.names) {
            const sid = id[name];
            const schema = opts.states[name];
            const fields = Object.keys(schema);
            this.fieldsByState[sid] = fields;
            for (const f of fields) {
                if (this.cols[f]) continue;
                const field = schema[f];
                this.cols[f] = {
                    field,
                    dv: new DataView(new ArrayBuffer(capacity * field.size)),
                    size: field.size,
                };
            }
        }

        this.enterFns = this.names.map(() => []);
        this.updateFns = this.names.map(() => []);
        this.exitFns = this.names.map(() => []);
        this.Handle = this.buildHandle();
    }

    /** Number of live entities. */
    get size(): number {
        return this.store.size;
    }

    /**
     * Register behavior for a state. Cumulative: calling `add` again for the
     * same state appends another set of handlers. Returns the machine for
     * chaining.
     */
    add(state: keyof S & string, handlers: Handlers<Handle<S>>): this {
        const sid = this.id[state];
        if (handlers.enter) this.enterFns[sid].push(handlers.enter);
        if (handlers.update) this.updateFns[sid].push(handlers.update);
        if (handlers.exit) this.exitFns[sid].push(handlers.exit);
        return this;
    }

    /** Register an entity by id, in the initial state. Returns its handle. */
    spawn(id: number): Handle<S> {
        const handle = new this.Handle(id) as any;
        const slot = this.store.add(id, handle);
        handle._slot = slot;
        this.stateCol[slot] = this.prevCol[slot] = this.initialId;
        this.enteredCol[slot] = this.now;
        const enters = this.enterFns[this.initialId];
        for (let i = 0; i < enters.length; i++) enters[i](handle, 0);
        return handle;
    }

    /** The handle for `id`, or `null` if absent. */
    of(id: number): Handle<S> | null {
        return this.store.get(id);
    }

    has(id: number): boolean {
        return this.store.has(id);
    }

    /** Remove an entity. Deferred to the end of the pass if called during `tick`. */
    remove(id: number): void {
        if (this.ticking) {
            this.dead.push(id);
            return;
        }
        this.store.remove(id);
    }

    /**
     * Advance every entity by one step. Runs the current state's `update`
     * handlers in registration order; the first that transitions ends that
     * entity's chain for this step.
     */
    tick(): void {
        this.now++;
        this.ticking = true;
        this.store.forEach(this.step);
        this.ticking = false;

        if (this.dead.length) {
            for (let i = 0; i < this.dead.length; i++) this.store.remove(this.dead[i]);
            this.dead.length = 0;
        }
    }

    /**
     * Write an entity's state id and current-state fields into `dv` at
     * `offset`. Returns the offset past the written bytes.
     */
    serialize(id: number, dv: DataView, offset: number): number {
        const slot = this.store.slotOf(id);
        let o = offset;
        const sid = this.stateCol[slot];
        dv.setUint8(o, sid);
        o += 1;
        const fields = this.fieldsByState[sid];
        for (let i = 0; i < fields.length; i++) {
            const c = this.cols[fields[i]];
            c.field.write(dv, o, c.field.read(c.dv, slot * c.size));
            o += c.size;
        }
        return o;
    }

    /**
     * Load an entity's state id and fields from `dv` at `offset`, re-anchoring
     * its `ticksInState`. Returns the offset past the read bytes.
     */
    restore(id: number, dv: DataView, offset: number): number {
        const slot = this.store.slotOf(id);
        let o = offset;
        const sid = dv.getUint8(o);
        o += 1;
        this.stateCol[slot] = sid;
        this.enteredCol[slot] = this.now;
        const fields = this.fieldsByState[sid];
        for (let i = 0; i < fields.length; i++) {
            const c = this.cols[fields[i]];
            c.field.write(c.dv, slot * c.size, c.field.read(dv, o));
            o += c.size;
        }
        return o;
    }

    /** Serialized byte size of an entity in its current state. */
    byteSize(id: number): number {
        const slot = this.store.slotOf(id);
        const fields = this.fieldsByState[this.stateCol[slot]];
        let size = 1;
        for (let i = 0; i < fields.length; i++) size += this.cols[fields[i]].size;
        return size;
    }

    private readonly step = (handle: any, _id: number, slot: number): void => {
        const before = this.stateCol[slot];
        const updates = this.updateFns[before];
        for (let i = 0; i < updates.length; i++) {
            updates[i](handle);
            if (this.stateCol[slot] !== before) break;
        }
    };

    private transition(handle: any, to: number, payload: number): void {
        const slot = handle._slot;
        const from = this.stateCol[slot];
        if (to === from) return;

        const exits = this.exitFns[from];
        for (let i = 0; i < exits.length; i++) exits[i](handle);

        this.prevCol[slot] = from;
        this.stateCol[slot] = to;
        this.enteredCol[slot] = this.now;

        const enters = this.enterFns[to];
        for (let i = 0; i < enters.length; i++) enters[i](handle, payload);

        this.ev.id = handle.id;
        this.ev.from = from;
        this.ev.to = to;
        this.events.emit("change", this.ev);
    }

    private buildHandle(): new (id: number) => Handle<S> {
        const sm = this;

        class H {
            _slot = -1;
            constructor(public readonly id: number) {}

            get state(): string {
                return sm.names[sm.stateCol[this._slot]];
            }
            get stateId(): number {
                return sm.stateCol[this._slot];
            }
            get ticksInState(): number {
                return sm.now - sm.enteredCol[this._slot];
            }
            is(state: string): boolean {
                return sm.stateCol[this._slot] === sm.id[state as keyof S & string];
            }
            change(to: string | number, payload = 0): void {
                sm.transition(this, typeof to === "number" ? to : sm.id[to as keyof S & string], payload);
            }
        }

        for (const name in this.cols) {
            const c = this.cols[name];
            Object.defineProperty(H.prototype, name, {
                get(this: { _slot: number }) {
                    return c.field.read(c.dv, this._slot * c.size);
                },
                set(this: { _slot: number }, v: unknown) {
                    c.field.write(c.dv, this._slot * c.size, v);
                },
                enumerable: true,
            });
        }

        return H as unknown as new (id: number) => Handle<S>;
    }
}

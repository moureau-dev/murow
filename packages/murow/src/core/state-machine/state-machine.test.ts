import { describe, test, expect } from "bun:test";
import { StateMachine } from "./state-machine";
import { u8, u32 } from "../binary-codec";

function makeMachine() {
    return new StateMachine({
        initial: "idle",
        capacity: 16,
        states: {
            idle: { pending: u8 },
            casting: { abilityId: u8, startedTick: u32 },
            recovery: { until: u32 },
        },
    });
}

describe("StateMachine", () => {
    test("spawns in the initial state with a typed handle", () => {
        const sm = makeMachine();
        const e = sm.spawn(0);
        expect(e.state).toBe("idle");
        expect(e.id).toBe(0);
        expect(e.is("idle")).toBe(true);
        expect(e.ticksInState).toBe(0);
    });

    test("update transitions on read input; first transition wins", () => {
        const sm = makeMachine()
            .add("idle", {
                update: (e) => {
                    if (e.pending) {
                        e.abilityId = e.pending;
                        e.pending = 0;
                        e.change("casting");
                    }
                },
            })
            .add("idle", { update: (e) => { e.pending = 99; } });

        const e = sm.spawn(0);
        e.pending = 5;
        sm.tick();

        expect(e.state).toBe("casting");
        expect(e.abilityId).toBe(5);
    });

    test("change carries a numeric payload to enter", () => {
        const sm = makeMachine().add("recovery", {
            enter: (e, until) => { e.until = until; },
        });
        const e = sm.spawn(0);
        e.change("recovery", 42);
        expect(e.state).toBe("recovery");
        expect(e.until).toBe(42);
    });

    test("enter and exit run on transition", () => {
        const order: string[] = [];
        const sm = makeMachine()
            .add("idle", { exit: () => order.push("exit-idle") })
            .add("casting", { enter: () => order.push("enter-casting") });
        sm.spawn(0).change("casting");
        expect(order).toEqual(["exit-idle", "enter-casting"]);
    });

    test("cumulative handlers run in registration order", () => {
        const order: number[] = [];
        const sm = makeMachine()
            .add("idle", { update: () => order.push(1) })
            .add("idle", { update: () => order.push(2) })
            .add("idle", { update: () => order.push(3) });
        sm.spawn(0);
        sm.tick();
        expect(order).toEqual([1, 2, 3]);
    });

    test("ticksInState counts ticks since entering", () => {
        const sm = makeMachine();
        const e = sm.spawn(0);
        sm.tick();
        sm.tick();
        sm.tick();
        expect(e.ticksInState).toBe(3);
    });

    test("emits change with id, from, to", () => {
        const sm = makeMachine();
        let captured: any = null;
        sm.events.on("change", (ev) => { captured = { ...ev }; });
        sm.spawn(0).change("casting");
        expect(captured).toEqual({ id: 0, from: sm.id.idle, to: sm.id.casting });
    });

    test("a handler may remove its entity mid-tick without breaking the pass", () => {
        const sm = makeMachine()
            .add("idle", { update: (e) => { if (e.id === 0) sm.remove(0); seen.push(e.id); } });
        const seen: number[] = [];
        sm.spawn(0);
        sm.spawn(1);
        sm.spawn(2);
        sm.tick();
        expect(seen).toContain(1);
        expect(seen).toContain(2);
        expect(sm.has(0)).toBe(false);
        expect(sm.size).toBe(2);
    });

    test("serialize then restore round-trips state and fields", () => {
        const a = makeMachine().add("recovery", { enter: (e, until) => { e.until = until; } });
        const ea = a.spawn(0);
        ea.change("recovery", 1234);

        const buf = new DataView(new ArrayBuffer(a.byteSize(0)));
        a.serialize(0, buf, 0);

        const b = makeMachine();
        const eb = b.spawn(0);
        b.restore(0, buf, 0);

        expect(eb.state).toBe("recovery");
        expect(eb.until).toBe(1234);
    });

    test("of returns the handle, null when absent", () => {
        const sm = makeMachine();
        sm.spawn(3);
        expect(sm.of(3)?.id).toBe(3);
        expect(sm.of(9)).toBeNull();
    });
});

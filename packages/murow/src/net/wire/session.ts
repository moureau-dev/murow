/**
 * Generic session identity: token creation, resume, and bounded hold on
 * disconnect. It knows nothing about entities or game state.
 */

import { generateId } from 'murow/core';
import { SlotMap } from 'murow/core/slot-map';

interface HeldSession<T> {
    token: string;
    data: T;
    timer: ReturnType<typeof setTimeout>;
}

/** Options for {@link SessionRegistry}. */
export interface SessionRegistryOptions {
    /** Maximum simultaneously held sessions. Default 1024. */
    capacity?: number;
}

/** Arguments for {@link SessionRegistry.hold}. */
export interface HoldSessionOptions<T> {
    /** Token issued to the client. */
    readonly token: string;
    /** State to resume with. */
    readonly data: T;
    /** How long the session stays resumable. */
    readonly graceMs: number;
    /** Called when the hold expires or the pool is full. */
    readonly onExpire: () => void;
}

/**
 * Token registry for resumable peers.
 *
 * A live peer's token is not stored; only a disconnected peer's session is
 * held for a grace period so a reconnect can resume it. Held sessions live in
 * a `SlotMap`; `resume` scans the held set (a cold, small path) and compares
 * the token. No string-keyed Map is used.
 */
export class SessionRegistry<T> {
    private readonly slots: SlotMap;
    private readonly sessions: (HeldSession<T> | null)[];

    constructor(options: SessionRegistryOptions = {}) {
        const capacity = options.capacity ?? 1024;
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new Error(`SessionRegistry: capacity must be a positive integer (got ${capacity})`);
        }
        this.slots = new SlotMap(capacity);
        this.sessions = new Array<HeldSession<T> | null>(capacity).fill(null);
    }

    /** Create a fresh token. The session is not held until `hold` is called. */
    createToken(): string {
        return generateId();
    }

    /**
     * Take a held session by token. Clears its expiry timer.
     * @returns the held data, or `undefined` when the token is unknown/expired.
     */
    resume(token: string): T | undefined {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            const session = this.sessions[slot]!;
            if (session.token !== token) continue;
            clearTimeout(session.timer);
            this.sessions[slot] = null;
            this.slots.remove(slot);
            return session.data;
        }
        return undefined;
    }

    /**
     * Hold a disconnected peer's session for `graceMs`. A non-positive grace
     * calls `onExpire` immediately. When the hold pool is full, the session is
     * not held and `onExpire` is called immediately.
     */
    hold(options: HoldSessionOptions<T>): void {
        const { token, data, graceMs, onExpire } = options;
        if (graceMs <= 0) {
            onExpire();
            return;
        }
        const slot = this.slots.add();
        if (slot === -1) {
            onExpire();
            return;
        }
        const timer = setTimeout(() => {
            this.sessions[slot] = null;
            this.slots.remove(slot);
            onExpire();
        }, graceMs);
        this.sessions[slot] = { token, data, timer };
    }

    /** Drop every held session and clear its timer. */
    clear(): void {
        const active = this.slots.activeSlots;
        const size = this.slots.size;
        for (let i = 0; i < size; i++) {
            const slot = active[i]!;
            const session = this.sessions[slot];
            if (session !== null) clearTimeout(session.timer);
            this.sessions[slot] = null;
        }
        this.slots.clear();
    }
}

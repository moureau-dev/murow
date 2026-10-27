/**
 * Packet helpers.
 *
 * A packet is one encoded wire message: a leading kind byte followed by an
 * optional payload. The helpers are allocation-free for reading; `packet` and
 * `packetU32` allocate only on the cold paths that build a new message.
 */

/** Build a packet from a kind and an optional payload. */
export function packet(kind: number, payload?: Uint8Array): Uint8Array {
    if (payload === undefined || payload.length === 0) return new Uint8Array([kind]);
    const out = new Uint8Array(payload.length + 1);
    out[0] = kind;
    out.set(payload, 1);
    return out;
}

/** Build a packet from a kind and a little-endian u32. */
export function packetU32(kind: number, value: number): Uint8Array {
    const out = new Uint8Array(5);
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, value >>> 0, true);
    return out;
}

/** Kind byte, or 0 when the packet is empty. */
export function packetType(data: Uint8Array): number {
    return data[0] ?? 0;
}

/** Payload view after the kind byte. Reuses the input buffer. */
export function packetPayload(data: Uint8Array): Uint8Array {
    return data.subarray(1);
}

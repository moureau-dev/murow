/**
 * Wire message kinds.
 *
 * The leading byte of every packet selects one of these. Server and client
 * ranges are separate so a direction mismatch is a protocol error rather than
 * a silent reinterpretation.
 */

/** Server -> client message kinds. */
export const ServerMessage = {
    Snapshot: 0x80,
    Rpc: 0x81,
    Kick: 0x82,
    AssignEntity: 0x84,
    Schema: 0x85,
    Session: 0x86,
    Custom: 0x87,
    SyncComplete: 0x88,
    Outcome: 0x89,
} as const;

/** Client -> server message kinds. */
export const ClientMessage = {
    Intent: 0x01,
    Rpc: 0x02,
    KickAck: 0x03,
    Resume: 0x04,
    Message: 0x05,
    SyncAck: 0x06,
} as const;

export type ServerMessageKind = (typeof ServerMessage)[keyof typeof ServerMessage];
export type ClientMessageKind = (typeof ClientMessage)[keyof typeof ClientMessage];

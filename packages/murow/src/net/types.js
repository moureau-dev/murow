/**
 * Core networking types for transport-agnostic multiplayer game networking
 */
/**
 * Message type identifiers for protocol discrimination
 */
export var MessageType;
(function (MessageType) {
    /** Client -> Server: Intent/command */
    MessageType[MessageType["INTENT"] = 1] = "INTENT";
    /** Server -> Client: State snapshot */
    MessageType[MessageType["SNAPSHOT"] = 2] = "SNAPSHOT";
    /** Bidirectional: Heartbeat/ping */
    MessageType[MessageType["HEARTBEAT"] = 3] = "HEARTBEAT";
    /** Bidirectional: Custom application message */
    MessageType[MessageType["CUSTOM"] = 255] = "CUSTOM";
})(MessageType || (MessageType = {}));
/**
 * Message priority levels for send queue
 */
export var MessagePriority;
(function (MessagePriority) {
    /** Lowest priority - can be dropped if queue is full (e.g., chat) */
    MessagePriority[MessagePriority["LOW"] = 0] = "LOW";
    /** Normal priority - most game messages (e.g., movement) */
    MessagePriority[MessagePriority["NORMAL"] = 1] = "NORMAL";
    /** High priority - important events (e.g., damage, scoring) */
    MessagePriority[MessagePriority["HIGH"] = 2] = "HIGH";
    /** Critical priority - never drop (e.g., connection control) */
    MessagePriority[MessagePriority["CRITICAL"] = 3] = "CRITICAL";
})(MessagePriority || (MessagePriority = {}));

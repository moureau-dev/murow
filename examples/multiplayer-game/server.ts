import { ServerNetwork, BunWebSocketServerTransport, createDriver } from "murow";

import {
    Simulation,
    createIntentRegistry,
    createSnapshotRegistry,
    Intents,
    WS_PORT as PORT,
    type GameStateUpdate,
    createRpcRegistry,
    RPCs,
} from "./shared";

const HTTP_PORT = 3008;

class GameServer {
    simulation: Simulation<'server-timeout'>;
    network: ServerNetwork<any, GameStateUpdate>;
    private playerIds: Map<string, string> = new Map(); // Map peerId to playerId
    private pendingIntents: Map<string, Intents.Move[]> = new Map(); // Buffer intents per peer

    constructor() {
        this.simulation = new Simulation('server-timeout');

        // Pre-tick: Apply all buffered intents before stepping
        this.simulation.loop.events.on('pre-tick', () => {
            for (const [peerId, intents] of this.pendingIntents) {
                const playerId = this.playerIds.get(peerId);
                if (!playerId) continue;

                if (intents.length === 0) continue;

                // Use the intent with the HIGHEST tick number (not the latest to arrive)
                // This handles out-of-order packet arrival correctly
                const highestTickIntent = intents.reduce((highest, current) =>
                    current.tick > highest.tick ? current : highest
                );

                // Debug: log if we received multiple intents
                if (intents.length > 1) {
                    const ticks = intents.map(i => i.tick).sort((a, b) => a - b);
                    console.log(`Peer ${peerId.substring(0, 8)}: buffered ${intents.length} intents with ticks [${ticks}], using highest: ${highestTickIntent.tick}`);
                }

                this.simulation.applyVelocity(playerId, highestTickIntent);
            }
            this.pendingIntents.clear();
        });

        // Tick: Step the simulation
        this.simulation.loop.events.on('tick', ({ deltaTime }) => {
            this.simulation.step(deltaTime);
        });

        this.simulation.loop.events.on('post-tick', ({ tick }) => {
            // Send snapshots to all peers (only if game state changed)
            const gameState = this.simulation.getSnapshot();
            let peersToUpdate = 0;

            for (const peerId of this.network.getPeerIds()) {
                // Get the last confirmed tick for Move intents (used for reconciliation)
                const confirmedClientTick = this.network.getConfirmedClientTick(peerId, Intents.Move.kind);

                // sendSnapshotToPeerIfChanged automatically detects changes using hash comparison
                if (this.network.sendSnapshotToPeerIfChanged(peerId, 'gameState', {
                    tick: confirmedClientTick, // Client tick for reconciliation
                    updates: gameState,
                })) {
                    peersToUpdate++;
                }
            }
        });

        // Create transport
        const transport = BunWebSocketServerTransport.create(PORT);

        // Create network with intents and snapshots
        this.network = new ServerNetwork({
            transport,
            intentRegistry: createIntentRegistry(),
            rpcRegistry: createRpcRegistry(),
            createPeerSnapshotRegistry: createSnapshotRegistry,
            config: {
                debug: false,
                heartbeatInterval: 100000,  // Send heartbeat every 10 seconds
                heartbeatTimeout: 45000,   // Timeout after 45 seconds of no messages
                maxMessagesPerSecond: 0,
                maxMessageSize: 1024 * 1024, // 1 MB
                maxSendQueueSize: 5 * 1024 * 1024, // 5 MB
            },
        });

        this.setupNetworkHandlers();
    }

    setupNetworkHandlers() {
        // Handle new player connections
        this.network.onConnection((peerId) => {
            console.log(`Player connected: ${peerId}`);
            // Don't spawn here - wait for SpawnPlayer RPC from client
        });

        // Handle player disconnections
        this.network.onDisconnection((peerId) => {
            console.log(`Player disconnected: ${peerId}`);
            const playerId = this.playerIds.get(peerId);
            if (!playerId) {
                // Player never spawned, just clean up
                this.pendingIntents.delete(peerId);
                return;
            }

            this.simulation.remove(playerId);
            this.playerIds.delete(peerId);
            this.pendingIntents.delete(peerId);
            // Note: ServerNetwork automatically cleans up internal state (including lastProcessedClientTick)
        });

        // Handle spawn RPC
        this.network.onRPC(RPCs.SpawnPlayer, (peerId, rpc) => {
            console.log(`RPC SpawnPlayer received from peer=${peerId.substring(0, 8)} with id=${rpc.id}`);

            // Spawn player with client-provided ID
            const { x, y, color } = this.simulation.spawn(rpc.id);
            this.playerIds.set(peerId, rpc.id);

            // Broadcast PlayerSpawned to ALL peers (including the requester)
            for (const targetPeerId of this.network.getPeerIds()) {
                this.network.sendRPC(
                    targetPeerId,
                    RPCs.PlayerSpawned,
                    {
                        id: rpc.id,
                        x,
                        y,
                        color,
                    },
                );
            }

            // Send initial game state to the new player
            const gameState = this.simulation.getSnapshot();
            this.network.sendSnapshotToPeer(peerId, 'gameState', {
                tick: 0, // No client ticks confirmed yet
                updates: gameState,
            });
        });

        // Handle move intents - buffer them for processing during tick
        this.network.onIntent(Intents.Move, (peerId, intent) => {
            const playerId = this.playerIds.get(peerId);
            if (!playerId) return; // Player not spawned yet

            // Buffer intent for processing during next pre-tick event
            if (!this.pendingIntents.has(peerId)) {
                this.pendingIntents.set(peerId, []);
            }
            this.pendingIntents.get(peerId)!.push(intent);
        }, (peerId, intent) => { // intent validation
            // drop intents from non-spawned players
            if (!this.playerIds.has(peerId)) return false;

            // drop invalid intents
            if (typeof intent.vx !== 'number' || typeof intent.vy !== 'number') return false;
            if (Math.abs(intent.vx) > 1 || Math.abs(intent.vy) > 1) return false;
            if (intent.tick < 0) return false;

            // Use a sliding window for tick validation
            // This smooths the server simulation by dropping very stale/future intents
            const lastConfirmedTick = this.network.getConfirmedClientTick(peerId, intent.kind);
            const backwardTolerance = 8; // Allow up to 8 ticks behind (~666ms at 12Hz)
            const forwardTolerance = 3;   // Allow up to 3 ticks ahead (~250ms at 12Hz)

            // Reject intents that are too old
            if (intent.tick < lastConfirmedTick - backwardTolerance) {
                return false;
            }

            // Reject intents that are too far in the future
            if (intent.tick > lastConfirmedTick + forwardTolerance) {
                return false;
            }

            // Accept the intent - network layer will automatically update lastProcessedClientTick for this intent kind
            return true;
        });
    }

    start() {
        console.log(`Game server starting on port ${PORT}...`);
        console.log(`WebSocket endpoint: ws://mococa:${PORT}`);
        console.log(`HTTP server starting on port ${HTTP_PORT}...`);
        console.log(`Open http://mococa:${HTTP_PORT} in your browser to play!`);

        // Start HTTP server to serve the client
        this.startHttpServer();

        // Game loop using server driver
        this.simulation.loop.start();
    }

    startHttpServer() {
        Bun.serve({
            port: HTTP_PORT,
            async fetch(req) {
                const url = new URL(req.url);

                // Serve the client HTML file
                if (url.pathname === '/' || url.pathname === '/index.html') {
                    const file = Bun.file('./client.html');
                    return new Response(file, {
                        headers: {
                            'Content-Type': 'text/html',
                        },
                    });
                }

                // Serve the bundled client JS
                if (url.pathname === '/client.js') {
                    const file = Bun.file('./client.js');
                    return new Response(file, {
                        headers: {
                            'Content-Type': 'application/javascript',
                        },
                    });
                }

                return new Response('Not Found', { status: 404 });
            },
        });
    }
}

// Start the server
const server = new GameServer();
server.start();

import {
    ClientNetwork,
    generateId,
    InputSnapshot,
    lerp,
    Reconciliator,
} from "murow";

import { BrowserWebSocketClientTransport } from "murow/net/adapters/browser-websocket";
import {
    Simulation,
    Intents,
    GameStateUpdate,
    createIntentRegistry,
    createSnapshotRegistry,
    PLAYER_SIZE,
    WORLD_WIDTH,
    WORLD_HEIGHT,
    WS_PORT,
    createRpcRegistry,
    RPCs,
} from "./shared";

/* ================================
   Client
================================ */

export class GameClient {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;

    network!: ClientNetwork<GameStateUpdate>;
    simulation: Simulation<'client'>;

    myId: string | null = null;
    connected = false;

    keys: Record<string, boolean> = {};
    lastSnapshotTick = 0;
    lastPeerSnapshotTicks: Map<string, number> = new Map(); // Track last snapshot tick per peer

    reconciler: Reconciliator<Intents.Move, GameStateUpdate>;

    // Snapshot buffer for entity interpolation (render in the past for smoothness)
    snapshotBuffer: Array<{ serverTime: number; receiveTime: number; state: GameStateUpdate }> = [];
    readonly RENDER_DELAY = 0; // Render 200ms behind (ensures we always have snapshots to interpolate)

    // Error smoothing for own player
    positionError = { x: 0, y: 0 };
    readonly errorSmoothingFactor = 0.1; // Smooth out prediction errors quickly
    positionBeforeReconciliation = { x: 0, y: 0 };
    readonly maxCorrectionPerFrame = 10; // Max pixels to correct per frame (prevents snapping)

    // Interpolation for own player
    myPreviousPosition = { x: 0, y: 0 };
    lastTickTime = 0;
    shouldInterpolate = false;

    constructor() {
        this.canvas = document.getElementById("gameCanvas") as HTMLCanvasElement;
        this.ctx = this.canvas.getContext("2d")!;

        this.simulation = new Simulation('client');

        // Hook into pre-tick to store position before tick processing
        this.simulation.loop.events.on('pre-tick', () => {
            // Store position and timestamp before tick for interpolation
            const myPlayer = this.simulation.players.get(this.myId!);
            if (myPlayer) {
                this.myPreviousPosition.x = myPlayer.x;
                this.myPreviousPosition.y = myPlayer.y;
                this.lastTickTime = performance.now();
                this.shouldInterpolate = true;
            }
        });

        // Hook into tick event to apply input and send intents
        this.simulation.loop.events.on('tick', ({ tick, deltaTime, input }) => this.tick(tick, deltaTime, input));

        this.simulation.loop.events.on('render', ({ alpha }) => this.render(alpha))

        // Temporary variables for reconciliation
        let tempServerX = 0;
        let tempServerY = 0;

        this.reconciler = new Reconciliator({
            onLoadState: (state) => {
                const myPlayer = this.simulation.players.get(this.myId!);
                if (myPlayer && this.myId) {
                    this.positionBeforeReconciliation.x = myPlayer.x;
                    this.positionBeforeReconciliation.y = myPlayer.y;
                }

                // Extract server position without applying it
                const serverState = state.find((p: any) => p.id === this.myId);
                if (serverState) {
                    tempServerX = serverState.x;
                    tempServerY = serverState.y;
                }

                this.loadSnapshot(state);
            },
            onReplay: (intents) => {
                if (!this.myId) return;
                const myPlayer = this.simulation.players.get(this.myId);
                if (!myPlayer) return;

                // Save current visual position
                const visualX = myPlayer.x;
                const visualY = myPlayer.y;

                // Apply server state and replay
                myPlayer.x = tempServerX;
                myPlayer.y = tempServerY;
                myPlayer.vx = 0;
                myPlayer.vy = 0;

                for (const intent of intents) {
                    this.simulation.applyVelocity(this.myId, intent);
                    this.simulation.step();
                }

                // Calculate error
                const errorX = visualX - myPlayer.x;
                const errorY = visualY - myPlayer.y;
                const errorMagnitude = Math.hypot(errorX, errorY);

                if (errorMagnitude > 0.5) {
                    // Cap the maximum error to prevent large snaps during lag spikes
                    const maxError = 50; // Max 50px error accumulation
                    if (errorMagnitude > maxError) {
                        const scale = maxError / errorMagnitude;
                        this.positionError.x = errorX * scale;
                        this.positionError.y = errorY * scale;
                    } else {
                        this.positionError.x = errorX;
                        this.positionError.y = errorY;
                    }

                    if (errorMagnitude > 20) {
                        console.warn(`Prediction error: ${errorMagnitude.toFixed(2)}px (capped if >50px)`);
                    }
                }

                // DON'T update myPreviousPosition or lastTickTime here
                // Let the normal tick event handle that, otherwise we disrupt interpolation
            },
        });

        this.setupInput();
        this.connect();
    }

    /* ================================
       Networking
    ================================ */

    connect() {
        const transport = new BrowserWebSocketClientTransport(`ws://mococa:${WS_PORT}`);

        const intentRegistry = createIntentRegistry();

        this.network = new ClientNetwork({
            transport,
            intentRegistry,
            snapshotRegistry: createSnapshotRegistry(),
            rpcRegistry: createRpcRegistry(),
            config: {
                debug: false,
                heartbeatInterval: 0,
                maxSendQueueSize: 1024 * 1024, // 1 MB
                maxMessagesPerSecond: 0,
                lagSimulation: { min: 0, max: 400 }, // for testing
            },
        });

        this.network.onConnect(() => {
            this.connected = true;
            console.log('connected.');

            const id = generateId({ prefix: 'player_', size: 16 });
            this.myId = id;
            this.network.sendRPC(RPCs.SpawnPlayer, { id });
            this.start();
        });

        this.network.onRPC(RPCs.PlayerSpawned, (rpc) => {
            if (!this.simulation.players.has(rpc.id)) {
                console.log(`RPC SpawnPlayer received for id=${rpc.id}`);
                const player = this.simulation.spawn(rpc.id);
                player.x = rpc.x;
                player.y = rpc.y;
                player.color = rpc.color;
            }

            if (rpc.id === this.myId) {
                console.log(`Spawned own player with id=${rpc.id}`);
            }
        });

        this.network.onSnapshot("gameState", (snapshot) => {
            if (!snapshot.updates) return;

            // Reject old snapshots that arrive out of order (due to variable network lag)
            if (snapshot.tick < this.lastSnapshotTick) {
                console.log(`Rejecting old snapshot: tick ${snapshot.tick} (last: ${this.lastSnapshotTick})`);
                return;
            }
            this.lastSnapshotTick = snapshot.tick;

            const now = performance.now();

            // Add snapshot to buffer with both server time (tick-based) and receive time
            this.snapshotBuffer.push({
                serverTime: snapshot.tick * (1000 / 12), // Convert tick to milliseconds (12Hz = 83.33ms per tick)
                receiveTime: now,
                state: snapshot.updates as GameStateUpdate,
            });

            // Keep only last 1 second of snapshots
            const cutoff = now - 1000;
            this.snapshotBuffer = this.snapshotBuffer.filter(s => s.receiveTime > cutoff);

            this.reconciler.onSnapshot({
                tick: snapshot.tick,
                state: snapshot.updates as GameStateUpdate,
            });
        });
    }

    /* ================================
       Input
    ================================ */

    setupInput() {
        window.addEventListener("keydown", e => {
            this.keys[e.key.toLowerCase()] = true;
        });

        window.addEventListener("keyup", e => {
            this.keys[e.key.toLowerCase()] = false;
        });
    }

    readInput() {
        let vx = 0;
        let vy = 0;

        if (this.keys["w"] || this.keys["arrowup"]) vy -= 1;
        if (this.keys["s"] || this.keys["arrowdown"]) vy += 1;
        if (this.keys["a"] || this.keys["arrowleft"]) vx -= 1;
        if (this.keys["d"] || this.keys["arrowright"]) vx += 1;

        return { vx, vy };
    }

    /* ================================
       Game Loop
    ================================ */

    start() {
        this.simulation.loop.start();
    }

    tick(tick: number, deltaTime: number, input: InputSnapshot) {
        if (!this.connected || !this.myId) return;
        const moveKeys = ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
        let vx = 0, vy = 0;
        for (const key of moveKeys) {
            if (input.keys[key]?.down) {
                if (key === 'ArrowUp') vy = -1;
                if (key === 'ArrowLeft') vx = -1;
                if (key === 'ArrowRight') vx = 1;
                if (key === 'ArrowDown') vy = 1;
            }
        }

        // Create intent
        const intent: Intents.Move = {
            kind: Intents.Move.kind,
            tick,
            vx,
            vy,
        };

        // Send intent to server and track locally
        this.network.sendIntent(intent);
        this.reconciler.trackIntent(tick, intent);

        // Apply client-side prediction (must match replay logic)
        this.simulation.applyVelocity(this.myId, intent);
        this.simulation.step(deltaTime);
    }

    /* ================================
       Snapshot Handling
    ================================ */

    loadSnapshot(state: GameStateUpdate) {
        for (const p of state) {
            let player = this.simulation.players.get(p.id);

            if (!player) {
                // Spawn new player from server snapshot
                player = this.simulation.spawn(p.id);
            }

            if (p.id === this.myId) {
                // For own player: only update on first spawn
                if (player.x === 0 && player.y === 0) {
                    player.x = p.x;
                    player.y = p.y;
                }
            } else {
                // For peers: update from authoritative server state
                // Rendering will handle interpolation using snapshot buffer
                player.x = p.x;
                player.y = p.y;
            }

            player.color = p.color;
        }
    }

    /* ================================
       Rendering
    ================================ */

    renderGrid() {
        this.ctx.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
        this.ctx.fillStyle = '#0f3460';
        this.ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

        this.ctx.strokeStyle = 'rgba(78, 205, 196, 0.1)';
        this.ctx.lineWidth = 1;
        for (let x = 0; x < WORLD_WIDTH; x += 50) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, WORLD_HEIGHT);
            this.ctx.stroke();
        }
        for (let y = 0; y < WORLD_HEIGHT; y += 50) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(WORLD_WIDTH, y);
            this.ctx.stroke();
        }
    }

    renderPlayers(alpha: number) {
        const now = performance.now();

        for (const [playerId, player] of this.simulation.players) {
            let x = player.x;
            let y = player.y;

            if (playerId === this.myId) {
                // Own player: client-side prediction with interpolation and error correction
                if (this.shouldInterpolate) {
                    // Interpolate base position between ticks
                    x = lerp(this.myPreviousPosition.x, player.x, alpha);
                    y = lerp(this.myPreviousPosition.y, player.y, alpha);
                } else {
                    // No interpolation - use current position directly
                    x = player.x;
                    y = player.y;
                }

                // Apply error correction on top
                x += this.positionError.x;
                y += this.positionError.y;

                // Gradually reduce the error over time (exponential decay)
                this.positionError.x *= (1 - this.errorSmoothingFactor);
                this.positionError.y *= (1 - this.errorSmoothingFactor);

                // Clear tiny errors to prevent floating point drift
                if (Math.abs(this.positionError.x) < 0.01) this.positionError.x = 0;
                if (Math.abs(this.positionError.y) < 0.01) this.positionError.y = 0;
            } else {
                // Other players: time-delayed entity interpolation
                if (this.snapshotBuffer.length >= 2) {
                    // Find the newest snapshot that's old enough (arrived at least RENDER_DELAY ms ago)
                    let renderSnapshot = null;
                    let nextSnapshot = null;

                    for (let i = this.snapshotBuffer.length - 1; i >= 0; i--) {
                        if (now - this.snapshotBuffer[i].receiveTime >= this.RENDER_DELAY) {
                            renderSnapshot = this.snapshotBuffer[i];
                            // Find the next newer snapshot for interpolation
                            if (i + 1 < this.snapshotBuffer.length) {
                                nextSnapshot = this.snapshotBuffer[i + 1];
                            }
                            break;
                        }
                    }

                    if (renderSnapshot && nextSnapshot) {
                        // Interpolate between these two snapshots
                        const fromPlayer = renderSnapshot.state.find(p => p.id === playerId);
                        const toPlayer = nextSnapshot.state.find(p => p.id === playerId);

                        if (fromPlayer && toPlayer) {
                            // How far are we into the interval between these two snapshots?
                            const elapsed = now - renderSnapshot.receiveTime - this.RENDER_DELAY;
                            const interval = nextSnapshot.receiveTime - renderSnapshot.receiveTime;
                            const alpha = Math.min(elapsed / interval, 1.0);

                            x = lerp(fromPlayer.x, toPlayer.x, alpha);
                            y = lerp(fromPlayer.y, toPlayer.y, alpha);
                        }
                    } else if (renderSnapshot) {
                        // Only have one snapshot old enough, use it directly
                        const snapPlayer = renderSnapshot.state.find(p => p.id === playerId);
                        if (snapPlayer) {
                            x = snapPlayer.x;
                            y = snapPlayer.y;
                        }
                    }
                    // else: no snapshots old enough yet, use fallback (reconciled position)
                }
            }

            this.ctx.fillStyle = player.color;
            this.ctx.beginPath();
            this.ctx.arc(x, y, PLAYER_SIZE / 2, 0, Math.PI * 2);
            this.ctx.fill();

            if (playerId === this.myId) {
                this.ctx.strokeStyle = '#fff';
                this.ctx.lineWidth = 3;
                this.ctx.stroke();
            }

            this.ctx.fillStyle = '#fff';
            this.ctx.font = '10px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText(playerId.substring(0, 8), x, y - PLAYER_SIZE);
        }
    }

    renderDebugInfo() {
        this.ctx.fillStyle = '#4ECDC4';
        this.ctx.font = '16px Arial';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(`Players: ${this.simulation.players.size}`, 10, 20);
        this.ctx.fillText(`My ID: ${this.myId ? this.myId.substring(0, 12) : 'none'}`, 10, 40);
        this.ctx.fillText(`Tick: ${this.simulation.loop.ticker.tickCount}`, 10, 60);
    }

    render(alpha: number) {
        this.renderGrid();
        this.renderPlayers(alpha);
        this.renderDebugInfo();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new GameClient();
});

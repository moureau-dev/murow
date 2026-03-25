import { DriverType, EventSystem, FixedTicker } from "../../core";
import { InputManager } from "../../core/input";
/**
 * GameLoop class that manages the main game loop with tick events and optional rendering.
 * It supports both client and server types, emitting appropriate events for both.
 */
export declare class GameLoop<T extends DriverType | Manual = DriverType> {
    options: GameLoopOptions & {
        type: T;
    };
    private _driver?;
    private _input;
    private readonly _isClient;
    private readonly _isManual;
    /**
     * FixedTicker instance that handles tick timing and updates.
     */
    ticker: FixedTicker;
    /**
     * Event emitter system for the game loop, emitting various lifecycle events.
     */
    events: EventSystem<T extends ClientLike ? ClientEvents : ServerEvents>;
    /**
     * Current frames per second (FPS) measurement.
     */
    fps: number;
    /**
     * Current status of the game loop: 'running', 'paused', or 'stopped'.
     */
    status: "running" | "paused" | "stopped";
    constructor(options: GameLoopOptions & {
        type: T;
    });
    step(deltaTime: number): void;
    /**
     * Pauses the game ticker and emits a 'toggle-pause' event.
     */
    pause(): void;
    /**
     * Resumes the game ticker and emits a 'toggle-pause' event.
     */
    resume(): void;
    /**
     * Starts the game ticker and emits a 'start' event.
     */
    start(): void;
    /**
     * Stops the game ticker and emits a 'stop' event.
     */
    stop(): void;
}
interface GameLoopOptions {
    tickRate: number;
    type: DriverType | Manual;
    onTick?: (dt: number, tick: number, input: ReturnType<InputManager["snapshot"]>) => void;
    onRender?: (dt: number, alpha: number, input: ReturnType<InputManager["peek"]>) => void;
}
type BaseEvents = [
    [
        "start",
        {
            /**
             * Timestamp when the loop was started.
             */
            startedAt: number;
        }
    ],
    [
        "pre-tick",
        {
            /**
             * Current tick number.
             */
            tick: number;
            /**
             * Delta time since the last tick.
             */
            deltaTime: number;
            /**
             * Input snapshot at the start of the tick.
             *
             * **Only available in client loops.**
             */
            input: ReturnType<InputManager["snapshot"]>;
        }
    ],
    [
        "tick",
        {
            /**
             * Current tick number.
             */
            tick: number;
            /**
             * Delta time since the last tick.
             */
            deltaTime: number;
            /**
             * Input snapshot at the start of the tick.
             *
             * **Only available in client loops.**
             */
            input: ReturnType<InputManager["snapshot"]>;
        }
    ],
    [
        "post-tick",
        {
            /**
             * Current tick number.
             */
            tick: number;
            /**
             * Delta time since the last tick.
             */
            deltaTime: number;
            /**
             * Input snapshot at the start of the tick.
             *
             * **Only available in client loops.**
             */
            input: ReturnType<InputManager["snapshot"]>;
        }
    ],
    [
        "skip",
        {
            /**
             * Number of ticks that were skipped.
             */
            ticks: number;
        }
    ],
    [
        "stop",
        {
            /**
             * Timestamp when the loop was stopped.
             */
            stoppedAt: number;
        }
    ],
    [
        "toggle-pause",
        {
            /**
             * Current paused state of the loop.
             */
            paused: boolean;
            /**
             * Timestamp when the pause state was last toggled.
             */
            lastToggledAt: number;
            /**
             * Tick number when the pause state was last toggled.
             */
            lastToggleTick: number;
        }
    ]
];
type ClientEvents = [
    ...BaseEvents,
    [
        "render",
        {
            deltaTime: number;
            alpha: number;
            input: ReturnType<InputManager["peek"]>;
        }
    ]
];
type ServerEvents = BaseEvents;
type Manual = "manual-client" | "manual-server";
type ClientLike = "client" | "manual-client";
export {};

import {
    createDriver,
    DriverType,
    EventSystem,
    FixedTicker,
    LoopDriver,
} from "../../core";
import { InputManager, BrowserInputSource, type InputSnapshot } from "../../core/input";

/**
 * GameLoop class that manages the main game loop with tick events and optional rendering.
 * It supports both client and server types, emitting appropriate events for both.
 */
export class GameLoop<T extends GameLoopType = DriverType> {
    private _driver?: LoopDriver;
    private _input: InputManager;
    private readonly _isClient: boolean;
    private readonly _isManual: boolean;

    /**
     * FixedTicker instance that handles tick timing and updates.
     */
    ticker: FixedTicker;
    /**
     * Event emitter system for the game loop, emitting various lifecycle events.
     */
    events: EventSystem<BaseEvents> & T extends ClientLike ? EventSystem<ClientEvents> : EventSystem<ServerEvents>;
    /**
     * Current frames per second (FPS) measurement.
     */
    fps: number = 0;
    /**
     * Current status of the game loop: 'running', 'paused', or 'stopped'.
     */
    status: "running" | "paused" | "stopped" = "stopped";

    // Pre-allocated event data objects — mutated before each emit, zero GC
    private _tickData = { deltaTime: 0, tick: 0, input: null as InputSnapshot };
    private _skipData = { ticks: 0 };
    private _renderData = { deltaTime: 0, alpha: 0, input: null as InputSnapshot };

    constructor(public options: GameLoopOptions<T>) {
        const CLIENT_TYPES = new Set<GameLoopType>([
            "client",
            "manual-client",
        ]);

        const MANUAL_TYPES = new Set<GameLoopType>([
            "manual-client",
            "manual-server",
        ]);

        this._isClient = CLIENT_TYPES.has(this.options.type);
        this._isManual = MANUAL_TYPES.has(this.options.type);

        const eventNames = [
            "pre-tick",
            "tick",
            "post-tick",
            "skip",
            "start",
            "stop",
            "toggle-pause",
        ];

        if (this._isClient) {
            eventNames.push("render");
        }

        this.events = new EventSystem<EventsFor<T>>({
            events: eventNames,
        });

        // yes, instanciated on server but it is innofensive
        this._input = new InputManager();

        const baseEvents = this.events as EventSystem<BaseEvents>;

        this.ticker = new FixedTicker({
            rate: this.options.tickRate,
            onTick: (dt, tick = 0) => {
                const input = this._input.snapshot();

                // Reuse the same object for all three tick events because I'm a freak
                this._tickData.deltaTime = dt;
                this._tickData.tick = tick;
                this._tickData.input = input;


                baseEvents.emit("pre-tick", this._tickData);
                this.options.onTick?.(dt, tick, input);
                baseEvents.emit("tick", this._tickData);
                baseEvents.emit("post-tick", this._tickData);
            },
            onTickSkipped: (skippedTicks) => {
                this._skipData.ticks = skippedTicks;
                baseEvents.emit("skip", this._skipData);
            },
        });

        if (!this._isManual) {
            this._driver = createDriver(
                this.options.type as DriverType,
                (dt: number) => {
                    this.step(dt);
                },
            );
        }
    }

    step(deltaTime: number) {
        this.ticker.tick(deltaTime);
        this.fps = 1 / deltaTime;

        if (this._isClient) {
            const peek = this._input.peek();
            const alpha = this.ticker.alpha;

            this.options.onRender?.(deltaTime, alpha, peek);

            this._renderData.deltaTime = deltaTime;
            this._renderData.alpha = alpha;
            this._renderData.input = peek;
            (this.events as EventSystem<ClientEvents>).emit("render", this._renderData);
        }
    }

    /**
     * Pauses the game ticker and emits a 'toggle-pause' event.
     */
    pause() {
        if (this._driver) {
            this._driver.stop();
        }

        this.status = "paused";
        (this.events as EventSystem<BaseEvents>).emit("toggle-pause", {
            paused: true,
            lastToggledAt: Date.now(),
            lastToggleTick: this.ticker.tickCount,
        });
    }

    /**
     * Resumes the game ticker and emits a 'toggle-pause' event.
     */
    resume() {
        if (this._driver) {
            this._driver.start();
        }

        this.status = "running";
        (this.events as EventSystem<BaseEvents>).emit("toggle-pause", {
            paused: false,
            lastToggledAt: Date.now(),
            lastToggleTick: this.ticker.tickCount,
        });
    }

    /**
     * Starts the game ticker and emits a 'start' event.
     */
    start() {
        if (this._driver) {
            this._driver.start();
        }

        this.status = "running";
        (this.events as EventSystem<BaseEvents>).emit("start", { startedAt: Date.now() });

        if (this._isClient) {
            const source = new BrowserInputSource(document, document.body);
            this._input.listen(source);
        }
    }

    /**
     * Stops the game ticker and emits a 'stop' event.
     */
    stop() {
        if (this._driver) {
            this._driver.stop();
        }

        this.ticker.resetTickCount();
        this.status = "stopped";
        (this.events as EventSystem<BaseEvents>).emit("stop", { stoppedAt: Date.now() });

        if (this._isClient) {
            this._input.unlisten();
        }
    }
}

interface GameLoopOptions<T extends GameLoopType> {
    tickRate: number;
    type: T;
    onTick?: (
        dt: number,
        tick: number,
        input: ReturnType<InputManager["snapshot"]>,
    ) => void;
    onRender?: (
        dt: number,
        alpha: number,
        input: ReturnType<InputManager["peek"]>,
    ) => void;
}

type BaseEvents = [
    [
        "start",
        {
            /**
             * Timestamp when the loop was started.
             */
            startedAt: number;
        },
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
        },
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
        },
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
        },
    ],
    [
        "skip",
        {
            /**
             * Number of ticks that were skipped.
             */
            ticks: number;
        },
    ],
    [
        "stop",
        {
            /**
             * Timestamp when the loop was stopped.
             */
            stoppedAt: number;
        },
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
        },
    ],
];

type ClientEvents = [
    ...BaseEvents,
    [
        "render",
        {
            deltaTime: number;
            alpha: number;
            input: ReturnType<InputManager["peek"]>;
        },
    ],
];

type ServerEvents = BaseEvents;

type Manual = "manual-client" | "manual-server";
type ClientLike = "client" | "manual-client";
type EventsFor<T> = T extends ClientLike ? ClientEvents : ServerEvents;

export type GameLoopType = DriverType | Manual;

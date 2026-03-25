import { createDriver, EventSystem, FixedTicker, } from "../../core";
import { InputManager, BrowserInputSource } from "../../core/input";
/**
 * GameLoop class that manages the main game loop with tick events and optional rendering.
 * It supports both client and server types, emitting appropriate events for both.
 */
export class GameLoop {
    constructor(options) {
        this.options = options;
        /**
         * Current frames per second (FPS) measurement.
         */
        this.fps = 0;
        /**
         * Current status of the game loop: 'running', 'paused', or 'stopped'.
         */
        this.status = "stopped";
        const CLIENT_TYPES = new Set([
            "client",
            "manual-client",
        ]);
        const MANUAL_TYPES = new Set([
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
        this.events = new EventSystem({
            events: eventNames,
        });
        this._input = new InputManager();
        this.ticker = new FixedTicker({
            rate: this.options.tickRate,
            onTick: (dt, tick = 0) => {
                /** Input snapshot (mutates). Always the same in the server-side */
                const input = this._input.snapshot();
                this.events.emit("pre-tick", { deltaTime: dt, tick, input });
                this.options.onTick?.(dt, tick, input);
                this.events.emit("tick", { deltaTime: dt, tick, input });
                this.events.emit("post-tick", { deltaTime: dt, tick, input });
            },
            onTickSkipped: (skippedTicks) => {
                this.events.emit("skip", { ticks: skippedTicks });
            },
        });
        if (!this._isManual) {
            this._driver = createDriver(this.options.type, (dt) => {
                this.step(dt);
            });
        }
    }
    step(deltaTime) {
        this.ticker.tick(deltaTime);
        this.fps = 1 / deltaTime;
        if (this._isClient) {
            const peek = this._input.peek();
            const alpha = this.ticker.alpha;
            this.options.onRender?.(deltaTime, alpha, peek);
            this.events.emit("render", {
                deltaTime,
                alpha,
                input: peek,
            });
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
        this.events.emit("toggle-pause", {
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
        this.events.emit("toggle-pause", {
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
        this.events.emit("start", { startedAt: Date.now() });
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
        this.events.emit("stop", { stoppedAt: Date.now() });
        if (this._isClient) {
            this._input.unlisten();
        }
    }
}

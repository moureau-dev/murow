/**
 * Abstract base for all renderers. Provides lifecycle and canvas management.
 */
import type { ClearColor, RendererOptions } from "./types";

export abstract class BaseRenderer<TOptions extends RendererOptions = RendererOptions> {
    readonly canvas: HTMLCanvasElement;
    protected readonly options: TOptions;
    protected _clearColor: ClearColor;
    protected _width: number = 0;
    protected _height: number = 0;
    protected _initialized: boolean = false;

    constructor(canvas: HTMLCanvasElement, options: TOptions) {
        this.canvas = canvas;
        this.options = options;
        this._clearColor = options.clearColor ?? [0, 0, 0, 1];
    }

    get clearColor(): ClearColor { return this._clearColor; }
    set clearColor(value: ClearColor) { this._clearColor = value; }

    get width(): number { return this._width; }
    get height(): number { return this._height; }
    get initialized(): boolean { return this._initialized; }

    abstract init(): Promise<void>;
    abstract render(alpha: number): void;
    abstract destroy(): void;
}

export type InputHandlers = {
    keydown: (e: KeyboardEvent) => void;
    keyup: (e: KeyboardEvent) => void;

    mousemove: (e: MouseEvent) => void;
    mousedown: (e: MouseEvent) => void;
    mouseup: (e: MouseEvent) => void;

    wheel: (e: WheelEvent) => void;

    swipe: (direction: 'up' | 'down' | 'left' | 'right') => void;
    pinch: (scale: number) => void;
};

export interface InputEventSource {
    attach(handlers: InputHandlers): void;
    detach(): void;
}

export type ButtonState = {
    down: boolean;
    hit: boolean;
    released: boolean;
};

export type Vector2 = {
    x: number;
    y: number;
};

export type InputSnapshot = {
    keys: Record<string, ButtonState>;
    mouse: {
        position: Vector2;
        delta: { position: Vector2, scroll: Vector2 };
        left: ButtonState;
        middle: ButtonState;
        right: ButtonState;
    };
};

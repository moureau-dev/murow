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

export type InputSnapshot = {
    keys: Record<string, ButtonState>;
    mouse: {
        position: { x: number; y: number };
        delta: { position: { x: number; y: number }, scroll: { x: number; y: number } };
        left: ButtonState;
        middle: ButtonState;
        right: ButtonState;
    };
};

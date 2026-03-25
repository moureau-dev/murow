import { InputHandlers, InputEventSource } from "../types";
export declare class BrowserInputSource implements InputEventSource {
    private keyboardTarget;
    private mouseTarget;
    private handlers;
    constructor(keyboardTarget: Document | Window, mouseTarget: HTMLElement);
    attach(h: InputHandlers): void;
    detach(): void;
}

import { InputHandlers, InputEventSource } from "../types";

export class BrowserInputSource implements InputEventSource {
    private handlers!: InputHandlers;

    constructor(
        private keyboardTarget: Document | Window,
        private mouseTarget: HTMLElement
    ) { }

    attach(h: InputHandlers) {
        if (this.handlers) {
            this.detach();
        }

        this.handlers = h;

        this.keyboardTarget.addEventListener('keydown', h.keydown);
        this.keyboardTarget.addEventListener('keyup', h.keyup);

        this.mouseTarget.addEventListener('pointermove', h.mousemove);
        this.mouseTarget.addEventListener('pointerdown', h.mousedown);
        this.mouseTarget.addEventListener('pointerup', h.mouseup);
        this.mouseTarget.addEventListener('pointercancel', h.mouseup);
        this.mouseTarget.addEventListener('wheel', h.wheel);
    }

    detach() {
        const h = this.handlers;
        if (!h) return;

        this.keyboardTarget.removeEventListener('keydown', h.keydown);
        this.keyboardTarget.removeEventListener('keyup', h.keyup);

        this.mouseTarget.removeEventListener('pointermove', h.mousemove);
        this.mouseTarget.removeEventListener('pointerdown', h.mousedown);
        this.mouseTarget.removeEventListener('pointerup', h.mouseup);
        this.mouseTarget.removeEventListener('pointercancel', h.mouseup);
        this.mouseTarget.removeEventListener('wheel', h.wheel);
    }
}

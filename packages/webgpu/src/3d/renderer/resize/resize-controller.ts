export type ApplyResize = (
    width: number,
    height: number,
    cssWidth: number,
    cssHeight: number,
) => void;

export type ResizeObserverFactory = (callback: ResizeObserverCallback) => ResizeObserver;

/**
 * ResizeController — tracks the canvas element size and notifies listeners.
 * The renderer supplies an `apply` callback for the GPU-side reactions
 * (canvas backing size, context reconfigure, camera aspect, depth texture).
 */
export class ResizeController {
    private observer: ResizeObserver | null = null;
    private readonly callbacks: ((width: number, height: number) => void)[] = [];
    private width = 0;
    private height = 0;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly apply: ApplyResize,
        private readonly createObserver: ResizeObserverFactory = (callback) => new ResizeObserver(callback),
    ) {}

    start(width: number, height: number): void {
        this.width = width;
        this.height = height;

        const supportsDevicePixelBox = (() => {
            try {
                const ro = this.createObserver(() => {});
                ro.observe(document.body, { box: 'device-pixel-content-box' });
                ro.disconnect();
                return true;
            } catch {
                return false;
            }
        })();

        this.observer = this.createObserver((entries) => {
            for (const entry of entries) {
                let w: number;
                let h: number;
                if (supportsDevicePixelBox && entry.devicePixelContentBoxSize?.[0]) {
                    w = entry.devicePixelContentBoxSize[0].inlineSize;
                    h = entry.devicePixelContentBoxSize[0].blockSize;
                } else {
                    const box = entry.contentBoxSize[0];
                    const dpr = devicePixelRatio;
                    w = Math.round(box.inlineSize * dpr);
                    h = Math.round(box.blockSize * dpr);
                }

                if (w === this.width && h === this.height) continue;
                this.width = w;
                this.height = h;

                const cssBox = entry.contentBoxSize?.[0];
                const cssW = cssBox ? cssBox.inlineSize : w;
                const cssH = cssBox ? cssBox.blockSize : h;
                this.apply(w, h, cssW, cssH);

                for (const cb of this.callbacks) {
                    cb(w, h);
                }
            }
        });

        this.observer.observe(
            this.canvas,
            supportsDevicePixelBox ? { box: 'device-pixel-content-box' } : undefined,
        );
    }

    onResize(callback: (width: number, height: number) => void): void {
        this.callbacks.push(callback);
    }

    disconnect(): void {
        this.observer?.disconnect();
        this.observer = null;
        this.callbacks.length = 0;
    }
}

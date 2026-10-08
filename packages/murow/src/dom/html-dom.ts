/**
 * World-anchored HTML overlays: DOM elements that follow a 3D (or 2D) world
 * point, projected by a renderer each frame. Use it for nameplates, health bars
 * and damage numbers, where CSS gives you the look for free.
 *
 * DOM only, no GPU: the renderer supplies the projection, this module owns the
 * element pool, per-frame positioning and recycling.
 */

/**
 * Anything that can project a world point to the canvas. Both the 2D and 3D
 * renderers implement it, so `HTMLDom` is backend-agnostic.
 */
export interface Projector {
    /**
     * Project a world point. Writes `[x, y, depth]` into `out` as CSS pixels and
     * a positive depth, and returns `false` when the point is behind the camera.
     */
    worldToScreen(x: number, y: number, z: number, out: Float32Array): boolean;
}

export interface HtmlDomOptions {
    /** The renderer (or anything with `worldToScreen`). */
    renderer: Projector;
    /** Max live nodes across every overlay. Oldest are evicted. Default 32. */
    budget?: number;
    /** Element the nodes are appended to. Defaults to a full-screen layer. */
    container?: HTMLElement;
    /** Depth at which a node renders at 1x. Default 16. */
    referenceDepth?: number;
    /** Scale clamp. Default `0.35`. */
    minScale?: number;
    /** Scale clamp. Default `2.5`. */
    maxScale?: number;
    /**
     * Update rate in Hz. When provided, positions are lerped with a CSS
     * transition of one interval, so `update()` should be called on `loop.tick`
     * rather than `loop.render`. Omit it to write the transform every `update()`.
     */
    refreshRate?: number;
}

export interface OverlayOptions {
    /** CSS selector for the template element to clone, e.g. `'template#dmg'`. */
    selector: string;
    /** Max live nodes for this overlay. Oldest are evicted. Default 8. */
    maxChildren?: number;
    /** Default pointer interactivity for spawned nodes. Default `false`. */
    interactive?: boolean;
}

export interface SpawnOptions {
    readonly position: readonly [x: number, y: number, z: number];
    /** `'camera'` renders the node facing the camera (billboard). Default. */
    readonly rotation?: 'camera';
    /** Extra scale multiplier on top of the distance scale. Default 1. */
    readonly scale?: number;
    /**
     * Let this node receive pointer events (`onclick`, hover, ...). Overrides the
     * overlay default. The node's element is the hit target; add listeners to it.
     */
    readonly interactive?: boolean;
}

/** A single spawned node. Mutate it, then call `remove()` to recycle. */
export class HtmlNode {
    /** @internal */
    readonly anchor: HTMLDivElement;
    private host: HTMLElement | null = null;
    /** @internal */
    active = false;
    /** @internal */
    snapNext = true;
    private readonly pos: [number, number, number] = [0, 0, 0];
    private rotationValue: 'camera' | readonly [number, number, number] = 'camera';
    private scaleValue = 1;

    /** @internal */
    constructor(anchor: HTMLDivElement) {
        this.anchor = anchor;
    }

    /** The cloned element. Set its `textContent`, animate it, style it. */
    get element(): HTMLElement {
        return this.host!;
    }

    /** @internal */
    get attached(): boolean {
        return this.host !== null;
    }

    /** Logical world position. Assign to move it (`node.position = [x, y, z]`). */
    get position(): readonly [number, number, number] {
        return this.pos;
    }
    set position(value: readonly [number, number, number]) {
        this.pos[0] = value[0];
        this.pos[1] = value[1];
        this.pos[2] = value[2];
    }

    /** `'camera'` (billboard). A fixed rotation is reserved for a later pass. */
    get rotation(): 'camera' | readonly [number, number, number] {
        return this.rotationValue;
    }
    set rotation(value: 'camera' | readonly [number, number, number]) {
        this.rotationValue = value;
    }

    /** Extra scale multiplier applied on top of the distance scale. */
    get scale(): number {
        return this.scaleValue;
    }
    set scale(value: number) {
        this.scaleValue = value;
    }

    /** Move the node to a world position. */
    moveTo(x: number, y: number, z: number): void {
        this.pos[0] = x;
        this.pos[1] = y;
        this.pos[2] = z;
    }

    /**
     * Jump to the current position on the next `update()` instead of tweening.
     * When `refreshRate` is set, call this after a teleport so the label does
     * not slide across the screen.
     */
    snap(): void {
        this.snapNext = true;
    }

    /** Set the node's text. */
    setText(text: string): void {
        this.host.textContent = text;
    }

    /** Recycle this node. Safe to call more than once. */
    remove(): void {
        this.onRemove?.(this);
    }

    /** @internal */
    onRemove?: (node: HtmlNode) => void;
    /** @internal */
    attach(host: HTMLElement): void {
        this.host = host;
        this.anchor.replaceChildren(host);
    }
}

/** A pool of nodes cloned from one template. */
export class HtmlOverlay {
    private readonly template: Element;
    private readonly maxChildren: number;
    private readonly interactive: boolean;
    private readonly dom: HTMLDom;
    private readonly pool: HtmlNode[] = [];
    private readonly active: HtmlNode[] = [];

    /** @internal */
    constructor(dom: HTMLDom, template: Element, maxChildren: number, interactive: boolean) {
        this.dom = dom;
        this.template = template;
        this.maxChildren = maxChildren;
        this.interactive = interactive;
    }

    get size(): number {
        return this.active.length;
    }

    /** Spawn a node anchored at a world position. */
    spawn(options: SpawnOptions): HtmlNode {
        let node = this.pool.pop();
        if (!node) {
            const anchor = document.createElement('div');
            anchor.className = 'murow-node';
            node = new HtmlNode(anchor);
            node.onRemove = (n) => this.recycle(n);
            this.dom.appendNode(anchor);
        }
        if (!node.attached) node.attach(this.clone());
        node.element.textContent = '';
        node.active = true;
        node.rotation = options.rotation ?? 'camera';
        node.scale = options.scale ?? 1;
        node.position = options.position;
        node.anchor.style.display = 'block';

        this.active.push(node);
        this.dom.track(node);
        if (this.active.length > this.maxChildren) {
            this.active.shift()!.remove();
        }
        return node;
    }

    /** @internal */
    eachActive(visit: (node: HtmlNode) => void): void {
        for (const node of this.active) visit(node);
    }

    private recycle(node: HtmlNode): void {
        if (!node.active) return;
        node.active = false;
        const i = this.active.indexOf(node);
        if (i !== -1) this.active.splice(i, 1);
        node.anchor.style.display = 'none';
        this.dom.forget(node);
        this.pool.push(node);
    }

    /** @internal */
    evictOldest(): void {
        if (this.active.length > 0) this.active[0]!.remove();
    }

    private clone(): HTMLElement {
        const src = this.template.tagName === 'TEMPLATE'
            ? (this.template as HTMLTemplateElement).content.firstElementChild
            : this.template;
        const el = (src ?? this.template).cloneNode(true) as HTMLElement;
        el.removeAttribute?.('id');
        return el;
    }
}

/**
 * Owns the container, the global node budget and the per-frame update. Create
 * overlays from it, mutate their nodes, and call `update()` once per frame.
 */
export class HTMLDom {
    private readonly renderer: Projector;
    private readonly budget: number;
    private readonly referenceDepth: number;
    private readonly minScale: number;
    private readonly maxScale: number;
    private readonly transition: string;
    private readonly ownedContainer: HTMLElement | null;
    /** @internal */
    readonly container: HTMLElement;
    private readonly overlays: HtmlOverlay[] = [];
    private readonly live: HtmlNode[] = [];
    private readonly scratch = new Float32Array(3);

    constructor(options: HtmlDomOptions) {
        this.renderer = options.renderer;
        this.budget = options.budget ?? 32;
        this.referenceDepth = options.referenceDepth ?? 16;
        this.minScale = options.minScale ?? 0.35;
        this.maxScale = options.maxScale ?? 2.5;
        this.transition = options.refreshRate
            ? `transform ${(1 / options.refreshRate).toFixed(4)}s linear`
            : '';
        if (options.container) {
            this.container = options.container;
            this.ownedContainer = null;
        } else {
            const el = document.createElement('div');
            el.className = 'murow-dom';
            el.style.position = 'fixed';
            el.style.inset = '0';
            el.style.overflow = 'hidden';
            el.style.pointerEvents = 'none';
            document.body.appendChild(el);
            this.container = el;
            this.ownedContainer = el;
        }
    }

    get size(): number {
        return this.live.length;
    }

    /** Create a pooled overlay from a template element. */
    createOverlay(options: OverlayOptions): HtmlOverlay {
        const template = document.querySelector(options.selector);
        if (!template) throw new Error(`HTMLDom: no element matches "${options.selector}"`);
        const overlay = new HtmlOverlay(this, template, options.maxChildren ?? 8);
        this.overlays.push(overlay);
        return overlay;
    }

    /**
     * Reposition every live node. Call on `loop.render` normally, or on
     * `loop.tick` when `refreshRate` is set (after rendering).
     */
    update(): void {
        const out = this.scratch;
        for (const node of this.live) {
            if (!this.renderer.worldToScreen(node.position[0], node.position[1], node.position[2], out)) {
                node.anchor.style.display = 'none';
                node.snapNext = true;
                continue;
            }
            const depth = out[2] > 1e-4 ? out[2] : 1e-4;
            let scale = this.referenceDepth / depth;
            if (scale < this.minScale) scale = this.minScale;
            else if (scale > this.maxScale) scale = this.maxScale;
            node.anchor.style.display = 'block';
            const transform =
                `translate3d(${out[0]}px, ${out[1]}px, 0) scale(${(scale * node.scale).toFixed(3)})`;
            if (node.snapNext) {
                node.snapNext = false;
                if (this.transition) {
                    node.anchor.style.transition = 'none';
                    node.anchor.style.transform = transform;
                    void node.anchor.offsetWidth;
                    node.anchor.style.transition = this.transition;
                } else {
                    node.anchor.style.transform = transform;
                }
            } else {
                node.anchor.style.transform = transform;
            }
        }
    }

    /** Remove every node and (if owned) the container. */
    destroy(): void {
        for (const node of [...this.live]) node.remove();
        this.overlays.length = 0;
        this.ownedContainer?.remove();
    }

    /** @internal */
    appendNode(anchor: HTMLDivElement): void {
        anchor.style.willChange = 'transform';
        if (this.transition) anchor.style.transition = this.transition;
        this.container.appendChild(anchor);
    }

    /** @internal */
    track(node: HtmlNode): void {
        this.live.push(node);
        if (this.live.length > this.budget) this.live.shift()!.remove();
    }

    /** @internal */
    forget(node: HtmlNode): void {
        const i = this.live.indexOf(node);
        if (i !== -1) this.live.splice(i, 1);
    }
}

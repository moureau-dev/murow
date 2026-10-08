import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { HTMLDom, type Projector } from './html-dom';

/** Minimal container used for `<template>.content` (avoids element recursion). */
class FakeContainer {
    children: FakeElement[] = [];
    appendChild(child: FakeElement): FakeElement {
        this.children.push(child);
        return child;
    }
    get firstElementChild(): FakeElement | null {
        return this.children[0] ?? null;
    }
}

/** Tiny DOM shim covering the handful of APIs `HTMLDom` uses. */
class FakeElement {
    tagName: string;
    className = '';
    style: Record<string, string> = {};
    textContent = '';
    children: FakeElement[] = [];
    parent: FakeElement | null = null;
    readonly content = new FakeContainer();
    constructor(tagName: string) {
        this.tagName = tagName.toUpperCase();
    }
    appendChild(child: FakeElement): FakeElement {
        child.parent = this;
        this.children.push(child);
        return child;
    }
    replaceChildren(...nodes: FakeElement[]): void {
        for (const c of this.children) c.parent = null;
        this.children = [];
        for (const n of nodes) this.appendChild(n);
    }
    remove(): void {
        if (!this.parent) return;
        const i = this.parent.children.indexOf(this);
        if (i !== -1) this.parent.children.splice(i, 1);
        this.parent = null;
    }
    removeAttribute(): void { /* no-op */ }
    cloneNode(deep: boolean): FakeElement {
        const el = new FakeElement(this.tagName);
        el.className = this.className;
        if (deep) for (const c of this.children) el.appendChild(c.cloneNode(true));
        return el;
    }
    get firstElementChild(): FakeElement | null {
        return this.children[0] ?? null;
    }
}

const templates = new Map<string, FakeElement>();

beforeEach(() => {
    templates.clear();
    const tpl = new FakeElement('template');
    tpl.content.appendChild(new FakeElement('div'));
    templates.set('template#dmg', tpl);
    (globalThis as any).document = {
        createElement: (t: string) => new FakeElement(t),
        body: new FakeElement('body'),
        querySelector: (sel: string) => templates.get(sel) ?? null,
    };
});

afterEach(() => {
    // Other test files assume there is no DOM; don't leak the shim.
    delete (globalThis as any).document;
});

/** Projects world (x,y,z) to (x*10, y*10) with depth = z; behind camera when z <= 0. */
class FakeProjector implements Projector {
    worldToScreen(x: number, y: number, z: number, out: Float32Array): boolean {
        out[0] = x * 10;
        out[1] = y * 10;
        out[2] = z;
        return z > 0;
    }
}

describe('HTMLDom', () => {
    test('spawn returns a node with the cloned element and a live position', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector() });
        const overlay = dom.createOverlay({ selector: 'template#dmg' });
        const node = overlay.spawn({ position: [1, 2, 3] });
        expect(node.element.tagName).toBe('DIV');
        expect(node.position).toEqual([1, 2, 3]);
        node.position = [4, 5, 6];
        expect(node.position).toEqual([4, 5, 6]);
        node.setText('42');
        expect(node.element.textContent).toBe('42');
    });

    test('update positions+scales the anchor, clamped', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector(), minScale: 0.5, maxScale: 2.5 });
        const node = dom.createOverlay({ selector: 'template#dmg' }).spawn({ position: [1, 2, 4] });
        dom.update();
        expect(node.anchor.style.transform).toBe('translate3d(10px, 20px, 0) scale(2.500)');
        expect(node.anchor.style.display).toBe('block');
    });

    test('behind the camera hides the node', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector() });
        const node = dom.createOverlay({ selector: 'template#dmg' }).spawn({ position: [1, 2, -1] });
        dom.update();
        expect(node.anchor.style.display).toBe('none');
    });

    test('global budget evicts the oldest node', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector(), budget: 1 });
        const overlay = dom.createOverlay({ selector: 'template#dmg', maxChildren: 10 });
        const a = overlay.spawn({ position: [0, 0, 1] });
        const b = overlay.spawn({ position: [0, 0, 1] });
        expect(a.active).toBe(false);
        expect(b.active).toBe(true);
        expect(dom.size).toBe(1);
    });

    test('maxChildren evicts the oldest within an overlay', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector() });
        const overlay = dom.createOverlay({ selector: 'template#dmg', maxChildren: 1 });
        const a = overlay.spawn({ position: [0, 0, 1] });
        const b = overlay.spawn({ position: [0, 0, 1] });
        expect(a.active).toBe(false);
        expect(overlay.size).toBe(1);
        expect(b.active).toBe(true);
    });

    test('removed nodes are reused from the pool', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector() });
        const overlay = dom.createOverlay({ selector: 'template#dmg' });
        const a = overlay.spawn({ position: [0, 0, 1] });
        a.remove();
        const b = overlay.spawn({ position: [0, 0, 1] });
        expect(b).toBe(a);
    });

    test('refreshRate adds a transition and snaps on the first update', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector(), refreshRate: 30 });
        const node = dom.createOverlay({ selector: 'template#dmg' }).spawn({ position: [1, 2, 4] });
        expect(node.anchor.style.transition).toBe('transform 0.0333s linear');
        dom.update();
        expect(node.anchor.style.transform).toBe('translate3d(10px, 20px, 0) scale(2.500)');
        expect(node.anchor.style.transition).toBe('transform 0.0333s linear');
    });

    test('no refreshRate means no transition', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector() });
        const node = dom.createOverlay({ selector: 'template#dmg' }).spawn({ position: [0, 0, 1] });
        expect(node.anchor.style.transition ?? '').toBe('');
    });

    test('snap() re-arms the jump', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector(), refreshRate: 30 });
        const node = dom.createOverlay({ selector: 'template#dmg' }).spawn({ position: [0, 0, 1] });
        dom.update();
        node.snap();
        expect(node.snapNext).toBe(true);
    });

    test('unknown selector throws', () => {
        const dom = new HTMLDom({ renderer: new FakeProjector() });
        expect(() => dom.createOverlay({ selector: 'template#missing' })).toThrow();
    });
});

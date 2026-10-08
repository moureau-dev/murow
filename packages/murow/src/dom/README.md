# HTMLDom

World-anchored HTML overlays: DOM elements that follow a world point, projected
by a renderer every frame. Use it for nameplates, health bars and damage
numbers, where CSS gives you the look for free.

DOM only, no GPU. The renderer supplies the projection; this module owns the
element pool, per-frame positioning and recycling. It is renderer-agnostic — it
takes anything with a `worldToScreen` method, so the 2D and 3D renderers both
plug in.

```ts
import { HTMLDom } from 'murow/dom';

const dom = new HTMLDom({ renderer, budget: 32 });      // renderer.worldToScreen(...)
const dmg = dom.createOverlay({ selector: 'template#dmg', maxChildren: 8 });

const node = dmg.spawn({ position: [x, y, z] });         // anchor at spawn
node.element.textContent = '42';                          // mutate the clone
node.moveTo(x, y, z);                                     // follow the model

// once per frame, after rendering:
dom.update();
```

- `new HTMLDom({ renderer, budget?, container?, referenceDepth?, minScale?, maxScale?, refreshRate? })`
  creates the layer (a full-screen, `pointer-events:none` div unless `container`
  is given). `budget` caps live nodes across every overlay; the oldest are
  evicted. `refreshRate` is in Hz (see below).
- `dom.createOverlay({ selector, maxChildren?, interactive? })` clones `selector`
  (a `<template>`'s first child, or the element itself) per spawn, up to
  `maxChildren` live nodes. `interactive` is the default for every node.
- `overlay.spawn({ position, rotation?, scale?, interactive? })` returns an
  `HtmlNode`. `rotation` defaults to `'camera'` (billboard). The node is
  positioned by `renderer.worldToScreen`. `interactive` overrides the overlay
  default.
- `dom.update()` repositions every live node and scales it by distance
  (`referenceDepth / depth`, clamped). Call it once per frame. If you pass
  `refreshRate`, call it on `loop.tick` instead (see below).

`HtmlNode`:

| Member | Description |
|---|---|
| `element` | The cloned element. Set `textContent`, animate it, style it. |
| `position` | World position, as a live getter/setter (`node.position = [x, y, z]`). |
| `rotation` | `'camera'` (billboard). |
| `scale` | Extra multiplier on top of the distance scale. |
| `moveTo(x, y, z)` | Move the anchor. |
| `setText(text)` | Set the element's text. |
| `snap()` | Jump to the position on the next `update()` instead of tweening. |
| `remove()` | Recycle the node (safe to call more than once). |

## Tick-rate updates

By default the transform is written on every `update()`, so call it on
`loop.render` for positions that track the interpolated camera exactly. Pass
`refreshRate` (Hz) to move less often and let the browser smooth it instead: the
node then gets a CSS `transition` of one interval, and `update()` only needs to
run on `loop.tick` — the compositor lerps between ticks.

```ts
const dom = new HTMLDom({ renderer, refreshRate: loop.ticker.rate });
loop.events.on('tick', () => dom.update());
```

This cuts DOM writes at the cost of a small drift: CSS lerps the screen position
linearly, while the scene interpolates in world space and re-projects. Call
`node.snap()` after a teleport so the label does not slide across the screen. It
also does not reduce the number of elements animated, only the JavaScript work.

## Interactivity

The layer is `pointer-events:none`, so labels are click-through by default.
Pass `interactive: true` (on the overlay or a single spawn) to make a node a hit
target — it gets `pointer-events:auto` and `cursor:pointer`. Add listeners to
the node's element directly:

```ts
const nameplates = dom.createOverlay({ selector: 'template#nameplate', interactive: true });
const node = nameplates.spawn({ position: [x, y, z] });
node.element.querySelector('.hp').addEventListener('click', () => inspect());
```

Only interactive nodes capture clicks; the rest of the canvas keeps receiving
them. A node hidden off-camera (`display:none`) is not clickable.

## Notes

- The node is an outer `<div class="murow-node">` (positioned each frame) that
  wraps the clone, so your per-frame transform never fights an animation on the
  clone's own `transform`.
- DOM elements scale to dozens of labels well; for hundreds, use a canvas/GPU
  overlay instead.
- No depth occlusion: a label draws over walls unless you cull it yourself.
- A numeric (non-billboard) `rotation` needs a world size and a CSS `matrix3d`,
  so only `'camera'` is implemented for now.

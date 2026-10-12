# UI and world-anchored overlays in murow

murow keeps the UI out of the simulation: the HUD is ordinary DOM (or React) beside the canvas, and the only thing the engine owns is a pool of DOM elements that follow world points. This guide covers the two layers — screen-space UI and world-anchored overlays via `murow/dom` — plus the ECS bridge that keys one node per entity.

Referenced from [llms.txt](../llms.txt).

## TL;DR rules

1. **HUD is normal DOM/React.** A skill bar, minimap, scoreboard, or menu is a DOM element (or a React tree) sibling to the canvas; the engine has no opinion on it.
2. **World-anchored labels are `HTMLDom`.** Damage numbers, nameplates and health bars are DOM nodes following a world point, projected by the renderer each frame.
3. **One `HTMLDom` layer owns the pool.** Create overlays from it with `createOverlay({ selector })`, spawn from the overlay, and call `dom.update(dt)` once per frame.
4. **Popups expire with `lifetime`**, never `setTimeout`. `update(dt)` counts it down and recycles the node on the same tick. See the [determinism guide](./determinism.md#scheduling--never-settimeout--setinterval--requestanimationframe).
5. **Long-lived labels omit `lifetime`** (default `Infinity`) and live until `remove()`.
6. **Key nodes by entity in a `SlotStore<Entity, HtmlNode>`**, not a `Map`. See the [zero-allocation guide](./zero-allocation.md).
7. **Spawn on `'spawn'`, remove on `'despawn'`**, and each tick iterate `world.query(...)` and `store.get(e)?.moveTo(...)`. Do not iterate the store.
8. **The layer is click-through.** Opt a node in with `interactive: true` and add listeners to `node.element`; respond by sending an intent, not by mutating state.

## Two layers

### Screen-space UI

The HUD — skill bar, minimap, scoreboard, menus, chat — is plain HTML. React works: import it through your bundler and mount it into an element that is a sibling of the canvas. There is no engine API here and nothing to keep in sync with the tick. Style it with CSS; drive it from networked or local state you already hold. Keep it out of the simulation: it reads state, it does not decide it.

### World-anchored overlays — `murow/dom` (`HTMLDom`)

`HTMLDom` is DOM-only (no GPU). The renderer supplies the projection via `worldToScreen`, so the 2D and 3D renderers both plug in; the module owns the element pool, per-frame positioning and recycling. Use it for damage numbers, nameplates and health bars, where CSS gives you the look for free.

```ts
import { HTMLDom } from 'murow/dom';

const dom = new HTMLDom({ renderer, budget: 32 });             // renderer.worldToScreen(...)
const dmg = dom.createOverlay({ selector: 'template#dmg', maxChildren: 8 });

const node = dmg.spawn({ position: [x, y, z], lifetime: 1 });  // anchor, recycled after 1s
node.element.textContent = '42';                               // mutate the clone
node.moveTo(x, y, z);                                          // follow the model

// once per frame, after rendering (dt advances lifetimes):
dom.update(dt);
```

Construction and overlay options:

| call | options |
|---|---|
| `new HTMLDom({ ... })` | `renderer` (anything with `worldToScreen`); `budget?` max live nodes across every overlay, oldest evicted (default 32); `container?` element to append to (default: an owned full-screen `pointer-events:none` div); `referenceDepth?` depth at which a node renders at 1x (default 16); `minScale?` / `maxScale?` scale clamps (defaults `0.35` / `2.5`); `refreshRate?` update rate in Hz (see below) |
| `dom.createOverlay({ ... })` | `selector` for the template (a `<template>`'s first child, or the element itself); `maxChildren?` max live nodes for this overlay, oldest evicted (default 8); `interactive?` default interactivity for its nodes (default `false`) |
| `overlay.spawn({ ... })` | `position` `[x, y, z]`; `rotation?` `'camera'` billboard (default); `scale?` extra multiplier on top of the distance scale (default 1); `lifetime?` seconds before auto-recycle (omit for `Infinity`); `interactive?` overrides the overlay default |

`HtmlNode` members:

| member | description |
|---|---|
| `element` | The cloned element. Set `textContent`, animate it, style it. |
| `position` | World position, a live getter/setter (`node.position = [x, y, z]`). |
| `rotation` | `'camera'` (billboard). A numeric rotation is reserved for a later pass. |
| `scale` | Extra multiplier on top of the distance scale. |
| `lifetime` | Remaining seconds, advanced by `update(dt)`; `Infinity` (default) lives until `remove()`. Assign to set or reset. |
| `moveTo(x, y, z)` | Move the anchor. |
| `setText(text)` | Set the element's text. |
| `snap()` | Jump to the position on the next `update()` instead of tweening. |
| `remove()` | Recycle the node. Safe to call more than once. |

Each node is an outer `<div class="murow-node">` (positioned each frame) wrapping your clone, so the per-frame transform never fights an animation on the clone's own `transform`.

## Lifetimes vs `setTimeout`

Popups like damage numbers must not be cleaned up with `setTimeout`: that spawns a timer per node, runs outside the loop, and breaks determinism. Give the node a `lifetime` at spawn instead; `update(dt)` counts it down and recycles the node when it elapses, on the same tick that moves it.

```ts
const dmg = dom.createOverlay({ selector: 'template#dmg' });
dmg.spawn({ position: [x, y, z], lifetime: 1 });   // gone after 1s, no timer
```

`node.lifetime` is the remaining seconds. Assign a finite number to cap a node, or `Infinity` to let it live until `remove()`.

Nameplates and health bars are the opposite case: spawn once with no `lifetime` (so it defaults to `Infinity`) and keep updating the same node for the entity's whole life.

## Interactivity

The layer is `pointer-events:none`, so labels are click-through by default. Pass `interactive: true` on the overlay or on a single spawn to make a node a hit target: it gets `pointer-events:auto` and `cursor:pointer`. Add listeners to the node's element directly, and respond by sending an intent (the bridge to netcode):

```ts
const plates = dom.createOverlay({ selector: 'template#nameplate', interactive: true });
const node = plates.spawn({ position: [x, y, z] });
node.element.addEventListener('click', () => client.sendIntent('inspect', { target: e }));
```

Only interactive nodes capture clicks; the rest of the canvas keeps receiving them. A node hidden off-camera (`display:none`) is not clickable.

## Tick-rate updates

By default the transform is written on every `update()`, so call it on `loop.render` for positions that track the interpolated camera exactly. Pass `refreshRate` (Hz) to write less often and let the browser smooth it: each node then gets a CSS `transition` of one interval and `update()` only needs to run on `loop.tick` — the compositor lerps between ticks.

```ts
const dom = new HTMLDom({ renderer, refreshRate: loop.ticker.rate });
loop.events.on('tick', ({ deltaTime }) => dom.update(deltaTime));
```

This cuts DOM writes at the cost of a small drift: CSS lerps the screen position linearly, while the scene interpolates in world space and re-projects. Call `node.snap()` after a teleport so the label does not slide across the screen. It does not reduce the number of elements animated, only the JavaScript work.

## The ECS bridge

Keep one node per entity, keyed by entity id. A `SlotStore<Entity, HtmlNode>` is the per-entity companion store (see the [zero-allocation guide](./zero-allocation.md)); spawn on the client `'spawn'` event, tear down on `'despawn'`, and each tick move the nodes the ECS says are alive.

```ts
import { SlotStore } from 'murow/core/slot-map';
import { HTMLDom } from 'murow/dom';

const dom = new HTMLDom({ renderer, refreshRate: loop.ticker.rate });
const plates = dom.createOverlay({ selector: 'template#nameplate', maxChildren: 64 });
const nodes = new SlotStore<Entity, HtmlNode>(64, world.getMaxEntities());

client.on('spawn', ({ entity }) => {
  const p = world.get(entity, Position);              // reused; read out now
  nodes.add(entity, plates.spawn({ position: [p.x, p.y, p.z] }));
});
client.on('despawn', ({ entity }) => {
  nodes.get(entity)?.remove(); nodes.remove(entity);
});

// per tick: the query drives iteration, the store is only looked up
function labelSystem(world: World) {
  const pos = world.fields(Position);
  return function update(deltaTime: number) {
    for (const e of world.query(Position, LabelTag)) {
      nodes.get(e)?.moveTo(pos.x[e], pos.y[e], pos.z[e]);
    }
  };
}
```

Do **not** drive the loop from the store (`store.forEach(world.get)`); that inverts the ECS data path. Iterate `world.query(...)` and use `store.get(e)` for the O(1) lookup.

Styling is a `<template>` plus CSS; `createOverlay` clones the template's first child per spawn and strips its `id` so clones do not collide:

```html
<template id="nameplate">
  <div class="plate"><span class="name"></span><div class="hp"></div></div>
</template>
```

```css
.plate { transform: translateX(-50%); color: #fff; text-shadow: 0 0 2px #000; }
.hp { height: 4px; background: #4caf50; }
```

Set per-entity content with `node.element.querySelector('.name')!.textContent = name` and `node.setText(text)` for the simple case.

## Gotchas

- **`budget` evicts globally, `maxChildren` per overlay.** Both evict the oldest; size `budget` for every live overlay combined, not one.
- **`spawn` clears the clone.** The pool resets `element.textContent` and reapplies rotation/scale/lifetime each spawn; set text after spawning.
- **`lifetime` counts down inside `update(dt)`.** If you never call `update`, nothing expires and nothing moves. Pass the frame delta in seconds.
- **`update` on `tick` only when `refreshRate` is set.** Otherwise call it on `render`; with the transition path, `update` on `render` fights the CSS lerp.
- **`snap()` after a teleport.** With `refreshRate`, a large jump otherwise slides across the screen as the transition catches up.
- **No depth occlusion.** A label draws over walls unless you cull it yourself; hide it when the target is occluded.
- **`rotation` is `'camera'` only.** A numeric rotation needs a world size and a CSS `matrix3d`, and is not implemented.
- **DOM scales to dozens of labels.** For hundreds, use a canvas/GPU overlay instead.
- **Don't `setTimeout` the node.** Use `lifetime`, so expiry is bound to the tick and stays deterministic.
- **Don't key nodes in a `Map`.** Use `SlotStore<Entity, HtmlNode>` for the per-entity object.
- **Reactivity is yours.** Click handlers should send an intent; the server decides, and the snapshot drives what the label shows.

## Quick reference

| want | use |
|---|---|
| HUD, menus, scoreboard | plain DOM / React, sibling to the canvas |
| world-anchored label | `new HTMLDom({ renderer })` + `createOverlay` + `spawn` |
| damage number | `spawn({ position, lifetime: 1 })` (never `setTimeout`) |
| nameplate / health bar | `spawn({ position })` with no `lifetime`, update `moveTo` each tick |
| per-frame update | `dom.update(dt)` on `render`, or on `tick` with `refreshRate` |
| smooth at tick rate | `new HTMLDom({ renderer, refreshRate: loop.ticker.rate })` |
| jump after teleport | `node.snap()` |
| clickable label | `createOverlay({ interactive: true })` + listener on `node.element` |
| text | `node.setText(text)` or `node.element.textContent` |
| node per entity | `SlotStore<Entity, HtmlNode>` keyed by entity (spawn/despawn events) |
| move labels each tick | iterate `world.query(...)`, then `store.get(e)?.moveTo(...)` |
| style clones | a `<template>` + CSS |
| lifecycle | `'spawn'` → `plates.spawn(...)`; `'despawn'` → `remove()` + `store.remove(e)` |

---

Related guides: [ECS](./ecs.md), [Zero-allocation](./zero-allocation.md), [Determinism](./determinism.md), [Shaders](./shaders.md), [Renderer](./renderer.md), [Performance](./performance.md), [Netcode](./netcode.md), [Assets](./assets.md), [UI](./ui.md), [Testing](./testing.md)


# Input

Unified keyboard/mouse state plus camera-input helpers built on top of it.

## InputManager

Tracks keys and the mouse, exposes two read modes:

- `peek()` returns the live state. Use for render-rate logic where you don't
  care about tick boundaries.
- `snapshot()` returns a frozen copy for the current tick. Use inside the
  loop's `tick` handler so simulation reads stable data.

```ts
import { InputManager, BrowserInputSource } from 'murow/core/input';

const input = new InputManager();
input.listen(new BrowserInputSource(document, document.body));

loop.events.on('tick', () => {
    const snap = input.snapshot();
    if (snap.keys['Space']?.hit) jump();
});
```

`InputSnapshot` shape:

```ts
{
    keys: Record<string, { down: boolean; hit: boolean; released: boolean }>;
    mouse: {
        position: { x: number; y: number };
        delta: { position: { x, y }; scroll: { x, y } };
        left:   { down: boolean; hit: boolean; released: boolean };
        middle: { ... };
        right:  { ... };
    };
}
```

`hit` is true for the one tick the key/button was pressed; `released` for
the one tick it was let go. `down` is held-state.

## MouseLook

Yaw/pitch state driven by mouse motion. Handles pointer lock with a
drag-to-look fallback so it works on iOS Safari (which has no Pointer
Lock API).

Exposes `forward`, `right`, `up` (orthonormal basis) and an `orbit(target,
distance)` helper. Each accessor returns a shared `Float32Array(3)` reused
across calls (zero allocation per frame; don't hold the reference past the
next read).

### FPS

```ts
import { MouseLook } from 'murow/core/input';

const look = new MouseLook({ sensitivity: 0.002, drag: true });

canvas.addEventListener('click', () => {
    look.lock(canvas).catch(() => { /* iOS: drag-to-look takes over */ });
});

loop.events.on('tick', ({ input }) => {
    look.update(input);
    const pos = renderer.camera.position;
    const f = look.forward;
    renderer.camera.setTarget(pos[0] + f[0], pos[1] + f[1], pos[2] + f[2]);
});
```

### Third-person / orbit

```ts
const look = new MouseLook({
    sensitivity: 0.0035,
    pitchMin: 0.15,
    pitchMax: Math.PI / 2 - 0.05,
    initialYaw: Math.PI * 0.25,
    initialPitch: 0.6,
});

loop.events.on('tick', ({ input }) => {
    look.update(input);
    const c = look.orbit(playerPos, 8);
    renderer.camera.setPosition(c[0], c[1], c[2]);
    renderer.camera.setTarget(playerPos[0], playerPos[1], playerPos[2]);
});
```

### Options

| Option | Default | Notes |
|---|---|---|
| `sensitivity` | `0.002` | radians per pixel of motion |
| `pitchMin` | `-PI/2 + 0.01` | lower clamp |
| `pitchMax` | `PI/2 - 0.01` | upper clamp |
| `initialYaw` | `0` | |
| `initialPitch` | `0` | |
| `invertX` | `false` | flip horizontal direction |
| `invertY` | `false` | flip vertical direction (flight-sim style) |
| `drag` | `true` | allow drag-to-look as a Pointer Lock fallback |
| `dragButton` | `'left'` | which button drives drag mode |

### Lifecycle

- `lock(element)` returns a Promise. Rejects if Pointer Lock isn't
  available (iOS) or denied; drag-to-look takes over if `drag` is true.
- `unlock()` releases the lock if held.
- `destroy()` releases the lock and detaches any in-flight `lock()`
  listeners. Always pair construction with `destroy()` if your program
  has a teardown phase.

`yaw` and `pitch` are public mutable fields. You can write to them
directly to drive camera animations (cutscenes, "leave car" cinematics,
auto-rotate on idle). Just skip `update(input)` while the animation
plays, and the next call resumes from your written state.

## ScrollZoom

Scroll-wheel-driven scalar with clamps. Useful for orbit distance, FOV,
RTS camera height, etc.

```ts
import { ScrollZoom } from 'murow/core/input';

const zoom = new ScrollZoom({ initial: 8, min: 3, max: 20, sensitivity: 0.01 });

loop.events.on('tick', ({ input }) => {
    zoom.update(input);
    const c = look.orbit(target, zoom.value);
    // ...
});
```

`value` is public mutable. `sensitivity` can be negative to invert the
direction.

## Composing helpers

`MouseLook` and `ScrollZoom` are independent. Wire them together in your
own code; don't expect a bundled `TpsCamera` or `FpsCamera` from the
engine. The boilerplate is two lines per tick and games want different
combinations (idle rotation, wall collision, screen shake, etc.) that
can't be predicted up front.

For game-specific composition, write a small wrapper in your project:

```ts
class GameCamera {
    private look = new MouseLook({ ... });
    private zoom = new ScrollZoom({ ... });

    update(input: InputSnapshot, target: ArrayLike<number>) {
        this.look.update(input);
        this.zoom.update(input);
        return this.look.orbit(target, this.zoom.value);
    }
}
```

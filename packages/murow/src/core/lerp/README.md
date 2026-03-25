# lerp

A simple utility function for linear interpolation between two numeric values. Perfect for smooth animations, transitions, and value easing in game development.

## Features

- Clean linear interpolation implementation.
- Unclamped by design - allows extrapolation when t is outside [0, 1].
- Zero dependencies.
- Works in browsers and Node.js.
- TypeScript support with proper type definitions.

## Usage

```typescript
import { lerp } from './lerp';

// Basic interpolation
const value = lerp(0, 100, 0.5); // Returns 50

// Animation example
const startPos = 0;
const endPos = 100;
const progress = 0.75;
const currentPos = lerp(startPos, endPos, progress); // Returns 75

// Smooth camera movement
function updateCamera(deltaTime: number) {
  const t = deltaTime * smoothingFactor;
  camera.x = lerp(camera.x, target.x, t);
  camera.y = lerp(camera.y, target.y, t);
}

// Color transitions
const r = lerp(startColor.r, endColor.r, progress);
const g = lerp(startColor.g, endColor.g, progress);
const b = lerp(startColor.b, endColor.b, progress);
```

## Parameters

- `start` (number): The starting value (returned when t = 0)
- `end` (number): The ending value (returned when t = 1)
- `t` (number): The interpolation factor, typically in range [0, 1]

## Returns

`number` - The interpolated value between start and end.

## Extrapolation

The function does not clamp the `t` parameter, allowing extrapolation:

```typescript
lerp(0, 100, 1.5);  // Returns 150 (extrapolated beyond end)
lerp(0, 100, -0.5); // Returns -50 (extrapolated before start)
```

If you need clamped interpolation, combine with a clamp function:

```typescript
function clampedLerp(start: number, end: number, t: number): number {
  const clampedT = Math.max(0, Math.min(1, t));
  return lerp(start, end, clampedT);
}
```

## Common Use Cases

- **Smooth animations**: Interpolate position, rotation, scale over time
- **Camera movement**: Create smooth camera following behavior
- **UI transitions**: Fade effects, sliding panels, progress bars
- **Color blending**: Transition between colors smoothly
- **Value easing**: Gradually approach target values
- **Physics simulations**: Interpolate between physics states for rendering

---

`lerp` provides a foundational building block for smooth, continuous value transitions in game development and interactive applications.

# Renderer

Abstract base classes and shared types for rendering backends. Any renderer implementation (WebGPU, PixiJS, Three.js, etc.) extends these to provide a consistent API.

## Architecture

```
BaseRenderer            — canvas, clearColor, init/render/destroy lifecycle
├── Base2DRenderer      — maxSprites, camera (2D), loadSpritesheet, addSprite/removeSprite
└── Base3DRenderer      — maxModels, camera (3D)
```

## Types

- `SpriteHandle` — zero-alloc handle for reading/writing sprite data (x, y, rotation, scale, opacity, etc.)
- `SpritesheetHandle` — loaded spritesheet with UV lookups
- `SpriteOptions` — options for creating a sprite (sheet, position, layer, tint, etc.)
- `Camera2DState` / `Camera3DState` — camera properties consumed by renderers
- `ClearColor` — `[r, g, b, a]` tuple

## Implementing a Backend

```typescript
import { Base2DRenderer } from 'murow';

class MyRenderer extends Base2DRenderer {
    async init() { /* setup GPU context */ }
    render(alpha: number) { /* draw frame */ }
    destroy() { /* cleanup */ }
    loadSpritesheet(source) { /* load textures */ }
    addSprite(options) { /* allocate + return handle */ }
    removeSprite(sprite) { /* free slot */ }
}
```

/**
 * ParticleEmitter — CPU-driven particle system using the renderer's instancing.
 *
 * Particles are managed as sprites in the 2D renderer. The emitter handles
 * spawning, lifetime, velocity, gravity, fade, and cleanup.
 *
 * Usage:
 * ```ts
 * const trail = new ParticleEmitter(renderer, {
 *   max: 2000,
 *   lifetime: { min: 0.4, max: 0.8 },
 *   speed: { min: 20, max: 100 },
 *   size: { min: 3, max: 5 },
 *   gravity: [0, 120],
 *   color: [1, 0.6, 0.1, 1],
 *   direction: { min: -180, max: 180 },
 *   fadeOut: true,
 * });
 *
 * trail.emit(x, y, count);
 * trail.update(deltaTime);
 * ```
 */
import { SimpleRNG } from 'murow/core/simple-rng';
import { SlotSet } from 'murow/core/slot-map';
import type { SpritesheetHandle } from 'murow/renderer';
import type { WebGPU2DRenderer } from '../2d/renderer';
import type { SpriteAccessor } from '../2d/renderer';

export interface Range {
    min: number;
    max: number;
}

export interface ParticleEmitterConfig {
    max: number;
    lifetime: Range;
    speed: Range;
    size: Range;
    gravity?: [number, number];
    color: [number, number, number, number];
    direction: Range;
    fadeOut?: boolean;
    sheet?: SpritesheetHandle;
    sprite?: number;
    seed?: number;
}

export class ParticleEmitter {
    private renderer: WebGPU2DRenderer;
    private config: ParticleEmitterConfig;

    // Pre-allocated particle state arrays (zero-GC)
    private sprites: (SpriteAccessor | null)[];
    private lifetimes: Float32Array;
    private maxLifetimes: Float32Array;
    private velocitiesX: Float32Array;
    private velocitiesY: Float32Array;
    private readonly active: SlotSet;
    private head = 0; // ring buffer write head
    private rng: SimpleRNG;

    constructor(renderer: WebGPU2DRenderer, config: ParticleEmitterConfig) {
        this.renderer = renderer;
        this.config = config;
        this.rng = new SimpleRNG(config.seed);

        const max = config.max;
        this.sprites = new Array(max).fill(null);
        this.lifetimes = new Float32Array(max);
        this.maxLifetimes = new Float32Array(max);
        this.velocitiesX = new Float32Array(max);
        this.velocitiesY = new Float32Array(max);
        this.active = new SlotSet(max);
    }

    emit(x: number, y: number, count: number = 1): void {
        for (let i = 0; i < count; i++) {
            const idx = this.head;
            this.head = (this.head + 1) % this.config.max;

            // If this slot is occupied, remove the old particle
            if (this.sprites[idx] !== null) {
                this.sprites[idx]!.destroy();
                this.sprites[idx] = null;
                this.active.remove(idx);
            }

            const rng = this.rng;
            const dirDeg = rng.range(this.config.direction.min, this.config.direction.max);
            const dirRad = dirDeg * (Math.PI / 180);
            const speed = rng.range(this.config.speed.min, this.config.speed.max);
            const lifetime = rng.range(this.config.lifetime.min, this.config.lifetime.max);
            const size = rng.range(this.config.size.min, this.config.size.max);

            this.velocitiesX[idx] = Math.cos(dirRad) * speed;
            this.velocitiesY[idx] = Math.sin(dirRad) * speed;
            this.lifetimes[idx] = lifetime;
            this.maxLifetimes[idx] = lifetime;

            // Create sprite in the renderer
            if (this.config.sheet) {
                const sprite = this.renderer.sprites.add({
                    sheet: this.config.sheet,
                    sprite: this.config.sprite ?? 0,
                    position: [x, y],
                    scale: size,
                    opacity: 1,
                    tint: this.config.color,
                    layer: 255, // particles on top
                });
                if (sprite) {
                    this.sprites[idx] = sprite;
                    this.active.add(idx);
                }
            }
        }
    }

    update(deltaTime: number): void {
        const gx = this.config.gravity?.[0] ?? 0;
        const gy = this.config.gravity?.[1] ?? 0;
        const fade = this.config.fadeOut ?? false;

        const active = this.active;
        const dense = active.denseBuffer;
        for (let i = active.size - 1; i >= 0; i--) {
            const idx = dense[i]!;
            const sprite = this.sprites[idx];
            if (sprite === null) {
                active.remove(idx);
                continue;
            }

            this.lifetimes[idx] -= deltaTime;
            if (this.lifetimes[idx] <= 0) {
                sprite.destroy();
                this.sprites[idx] = null;
                active.remove(idx);
                continue;
            }

            this.velocitiesX[idx] += gx * deltaTime;
            this.velocitiesY[idx] += gy * deltaTime;

            sprite.x += this.velocitiesX[idx] * deltaTime;
            sprite.y += this.velocitiesY[idx] * deltaTime;

            if (fade) {
                sprite.opacity = this.lifetimes[idx] / this.maxLifetimes[idx];
            }
        }
    }

    getActiveCount(): number {
        return this.active.size;
    }

    clear(): void {
        const active = this.active;
        const dense = active.denseBuffer;
        for (let i = 0; i < active.size; i++) {
            const idx = dense[i]!;
            const sprite = this.sprites[idx];
            if (sprite !== null) {
                sprite.destroy();
                this.sprites[idx] = null;
            }
        }
        active.clear();
        this.head = 0;
    }
}

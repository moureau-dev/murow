/**
 * ParticleEmitter — CPU-driven particle system using the renderer's instancing.
 *
 * Particles are managed as sprites in the 2D renderer. The emitter handles
 * spawning, lifetime, velocity, gravity, fade, and cleanup. Zero external
 * allocations in the update loop — all state lives in pre-allocated arrays.
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
import type { SpriteHandle, SpritesheetHandle } from 'murow';
import type { WebGPU2DRenderer } from '../2d/renderer';

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
    private sprites: (SpriteHandle | null)[];
    private lifetimes: Float32Array;
    private maxLifetimes: Float32Array;
    private velocitiesX: Float32Array;
    private velocitiesY: Float32Array;
    private activeCount = 0;
    private head = 0; // ring buffer write head

    // Simple LCG PRNG for deterministic, zero-alloc randomness
    private rngState: number;

    constructor(renderer: WebGPU2DRenderer, config: ParticleEmitterConfig) {
        this.renderer = renderer;
        this.config = config;

        const max = config.max;
        this.sprites = new Array(max).fill(null);
        this.lifetimes = new Float32Array(max);
        this.maxLifetimes = new Float32Array(max);
        this.velocitiesX = new Float32Array(max);
        this.velocitiesY = new Float32Array(max);

        this.rngState = config.seed ?? (Math.random() * 0x7FFFFFFF) | 0;
    }

    private rand(): number {
        this.rngState = (this.rngState * 1664525 + 1013904223) & 0x7FFFFFFF;
        return this.rngState / 0x7FFFFFFF;
    }

    private randRange(range: Range): number {
        return range.min + this.rand() * (range.max - range.min);
    }

    emit(x: number, y: number, count: number = 1): void {
        for (let i = 0; i < count; i++) {
            const idx = this.head;
            this.head = (this.head + 1) % this.config.max;

            // If this slot is occupied, remove the old particle
            if (this.sprites[idx] !== null) {
                this.renderer.removeSprite(this.sprites[idx]!);
                this.sprites[idx] = null;
            }

            const dirDeg = this.randRange(this.config.direction);
            const dirRad = dirDeg * (Math.PI / 180);
            const speed = this.randRange(this.config.speed);
            const lifetime = this.randRange(this.config.lifetime);
            const size = this.randRange(this.config.size);

            this.velocitiesX[idx] = Math.cos(dirRad) * speed;
            this.velocitiesY[idx] = Math.sin(dirRad) * speed;
            this.lifetimes[idx] = lifetime;
            this.maxLifetimes[idx] = lifetime;

            // Create sprite in the renderer
            if (this.config.sheet) {
                const sprite = this.renderer.addSprite({
                    sheet: this.config.sheet,
                    sprite: this.config.sprite ?? 0,
                    x, y,
                    scaleX: size,
                    scaleY: size,
                    opacity: 1,
                    tint: this.config.color,
                    layer: 255, // particles on top
                });
                this.sprites[idx] = sprite;
            }

            if (this.sprites[idx] === null) {
                this.activeCount = Math.min(this.activeCount + 1, this.config.max);
            }
        }
    }

    update(deltaTime: number): void {
        const gx = this.config.gravity?.[0] ?? 0;
        const gy = this.config.gravity?.[1] ?? 0;
        const fade = this.config.fadeOut ?? false;

        for (let i = 0; i < this.config.max; i++) {
            const sprite = this.sprites[i];
            if (sprite === null) continue;

            this.lifetimes[i] -= deltaTime;
            if (this.lifetimes[i] <= 0) {
                this.renderer.removeSprite(sprite);
                this.sprites[i] = null;
                this.activeCount--;
                continue;
            }

            // Apply gravity
            this.velocitiesX[i] += gx * deltaTime;
            this.velocitiesY[i] += gy * deltaTime;

            // Move
            sprite.x += this.velocitiesX[i] * deltaTime;
            sprite.y += this.velocitiesY[i] * deltaTime;

            // Fade
            if (fade) {
                sprite.opacity = this.lifetimes[i] / this.maxLifetimes[i];
            }
        }
    }

    getActiveCount(): number {
        return this.activeCount;
    }

    clear(): void {
        for (let i = 0; i < this.config.max; i++) {
            if (this.sprites[i] !== null) {
                this.renderer.removeSprite(this.sprites[i]!);
                this.sprites[i] = null;
            }
        }
        this.activeCount = 0;
        this.head = 0;
    }
}

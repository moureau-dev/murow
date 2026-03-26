import { GameLoop } from 'murow';
import { WebGPU2DRenderer, d, std } from '@murow/webgpu';
import type { Program } from '../index';

const MAX_PARTICLES = 50_000;

const Particle = d.struct({
    posX: d.f32,
    posY: d.f32,
    velX: d.f32,
    velY: d.f32,
    life: d.f32,
});

const Config = d.struct({
    deltaTime: d.f32,
    gravity: d.f32,
    bounceEnergy: d.f32,
    count: d.u32,
});

export const gpuParticles: Program = {
    name: 'GPU Particles',

    async init(canvas: HTMLCanvasElement, stats: HTMLElement) {
        const renderer = new WebGPU2DRenderer(canvas, {
            maxSprites: 1,
            clearColor: [0.02, 0.02, 0.05, 1],
            autoResize: true,
        });
        await renderer.init();

        // --- Compute: update particles on GPU ---
        const compute = renderer
            .createCompute('particle-physics', { workgroupSize: 256 })
            .buffers({
                particles: { storage: d.arrayOf(Particle, MAX_PARTICLES), readwrite: true },
                config: { uniform: Config },
            })
            .shader(({ particles, config }, { globalId }) => {
                const idx = globalId.x;
                if (idx >= config.count) { return; }

                const p = particles[idx];
                const dt = config.deltaTime;
                const gravity = config.gravity;
                const bounce = config.bounceEnergy;

                p.velY = p.velY + gravity * dt;
                p.posX = p.posX + p.velX * dt;
                p.posY = p.posY + p.velY * dt;

                if (p.posX < 0.0) { p.posX = 0.0; p.velX = std.abs(p.velX) * bounce; }
                if (p.posX > 1.0) { p.posX = 1.0; p.velX = std.abs(p.velX) * bounce * -1.0; }
                if (p.posY < 0.0) { p.posY = 0.0; p.velY = std.abs(p.velY) * bounce; }
                if (p.posY > 1.0) { p.posY = 1.0; p.velY = std.abs(p.velY) * bounce * -1.0; }

                p.life = p.life - dt;
            })
            .build();

        // --- Render: zero-copy from compute buffer ---
        const render = renderer
            .createGeometry('particle-vis', { maxInstances: MAX_PARTICLES, geometry: 'quad' })
            .instanceLayout({
                dynamic: { posX: d.f32, posY: d.f32, velX: d.f32, velY: d.f32, life: d.f32 },
                static: {},
            })
            .fromCompute(compute, 'particles')
            .uniforms({ resolution: d.vec2f })
            .shaders({
                vertex: {
                    out: { vLife: d.f32, localUV: d.vec2f, vHue: d.f32 },
                    fn({ dynamic, uniforms }, input) {
                        const p = dynamic[input.instanceIndex];
                        const resX = uniforms.resolution.x;
                        const resY = uniforms.resolution.y;

                        const vf = d.f32(input.vertexIndex);
                        const r1 = std.step(0.5, vf) * (1.0 - std.step(1.5, vf));
                        const r2 = std.step(1.5, vf) * (1.0 - std.step(2.5, vf));
                        const r4 = std.step(3.5, vf) * (1.0 - std.step(4.5, vf));
                        const t2 = r2;
                        const t4 = r4;
                        const t5 = std.step(4.5, vf) * (1.0 - std.step(5.5, vf));
                        const qx = std.max(std.max(r1, r2), r4) * 2.0 - 1.0;
                        const qy = std.max(std.max(t2, t4), t5) * 2.0 - 1.0;

                        const sizeX = 4.0 / resX;
                        const sizeY = 4.0 / resY;
                        const wx = (p.posX * 2.0 - 1.0) + qx * sizeX;
                        const wy = (1.0 - p.posY * 2.0) + qy * sizeY;

                        const hue = d.f32(input.instanceIndex % 360) / 360.0;

                        return {
                            pos: d.vec4f(wx, wy, 0, 1),
                            vLife: p.life,
                            localUV: d.vec2f(qx, qy),
                            vHue: hue,
                        };
                    },
                },
                fragment: {
                    fn(input) {
                        const dist = std.length(input.localUV);
                        const glow = std.pow(std.saturate(1.0 - dist), 2.0);
                        const fade = std.saturate(input.vLife * 0.5);

                        const h = input.vHue * 6.0;
                        const r = std.saturate(std.abs(h - 3.0) - 1.0);
                        const g = std.saturate(2.0 - std.abs(h - 2.0));
                        const b = std.saturate(2.0 - std.abs(h - 4.0));

                        return d.vec4f(r * glow * fade, g * glow * fade, b * glow * fade, glow * fade);
                    },
                },
            })
            .build();

        // Initialize particles
        const initData: Array<{ posX: number; posY: number; velX: number; velY: number; life: number }> = [];
        for (let i = 0; i < MAX_PARTICLES; i++) {
            initData.push({
                posX: Math.random(),
                posY: Math.random(),
                velX: (Math.random() - 0.5) * 0.5,
                velY: (Math.random() - 0.5) * 0.5,
                life: 5.0 + Math.random() * 10.0,
            });
        }
        compute.write('particles', initData);

        render.updateUniforms({ resolution: [canvas.width, canvas.height] });

        renderer.onResize((w, h) => {
            render.updateUniforms({ resolution: [w, h] });
        });

        let frameCount = 0;
        let lastFpsTime = performance.now();
        let lastTime = performance.now();

        const loop = new GameLoop({ tickRate: 5, type: 'client' });

        loop.events.on('render', ({ deltaTime }) => {
            const context = canvas.getContext('webgpu');
            if (!context) return;
            const view = context.getCurrentTexture().createView();

            // Compute + render — zero CPU involvement
            compute.write('config', { deltaTime, gravity: 0.3, bounceEnergy: 0.8, count: MAX_PARTICLES });
            compute.dispatch(MAX_PARTICLES);
            render.render(view, [0.02, 0.02, 0.05, 1]);

            frameCount++;
            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
                const fps = frameCount / ((now - lastFpsTime) / 1000);
                stats.textContent = `FPS: ${fps.toFixed(0)} | Particles: ${MAX_PARTICLES.toLocaleString()} (zero-copy GPU)`;
                frameCount = 0;
                lastFpsTime = now;
            }
        });

        loop.start();

        return () => {
            loop.stop();
            compute.destroy();
            render.destroy();
        };
    },
};

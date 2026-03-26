import tgpu from 'typegpu';
import * as d from 'typegpu/data';
import * as std from 'typegpu/std';
import { GameLoop } from 'murow';
import { WebGPU2DRenderer } from '@murow/webgpu';
import type { Program } from '../index';

const MAX_STARS = 1_000;

export const starfield: Program = {
    name: 'Starfield',

    async init(canvas: HTMLCanvasElement, stats: HTMLElement) {
        const renderer = new WebGPU2DRenderer(canvas, {
            maxSprites: 1,
            clearColor: [0, 0, 0.02, 1],
        });
        await renderer.init();

        const geom = renderer
            .createGeometry('starfield', { maxInstances: MAX_STARS, geometry: 'quad' })
            .instanceLayout({
                dynamic: { position: d.vec2f },
                static: { speed: d.f32, phase: d.f32 },
            })
            .uniforms({ time: d.f32, resolution: d.vec2f })
            .shaders(({ layout }) => ({
                vertex: tgpu.vertexFn({
                    in: { vertexIndex: d.builtin.vertexIndex, instanceIndex: d.builtin.instanceIndex },
                    out: { pos: d.builtin.position, brightness: d.f32, localUV: d.vec2f },
                })(function starfieldVertex(input: { vertexIndex: number; instanceIndex: number }) {
                    'use gpu';
                    const starPos = layout.$.dynamicInstances[input.instanceIndex].position;
                    const speed = layout.$.staticInstances[input.instanceIndex].speed;
                    const phase = layout.$.staticInstances[input.instanceIndex].phase;
                    const time = layout.$.uniforms.time;
                    const resX = layout.$.uniforms.resolution.x;
                    const resY = layout.$.uniforms.resolution.y;

                    // Quad: draw(6, count) → vertexIndex is 0-5 per instance
                    const vf = d.f32(input.vertexIndex);
                    const r1 = std.step(0.5, vf) * (1.0 - std.step(1.5, vf));
                    const r2 = std.step(1.5, vf) * (1.0 - std.step(2.5, vf));
                    const r4 = std.step(3.5, vf) * (1.0 - std.step(4.5, vf));
                    const t2 = r2;
                    const t4 = r4;
                    const t5 = std.step(4.5, vf) * (1.0 - std.step(5.5, vf));
                    const qx = std.max(std.max(r1, r2), r4) * 2.0 - 1.0;
                    const qy = std.max(std.max(t2, t4), t5) * 2.0 - 1.0;

                    const sizeX = 8.0 / resX;
                    const sizeY = 8.0 / resY;
                    const wx = (starPos.x * 2.0 - 1.0) + qx * sizeX;
                    const wy = (1.0 - starPos.y * 2.0) + qy * sizeY;

                    const brightness = std.sin(time * speed + phase) * 0.5 + 0.5;

                    return {
                        pos: d.vec4f(wx, wy, 0, 1),
                        brightness,
                        localUV: d.vec2f(qx, qy),
                    };
                }),

                fragment: tgpu.fragmentFn({
                    in: { brightness: d.f32, localUV: d.vec2f },
                    out: d.vec4f,
                })(function starfieldFragment(input: { brightness: number; localUV: d.v2f }) {
                    'use gpu';
                    const dist = std.length(input.localUV);
                    const glow = std.pow(std.saturate(1.0 - dist), 3.0);
                    const c = glow * input.brightness;
                    return d.vec4f(c * 0.9, c * 0.95, c, glow);
                }),
            }))
            .build();

        // Initialize stars
        for (let i = 0; i < MAX_STARS; i++) {
            geom.addInstance({
                position: [Math.random(), Math.random()],
                speed: 0.5 + Math.random(),
                phase: Math.random() * Math.PI * 2,
            });
        }

        geom.updateUniforms({
            time: 0,
            resolution: [canvas.width, canvas.height],
        });

        let frameCount = 0;
        let lastFpsTime = performance.now();

        const loop = new GameLoop({ tickRate: 1, type: 'client' });

        loop.events.on('render', () => {
            geom.updateUniforms({
                time: (performance.now() / 1000) % 1000,
                resolution: [canvas.width, canvas.height],
            });

            const context = canvas.getContext('webgpu');
            if (!context) return;
            const view = context.getCurrentTexture().createView();
            geom.render(view, [0, 0, 0.02, 1]);

            frameCount++;
            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
                const fps = frameCount / ((now - lastFpsTime) / 1000);
                stats.textContent = `FPS: ${fps.toFixed(0)} | Stars: ${MAX_STARS.toLocaleString()}`;
                frameCount = 0;
                lastFpsTime = now;
            }
        });

        loop.start();

        const context = canvas.getContext('webgpu')!;
        const resizeObserver = new ResizeObserver(() => {
            canvas.width = window.innerWidth * devicePixelRatio;
            canvas.height = window.innerHeight * devicePixelRatio;
            context.configure({
                device: renderer.device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'premultiplied',
            });
            geom.updateUniforms({
                resolution: [canvas.width, canvas.height],
            });
        });
        resizeObserver.observe(canvas);

        return () => {
            loop.stop();
            resizeObserver.disconnect();
            geom.destroy();
        };
    },
};

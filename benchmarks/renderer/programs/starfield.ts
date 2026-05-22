import { GameLoop, SimpleRNG } from 'murow';
import { WebGPU2DRenderer, d, std } from 'murow/webgpu';
import type { Control, ControlValues, Program, ProgramHandle } from '..';

const DEFAULT_MAX_STARS = 1_000;
const DEFAULT_SPEED = 1.0;

const controls: Control[] = [
    { kind: 'number', key: 'maxStars', label: 'Max stars', min: 1, max: 50_000, step: 100, default: DEFAULT_MAX_STARS, restart: true },
    { kind: 'number', key: 'speed', label: 'Speed', min: 0, max: 10, step: 0.1, default: DEFAULT_SPEED },
];

export const starfield: Program = {
    name: 'Starfield',
    controls,

    async init(canvas: HTMLCanvasElement, stats: HTMLElement, values: ControlValues): Promise<ProgramHandle> {
        const maxStars = Math.max(1, Math.floor(values.maxStars ?? DEFAULT_MAX_STARS));
        let speedMultiplier = values.speed ?? DEFAULT_SPEED;

        const renderer = new WebGPU2DRenderer(canvas, {
            maxSprites: 1,
            clearColor: [0, 0, 0.02, 1],
            autoResize: true,
        });
        await renderer.init();

        const rng = new SimpleRNG(0xC0FFEE);

        const geom = renderer
            .createGeometry('starfield', { maxInstances: maxStars, geometry: 'quad' })
            .instanceLayout({
                dynamic: { position: d.vec2f },
                static: { speed: d.f32, phase: d.f32 },
            })
            .uniforms({ time: d.f32, resolution: d.vec2f, speedMultiplier: d.f32 })
            .shaders({
                vertex: {
                    out: { brightness: d.f32, localUV: d.vec2f },
                    fn({ dynamic, statics, uniforms }, input) {
                        const starPos = dynamic[input.instanceIndex].position;
                        const speed = statics[input.instanceIndex].speed;
                        const phase = statics[input.instanceIndex].phase;
                        const time = uniforms.time * uniforms.speedMultiplier;
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
                    },
                },
                fragment: {
                    fn(input) {
                        const dist = std.length(input.localUV as number);
                        const glow = std.pow(std.saturate(1.0 - dist), 3.0);
                        const c = glow * (input.brightness as number);
                        return d.vec4f(c * 0.9, c * 0.95, c, glow);
                    },
                },
            })
            .build();

        // Initialize stars
        for (let i = 0; i < maxStars; i++) {
            geom.addInstance({
                position: [rng.rand(), rng.rand()],
                speed: 0.5 + rng.rand(),
                phase: rng.rand() * Math.PI * 2,
            });
        }

        geom.updateUniforms({
            time: 0,
            resolution: [canvas.width, canvas.height],
            speedMultiplier,
        });

        let frameCount = 0;
        let lastFpsTime = performance.now();

        const loop = new GameLoop({ tickRate: 1, type: 'client' });
        let time = 0;

        loop.events.on('render', ({ deltaTime }) => {
            time += deltaTime;

            geom.updateUniforms({ time, speedMultiplier });
            geom.render();

            frameCount++;
            const now = performance.now();
            if (now - lastFpsTime >= 1000) {
                const fps = frameCount / ((now - lastFpsTime) / 1000);
                stats.textContent = `FPS: ${fps.toFixed(0)} | Stars: ${maxStars.toLocaleString()}`;
                frameCount = 0;
                lastFpsTime = now;
            }
        });

        renderer.onResize((width, height) => {
            geom.updateUniforms({ resolution: [width, height] });
        });

        loop.start();

        return {
            onControlChange(key, value) {
                if (key === 'speed') speedMultiplier = value;
            },
            destroy() {
                loop.stop();
                geom.destroy();
            },
        };
    },
};

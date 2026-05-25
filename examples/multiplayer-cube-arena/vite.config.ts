import { defineConfig } from 'vite';
import path from 'path';
import typegpu from 'unplugin-typegpu/vite';

/**
 * Vite is used for the client bundle because the WebGPU renderer relies on
 * `unplugin-typegpu` to embed shader-function metadata at build time. Bun's
 * bundler doesn't run TypeGPU's transform, so attempting to use it produces
 * a `Missing metadata for tgpu.fn` ResolutionError at runtime.
 *
 * The Bun server (`server/index.ts`) is unaffected — it never touches the
 * WebGPU renderer and is run directly via `bun run server`.
 */
export default defineConfig({
    root: path.resolve(__dirname, 'client'),
    plugins: [typegpu({})],
    resolve: {
        alias: {
            // Specific subpaths first — Vite matches in order, so these
            // win over the catch-all below for the workspace packages
            // that live outside `packages/murow/src`.
            'murow/webgpu': path.resolve(__dirname, '../../packages/webgpu/src/index.ts'),
            'murow/netcode': path.resolve(__dirname, '../../packages/netcode/src/index.ts'),
            // Catch-all for every other `murow/<subpath>` import — points
            // straight at source so edits in `packages/murow/src/**` are
            // picked up by the dev server without rebuilding the package.
            'murow/*': path.resolve(__dirname, '../../packages/murow/src/*'),
            'murow': path.resolve(__dirname, '../../packages/murow/src'),
        },
    },
    build: {
        outDir: path.resolve(__dirname, 'client/dist'),
        emptyOutDir: true,
        // WebGPU requires modern browsers anyway — these all support top-level await.
        target: ['chrome95', 'firefox92', 'safari15', 'edge95', 'es2022'],
    },
    server: {
        port: 5173,
        // Forward the WebSocket endpoint to the Bun server so the dev
        // page (served by Vite at 5173) can talk to the game server
        // (Bun at 3010) using the same relative URL the production
        // build uses. `ws: true` enables WebSocket upgrades.
        proxy: {
            '/ws': {
                target: 'ws://localhost:3010',
                ws: true,
                changeOrigin: true,
            },
        },
    },
});

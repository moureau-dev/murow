import { defineConfig } from 'vite';
import path from 'path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import typegpu from 'unplugin-typegpu/vite';

export default defineConfig({
    plugins: [basicSsl(), typegpu({})],
    resolve: {
        alias: {
            "murow/webgpu": path.resolve(__dirname, "../../packages/webgpu/src/index.ts"),
            "murow": path.resolve(__dirname, "../../packages/murow/src"),
            "murow/*": path.resolve(__dirname, "../../packages/murow/src/*"),
        },
    },
    build: {
        minify: false,
    },
    server: {
        allowedHosts: true,
    },
});

import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import typegpu from 'unplugin-typegpu/vite';

export default defineConfig({
    plugins: [basicSsl(), typegpu({})],
    resolve: {
        conditions: ['source'],
    },
    server: {
        allowedHosts: true,
    },
});

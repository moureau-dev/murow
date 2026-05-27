#!/usr/bin/env bun
/**
 * Build a self-contained `dist/` folder ready to deploy.
 *
 * Output layout:
 *   dist/
 *     server.js              - bundled server (murow inlined, ~80KB)
 *     client/dist/           - vite-built browser bundle
 *     package.json           - minimal manifest with `bun start`
 *     README.md              - one-page run instructions
 *
 * Run with `bun run build`.
 */

import { $ } from 'bun';
import { mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exampleRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(exampleRoot, 'dist');
const clientDist = join(exampleRoot, 'client', 'dist');

async function main() {
    process.chdir(exampleRoot);

    // 1. Clean any previous build output so we don't ship stale files.
    if (existsSync(dist)) await rm(dist, { recursive: true });
    await mkdir(dist, { recursive: true });

    // 2. Build the client (vite). Produces ./client/dist.
    console.log('[build] vite build...');
    await $`bun run build:client`;
    if (!existsSync(clientDist)) {
        throw new Error('vite build did not produce client/dist');
    }

    // 3. Bundle the server into a single file with murow inlined.
    console.log('[build] bundling server...');
    await $`bun build server/index.ts --target=bun --outfile=${join(dist, 'server.js')} --minify`;

    // 4. Copy the client bundle to where the server expects it at runtime.
    //    The server reads `./client/dist` relative to its working directory,
    //    so we preserve that path inside dist/.
    console.log('[build] copying client assets...');
    await mkdir(join(dist, 'client'), { recursive: true });
    await cp(clientDist, join(dist, 'client', 'dist'), { recursive: true });

    // 5. Minimal package.json so `bun start` works on the VPS.
    const pkg = {
        name: 'cube-arena-server',
        type: 'module',
        private: true,
        scripts: {
            start: 'bun server.js',
        },
    };
    await writeFile(join(dist, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

    // 6. Run instructions.
    const readme = [
        '# cube-arena (deploy bundle)',
        '',
        'Requires Bun on the host. Install:',
        '',
        '```',
        'curl -fsSL https://bun.sh/install | bash',
        '```',
        '',
        'Run:',
        '',
        '```',
        'bun start',
        '```',
        '',
        'Listens on `process.env.PORT` (default 3010). WebSocket upgrades',
        'happen on `/ws`; everything else is served from `client/dist`.',
        '',
        'Example with a reverse proxy on a different port:',
        '',
        '```',
        'PORT=4000 bun start',
        '```',
        '',
    ].join('\n');
    await writeFile(join(dist, 'README.md'), readme);

    console.log(`[build] done.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

import { build } from 'esbuild'
import { Glob } from 'bun';

const exclude = [
    '.test.ts',
    'types.ts',
    'example.ts'
];

const files = ['index.ts'];

const pattern = [files].flat();

async function main() {
    const glob = new Glob(pattern.join(','));
    const scannedFiles = await Array.fromAsync(glob.scan({ cwd: './src' }));
    const entryPoints = scannedFiles
        .filter((file) => !exclude.some(avoid => file.includes(avoid)))
        .map((fileName) => `./src/${fileName}`);

    await Promise.all([
        build({
            entryPoints,
            outbase: 'src',
            outdir: 'dist/esm',
            format: 'esm',
            platform: 'browser',
            packages: 'external',
            // minify: true,
            bundle: true,
        }),
        build({
            entryPoints,
            outbase: 'src',
            outdir: 'dist/cjs',
            format: 'cjs',
            platform: 'browser',
            packages: 'external',
            // minify: true,
            bundle: true,
        }),
        // Single-file bundle for CDN use — all deps inlined so TypeGPU's
        // $internal Symbol is shared across a single module boundary.
        build({
            entryPoints: ['./src/index.ts'],
            outbase: 'src',
            outfile: 'dist/esm/murow.webgpu.bundle.js',
            format: 'esm',
            platform: 'browser',
            bundle: true,
            minify: true,
        }),
    ]);
}

main();

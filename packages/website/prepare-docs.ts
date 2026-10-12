/**
 * Prepare the deployed docs copy.
 *
 * The repo keeps `docs/*.md` and `llms.txt` with relative links so they work on
 * GitHub. The website serves a copy under `public/`, where:
 *   - links must be absolute (a fetcher pulling a URL cannot resolve `./x.md`), and
 *   - docs must also be available as `.txt`, since AI tooling reads `.txt`.
 *
 * This runs after the copy. For every `public/docs/*.md` it writes an
 * absolutized `.md` (unchanged links) and an absolutized `.txt` (with the
 * doc-to-doc links rewritten from `.md` to `.txt`), and it absolutizes
 * `public/llms.txt` with its links pointed at the `.txt` docs.
 *
 * Run by the website `prebuild` script against `public/`.
 */
import { Glob } from 'bun';

const BASE = 'https://murow.moureau.dev';
const ANCHOR = '(?:#[A-Za-z0-9_-]+)?';

function absolutize(source: string): string {
    return source
        // docs: ./x.md or ./x.txt
        .replace(new RegExp(`\\]\\(\\./([A-Za-z0-9-]+\\.(?:md|txt)${ANCHOR})\\)`, 'g'), `](${BASE}/docs/$1)`)
        // llms.txt -> docs: ./docs/x.md or ./docs/x.txt
        .replace(new RegExp(`\\]\\((\\./docs/[A-Za-z0-9-]+\\.(?:md|txt)${ANCHOR})\\)`, 'g'), (_, p) => `](${BASE}/${p.replace(/^\.\//, '')})`)
        // docs -> llms.txt: ../llms.txt
        .replace(/\]\(\.\.\/llms\.txt\)/g, `](${BASE}/llms.txt)`);
}

let docs = 0;
for await (const file of new Glob('docs/*.md').scan({ cwd: './public' })) {
    const mdPath = `./public/${file}`;
    const md = await Bun.file(mdPath).text();

    // Served .md — absolute links, unchanged (keeps working for browsers / GitHub-style readers).
    await Bun.write(mdPath, absolutize(md));

    // Served .txt — doc-to-doc links point at .txt, then absolutized.
    const txt = absolutize(md.replace(/(\.\/[A-Za-z0-9-]+\.)md/g, '$1txt'));
    await Bun.write(mdPath.replace(/\.md$/, '.txt'), txt);

    docs++;
}

{
    const path = './public/llms.txt';
    const source = await Bun.file(path).text();
    // Point the docs index at the .txt copies, then absolutize.
    await Bun.write(path, absolutize(source.replace(/(\.\/docs\/[A-Za-z0-9-]+\.)md/g, '$1txt')));
}

console.log(`prepare-docs: wrote .md + .txt for ${docs} doc(s), and llms.txt`);

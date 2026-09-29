# Murow — AI Development Guide

## Critical rules

- **Do NOT commit or push any changes without explicit user consent.**
- Stage specific files by path. Never `git add -A` / `git add .`, and review
  `git diff --cached` before committing.
- Do not add runtime dependencies without explicit permission.

## Ground truth

`llms.txt` at the repo root is the canonical AI reference for this codebase:
exports, patterns, and an anti-hallucination list of APIs that do not exist. It
is also served at https://murow.moureau.dev/llms.txt. Read the relevant section
before writing Murow code; it overrides training knowledge.

## JSDoc style

Keep doc comments clean, concise, plain English. No em dashes, no developer
anecdotes, no bug explanations. Describe what it is, not how it got that way.
Prefer JSDoc on the public API over inline comments.

## Documentation

After a significant change, update the relevant docs:

- `llms.txt` (root) — canonical AI reference: exports, patterns, API surface
- `README.md` (root) — overview and examples
- `packages/<pkg>/README.md` — per-package docs (murow, webgpu, netcode, website)
- `packages/murow/src/**/README.md` — per-module docs
- Website pages — `packages/website/src`, served at https://murow.moureau.dev

There is no `CHANGELOG.md` in this repo. Do not invent one.

## Project

- Use `bun`, not `node` or `npm`. Scripts still call `npm run` internally;
  invoke them with `bun run <script>`.
- TypeScript throughout. Dual ESM + CJS build via `esbuild` (`dist/esm`,
  `dist/cjs`) plus `tsc --emitDeclarationOnly` for types (`dist/types`).
- `murow` core has **zero runtime dependencies**. `murow/webgpu` needs
  `typegpu`, `acorn`, and `tinyest-for-wgsl` (declared as `optionalDependencies`
  of `murow`, bundled into the package).
- Bun workspaces monorepo:
  - `packages/murow` — the published package `murow` (core + bundled webgpu/netcode)
  - `packages/webgpu` — `@murow/webgpu`, the reference renderer backend
  - `packages/netcode` — `@murow/netcode`, the multiplayer layer
  - `packages/website` — Newstack SSG docs site
  - `examples/*` — runnable example games
  - `benchmarks` — comparative benchmarks

### Commands

Run from inside a package unless noted:

- Test: `bun test ./src`
- Typecheck: `bunx tsc --noEmit -p tsconfig.json`
- Build JS: `bun run build:js` (esbuild)
- Build types + JS: `bun run build`
- Root: `bun run build` builds every package; `bun run test` builds then tests

### Published entry points

`murow`, `murow/core`, `murow/ecs`, `murow/game`, `murow/net`,
`murow/protocol`, `murow/renderer`, `murow/webgpu`, `murow/netcode`, plus deep
globs such as `murow/core/*` and `murow/renderer/*`.

## File structure

Each module lives in its own folder:

- `<name>.ts` — implementation
- `<name>.test.ts` — co-located tests
- `index.ts` — barrel exports
- optional `README.md` — module docs

`index.ts` re-exports the folder's public API and may re-export from deeper
subfolders (for example `adapters/`).

```
packages/
├── murow/src/
│   ├── core/        # audio, bucket, clock, input, navmesh, hitbox, ray, codecs, ...
│   ├── ecs/         # World, components, systems
│   ├── game/        # GameLoop, Driver, FixedTicker
│   ├── net/         # ServerNetwork / ClientNetwork
│   ├── protocol/    # intents, snapshots, RPCs
│   └── renderer/    # renderer contracts + asset pipeline (pure CPU)
├── webgpu/src/      # 2d/, 3d/, camera/, compute/, shaders/, geometry/, ...
├── netcode/src/     # server/, client/, plugins/, ...
└── website/src/     # Newstack pages
```

## Conventions

Murow is data-oriented. Do not import patterns from Unity, Three.js, or Phaser.

- No entity/component classes. Components are typed binary schemas
  (`defineComponent`); an entity is a plain `number`.
- No scene graph, `Object3D`, or live per-frame material editing.
- No per-frame object allocation in hot loops. Keep the data path zero-GC
  (`Float32Array`, `FreeList`, `SlotMap`).
- Simulation belongs in `tick`; drawing belongs in `render`. Do not build a
  `requestAnimationFrame` simulation loop; `GameLoop` owns ticks.
- Predictions must be deterministic: no `Math.random()`, `Date.now()`,
  `performance.now()`, no I/O, no module-level mutable state.
- The server is the authority; gameplay decisions live in server handlers.

The full anti-pattern list is in `llms.txt` ("Do NOT" and "APIs that DO NOT
EXIST"). Consult it before finalizing code.

## Commit messages

Conventional Commits: `<type>(<scope>): <lowercase imperative subject>`, no
trailing period.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `build`
- Scopes: `murow`, `webgpu`, `netcode`, `website`, `llms.txt`, `deps`

```
feat(murow): add core audio subsystem; move Bucket into core
perf(netcode): store lag-compensation history as binary frames
docs(llms.txt): refresh netcode and renderer claims
```

## Release

**Never do this without explicit user consent.**

`murow` is the only published package (version in `packages/murow/package.json`).
`webgpu` and `netcode` are bundled into it and are not published separately.
There is no changelog file.

1. Bump `version` in `packages/murow/package.json`.
2. Commit: `git commit -m "chore(murow): release v<VERSION>"`.
3. Push to `main`.
4. Verify locally from the repo root: `bun run build` then `bun run test`, then
   `npm pack` inside `packages/murow` to confirm the tarball contents. Delete
   the generated `.tgz`.
5. Create a GitHub release:
   `gh release create v<VERSION> --title "v<VERSION>" --notes "<summary>"`.
6. Watch the triggered run to completion:
   `gh run list --workflow publish.yml --limit 1`, then
   `gh run watch <run-id> --exit-status`.

`.github/workflows/publish.yml` checks out the tag, runs `bun run build`,
`bun run test --bail`, and `npm publish` from `packages/murow`. There is no
separate npm step. npm propagation lags the workflow by a few minutes, so
`npm view murow@<VERSION>` can 404 while the run already shows success. Wait and
re-check rather than publishing by hand.

## Website

`packages/website` is the docs site (Newstack SSG), deployed to
https://murow.moureau.dev. Build with `bun run build` (its `prebuild` copies the
root `llms.txt` into `public/`), then deploy with `bun deploy.ts`, which reads
the Basebox keys from `packages/website/.env`.

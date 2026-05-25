# Multiplayer Cube Arena

A small end-to-end example of `murow/netcode` driving `murow/webgpu`.

Each connected player spawns as a colored cube on a shared grid. WASD
moves your cube with client-side prediction; other players' cubes are
interpolated 100 ms behind their authoritative state. The camera orbits
your cube in third person — purely local state, never networked.

The game is 2D in logic (no jumping, no Y-axis movement) but rendered in
3D using cube and grid prefabs from `PrefabBucket`.

## Run

From the repo root:

```sh
bun install
bun run --filter @murow/monorepository build    # (builds murow + webgpu + multiplayer)

# Then in this folder:
cd examples/multiplayer-cube-arena

# Production-style: build the client bundle once, serve everything from the Bun server.
bun run dev

# Or, for iterating on the client with HMR:
bun run server               # in one terminal — runs the WS + HTTP server
bun run dev:client           # in another — Vite dev server with hot reload at :5173
```

Open <http://localhost:3011> (or <http://localhost:5173> in dev mode) in
two browser tabs. Each tab gets its own cube; you'll see the other tab's
cube smoothly catching up over the network.

The client uses **Vite + `unplugin-typegpu`** for bundling because the
WebGPU renderer relies on the plugin to embed shader-function metadata.
Bun's bundler doesn't run TypeGPU's transform — using it produces a
`Missing metadata for tgpu.fn` runtime error. The server is still
Bun-only.

## Layout

```
multiplayer-cube-arena/
├── package.json
├── README.md
├── vite.config.ts              Vite + unplugin-typegpu for the client
├── shared/                  ── shared schema, imported by both sides
│   ├── constants.ts            tick rate, ports, world bounds
│   ├── components.ts           Position + Color
│   ├── protocol.ts             intents + (empty) rpcs
│   ├── predictions.ts          shared `move` prediction
│   └── index.ts
├── server/
│   └── index.ts                Bun WebSocket server + GameServer
└── client/
    ├── index.html              minimal HUD
    ├── index.ts                renderer, GameClient, camera, input
    └── dist/                   (built by `bun run build:client`)
```

## Why this layout

- **`shared/` is imported by both sides.** That's what makes prediction
  work — the same `move` function runs on the server (authoritative) and
  on each client (predicted). Components live here too so both worlds
  agree on the wire format.
- **`server/` is Bun-only.** It spawns one cube per peer, runs the loop
  at the same tick rate as clients, and ships snapshots through
  `BunWebSocketServerTransport`.
- **`client/` is browser-only.** It bundles to `client/index.js` via Bun's
  bundler, then the server serves the HTML + JS over plain HTTP. WebGPU
  rendering, third-person camera, WASD input.

## Notable points in the code

- **Movement is yaw-rotated** in the client (`client/index.ts`). The
  WASD vector is multiplied by the camera yaw matrix before being sent
  as an intent, so "W" always means "away from the camera" rather than a
  fixed world direction. This produces the same intent on both sides, so
  the prediction stays deterministic — only the input mapping is
  client-local.
- **The local entity is auto-assigned** by the server via
  `server.assignEntity(peer, e)`. The engine ships a `MSG_ASSIGN_ENTITY`
  frame to the client, which fires the typed `'assigned'` event and
  marks the entity predicted so the interpolation buffer leaves it
  alone. No client-side bookkeeping required — `client.sendIntent('move',
  ...)` defaults `ctx.entity` to the assigned entity.
- **The camera is never networked.** Yaw, pitch, and distance are local
  state — every client sees the same authoritative cube positions but
  through their own camera.
- **No `defineHandlers`** in this demo. The only intent (`move`) is
  predictable, so the shared prediction is the authoritative apply on
  the server. If you wanted a "shoot" intent that resolves hits, you'd
  add `defineHandlers` on the server with `ctx.lagCompensated` for the
  hit detection.

## Configuration knobs you can twist

- `shared/constants.ts → TICK_RATE` — try 10, 15, 30. Both sides read the
  same value, so changing one number changes the whole sim.
- `shared/constants.ts → MOVE_SPEED` — world units per second.
- `client/index.ts → interpolation.delay` — try 0 (jittery), 100
  (default, smooth), 250 (heavy lag visible on other players).
- `client/index.ts → camera.distance` — third-person zoom.

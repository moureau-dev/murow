/* ---------- External ---------- */
import Newstack from "@moureau/newstack";

const LLMS_URL = "/llms.txt";
const GITHUB_URL = "https://github.com/moureau-dev/murow";
const NPM_URL = "https://www.npmjs.com/package/murow";

const SECTIONS = [
  {
    id: "ecs",
    title: "Data-oriented ECS",
    paragraphs: [
      "Murow's World stores components as typed binary schemas in Structure-of-Arrays layout: one flat typed array per field, not objects per entity. A component is a descriptor, not a class; an entity is a plain number.",
      "There are five access tiers so you pick the right trade-off per system: RAW (manual typed-array hoisting, fastest), Fields (one typed bundle per component, the recommended default for hand-written systems), Hybrid and Ergonomic (the System Builder, for readability), and Direct (one-off work, slowest, never in hot loops).",
      "It holds 60 FPS at 50k entities and scales to ~100k, beating bitECS up to ~25k entities on a 2011 CPU with substantially tighter worst-case frame times (no GC spikes).",
    ],
  },
  {
    id: "loop",
    title: "Fixed-tick simulation",
    paragraphs: [
      "The GameLoop is the heartbeat: a fixed-rate tick for deterministic game logic and a variable-rate render with interpolation. Tick rate is configurable (10-30 Hz is typical for multiplayer); the renderer smoothly interpolates the frames in between.",
      "Drivers cover every context: requestAnimationFrame on the client, setImmediate / setTimeout on the server, and manual mode for tests or driving many simulations from one clock. Determinism is first-class: seed a SimpleRNG instead of Math.random for replays and lockstep.",
    ],
  },
  {
    id: "netcode",
    title: "Server-authoritative netcode",
    paragraphs: [
      "The high-level layer (murow/netcode) gives you GameServer and GameClient. You define intents, predictions, and networked components once in shared code; the server applies predictions authoritatively and ships snapshot deltas, while the client runs the same prediction speculatively and reconciles via rollback + replay when the authoritative state arrives.",
      "Underneath sits a lower-level layer (murow/net + murow/protocol) with transport-agnostic networking and binary codecs, for when you need a custom snapshot pipeline. Both ship in the one package.",
    ],
  },
  {
    id: "plugins",
    title: "Lag compensation & interest management",
    paragraphs: [
      "Hit detection is only fair if the server checks against the world as the shooter saw it. The LagCompensation plugin rewinds registered components to the client's tick inside a handler, so hitscan lands where the player aimed.",
      "For large worlds, the AoiGrid plugin replicates only the entities within a peer's area of interest, with hysteresis to avoid boundary flicker: bandwidth scales with what each player can perceive, not with the whole world.",
    ],
  },
  {
    id: "renderer",
    title: "WebGPU renderer (2D + 3D)",
    paragraphs: [
      "murow/webgpu is the reference backend, powered by TypeGPU. It handles GPU-side frame interpolation (your low tick-rate simulation looks smooth at 144 Hz), frustum culling, distance-based animation culling for crowds, sparse-batched draw calls, glTF skeletal animation with crossfade, and instance recycling: none of which you write yourself.",
      "The engine itself is renderer-agnostic: the abstract renderer contracts, asset pipeline (AssetBucket, glTF and spritesheet parsing, skeletal animation), and CPU hitbox/raycasting are pure CPU. Subclass the base renderer to target Three.js, Pixi, or anything else.",
    ],
  },
  {
    id: "compute",
    title: "Compute shaders & typed DSL",
    paragraphs: [
      "Write WGSL in TypeScript with full type safety. ComputeBuilder / ComputeKernel make GPU compute first-class: particle physics, simulation, anything massively parallel and custom instanced geometry can read straight from a compute buffer with zero copies.",
      "The same typed data-layout DSL (d and std) describes buffers and the math you run inside vertex, fragment, and compute closures.",
    ],
  },
];

export class Package extends Newstack {
  /* ---------- Lifecycle ---------- */
  prepare({ page, environment }) {
    page.title = "Murow — Package";
    page.description =
      "A deeper look at the Murow package: data-oriented ECS, fixed-tick simulation, server-authoritative netcode, lag compensation, the WebGPU renderer, and compute shaders.";

    if (environment === 'client') {
      window.scrollTo(0,0);
    }
  }

  render() {
    return (
      <>
        <article class="package">
          <a class="package__back" href="/">← Back</a>

          <header class="package__header">
            <h1 class="package__title">What's in the box</h1>
            <p class="package__lead">
              The <code class="home__inline-code">murow</code> npm package ships the core engine,
              the <code class="home__inline-code">murow/webgpu</code> renderer, and the{" "}
              <code class="home__inline-code">murow/netcode</code> multiplayer layer. Here's what
              each part does.
            </p>

            <div class="package__install">
              <code class="home__code">bun install murow</code>
            </div>
          </header>

          {SECTIONS.map((s) => (
            <section class="package__section" id={s.id}>
              <h2 class="package__section-title">{s.title}</h2>
              {s.paragraphs.map((p) => (
                <p class="package__paragraph">{p}</p>
              ))}
            </section>
          ))}

          <section class="package__cta">
            <p class="package__cta-text">
              The full, AI-readable API reference lives in <code class="home__inline-code">llms.txt</code>.
            </p>
            <div class="home__links">
              <a class="home__link" href={LLMS_URL} target="_blank" rel="noopener noreferrer">
                llms.txt
              </a>
              <a class="home__link" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <a class="home__link" href={NPM_URL} target="_blank" rel="noopener noreferrer">
                npm
              </a>
            </div>
          </section>
        </article>

        <footer class="home__footer">
          Made with ❤️ by{" "}
          <a href="https://moureau.dev" target="_blank" rel="noopener noreferrer">
            moureau.dev
          </a>
        </footer>
      </>
    );
  }
}

/* ---------- External ---------- */
import Newstack, { NewstackClientContext } from "@moureau/newstack";
import { Clipboard, IconClaude, IconGithub, IconNpm, IconOpenAI, IconSpinner } from "./icons";

const LLMS_URL = "/llms.txt";
const GITHUB_URL = "https://github.com/moureau-dev/murow";
const NPM_URL = "https://www.npmjs.com/package/murow";

const AI_PROMPT = "Read https://murow.moureau.dev/llms.txt and help me build a game with Murow";

const FEATURES = [
  {
    title: "Data-oriented ECS",
    body: "Structure-of-Arrays storage with five API tiers, from one-liners to zero-overhead hot loops. Holds 60 FPS at 50k entities, scales to 100k, with tighter tail-variance than other JS ECS libraries.",
  },
  {
    title: "Server-authoritative netcode",
    body: "GameServer / GameClient with snapshot deltas, client-side prediction, and rollback reconciliation. Define intents and predictions once; they run identically on both sides.",
  },
  {
    title: "Lag compensation & interest",
    body: "Server-side rewind for fair hitscan against what the shooter saw, plus an area-of-interest grid that only replicates what each peer can perceive.",
  },
  {
    title: "WebGPU renderer (2D + 3D)",
    body: "GPU-side frame interpolation, frustum and animation culling, instanced draw batching, and glTF skeletal animation — smooth at 144 Hz off a 15 Hz simulation.",
  },
  {
    title: "Compute & typed shaders",
    body: "Write WGSL in TypeScript with full type safety via TypeGPU. Compute kernels and custom instanced geometry are first-class, not bolted on.",
  },
  {
    title: "Renderer-agnostic core",
    body: "ECS, game loop, netcode, asset pipeline, and collision run entirely on the CPU, so the same logic powers a headless server. The WebGPU renderer is just one backend; bring your own.",
  },
];

const AI_OPTIONS = [
  { label: "Copy llms.txt", action: "copy", Icon: Clipboard },
  {
    label: "Open in ChatGPT",
    href: `https://chatgpt.com/?q=${encodeURIComponent(AI_PROMPT)}`,
    Icon: IconOpenAI,
  },
  {
    label: "Open in Claude",
    href: `https://claude.ai/new?q=${encodeURIComponent(AI_PROMPT)}`,
    Icon: IconClaude,
  },
];

export class Home extends Newstack {
  /* ---------- Proxies ---------- */
  copied: boolean;
  cmd: string = "bun install murow";
  llmsOpen: boolean = false;
  llmsCopied: boolean;
  llmsLoading: boolean;
  home: HTMLDivElement;

  /* ---------- Refs ---------- */
  menuWrapper: HTMLDivElement;

  /* ---------- Lifecycle ---------- */
  prepare({ page }) {
    page.title = "Murow";
    page.description =
      "A TypeScript game engine for server-authoritative multiplayer games. Data-oriented ECS, fixed-tick simulation, prediction with rollback, and a WebGPU renderer.";
  }

  hydrate() {
    document.addEventListener('click', (event) => {
      this.closeLlmsMenu({ event });
    });
  }

  /* ---------- Methods ---------- */
  async copy() {
    await navigator.clipboard.writeText(this.cmd);
    this.copied = true;
    setTimeout(() => (this.copied = false), 2000);
  }

  toggleLlmsMenu() {
    this.llmsOpen = !this.llmsOpen;
  }

  closeLlmsMenu({ event }: Partial<NewstackClientContext>) {
    if (this.menuWrapper?.contains(event.target as Node)) return;
    this.llmsOpen = false;
  }

  async copyLlmsContent() {
    this.llmsLoading = true;
    try {
      const res = await fetch(LLMS_URL);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      this.llmsCopied = true;
      this.llmsOpen = false;
      setTimeout(() => (this.llmsCopied = false), 2000);
    } finally {
      this.llmsLoading = false;
    }
  }

  /* ---------- Renderers ---------- */
  renderCommand() {
    return (
      <div class="home__command-wrapper">
        <div class="home__command">
          <code class="home__code">{this.cmd}</code>
          <button class="home__copy" onclick={this.copy}>
            {this.copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
    );
  }

  render() {
    return (
      <>
        <div class="home" ref={this.home}>
          <div class="home__content">
            <h1 class="home__title">
              Murow
            </h1>

            <p class="home__subtitle">
              A lean TypeScript game engine for sim-first <strong>server-authoritative multiplayer</strong>:
              <br />
              data-oriented ECS, fixed-tick simulation, prediction with rollback,
              <br />
              and a WebGPU renderer. One install: <code class="home__inline-code">murow</code>.
            </p>

            {this.renderCommand()}

            <div class="home__links">
              <a
                class="home__link"
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <IconGithub /> GitHub
              </a>

              <a
                class="home__link"
                href={NPM_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <IconNpm /> npm
              </a>

              <a
                class="home__link"
                href={LLMS_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                llms.txt
              </a>
            </div>

            <div class="home__llms-row">
              <div class="home__llms-menu-wrapper" ref={this.menuWrapper}>
                <button
                  class={`home__llms-trigger${this.llmsOpen ? " home__llms-trigger--open" : ""}`}
                  onclick={this.toggleLlmsMenu}
                >
                  {this.llmsCopied
                    ? <><i class="fa-solid fa-check" /> Copied!</>
                    : "Vibe with Murow ↓"}
                </button>

                <div class="home__llms-dropdown" data-visible={String(Boolean(this.llmsOpen))}>
                  {AI_OPTIONS.map((opt) =>
                    opt.action ? (
                      <button
                        class="home__llms-option"
                        onclick={this.copyLlmsContent}
                        disabled={Boolean(this.llmsLoading)}
                      >
                        {this.llmsLoading ? <IconSpinner /> : <opt.Icon />}
                        {this.llmsLoading ? "Fetching…" : opt.label}
                      </button>
                    ) : (
                      <a
                        class="home__llms-option"
                        href={opt.href}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <opt.Icon />
                        {opt.label}
                      </a>
                    )
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <section class="features">
          <div class="features__inner">
            <h2 class="features__heading">Everything in one package.</h2>
            <div class="features__grid">
              {FEATURES.map((f) => (
                <div class="feature">
                  <h3 class="feature__title">{f.title}</h3>
                  <p class="feature__body">{f.body}</p>
                </div>
              ))}
            </div>

            <a class="features__more" href="/package">
              Read more about the package →
            </a>
          </div>
        </section>

        <footer class="home__footer">
          Made with ❤️ by{' '}
          <a href="https://moureau.dev" target="_blank" rel="noopener noreferrer">
            moureau.dev
          </a>
        </footer>
      </>
    );
  }
}

# Newstack — AI Reference Guide

Newstack is a full-stack SSR/SSG/SPA framework with proxy-based reactivity, no virtual DOM, and an esbuild bundler. Components run on both server and client.

**This is not React, Vue, or Svelte.** Do not apply patterns from those frameworks. No JSX imports, no hooks, no stores, no signals, no className, no onClick, no style objects, no key reconciliation.

---

## Component Anatomy

```tsx
import Newstack, { type NewstackClientContext } from "newstack";

export class Counter extends Newstack {
  // State: plain class properties. Setting them triggers re-render automatically.
  count = 0;

  // Runs on server (SSR) AND on client before first render.
  // Use for data fetching, initializing state from context.
  prepare(context: NewstackClientContext) {
    context.page.title = "Counter";
  }

  // Runs on client only, after DOM is painted. Use for subscriptions, timers, etc.
  hydrate(context: NewstackClientContext) {
    console.log("mounted");
  }

  // Runs on client whenever any property on this component changes.
  update(context: NewstackClientContext) {}

  // Runs on client when component is removed from DOM.
  destroy(context: NewstackClientContext) {}

  // Required. Runs on server (SSR) and client. Returns JSX.
  render(context: NewstackClientContext) {
    return <div>{this.count}</div>;
  }
}
```

- All lifecycle methods are **optional** except `render`.
- `this` inside render is **always the proxy** — mutating `this.count++` triggers a re-render.
- Components must be **classes** (not functions).
- `this.prepared` and `this.hydrated` are set to `true` automatically after each lifecycle completes. Use in `render()` to show loading states.

---

## Reactivity

Just set properties. No setState, no signals, no stores.

```tsx
this.count++;                    // re-renders
this.user = { name };            // re-renders
this.items = [...this.items, x]; // re-renders
this.items.push(x);              // re-renders — works from event handlers, Promise callbacks, timers, anywhere
this.items[0] = x;               // re-renders
this.items.length = 0;           // re-renders
delete this.prop;                // re-renders
```

Array mutation methods (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`) are fully reactive regardless of call context.

**Reactivity is shallow — only top-level component properties are tracked.** Nested mutations are silent:

```tsx
this.user.name = "new";         // ❌ silent — no re-render
this.user = { ...this.user, name: "new" }; // ✅

this.matrix[0].push(x);        // ❌ silent — nested array not reactive
this.matrix[0] = [...this.matrix[0], x];   // ✅
```

`prepare` and `hydrate` (including async) are fully batched — all mutations are collected and a single re-render fires when they complete.

---

## Method Arguments & Context

All component methods receive **exactly one argument: the context object**. This is a hard rule.

```ts
// ✅ correct
method(context: NewstackClientContext) {}
method({ event, router }: NewstackClientContext) {}

// ❌ never do this
method(id) {}
method(context, id) {}
method("string") {}
```

When calling a method manually, pass an object — it is **merged into the context**:

```tsx
// ✅ correct — id is merged into context, router/event/etc. are still accessible
<button onclick={() => this.removeTodo({ id: todo.id })}>

// ❌ wrong — positional or non-object args are not injected
<button onclick={() => this.removeTodo(todo.id)}>
```

```ts
removeTodo({ id }: NewstackClientContext & { id: string }) {
  this.todos = this.todos.filter(t => t.id !== id);
}
```

---

## Event Handlers

Two valid forms:

```tsx
// Arrow function — inline logic, full control
<button onclick={() => this.count++}>+</button>

// Method reference — auto-binds this, passes full context as first arg
<button onclick={this.handleClick}>click</button>
```

With method reference, the method receives the full context including the DOM `event`:

```tsx
handleClick({ event, router }: NewstackClientContext) {
  console.log(event.target);
  this.count++;
}
```

`e.preventDefault()` is called automatically on all events. For "submit on Enter" behaviour, use a `<form>` with `onsubmit` instead of listening for `onkeydown` — it handles Enter natively, works with accessibility, and is already prevented by default:

```tsx
<form onsubmit={this.addTodo}>
  <input bind={this.newTodo} />  {/* shorthand — see Two-Way Binding */}
  <button type="submit">Add</button>
</form>
```

```ts
addTodo({ event }: NewstackClientContext) {
  if (!this.newTodo.trim()) return;
  this.todos = [...this.todos, this.newTodo];
  this.newTodo = "";
}
```

---

## Two-Way Binding

Use `bind={this.prop}` on any input, textarea, or select:

```tsx
<input bind={this.name} />
<input type="checkbox" bind={this.checked} />
<select bind={this.selected}>...</select>
```

Nested properties work too:

```tsx
// ✅ works — object is initialized
form = { name: "", age: 0 };
<input bind={this.form.name} />

// ✅ works — empty object is fine
form: Partial<{ name: string }> = {};
<input bind={this.form.name} />

// ❌ fails — form is undefined, this.form.name throws at runtime
form;
<input bind={this.form.name} />
```

- For text inputs: syncs `el.value` ↔ `this.prop`.
- For checkboxes: syncs `el.checked` ↔ `this.prop`.
- Works with `oninput` / `onchange` under the hood — don't add those manually.
- Nested objects must be **at minimum initialized to `{}`** — binding to a property of `undefined` will throw.

**CDN / no-build usage:** the `bind={this.prop}` shorthand relies on a build-time transform that is not available when using Newstack via CDN. Use the explicit object form instead:

```tsx
// ✅ works everywhere including CDN
<input bind={{ object: this, property: 'newTodo' }} />

// ❌ only works with the esbuild bundler
<input bind={this.newTodo} />
```

---

## Element Refs

Use `ref={this.prop}` to get a direct reference to a DOM element or component instance after mount. The bundler rewrites `ref={this.dialog}` to `ref={{ object: this, property: 'dialog' }}` at build time so the renderer can assign the live element directly.

```tsx
export class Modal extends Newstack {
  dialog: HTMLDialogElement;

  open() {
    this.dialog.showModal();
  }

  close() {
    this.dialog.close();
  }

  render() {
    return (
      <>
        <button onclick={() => this.open()}>Open</button>
        <dialog ref={this.dialog}>
          <p>Hello!</p>
          <button onclick={() => this.close()}>Close</button>
        </dialog>
      </>
    );
  }
}
```

- `ref` is set after the element is mounted — safe to use in `hydrate()` and later. **Never access a ref in `prepare()` — it runs on the server where there is no DOM, so `this.dialog` will be `undefined`.**
- Works on any HTML element or Newstack class component.
- `ref` never appears as an HTML attribute.
- **CDN / no-build:** the `ref={this.prop}` shorthand requires the esbuild transform. Not available without a build step.

```tsx
// ✅ works everywhere including CDN
<dialog ref={{ object: this, property: 'dialogRef' }} />

// ❌ only works with the esbuild bundler
<dialog ref={this.dialogRef} />
```

---

## Context

Two context shapes exist. On the server, `environment === "server"`. On the client, `environment === "client"`.

```ts
// Always available
context.environment       // "server" | "client"
context.page.title        // sets <title>
context.params            // route params e.g. { id: "42" }
context.fingerprint       // build hash — useful for cache-busting
context.project.name      // site name from NEWSTACK_PROJECT_NAME
context.project.domain    // domain from NEWSTACK_PROJECT_DOMAIN
context.project.favicon   // favicon path from NEWSTACK_PROJECT_FAVICON
context.project.cdn       // CDN base URL from NEWSTACK_PROJECT_CDN
context.project.color     // theme color from NEWSTACK_PROJECT_COLOR
context.deps              // injected dependencies (db, logger, etc.)
context.instances         // named component instances registered via key=""
context.instances.auth    // safe — returns {} if not yet registered

// Client only
context.router.path       // current path string
context.event             // DOM Event — set when called from an event handler

// Server only
context.path              // request path
context.secrets           // server-only secrets from env
```

Project metadata is set via env vars prefixed with `NEWSTACK_PROJECT_`:

```bash
# .env
NEWSTACK_PROJECT_NAME="My App"
NEWSTACK_PROJECT_DOMAIN="myapp.com"
NEWSTACK_PROJECT_FAVICON="/favicon.png"
NEWSTACK_PROJECT_COLOR="#101010"
NEWSTACK_PROJECT_CDN="https://cdn.myapp.com"
```

These are automatically injected into OG tags, Twitter Cards, PWA meta tags, favicon and icon links in the SSR template.

---

## Routing

Define routes inline with the `route` prop:

```tsx
render(context) {
  return (
    <main>
      <Home route="/" />
      <About route="/about" />
      <Profile route="/profile/:id" />
      <NotFound route="*" />
    </main>
  );
}
```

- Components with a non-matching `route` render as `<!---->` (invisible).
- Dynamic params are available via `context.params.id`.
- `route="*"` is a catch-all.
- Client navigation is handled automatically — all `<a>` tags are intercepted via a delegated listener, including ones added dynamically after hydration.
- Links with `target="_blank"`, external URLs, `#hash`, `mailto:`, and `tel:` are not intercepted and behave normally.

---

## Server Functions

Static async methods on a component execute on the server. The client calls them via a generated POST route.

```tsx
export class UserList extends Newstack {
  users = [];

  // Runs on server. Has access to context.deps.
  static async getUsers(context: NewstackServerContext) {
    return context.deps.db.query("SELECT * FROM users");
  }

  async hydrate(context: NewstackClientContext) {
    // Calling a static method from the client POSTs to /api/newstack/:hash/getUsers
    this.users = await UserList.getUsers(context);
  }

  render() {
    return <ul>{this.users.map(u => <li>{u.name}</li>)}</ul>;
  }
}
```

- Static methods receive `context` as their first argument.
- Return value is JSON-serialized and sent to client.
- Never expose secrets in return values — the response goes to the browser.

---

## Component Instances (`key` + `context.instances`)

> **`key` is not for list iteration.** Unlike React, Newstack does not use `key` to reconcile list items — it has no meaning on plain elements or in `.map()` calls. `key` only does something when placed on a **class component** — it registers that instance in `context.instances` so other components can access it by name.

Register a component by name so other components can access it via `context.instances`:

```tsx
// Register
<Sidebar key="sidebar" />

// Access from any component
render(context) {
  const sidebar = context.instances.sidebar;
  return <button onclick={() => sidebar.open = true}>Open</button>;
}
```

- `key` is a string identifier — the component is available as `context.instances[key]`.
- Accessing an unregistered instance returns `{}` (safe — no crash).
- Components without `render()` work fine as instances (e.g. service/store components).

**Typed instances** — augment `NewstackInstances` to get full type inference:

```ts
// globals.d.ts
import type { Sidebar } from "./src/Sidebar";

declare module "newstack" {
  interface NewstackInstances {
    sidebar: Sidebar;
  }
}
```

After this, `context.instances.sidebar` is fully typed — no `as any` needed.

---

## Persistent Components (`persistent`)

By default, components are destroyed and re-initialized on route changes. Add `persistent` to preserve state:

```tsx
// Component state survives navigation
<AuthStore key="auth" persistent />

// From anywhere
render(context) {
  return <p>User: {context.instances.auth.user?.name}</p>;
}
```

- Combine with `key` to use as a global store accessible from `context.instances`.
- `destroy()` and `terminate()` are NOT called on route change for persistent components.
- `prepare()` and `hydrate()` still run on first mount only.

---

## Dependency Injection

Pass deps when starting the server. Available everywhere via `context.deps`.

```ts
server.start(app, {
  deps: { db, logger, config },
});
```

```tsx
prepare(context) {
  const data = await context.deps.db.find(context.params.id);
  this.data = data;
}
```

---

## Entry Point (server)

```ts
import { NewstackServer } from "newstack/server";
import { App } from "./App";

const server = new NewstackServer();
server.start(new App(), { deps: { db } });
```

---

## Entry Point (client)

```ts
import { NewstackClient } from "newstack";
import { App } from "./App";

const client = new NewstackClient();
client.start(new App());
```

---

## CDN / No-Build Usage

Newstack can be used directly in a browser without any build step via Babel Standalone:

```html
<html>
  <body>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>

    <script type="text/babel" data-type="module">
      /* @jsxRuntime classic */
      /* @jsx h */
      /* @jsxFrag Fragment */

      import Newstack, { NewstackClient } from "https://cdn.jsdelivr.net/npm/@moureau/newstack/dist/index.min.js";
      import { h, Fragment } from "https://cdn.jsdelivr.net/npm/@moureau/newstack/dist/jsx-shim.js";

      class App extends Newstack {
        value = "";

        render() {
          return (
            <div>
              <input bind={{ object: this, property: "value" }} />
              <p>You typed: {this.value}</p>
            </div>
          );
        }
      }

      const root =
        document.querySelector("#app") ??
        document.body.appendChild(Object.assign(document.createElement("div"), { id: "app" }));

      const newstack = NewstackClient.init();
      newstack.mount(App, root);
    </script>
  </body>
</html>
```

**Key differences from the bundled version:**
- Import `h` and `Fragment` manually from `jsx-shim.js` and declare the JSX pragmas at the top of each script.
- Use `bind={{ object: this, property: 'prop' }}` instead of `bind={this.prop}` — the shorthand requires the esbuild transform which is not available without a build step.
- No SSR — components mount client-side only via `mount()`.
- `onclick={this.method}` shorthand also requires the build transform; use `onclick={() => this.method({})}` instead.

---

## Mounting Components Imperatively

Use `mount()` to render a Newstack component into any DOM element without a full SSR app — useful for micro-frontends or embedding into existing pages.

```ts
import { NewstackClient } from "newstack";
import { Widget } from "./Widget";

// Get or create the shared client instance
const client = NewstackClient.init();

// Mount a component into a specific element
const { destroy } = client.mount(Widget, document.getElementById("widget"));

// Clean up when done
destroy();
```

- `NewstackClient.init()` returns the existing client if already running, or creates a new one.
- Components mounted this way go through `prepare` and `hydrate` normally.
- `destroy()` calls the component's `destroy`/`terminate` and removes the element.
- Listen for `window.newstack:ready` if mounting before the client has started:

```ts
window.addEventListener("newstack:ready", () => {
  window.mount(Widget, document.getElementById("widget"));
}, { once: true });

// or use the global shorthand (available after client.js loads):
window.mount(Widget, document.getElementById("widget"));
```

---

## Stateless Function Components

Plain functions returning JSX work as `<MyComponent />` — no class, no lifecycle, no reactivity.

```tsx
function Badge({ label }: { label: string }) {
  return <span class="badge">{label}</span>;
}

// Used as:
render() {
  return <div><Badge label="new" /></div>;
}
```

---

## Sub-render Helpers

Methods called from `render()` automatically receive the current context as their first argument — no need to pass it down manually:

```tsx
export class Page extends Newstack {
  renderHeader({ router }: NewstackClientContext) {
    return <h1>Current path: {router.path}</h1>;
  }

  render() {
    return (
      <div>
        {this.renderHeader({})}
      </div>
    );
  }
}
```

Caller-supplied keys override context values — `this.renderHeader({ router: customRouter })` still works.

---

## Passing Children to Components

JSX children are passed as props, not as `this.children`. Class components do not receive children automatically — use a **function component** as the layout wrapper and destructure `children` from its props:

```tsx
// ✅ correct — function component receives children as props
export function Layout({ children }) {
  return (
    <main>
      <Navbar />
      {children}
      <Footer />
    </main>
  );
}

// ❌ wrong — this.children does not exist on class components
export class Layout extends Newstack {
  render() {
    return <main>{this.children}</main>; // undefined
  }
}
```

## Function Component Layout Wrappers

Function components can contain class components. All class components inside a function component are discovered and registered correctly:

```tsx
import { Navbar } from "./Navbar"; // class component
import { Footer } from "./Footer"; // class component

export function Layout({ children }) {
  return (
    <main>
      <Navbar />
      {children}
      <Footer />
    </main>
  );
}

// Application.tsx
export class Application extends Newstack {
  render() {
    return (
      <Layout>
        <Home route="/" />
        <About route="/about" />
      </Layout>
    );
  }
}
```

---

## Loading States with `hydrated` / `prepared`

```tsx
export class UserList extends Newstack {
  users = [];

  async hydrate() {
    this.users = await UserList.getUsers();
  }

  render() {
    if (!this.hydrated) return <p>Loading...</p>;
    return <ul>{this.users.map(u => <li>{u.name}</li>)}</ul>;
  }
}
```

---

## JSX

- Factory is `h` from `@newstack/jsx`. Injected automatically by the bundler — no manual import needed.
- Standard JSX syntax. Use `class` not `className`. Use `onclick` not `onClick` (lowercase DOM events).
- Fragment syntax `<>...</>` is supported.
- The `html` prop sets `innerHTML` directly on an element — use for trusted raw HTML strings.

```tsx
// ✅
<div class="box" style="color: red" onclick={() => this.open = true}>

// ❌ — style must be a string, not an object
<div className="box" style={{ color: 'red' }} onClick={() => this.open = true}>

// Fragments
<>
  <p>First</p>
  <p>Second</p>
</>

// Raw HTML
<div html={this.trustedHtmlString} />
```

---

## Head Injection

Components can inject scripts, meta tags, and links into `<head>` directly from JSX. Content is scoped per component and cleaned up when the component stops rendering or the route changes.

```tsx
export class Page extends Newstack {
  render() {
    return (
      <>
        <head>
          <script src="https://cdn.example.com/analytics.js" />
          <meta name="theme-color" content="#101010" />
          <link rel="canonical" href="https://example.com/page" />
        </head>
        <div>...page content...</div>
      </>
    );
  }
}
```

- Works on SSR and client-side navigation.
- Each component's head content is tagged and cleaned up independently — multiple components injecting `<head>` blocks coexist without conflict.
- Content is not re-injected if it hasn't changed (prevents unnecessary DOM churn).
- Scripts are created via `document.createElement('script')` on the client so they actually execute (innerHTML script tags are inert in browsers).

---

## Build & Dev

```bash
newstack start              # dev server with HMR (watch mode)
newstack build              # production SSR build
newstack build --mode=ssg   # static site generation
newstack build --mode=spa   # SPA (client-only) build

NEWSTACK_PORT=4000 newstack start  # custom port (default 3000)
```

esbuild config lives in `esbuild.config.ts` at project root:

```ts
import { builder } from "newstack/builder";

export default {
  server: { ...builder.server },
  client: { ...builder.client },
};
```

---

## SSR + Hydration Flow

1. Request → server renders component tree to HTML string.
2. Component state serialized into `window.__NEWSTACK_STATE__` in `<head>`.
3. Browser loads `client.js` → restores state → hydrates DOM (no re-render, just event attachment).
4. Subsequent state changes trigger `patchElement()` — direct DOM diffing, no vdom.

---

## Common Mistakes

| Wrong | Right |
|---|---|
| `this.list.push(x)` inside `update()` | Array mutations now trigger re-renders everywhere — calling `push` in `update()` creates an infinite loop. Guard mutations with a condition or avoid mutating state inside `update()`. |
| `this.user.name = "new"` | Nested property assignment is silent — no re-render. Use `this.user = { ...this.user, name: "new" }` instead. |
| `this.matrix[0].push(x)` | Nested array mutations are silent. Reassign the outer array: `this.matrix[0] = [...this.matrix[0], x]`. |
| Accessing a ref in `prepare()` | `prepare()` runs on the server — there is no DOM. Refs are only available in `hydrate()` and later. |
| `onClick={...}` | `onclick={...}` |
| `className="foo"` | `class="foo"` |
| `style={{ color: 'red' }}` | `style="color: red"` — styles are strings, not objects |
| `onkeydown` to detect Enter on an input | Wrap in a `<form onsubmit={this.handleSubmit}>` — form submit fires on Enter automatically and is already preventDefault'd |
| `import { h } from "@newstack/jsx"` | Not needed — injected automatically |
| Accessing `window` in `prepare()` | Only safe in `hydrate()` / `update()` |
| Returning multiple root elements without a wrapper | Use `<>...</>` fragment syntax |
| `handleClick(ctx, e)` to access event | `handleClick({ event })` — event is on context |
| `key` on list items like React | `key` is not for reconciliation — it only registers a class component in `context.instances` |

### update()

- Fires whenever **any** property on the component changes — assignment, array mutation, or `delete`.
- It is **not selective** — it does not track which properties were accessed. Every state change triggers it.
- Mutating state inside `update()` without a condition creates an infinite loop.

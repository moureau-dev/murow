# EventSystem

`EventSystem` is a callback-based event handling system designed to simplify event-driven programming.
It allows you to register, emit, and manage events with flexible callback support, making it easy to build modular and decoupled applications.

## Features

- Register Callbacks: Attach functions to specific events using `on`.
- One-Time Listeners: Use `once` to register callbacks that run only once.
- Emit Events: Trigger events with optional data using `emit`.
- Remove Callbacks: Detach specific callbacks with `off`.
- Clear Events: Remove all callbacks globally or for specific events with `clear`.

## Why use this?

Callbacks are often way faster than events, on both the browser and node, but they are also harder to manage. This system allows you to use callbacks in a more event-like way, and it is TypeScript-friendly, offering strong type safety for event names and payloads when using EventTuple definitions.

### Source

Benchmarks:

- https://jsbench.me/qmkkfcfpcw/2
- https://hackernoon.com/nodejs-48x-faster-if-you-go-back-to-callbacks

## Usage

```ts
import { EventSystem } from "...";

interface FooProps {
  foo: string;
}

interface BarProps {
  bar: number;
}

const events = new EventSystem<[["foo", FooProps], ["bar", BarProps]]>({
  events: ["foo", "bar"],
});

events.on("bar", ({ bar }) => {
  console.log("bar event listened", bar);
});

events.emit("bar", { bar: 42 });
```

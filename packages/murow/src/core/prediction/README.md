# Prediction & Reconciliation (IntentTracker + Reconciliator)

Client-side utility for **server-authoritative multiplayer games**.  
Tracks unconfirmed player intents and reconciles them with authoritative snapshots from the server.

---

## Installation

```ts
import { IntentTracker, Reconciliator } from './prediction';
````

---

## Usage Example

```ts
const positionRecon = new Reconciliator<MoveIntent, PositionSnapshot>({
  onLoadState: (state) => gameClient.setPositions(state), // rewind to server-authoritative state
  onReplay: (remainingIntents) => remainingIntents.forEach((i) => gameClient.applyMove(i)), // replay remaining unconfirmed intents
});

const ticker = new FixedTicker({
  rate: 12, // ticks per second
  onTick: (deltaTime, tick) => {
    // Track input
    if (inputs.has('position')) {
      const intent = inputs.getAndRemove('position');
      positionRecon.trackIntent(tick, intent);
    }

    // Update game client simulation
    gameClient.update(deltaTime);
  }
});

function onServerSnapshot(snapshot: { tick: number; state: PositionSnapshot }) {
  positionRecon.onSnapshot(snapshot);
}

let lastTime = 0;
function rafStep(now: number) {
  const delta = (now - lastTime) / 1000; // seconds
  lastTime = now;

  ticker.update(delta); // manually drive the ticker

  requestAnimationFrame(rafStep);
}

function start() {
  lastTime = performance.now();
  requestAnimationFrame(rafStep);
}
```

---

### Key Concepts

* **IntentTracker**: Tracks client-side intents that are sent but not yet confirmed by the server.
* **Reconciliator**: Resets client state to authoritative snapshots and replays unconfirmed intents to maintain smooth prediction.
* Works for **any type of server-authoritative game**, not just movement.

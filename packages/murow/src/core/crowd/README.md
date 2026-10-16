# Crowd

Moving agents over a [`NavMesh`](../navmesh/README.md). Each `step` re-paths an
agent when its goal changes or the navmesh version bumps, moves it along its
waypoints, and pushes it apart from nearby agents. 2D, matching the navmesh.

```ts
import { NavMesh } from 'murow/core/navmesh';
import { Crowd } from 'murow/core/crowd';

const navmesh = new NavMesh('grid');
const crowd = new Crowd({ navmesh, radius: 0.5, speed: 4, capacity: 512 });

const agent = crowd.add({ x: 0, y: 0 });   // AgentHandle | null at capacity
agent.setGoal(100, 40);

loop.events.on('tick', ({ deltaTime }) => {
    crowd.update(deltaTime);
    // read agent.x, agent.y, agent.arrived
});
```

## `Crowd`

`new Crowd({ navmesh, capacity?, radius?, speed?, separation?, waypointRadius?, maxWaypoints? })`

| Member | Description |
|---|---|
| `add(options?)` | Spawn an agent at `{ x, y }` with optional `radius`/`speed`. Returns an `AgentHandle`, or `null` at capacity. |
| `remove(handle)` | Remove an agent. |
| `clear()` | Remove every agent. |
| `each(cb)` | Visit every agent in stable slot order. |
| `update(deltaTime)` | Re-path, follow waypoints, separate, and integrate all agents. |
| `count` | Live agent count. |

## `AgentHandle`

| Member | Description |
|---|---|
| `x`, `y` | Position (read-only). |
| `arrived` | Reached the goal. |
| `hasGoal` | A goal is set. |
| `paused` | Stopped via `stop()`. |
| `cellX`, `cellY` | Grid cell (grid navmesh only). |
| `cellChanged` | Last `update` moved the agent to a different cell. |
| `speed`, `radius` | Mutable per-agent values. |
| `setGoal(x, y)` | Set the goal; schedules a re-path. |
| `clearGoal()` | Drop the goal and path; the agent idles. |
| `stop()` / `resume()` | Pause and continue movement. |
| `teleport(x, y)` | Move and re-path. |
| `destroy()` | Remove the agent. |

## Notes

- Paths are stored in a fixed slice of `maxWaypoints` per agent; a longer path is
  downsampled to fit.
- `step` calls `navmesh.findPath` synchronously. A navmesh built with workers
  returns a `Promise`, which `step` skips.
- The crowd keeps its own spatial index for separation, sized from `capacity`.

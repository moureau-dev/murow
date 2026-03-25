/**
 * ECS Usage Example
 *
 * This example demonstrates how to use the ECS for a simple game.
 */

import { defineComponent, World } from "./index";
import { BinaryCodec } from "../core/binary-codec";

// 1. Define components using BinaryCodec schemas
const Transform = defineComponent("Transform", {
  x: BinaryCodec.f32,
  y: BinaryCodec.f32,
  rotation: BinaryCodec.f32,
});

const Velocity = defineComponent("Velocity", {
  vx: BinaryCodec.f32,
  vy: BinaryCodec.f32,
});

const Health = defineComponent("Health", {
  current: BinaryCodec.u16,
  max: BinaryCodec.u16,
});

const Damage = defineComponent("Damage", {
  amount: BinaryCodec.u16,
});

// 2. Create systems
class MovementSystem {
  update(world: World, deltaTime: number) {
    for (const entity of world.query(Transform, Velocity)) {
      const transform = world.get(entity, Transform); // Readonly!
      const velocity = world.get(entity, Velocity); // Readonly!

      // Update position using update() (efficient partial update)
      world.update(entity, Transform, {
        x: transform.x + velocity.vx * deltaTime,
        y: transform.y + velocity.vy * deltaTime,
      });
    }
  }
}

class HealthSystem {
  update(world: World) {
    for (const entity of world.query(Health)) {
      const health = world.get(entity, Health);

      // Despawn dead entities
      if (health.current <= 0) {
        console.log(`Entity ${entity} died`);
        world.despawn(entity);
      }
    }
  }
}

class CombatSystem {
  update(world: World) {
    // Simple collision-based damage (in real game, use spatial partitioning)
    const combatants = Array.from(world.query(Transform, Health, Damage));

    for (let i = 0; i < combatants.length; i++) {
      for (let j = i + 1; j < combatants.length; j++) {
        const e1 = combatants[i];
        const e2 = combatants[j];

        const t1 = world.get(e1, Transform);
        const t2 = world.get(e2, Transform);

        // Check collision (simple distance check)
        const dx = t1.x - t2.x;
        const dy = t1.y - t2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 10) {
          // Apply damage
          const d1 = world.get(e1, Damage);
          const d2 = world.get(e2, Damage);

          world.update(e1, Health, { current: world.get(e1, Health).current - d2.amount });
          world.update(e2, Health, { current: world.get(e2, Health).current - d1.amount });

          console.log(`Entities ${e1} and ${e2} collided! Applying damage.`);
        }
      }
    }
  }
}

// 3. Create world and spawn entities
function runExample() {
  const world = new World({
    maxEntities: 1000,
    components: [Transform, Velocity, Health, Damage],
  });

  // Spawn player
  const player = world.spawn();
  world.add(player, Transform, { x: 0, y: 0, rotation: 0 });
  world.add(player, Velocity, { vx: 100, vy: 0 });
  world.add(player, Health, { current: 100, max: 100 });
  world.add(player, Damage, { amount: 10 });

  // Spawn enemies
  for (let i = 0; i < 5; i++) {
    const enemy = world.spawn();
    world.add(enemy, Transform, { x: 200 + i * 50, y: 0, rotation: 0 });
    world.add(enemy, Velocity, { vx: -50, vy: 0 });
    world.add(enemy, Health, { current: 50, max: 50 });
    world.add(enemy, Damage, { amount: 5 });
  }

  console.log(`Spawned ${world.getEntityCount()} entities`);

  // 4. Create systems
  const movementSystem = new MovementSystem();
  const combatSystem = new CombatSystem();
  const healthSystem = new HealthSystem();

  // 5. Game loop
  const deltaTime = 0.016; // 60 FPS
  let tick = 0;

  const interval = setInterval(() => {
    tick++;

    // Update systems
    movementSystem.update(world, deltaTime);
    combatSystem.update(world);
    healthSystem.update(world);

    // Log stats every 10 ticks
    if (tick % 10 === 0) {
      console.log(`Tick ${tick}: ${world.getEntityCount()} entities alive`);
    }

    // Stop after 100 ticks or when all entities are dead
    if (tick >= 100 || world.getEntityCount() === 0) {
      clearInterval(interval);
      console.log("Simulation ended");
    }
  }, deltaTime * 1000);
}

// Run the example
if (import.meta.main) {
  runExample();
}

import { defineComponent } from "murow/ecs";
import { BinaryCodec } from "murow/core/binary-codec";
import { World } from "murow/ecs";

// Define components matching Bevy's benchmark
const Transform2D = defineComponent("Transform2D", {
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

const Armor = defineComponent("Armor", {
  value: BinaryCodec.u16,
});

const Damage = defineComponent("Damage", {
  amount: BinaryCodec.u16,
});

const Cooldown = defineComponent("Cooldown", {
  current: BinaryCodec.f32,
  max: BinaryCodec.f32,
});

const Team = defineComponent("Team", {
  id: BinaryCodec.u8,
});

const Target = defineComponent("Target", {
  entityId: BinaryCodec.u32,
});

const Status = defineComponent("Status", {
  stunned: BinaryCodec.u8,
  slowed: BinaryCodec.u8,
});

const Lifetime = defineComponent("Lifetime", {
  remaining: BinaryCodec.f32,
});

// Simple random number generator for deterministic benchmarking
class SimpleRng {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  nextF32(): number {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    return (((this.seed / 65536) >>> 0) % 32768) / 32768.0;
  }

  nextU16(): number {
    return Math.floor(this.nextF32() * 65535);
  }

  nextU8(): number {
    return Math.floor(this.nextF32() * 255);
  }
}

interface BenchmarkMetrics {
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
  stdDev: number;
  percent60: number;
  percent30: number;
  jankScore: number;
  heapUsedMB: number;
}

function runBenchmark(entityCount: number): BenchmarkMetrics {
  const startMem = process.memoryUsage();

  const world = new World({
    maxEntities: entityCount,
    components: [
      Transform2D,
      Velocity,
      Health,
      Armor,
      Damage,
      Cooldown,
      Team,
      Target,
      Status,
      Lifetime,
    ],
  });

  // Cache arrays once for cross-entity reads
  const healthCurrent = world.getFieldArray(Health, 'current');
  const armorValue = world.getFieldArray(Armor, 'value');

  // Track current frame for system throttling
  let currentFrame = 0;

  // Register systems using ergonomic addSystem API with flattened property syntax
  // These run automatically with world.runSystems()
  // Note: We use flattened syntax (entity.transform_x) for best performance
  world
    .addSystem()
    .query(Transform2D, Velocity)
    .fields([
      { transform: ['x', 'y'] },
      { velocity: ['vx', 'vy'] }
    ])
    .run((entity, deltaTime) => {
      entity.transform_x += entity.velocity_vx * deltaTime;
      entity.transform_y += entity.velocity_vy * deltaTime;
    });

  world
    .addSystem()
    .query(Transform2D, Velocity)
    .fields([
      { transform: ['rotation'] },
      { velocity: ['vx', 'vy'] }
    ])
    .when((entity) => entity.velocity_vx !== 0 || entity.velocity_vy !== 0)
    .run((entity, _deltaTime) => {
      entity.transform_rotation = Math.atan2(
        entity.velocity_vy,
        entity.velocity_vx,
      );
    });

  world
    .addSystem()
    .query(Transform2D)
    .fields([
      { transform: ['x', 'y'] }
    ])
    .when((entity) =>
      entity.transform_x < 0 ||
      entity.transform_x > 1000 ||
      entity.transform_y < 0 ||
      entity.transform_y > 1000
    )
    .run((entity, _deltaTime) => {
      if (entity.transform_x < 0) entity.transform_x = 1000;
      if (entity.transform_x > 1000) entity.transform_x = 0;
      if (entity.transform_y < 0) entity.transform_y = 1000;
      if (entity.transform_y > 1000) entity.transform_y = 0;
    });

  world
    .addSystem()
    .query(Cooldown)
    .fields([
      { cooldown: ['current'] }
    ])
    .when((entity) => entity.cooldown_current > 0)
    .run((entity, deltaTime) => {
      const newCooldown = entity.cooldown_current - deltaTime;
      entity.cooldown_current = newCooldown < 0 ? 0 : newCooldown;
    });

  world
    .addSystem()
    .query(Status, Velocity)
    .fields([
      { status: ['stunned', 'slowed'] },
      { velocity: ['vx', 'vy'] }
    ])
    .when((entity) => entity.status_stunned === 1 || entity.status_slowed === 1)
    .run((entity, _deltaTime) => {
      entity.velocity_vx = entity.status_stunned ? 0 : entity.velocity_vx;
      entity.velocity_vy = entity.status_stunned ? 0 : entity.velocity_vy;

      entity.velocity_vx *= entity.status_slowed ? 0.5 : 1;
      entity.velocity_vy *= entity.status_slowed ? 0.5 : 1;
    });

  world
    .addSystem()
    .query(Velocity)
    .fields([
      { velocity: ['vx', 'vy'] }
    ])
    .run((entity, _deltaTime) => {
      entity.velocity_vx *= 0.99;
      entity.velocity_vy *= 0.99;
    });

  // Create manual systems for conditional execution
  const healthRegenSystem = world
    .addSystem()
    .query(Health)
    .fields([
      { health: ['current', 'max'] }
    ])
    .when((entity) => {
      if (currentFrame % 30 !== 0) return false;
      return entity.health_current > 0 && entity.health_current < entity.health_max;
    })
    .run((entity, _deltaTime) => {
      const current = entity.health_current;
      const max = entity.health_max;
      const newHealth = current + 5;
      entity.health_current = newHealth > max ? max : newHealth;
    });

  const deathSystem = world
    .addSystem()
    .query(Health)
    .fields([
      { health: ['current'] }
    ])
    .when((entity) => entity.health_current === 0)
    .run((entity, _deltaTime, world) => {
      world.despawn(entity.eid);
    });

  const lifetimeSystem = world
    .addSystem()
    .query(Lifetime)
    .fields([
      { lifetime: ['remaining'] }
    ])
    .when((entity) => entity.lifetime_remaining > 0)
    .run((entity, deltaTime, world) => {
      const remaining = entity.lifetime_remaining - deltaTime;
      entity.lifetime_remaining = remaining;
    });

  const lifetimeExpireSystem = world
    .addSystem()
    .query(Lifetime)
    .fields([
      { lifetime: ['remaining'] }
    ])
    .when((entity) => entity.lifetime_remaining <= 0)
    .run((entity, _deltaTime, world) => {
      world.despawn(entity.eid);
    });

  const aiSystem = world
    .addSystem()
    .query(Velocity)
    .fields([
      { velocity: ['vx', 'vy'] }
    ])
    .when(() => currentFrame % 20 === 0)
    .run((entity, _deltaTime) => {
      if (Math.random() > 0.9) {
        entity.velocity_vx += (Math.random() - 0.5) * 2;
        entity.velocity_vy += (Math.random() - 0.5) * 2;
      }
    });

  // // Combat system - uses ergonomic API + closure over cached arrays for cross-entity reads
  // const combatSystem = world
  //   .addSystem()
  //   .query(Cooldown, Damage, Target)
  //   .fields([
  //     { cooldown: ['current', 'max'] },
  //     { damage: ['amount'] },
  //     { target: ['entityId'] }
  //   ])
  //   .when((entity) => {
  //     if (currentFrame % 5 !== 0) return false;
  //     return entity.cooldown_current === 0 && world.isAlive(entity.target_entityId) && world.has(entity.target_entityId, Health);
  //   })
  //   .run((entity, _deltaTime, world) => {
  //     const targetId = entity.target_entityId;
  //     const targetHealth = healthCurrent[targetId]!;
  //     let damageDealt = entity.damage_amount;

  //     // Apply armor reduction
  //     if (world.has(targetId, Armor)) {
  //       const armor = armorValue[targetId]!;
  //       const reduced = entity.damage_amount - armor * 0.1;
  //       damageDealt = reduced < 1 ? 1 : Math.floor(reduced);
  //     }

  //     const newHealth = targetHealth > damageDealt ? targetHealth - damageDealt : 0;
  //     healthCurrent[targetId] = newHealth;

  //     // Reset cooldown
  //     entity.cooldown_current = entity.cooldown_max;
  //   });

  // Setup entities
  const rng = new SimpleRng(12345);

  for (let i = 0; i < entityCount; i++) {
    const entity = world
      .entity(world.spawn())
      .add(Transform2D, {
        x: rng.nextF32() * 1000,
        y: rng.nextF32() * 1000,
        rotation: rng.nextF32() * Math.PI * 2,
      })
      .add(Velocity, {
        vx: rng.nextF32() * 10 - 5,
        vy: rng.nextF32() * 10 - 5,
      })
      .add(Health, {
        current: 100,
        max: 100,
      });

    // 80% have armor
    if (rng.nextF32() > 0.2) {
      entity.add(Armor, {
        value: Math.floor(rng.nextF32() * 50),
      });
    }

    // 60% can deal damage
    if (rng.nextF32() > 0.4) {
      const targetEntity = Math.floor(rng.nextF32() * entityCount);
      entity
        .add(Damage, {
          amount: Math.floor(rng.nextF32() * 20) + 10,
        })
        .add(Cooldown, {
          current: 0,
          max: 1.0,
        })
        .add(Target, { entityId: targetEntity });
    }

    // Assign to teams
    entity.add(Team, { id: Math.floor(rng.nextF32() * 4) });

    // 20% have status effects
    if (rng.nextF32() > 0.8) {
      entity.add(Status, {
        stunned: rng.nextF32() > 0.5 ? 1 : 0,
        slowed: rng.nextF32() > 0.5 ? 1 : 0,
      });
    }

    // 15% are temporary entities
    if (rng.nextF32() > 0.85) {
      entity.add(Lifetime, {
        remaining: rng.nextF32() * 5,
      });
    }
  }

  // Run simulation for 60 frames
  const frameCount = 60;
  const deltaTime = 0.016;
  const frameTimes: number[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    currentFrame = frame;
    const frameStart = performance.now();

    // Override Math.random with deterministic RNG for this frame
    const rng = new SimpleRng(frame);
    const originalRandom = Math.random;
    Math.random = () => rng.nextF32();

    // Run all auto-registered systems
    world.runSystems(deltaTime);

    // Restore original Math.random
    Math.random = originalRandom;

    const frameTime = performance.now() - frameStart;
    frameTimes.push(frameTime);
  }

  // Calculate enhanced metrics
  const endMem = process.memoryUsage();
  const heapUsedMB = (endMem.heapUsed - startMem.heapUsed) / 1024 / 1024;

  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const min = Math.min(...frameTimes);
  const max = Math.max(...frameTimes);

  // Calculate percentiles
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;

  // Standard deviation
  const variance = frameTimes.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / frameTimes.length;
  const stdDev = Math.sqrt(variance);

  // Frame budget analysis
  const frames60fps = frameTimes.filter(t => t <= 16.67).length;
  const frames30fps = frameTimes.filter(t => t <= 33.33).length;
  const percent60 = (frames60fps / frameTimes.length) * 100;
  const percent30 = (frames30fps / frameTimes.length) * 100;

  // Jank score (consecutive slow frames)
  let jankScore = 0;
  let consecutiveSlow = 0;
  frameTimes.forEach(t => {
    if (t > 33.33) {
      consecutiveSlow++;
      jankScore += consecutiveSlow;
    } else {
      consecutiveSlow = 0;
    }
  });

  return { avg, min, max, p50, p95, p99, stdDev, percent60, percent30, jankScore, heapUsedMB };
}

function main() {
  console.log("Murow Ergonomic API Benchmark - Complex Game Simulation (11 Systems)\n");
  console.log("Running 5 iterations per entity count for averaging...\n");

  const entityCounts = [500, 1_000, 5_000, 10_000, 15_000, 25_000, 50_000, 100_000];

  console.log("| Entities | Avg   | P50   | P95   | P99   | Max   | StdDev | @60fps | @30fps | Jank | Heap  |");
  console.log("|----------|-------|-------|-------|-------|-------|--------|--------|--------|------|-------|");

  for (const count of entityCounts) {
    // Run 5 times and collect all metrics
    const runs: BenchmarkMetrics[] = [];

    for (let run = 0; run < 5; run++) {
      console.error(`  Run ${run + 1}/5 for ${count} entities...`);
      runs.push(runBenchmark(count));
    }

    // Average all metrics across runs
    const avgAvg = runs.reduce((sum, r) => sum + r.avg, 0) / runs.length;
    const avgP50 = runs.reduce((sum, r) => sum + r.p50, 0) / runs.length;
    const avgP95 = runs.reduce((sum, r) => sum + r.p95, 0) / runs.length;
    const avgP99 = runs.reduce((sum, r) => sum + r.p99, 0) / runs.length;
    const maxMax = Math.max(...runs.map(r => r.max));
    const avgStdDev = runs.reduce((sum, r) => sum + r.stdDev, 0) / runs.length;
    const avgPercent60 = runs.reduce((sum, r) => sum + r.percent60, 0) / runs.length;
    const avgPercent30 = runs.reduce((sum, r) => sum + r.percent30, 0) / runs.length;
    const avgJank = runs.reduce((sum, r) => sum + r.jankScore, 0) / runs.length;
    const avgHeap = runs.reduce((sum, r) => sum + r.heapUsedMB, 0) / runs.length;

    console.log(
      `| ${count.toString().padStart(8)} | ${avgAvg.toFixed(2).padStart(5)}ms | ${avgP50.toFixed(2).padStart(5)}ms | ${avgP95.toFixed(2).padStart(5)}ms | ${avgP99.toFixed(2).padStart(5)}ms | ${maxMax.toFixed(2).padStart(5)}ms | ${avgStdDev.toFixed(2).padStart(6)}ms | ${avgPercent60.toFixed(0).padStart(5)}% | ${avgPercent30.toFixed(0).padStart(5)}% | ${Math.round(avgJank).toString().padStart(4)} | ${avgHeap.toFixed(1).padStart(5)}MB |`
    );
  }
}

main();

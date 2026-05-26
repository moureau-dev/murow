import { defineComponent } from "murow/ecs";
import { BinaryCodec } from "murow/core/binary-codec";
import { World } from "murow/ecs";

/**
 * "Fields" API variant.
 *
 * Same workload as `murow.ts` (RAW), but uses `world.fields(C)` to get a
 * pre-built bundle of typed arrays per component instead of hoisting each
 * field array individually with `world.getFieldArray(C, 'x')`.
 *
 * Hot-path code looks like:
 *
 *   const pos = world.fields(Transform2D);
 *   pos.x[eid] += vel.vx[eid] * deltaTime;
 *
 * The bundle is built once when the component is registered, then
 * `world.fields(C)` is a single array index that returns the same frozen
 * object every call. Hot reads/writes hit the same Float32Arrays RAW uses.
 *
 * Goal: prove that the `world.fields()` ergonomic wrapper costs ~nothing
 * vs hoisting every field by hand.
 */

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

class SimpleRng {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  nextF32(): number {
    this.seed = (this.seed * 1103515245 + 12345) >>> 0;
    return (((this.seed / 65536) >>> 0) % 32768) / 32768.0;
  }
  nextU16(): number { return Math.floor(this.nextF32() * 65535); }
  nextU8(): number { return Math.floor(this.nextF32() * 255); }
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
      Transform2D, Velocity, Health, Armor, Damage,
      Cooldown, Team, Target, Status, Lifetime,
    ],
  });

  // One lookup per component. Each bundle field is typed precisely from
  // the schema: f32 -> Float32Array, u16 -> Uint16Array, etc. No casts.
  const transform = world.fields(Transform2D);
  const velocity = world.fields(Velocity);
  const health = world.fields(Health);
  const armor = world.fields(Armor);
  const damage = world.fields(Damage);
  const cooldown = world.fields(Cooldown);
  const target = world.fields(Target);
  const status = world.fields(Status);
  const lifetime = world.fields(Lifetime);

  // Setup
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
      .add(Health, { current: 100, max: 100 });

    if (rng.nextF32() > 0.2) {
      entity.add(Armor, { value: Math.floor(rng.nextF32() * 50) });
    }

    if (rng.nextF32() > 0.4) {
      const targetEntity = Math.floor(rng.nextF32() * entityCount);
      entity
        .add(Damage, { amount: Math.floor(rng.nextF32() * 20) + 10 })
        .add(Cooldown, { current: 0, max: 1.0 })
        .add(Target, { entityId: targetEntity });
    }

    entity.add(Team, { id: Math.floor(rng.nextF32() * 4) });

    if (rng.nextF32() > 0.8) {
      entity.add(Status, {
        stunned: rng.nextF32() > 0.5 ? 1 : 0,
        slowed: rng.nextF32() > 0.5 ? 1 : 0,
      });
    }

    if (rng.nextF32() > 0.85) {
      entity.add(Lifetime, { remaining: rng.nextF32() * 5 });
    }
  }

  const frameCount = 60;
  const deltaTime = 0.016;
  const frameTimes: number[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    const frameStart = performance.now();

    // Movement system (fields-style RAW)
    const movementEntities = world.query(Transform2D, Velocity);
    for (let i = 0; i < movementEntities.length; i++) {
      const eid = movementEntities[i]!;
      transform.x[eid]! += velocity.vx[eid]! * deltaTime;
      transform.y[eid]! += velocity.vy[eid]! * deltaTime;
    }

    // Rotation system
    for (let i = 0; i < movementEntities.length; i++) {
      const eid = movementEntities[i]!;
      const vx = velocity.vx[eid]!;
      const vy = velocity.vy[eid]!;
      if (vx !== 0 || vy !== 0) {
        transform.rotation[eid] = Math.atan2(vy, vx);
      }
    }

    // Boundary system
    const boundaryEntities = world.query(Transform2D);
    for (let i = 0; i < boundaryEntities.length; i++) {
      const eid = boundaryEntities[i]!;
      if (transform.x[eid]! < 0) transform.x[eid]! = 1000;
      if (transform.x[eid]! > 1000) transform.x[eid]! = 0;
      if (transform.y[eid]! < 0) transform.y[eid]! = 1000;
      if (transform.y[eid]! > 1000) transform.y[eid]! = 0;
    }

    // Health regen system
    if (frame % 30 === 0) {
      const healthEntities = world.query(Health);
      for (let i = 0; i < healthEntities.length; i++) {
        const eid = healthEntities[i]!;
        const current = health.current[eid]!;
        const max = health.max[eid]!;
        if (current > 0 && current < max) {
          const newHealth = current + 5;
          health.current[eid] = newHealth > max ? max : newHealth;
        }
      }
    }

    // Cooldown system
    const cooldownEntities = world.query(Cooldown);
    for (let i = 0; i < cooldownEntities.length; i++) {
      const eid = cooldownEntities[i]!;
      if (cooldown.current[eid]! > 0) {
        const newCooldown = cooldown.current[eid]! - deltaTime;
        cooldown.current[eid] = newCooldown < 0 ? 0 : newCooldown;
      }
    }

    // Combat system
    if (frame % 5 === 0) {
      const combatEntities = world.query(Cooldown, Damage, Target);
      const updates: Array<{ targetId: number; newHealth: number; attackerId: number }> = [];
      for (let i = 0; i < combatEntities.length; i++) {
        const eid = combatEntities[i]!;
        const cd = cooldown.current[eid]!;
        const dmg = damage.amount[eid]!;
        const targetId = target.entityId[eid]!;

        if (cd === 0 && world.isAlive(targetId) && world.has(targetId, Health)) {
          const targetHealth = health.current[targetId]!;
          let damageDealt = dmg;

          if (world.has(targetId, Armor)) {
            const armorVal = armor.value[targetId]!;
            const reduced = dmg - armorVal * 0.1;
            damageDealt = reduced < 1 ? 1 : Math.floor(reduced);
          }

          const newHealth = targetHealth > damageDealt ? targetHealth - damageDealt : 0;
          updates.push({ targetId, newHealth, attackerId: eid });
        }
      }

      for (const { targetId, newHealth, attackerId } of updates) {
        if (world.isAlive(targetId)) {
          health.current[targetId] = newHealth;
        }
        cooldown.current[attackerId] = cooldown.max[attackerId]!;
      }
    }

    // Death system
    const deathEntities = world.query(Health);
    const toRemove: number[] = [];
    for (let i = 0; i < deathEntities.length; i++) {
      const eid = deathEntities[i]!;
      if (health.current[eid] === 0) toRemove.push(eid);
    }
    for (const eid of toRemove) world.despawn(eid);

    // Status effect system
    const statusEntities = world.query(Status, Velocity);
    for (let i = 0; i < statusEntities.length; i++) {
      const eid = statusEntities[i]!;
      const stunned = status.stunned[eid];
      const slowed = status.slowed[eid];
      if (stunned === 1) {
        velocity.vx[eid] = 0;
        velocity.vy[eid] = 0;
      } else if (slowed === 1) {
        velocity.vx[eid]! *= 0.5;
        velocity.vy[eid]! *= 0.5;
      }
    }

    // Lifetime system
    const lifetimeEntities = world.query(Lifetime);
    const expiredEntities: number[] = [];
    for (let i = 0; i < lifetimeEntities.length; i++) {
      const eid = lifetimeEntities[i]!;
      const remaining = lifetime.remaining[eid]! - deltaTime;
      if (remaining <= 0) {
        expiredEntities.push(eid);
      } else {
        lifetime.remaining[eid] = remaining;
      }
    }
    for (const eid of expiredEntities) world.despawn(eid);

    // Velocity damping system
    const velocityEntities = world.query(Velocity);
    for (let i = 0; i < velocityEntities.length; i++) {
      const eid = velocityEntities[i]!;
      velocity.vx[eid]! *= 0.99;
      velocity.vy[eid]! *= 0.99;
    }

    // AI behavior system
    if (frame % 20 === 0) {
      const aiRng = new SimpleRng(frame);
      for (let i = 0; i < velocityEntities.length; i++) {
        const eid = velocityEntities[i]!;
        if (aiRng.nextF32() > 0.9) {
          velocity.vx[eid]! += (aiRng.nextF32() - 0.5) * 2;
          velocity.vy[eid]! += (aiRng.nextF32() - 0.5) * 2;
        }
      }
    }

    const frameTime = performance.now() - frameStart;
    frameTimes.push(frameTime);
  }

  // Metrics (same as other variants)
  const endMem = process.memoryUsage();
  const heapUsedMB = (endMem.heapUsed - startMem.heapUsed) / 1024 / 1024;

  const avg = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length;
  const min = Math.min(...frameTimes);
  const max = Math.max(...frameTimes);

  const sorted = [...frameTimes].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)]!;
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;

  const variance = frameTimes.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / frameTimes.length;
  const stdDev = Math.sqrt(variance);

  const frames60fps = frameTimes.filter((t) => t <= 16.67).length;
  const frames30fps = frameTimes.filter((t) => t <= 33.33).length;
  const percent60 = (frames60fps / frameTimes.length) * 100;
  const percent30 = (frames30fps / frameTimes.length) * 100;

  let jankScore = 0;
  let consecutiveSlow = 0;
  frameTimes.forEach((t) => {
    if (t > 33.33) { consecutiveSlow++; jankScore += consecutiveSlow; }
    else { consecutiveSlow = 0; }
  });

  return { avg, min, max, p50, p95, p99, stdDev, percent60, percent30, jankScore, heapUsedMB };
}

function main() {
  console.log("Murow FIELDS API Benchmark - Complex Game Simulation (11 Systems)\n");
  console.log("Using world.fields(C) — typed bundle returned from one array index, ");
  console.log("reused on every call. Same typed arrays RAW would hoist by hand.\n");
  console.log("Running 5 iterations per entity count for averaging...\n");

  const entityCounts = [500, 1_000, 5_000, 10_000, 15_000, 25_000, 50_000, 100_000];

  console.log("| Entities | Avg   | P50   | P95   | P99   | Max   | StdDev | @60fps | @30fps | Jank | Heap  |");
  console.log("|----------|-------|-------|-------|-------|-------|--------|--------|--------|------|-------|");

  for (const count of entityCounts) {
    const runs: BenchmarkMetrics[] = [];
    for (let run = 0; run < 5; run++) {
      console.error(`  Run ${run + 1}/5 for ${count} entities...`);
      runs.push(runBenchmark(count));
    }

    const avgAvg = runs.reduce((sum, r) => sum + r.avg, 0) / runs.length;
    const avgP50 = runs.reduce((sum, r) => sum + r.p50, 0) / runs.length;
    const avgP95 = runs.reduce((sum, r) => sum + r.p95, 0) / runs.length;
    const avgP99 = runs.reduce((sum, r) => sum + r.p99, 0) / runs.length;
    const maxMax = Math.max(...runs.map((r) => r.max));
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

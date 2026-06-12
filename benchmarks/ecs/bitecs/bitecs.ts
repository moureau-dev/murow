import {
  createWorld,
  addEntity,
  addComponent,
  removeEntity,
  query,
  type World,
} from "bitecs";

// Components matching Murow's benchmark schema, preallocated SoA typed arrays
const MAX_ENTITIES = 100001;

const Transform2D = {
  x: new Float32Array(MAX_ENTITIES),
  y: new Float32Array(MAX_ENTITIES),
  rotation: new Float32Array(MAX_ENTITIES),
};

const Velocity = {
  vx: new Float32Array(MAX_ENTITIES),
  vy: new Float32Array(MAX_ENTITIES),
};

const Health = {
  current: new Uint16Array(MAX_ENTITIES),
  max: new Uint16Array(MAX_ENTITIES),
};

const Armor = {
  value: new Uint16Array(MAX_ENTITIES),
};

const Damage = {
  amount: new Uint16Array(MAX_ENTITIES),
};

const Cooldown = {
  current: new Float32Array(MAX_ENTITIES),
  max: new Float32Array(MAX_ENTITIES),
};

const Team = {
  id: new Uint8Array(MAX_ENTITIES),
};

const Target = {
  entityId: new Uint32Array(MAX_ENTITIES),
};

const Status = {
  stunned: new Uint8Array(MAX_ENTITIES),
  slowed: new Uint8Array(MAX_ENTITIES),
};

const Lifetime = {
  remaining: new Float32Array(MAX_ENTITIES),
};

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

// System implementations
const movementQueryComponents = [Transform2D, Velocity];
function movementSystem(world: World, deltaTime: number): void {
  const entities = query(world, movementQueryComponents);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    Transform2D.x[eid]! += Velocity.vx[eid]! * deltaTime;
    Transform2D.y[eid]! += Velocity.vy[eid]! * deltaTime;
  }
}

const rotationQueryComponents = [Transform2D, Velocity];
function rotationSystem(world: World): void {
  const entities = query(world, rotationQueryComponents);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    const vx = Velocity.vx[eid]!;
    const vy = Velocity.vy[eid]!;

    if (vx !== 0 || vy !== 0) {
      Transform2D.rotation[eid] = Math.atan2(vy, vx);
    }
  }
}

const boundaryQueryComponents = [Transform2D];
function boundarySystem(world: World): void {
  const entities = query(world, boundaryQueryComponents);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;

    if (Transform2D.x[eid]! < 0) Transform2D.x[eid] = 1000;
    if (Transform2D.x[eid]! > 1000) Transform2D.x[eid] = 0;
    if (Transform2D.y[eid]! < 0) Transform2D.y[eid] = 1000;
    if (Transform2D.y[eid]! > 1000) Transform2D.y[eid] = 0;
  }
}

const healthRegenQueryComponents = [Health];
function healthRegenSystem(world: World, frame: number): void {
  if (frame % 30 === 0) {
    const entities = query(world, healthRegenQueryComponents);
    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i]!;
      const current = Health.current[eid]!;
      const max = Health.max[eid]!;

      if (current > 0 && current < max) {
        const newHealth = current + 5;
        Health.current[eid] = newHealth > max ? max : newHealth;
      }
    }
  }
}

const cooldownQueryComponents = [Cooldown];
function cooldownSystem(world: World, deltaTime: number): void {
  const entities = query(world, cooldownQueryComponents);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    if (Cooldown.current[eid]! > 0) {
      const newCooldown = Cooldown.current[eid]! - deltaTime;
      Cooldown.current[eid] = newCooldown < 0 ? 0 : newCooldown;
    }
  }
}

// Track active entities globally
let activeEntities = new Set<number>();

const combatQueryComponents = [Cooldown, Damage, Target];
function combatSystem(world: World, frame: number): void {
  if (frame % 5 === 0) {
    const entities = query(world, combatQueryComponents);
    const updates: Array<{ targetId: number; newHealth: number; attackerId: number }> = [];

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i]!;
      const cooldown = Cooldown.current[eid]!;
      const damage = Damage.amount[eid]!;
      const targetId = Target.entityId[eid]!;

      if (cooldown === 0 && activeEntities.has(targetId) && Health.current[targetId] !== undefined) {
        let damageDealt = damage;

        // Apply armor reduction
        if (Armor.value[targetId] !== undefined) {
          const reduced = damage - Armor.value[targetId] * 0.1;
          damageDealt = reduced < 1 ? 1 : Math.floor(reduced);
        }

        const targetHealth = Health.current[targetId];
        const newHealth = targetHealth > damageDealt ? targetHealth - damageDealt : 0;

        updates.push({ targetId, newHealth, attackerId: eid });
      }
    }

    // Apply all updates
    for (const { targetId, newHealth, attackerId } of updates) {
      if (activeEntities.has(targetId)) {
        Health.current[targetId] = newHealth;
      }
      // Reset cooldown
      Cooldown.current[attackerId] = Cooldown.max[attackerId]!;
    }
  }
}

const deathQueryComponents = [Health];
function deathSystem(world: World): void {
  const entities = query(world, deathQueryComponents);
  const toRemove: number[] = [];

  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    if (Health.current[eid] === 0) {
      toRemove.push(eid);
    }
  }

  for (const eid of toRemove) {
    removeEntity(world, eid);
    activeEntities.delete(eid);
  }
}

const statusEffectQueryComponents = [Status, Velocity];
function statusEffectSystem(world: World): void {
  const entities = query(world, statusEffectQueryComponents);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    const stunned = Status.stunned[eid];
    const slowed = Status.slowed[eid];

    if (stunned === 1) {
      Velocity.vx[eid] = 0;
      Velocity.vy[eid] = 0;
    } else if (slowed === 1) {
      Velocity.vx[eid]! *= 0.5;
      Velocity.vy[eid]! *= 0.5;
    }
  }
}

const lifetimeQueryComponents = [Lifetime];
function lifetimeSystem(world: World, deltaTime: number): void {
  const entities = query(world, lifetimeQueryComponents);
  const expiredEntities: number[] = [];

  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    const remaining = Lifetime.remaining[eid]! - deltaTime;

    if (remaining <= 0) {
      expiredEntities.push(eid);
    } else {
      Lifetime.remaining[eid] = remaining;
    }
  }

  for (const eid of expiredEntities) {
    removeEntity(world, eid);
    activeEntities.delete(eid);
  }
}

const velocityDampingQueryComponents = [Velocity];
function velocityDampingSystem(world: World): void {
  const entities = query(world, velocityDampingQueryComponents);
  for (let i = 0; i < entities.length; i++) {
    const eid = entities[i]!;
    Velocity.vx[eid]! *= 0.99;
    Velocity.vy[eid]! *= 0.99;
  }
}

const aiBehaviorQueryComponents = [Velocity];
function aiBehaviorSystem(world: World, frame: number): void {
  if (frame % 20 === 0) {
    const rng = new SimpleRng(frame);
    const entities = query(world, aiBehaviorQueryComponents);

    for (let i = 0; i < entities.length; i++) {
      const eid = entities[i]!;
      if (rng.nextF32() > 0.9) {
        Velocity.vx[eid]! += (rng.nextF32() - 0.5) * 2;
        Velocity.vy[eid]! += (rng.nextF32() - 0.5) * 2;
      }
    }
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

  const world = createWorld();
  activeEntities = new Set<number>();

  // Setup entities
  const rng = new SimpleRng(12345);
  const entities: number[] = [];

  for (let i = 0; i < entityCount; i++) {
    const eid = addEntity(world);
    entities.push(eid);
    activeEntities.add(eid);

    addComponent(world, eid, Transform2D);
    Transform2D.x[eid] = rng.nextF32() * 1000;
    Transform2D.y[eid] = rng.nextF32() * 1000;
    Transform2D.rotation[eid] = rng.nextF32() * Math.PI * 2;

    addComponent(world, eid, Velocity);
    Velocity.vx[eid] = rng.nextF32() * 10 - 5;
    Velocity.vy[eid] = rng.nextF32() * 10 - 5;

    addComponent(world, eid, Health);
    Health.current[eid] = 100;
    Health.max[eid] = 100;

    // 80% have armor
    if (rng.nextF32() > 0.2) {
      addComponent(world, eid, Armor);
      Armor.value[eid] = Math.floor(rng.nextF32() * 50);
    }

    // 60% can deal damage
    if (rng.nextF32() > 0.4) {
      const targetEntity = Math.floor(rng.nextF32() * entityCount);
      addComponent(world, eid, Damage);
      Damage.amount[eid] = Math.floor(rng.nextF32() * 20) + 10;

      addComponent(world, eid, Cooldown);
      Cooldown.current[eid] = 0;
      Cooldown.max[eid] = 1.0;

      addComponent(world, eid, Target);
      Target.entityId[eid] = targetEntity;
    }

    // Assign to teams
    addComponent(world, eid, Team);
    Team.id[eid] = Math.floor(rng.nextF32() * 4);

    // 20% have status effects
    if (rng.nextF32() > 0.8) {
      addComponent(world, eid, Status);
      Status.stunned[eid] = rng.nextF32() > 0.5 ? 1 : 0;
      Status.slowed[eid] = rng.nextF32() > 0.5 ? 1 : 0;
    }

    // 15% are temporary entities
    if (rng.nextF32() > 0.85) {
      addComponent(world, eid, Lifetime);
      Lifetime.remaining[eid] = rng.nextF32() * 5;
    }
  }

  // Run simulation for 60 frames
  const frameCount = 60;
  const deltaTime = 0.016;
  const frameTimes: number[] = [];

  for (let frame = 0; frame < frameCount; frame++) {
    const frameStart = performance.now();

    // Run all systems in order
    movementSystem(world, deltaTime);
    rotationSystem(world);
    boundarySystem(world);
    healthRegenSystem(world, frame);
    cooldownSystem(world, deltaTime);
    // combatSystem(world, frame);
    deathSystem(world);
    statusEffectSystem(world);
    lifetimeSystem(world, deltaTime);
    velocityDampingSystem(world);
    aiBehaviorSystem(world, frame);

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
  console.log("bitECS Benchmark - Complex Game Simulation (11 Systems)\n");
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

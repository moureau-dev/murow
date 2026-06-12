use bevy::prelude::*;
use std::time::Instant;

#[derive(Debug)]
struct BenchmarkMetrics {
    avg: f32,
    min: f32,
    max: f32,
    p50: f32,
    p95: f32,
    p99: f32,
    std_dev: f32,
    percent60: f32,
    percent30: f32,
    jank_score: u32,
}

// Define components matching Murow's benchmark
#[derive(Component)]
struct Transform2D {
    x: f32,
    y: f32,
    rotation: f32,
}

#[derive(Component)]
struct Velocity {
    vx: f32,
    vy: f32,
}

#[derive(Component)]
struct Health {
    current: u16,
    max: u16,
}

#[derive(Component)]
struct Armor {
    value: u16,
}

#[derive(Component)]
struct Damage {
    amount: u16,
}

#[derive(Component)]
struct Cooldown {
    current: f32,
    max: f32,
}

#[derive(Component)]
struct Team {
    id: u8,
}

#[derive(Component)]
struct Target {
    entity_id: Entity,
}

#[derive(Component)]
struct Status {
    stunned: u8,
    slowed: u8,
}

#[derive(Component)]
struct Lifetime {
    remaining: f32,
}

#[derive(Resource)]
struct FrameCounter(u32);

#[derive(Resource)]
struct DeltaTime(f32);

// Simple random number generator for deterministic benchmarking
struct SimpleRng {
    seed: u32,
}

impl SimpleRng {
    fn new(seed: u32) -> Self {
        Self { seed }
    }

    fn next_f32(&mut self) -> f32 {
        self.seed = self.seed.wrapping_mul(1103515245).wrapping_add(12345);
        ((self.seed / 65536) % 32768) as f32 / 32768.0
    }

    fn next_u16(&mut self) -> u16 {
        (self.next_f32() * 65535.0) as u16
    }

    fn next_u8(&mut self) -> u8 {
        (self.next_f32() * 255.0) as u8
    }
}

// Systems matching Murow's benchmark
fn movement_system(mut query: Query<(&mut Transform2D, &Velocity)>, delta_time: Res<DeltaTime>) {
    for (mut t, v) in query.iter_mut() {
        t.x += v.vx * delta_time.0;
        t.y += v.vy * delta_time.0;
    }
}

fn rotation_system(mut query: Query<(&mut Transform2D, &Velocity)>) {
    for (mut t, v) in query.iter_mut() {
        if v.vx != 0.0 || v.vy != 0.0 {
            t.rotation = v.vy.atan2(v.vx);
        }
    }
}

fn boundary_system(mut query: Query<&mut Transform2D>) {
    for mut t in query.iter_mut() {
        if t.x < 0.0 {
            t.x = 1000.0;
        }
        if t.x > 1000.0 {
            t.x = 0.0;
        }
        if t.y < 0.0 {
            t.y = 1000.0;
        }
        if t.y > 1000.0 {
            t.y = 0.0;
        }
    }
}

fn health_regen_system(mut query: Query<&mut Health>, frame: Res<FrameCounter>) {
    if frame.0 % 30 == 0 {
        for mut h in query.iter_mut() {
            if h.current > 0 && h.current < h.max {
                let new_health = h.current + 5;
                h.current = if new_health > h.max { h.max } else { new_health };
            }
        }
    }
}

fn cooldown_system(mut query: Query<&mut Cooldown>, delta_time: Res<DeltaTime>) {
    for mut cd in query.iter_mut() {
        if cd.current > 0.0 {
            let new_cooldown = cd.current - delta_time.0;
            cd.current = if new_cooldown < 0.0 { 0.0 } else { new_cooldown };
        }
    }
}

fn combat_system(
    mut health_query: Query<&mut Health>,
    mut attacker_query: Query<(&mut Cooldown, &Damage, &Target)>,
    armor_query: Query<&Armor>,
    frame: Res<FrameCounter>,
) {
    if frame.0 % 5 == 0 {
        // Collect all updates first to avoid borrow checker issues
        let mut updates: Vec<(Entity, u16, f32)> = Vec::new();

        for (cd, dmg, target) in attacker_query.iter() {
            if cd.current == 0.0 {
                if let Ok(target_health) = health_query.get(target.entity_id) {
                    let mut damage_dealt = dmg.amount;

                    if let Ok(armor) = armor_query.get(target.entity_id) {
                        let reduced = dmg.amount as f32 - armor.value as f32 * 0.1;
                        damage_dealt = if reduced < 1.0 { 1 } else { reduced as u16 };
                    }

                    let new_health = if target_health.current > damage_dealt {
                        target_health.current - damage_dealt
                    } else {
                        0
                    };

                    updates.push((target.entity_id, new_health, cd.max));
                }
            }
        }

        // Apply all updates
        for (entity, new_health, _cooldown_max) in updates {
            if let Ok(mut health) = health_query.get_mut(entity) {
                health.current = new_health;
            }
        }

        // Reset cooldowns separately
        for (mut cd, _, _) in attacker_query.iter_mut() {
            if cd.current == 0.0 {
                cd.current = cd.max;
            }
        }
    }
}

fn death_system(mut commands: Commands, query: Query<(Entity, &Health)>) {
    for (entity, h) in query.iter() {
        if h.current == 0 {
            commands.entity(entity).despawn();
        }
    }
}

fn status_effect_system(mut query: Query<(&Status, &mut Velocity)>) {
    for (status, mut v) in query.iter_mut() {
        if status.stunned == 1 {
            v.vx = 0.0;
            v.vy = 0.0;
        } else if status.slowed == 1 {
            v.vx *= 0.5;
            v.vy *= 0.5;
        }
    }
}

fn lifetime_system(
    mut commands: Commands,
    mut query: Query<(Entity, &mut Lifetime)>,
    delta_time: Res<DeltaTime>,
) {
    for (entity, mut lifetime) in query.iter_mut() {
        let remaining = lifetime.remaining - delta_time.0;
        if remaining <= 0.0 {
            commands.entity(entity).despawn();
        } else {
            lifetime.remaining = remaining;
        }
    }
}

fn velocity_damping_system(mut query: Query<&mut Velocity>) {
    for mut v in query.iter_mut() {
        v.vx *= 0.99;
        v.vy *= 0.99;
    }
}

fn ai_behavior_system(mut query: Query<&mut Velocity>, frame: Res<FrameCounter>) {
    if frame.0 % 20 == 0 {
        let mut rng = SimpleRng::new(frame.0);
        for mut v in query.iter_mut() {
            if rng.next_f32() > 0.9 {
                v.vx += (rng.next_f32() - 0.5) * 2.0;
                v.vy += (rng.next_f32() - 0.5) * 2.0;
            }
        }
    }
}

fn run_benchmark(entity_count: usize) -> BenchmarkMetrics {
    let mut app = App::new();

    // Initialize resources
    app.insert_resource(FrameCounter(0));
    app.insert_resource(DeltaTime(0.016));

    // Add all systems
    app.add_systems(
        Update,
        (
            movement_system,
            rotation_system,
            boundary_system,
            health_regen_system,
            cooldown_system,
            // combat_system,
            death_system,
            status_effect_system,
            lifetime_system,
            velocity_damping_system,
            ai_behavior_system,
        ).chain(),
    );

    // Setup entities
    let mut rng = SimpleRng::new(12345);
    let mut world = app.world_mut();

    for _i in 0..entity_count {
        let entity = world.spawn((
            Transform2D {
                x: rng.next_f32() * 1000.0,
                y: rng.next_f32() * 1000.0,
                rotation: rng.next_f32() * std::f32::consts::PI * 2.0,
            },
            Velocity {
                vx: rng.next_f32() * 10.0 - 5.0,
                vy: rng.next_f32() * 10.0 - 5.0,
            },
            Health {
                current: 100,
                max: 100,
            },
        )).id();

        // 80% have armor
        if rng.next_f32() > 0.2 {
            world.entity_mut(entity).insert(Armor {
                value: (rng.next_f32() * 50.0) as u16,
            });
        }

        // 60% can deal damage
        if rng.next_f32() > 0.4 {
            let target_entity = Entity::from_raw((rng.next_f32() * entity_count as f32) as u32);
            world.entity_mut(entity).insert((
                Damage {
                    amount: (rng.next_f32() * 20.0) as u16 + 10,
                },
                Cooldown {
                    current: 0.0,
                    max: 1.0,
                },
                Target {
                    entity_id: target_entity,
                },
            ));
        }

        // Assign to teams
        world.entity_mut(entity).insert(Team {
            id: (rng.next_f32() * 4.0) as u8,
        });

        // 20% have status effects
        if rng.next_f32() > 0.8 {
            world.entity_mut(entity).insert(Status {
                stunned: if rng.next_f32() > 0.5 { 1 } else { 0 },
                slowed: if rng.next_f32() > 0.5 { 1 } else { 0 },
            });
        }

        // 15% are temporary entities
        if rng.next_f32() > 0.85 {
            world.entity_mut(entity).insert(Lifetime {
                remaining: rng.next_f32() * 5.0,
            });
        }
    }

    // Run simulation for 60 frames
    let frame_count = 60;
    let mut frame_times = Vec::with_capacity(frame_count);

    for frame in 0..frame_count {
        app.world_mut().resource_mut::<FrameCounter>().0 = frame as u32;

        let frame_start = Instant::now();
        app.update();
        let frame_time = frame_start.elapsed().as_secs_f32() * 1000.0;

        frame_times.push(frame_time);
    }

    // Calculate enhanced metrics
    let avg = frame_times.iter().sum::<f32>() / frame_times.len() as f32;
    let min = frame_times.iter().copied().fold(f32::INFINITY, f32::min);
    let max = frame_times.iter().copied().fold(f32::NEG_INFINITY, f32::max);

    // Calculate percentiles
    let mut sorted = frame_times.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = sorted[(sorted.len() as f32 * 0.50) as usize];
    let p95 = sorted[(sorted.len() as f32 * 0.95) as usize];
    let p99 = sorted[(sorted.len() as f32 * 0.99) as usize];

    // Standard deviation
    let variance = frame_times.iter()
        .map(|&t| (t - avg).powi(2))
        .sum::<f32>() / frame_times.len() as f32;
    let std_dev = variance.sqrt();

    // Frame budget analysis
    let frames60fps = frame_times.iter().filter(|&&t| t <= 16.67).count();
    let frames30fps = frame_times.iter().filter(|&&t| t <= 33.33).count();
    let percent60 = (frames60fps as f32 / frame_times.len() as f32) * 100.0;
    let percent30 = (frames30fps as f32 / frame_times.len() as f32) * 100.0;

    // Jank score (consecutive slow frames)
    let mut jank_score = 0u32;
    let mut consecutive_slow = 0u32;
    for &t in &frame_times {
        if t > 33.33 {
            consecutive_slow += 1;
            jank_score += consecutive_slow;
        } else {
            consecutive_slow = 0;
        }
    }

    BenchmarkMetrics {
        avg,
        min,
        max,
        p50,
        p95,
        p99,
        std_dev,
        percent60,
        percent30,
        jank_score,
    }
}

fn main() {
    println!("Bevy ECS Benchmark - Complex Game Simulation (11 Systems)\n");
    println!("Running 5 iterations per entity count for averaging...\n");

    let entity_counts = [500, 1_000, 5_000, 10_000, 15_000, 25_000, 50_000, 100_000];

    println!("| Entities | Avg   | P50   | P95   | P99   | Max   | StdDev | @60fps | @30fps | Jank |");
    println!("|----------|-------|-------|-------|-------|-------|--------|--------|--------|------|");

    for count in entity_counts {
        // Run 5 times and collect all metrics
        let mut runs = Vec::new();

        for run in 0..5 {
            eprintln!("  Run {}/{} for {} entities...", run + 1, 5, count);
            runs.push(run_benchmark(count));
        }

        // Average all metrics across runs
        let avg_avg = runs.iter().map(|r| r.avg).sum::<f32>() / runs.len() as f32;
        let avg_p50 = runs.iter().map(|r| r.p50).sum::<f32>() / runs.len() as f32;
        let avg_p95 = runs.iter().map(|r| r.p95).sum::<f32>() / runs.len() as f32;
        let avg_p99 = runs.iter().map(|r| r.p99).sum::<f32>() / runs.len() as f32;
        let max_max = runs.iter().map(|r| r.max).fold(f32::NEG_INFINITY, f32::max);
        let avg_std_dev = runs.iter().map(|r| r.std_dev).sum::<f32>() / runs.len() as f32;
        let avg_percent60 = runs.iter().map(|r| r.percent60).sum::<f32>() / runs.len() as f32;
        let avg_percent30 = runs.iter().map(|r| r.percent30).sum::<f32>() / runs.len() as f32;
        let avg_jank = runs.iter().map(|r| r.jank_score).sum::<u32>() / runs.len() as u32;

        println!(
            "| {:>8} | {:>5.2}ms | {:>5.2}ms | {:>5.2}ms | {:>5.2}ms | {:>5.2}ms | {:>6.2}ms | {:>5.0}% | {:>5.0}% | {:>4} |",
            count,
            avg_avg,
            avg_p50,
            avg_p95,
            avg_p99,
            max_max,
            avg_std_dev,
            avg_percent60,
            avg_percent30,
            avg_jank
        );
    }
}

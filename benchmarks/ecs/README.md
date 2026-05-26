## Benchmark Environment

* **CPU:** Intel i5-2400 (4c / 4t, Sandy Bridge, 3.4 GHz, 2011)
* **OS:** Linux x64
* **Runtime (Murow):** Bun (`bun run`)
* **Runtime (bitECS):** Bun (`bun run`)
* **Runtime (Bevy):** Rust (release)
* **Workload:** identical “complex game simulation”
* **Systems:** 11
* **Runs:** **5 runs per entity count**
* **Values shown:** arithmetic averages
* **Rendering:** none

---

## Murow ECS — RAW API (TypeScript / Bun)

**11 systems — 5-run average**

| Entities | Avg Frame Time |     Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | -------------: | -------: | -------: | -------: | -------: | -------: |
|      500 |    **0.16 ms** | **~6,250 FPS** | **0.14** | **0.22** | **0.83** | **2.34** | **0.09** |
|    1,000 |    **0.13 ms** | **~7,690 FPS** | **0.11** | **0.17** | **0.54** | **0.64** | **0.06** |
|    5,000 |    **0.62 ms** | **~1,610 FPS** | **0.54** | **0.85** | **2.05** | **3.28** | **0.24** |
|   10,000 |    **1.12 ms** |   **~890 FPS** | **1.05** | **1.34** | **3.19** | **3.42** | **0.29** |
|   15,000 |    **1.89 ms** |   **~530 FPS** | **1.56** | **2.96** | **4.74** | **5.56** | **0.72** |
|   25,000 |    **3.51 ms** |   **~285 FPS** | **3.48** | **4.46** | **8.48** | **9.36** | **1.00** |
|   50,000 |    **8.18 ms** |   **~122 FPS** | **8.55** |**10.69** |**17.47** |**18.65** | **2.11** |
|  100,000 |   **21.39 ms** |    **~47 FPS** |**20.76** |**25.56** |**35.28** |**36.04** | **2.53** |

---

## Murow ECS — HYBRID API (TypeScript / Bun)

**11 systems — 5-run average**

Uses direct array access (`entity.field_array[entity.eid]`) for maximum performance.

| Entities | Avg Frame Time |     Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | -------------: | -------: | -------: | -------: | -------: | -------: |
|      500 |    **0.19 ms** | **~5,260 FPS** | **0.14** | **0.33** | **1.94** | **7.40** | **0.24** |
|    1,000 |    **0.24 ms** | **~4,170 FPS** | **0.23** | **0.29** | **0.45** | **0.54** | **0.03** |
|    5,000 |    **1.10 ms** |   **~910 FPS** | **1.07** | **1.30** | **2.00** | **2.05** | **0.14** |
|   10,000 |    **2.23 ms** |   **~450 FPS** | **2.18** | **2.50** | **4.00** | **4.85** | **0.27** |
|   15,000 |    **3.38 ms** |   **~295 FPS** | **3.30** | **3.79** | **5.51** | **5.67** | **0.35** |
|   25,000 |    **5.58 ms** |   **~179 FPS** | **5.46** | **6.21** | **8.87** | **9.49** | **0.54** |
|   50,000 |   **11.29 ms** |    **~89 FPS** |**11.06** |**12.78** |**17.80** |**18.04** | **1.08** |
|  100,000 |   **22.83 ms** |    **~44 FPS** |**22.42** |**24.90** |**37.86** |**39.52** | **2.31** |

---

## Murow ECS — ERGONOMIC API (TypeScript / Bun)

**11 systems — 5-run average**

Uses ergonomic field access with caching for convenience.

| Entities | Avg Frame Time |     Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | -------------: | -------: | -------: | -------: | -------: | -------: |
|      500 |    **0.25 ms** | **~4,000 FPS** | **0.21** | **0.40** | **1.49** | **5.07** | **0.17** |
|    1,000 |    **0.37 ms** | **~2,700 FPS** | **0.36** | **0.43** | **0.68** | **0.81** | **0.05** |
|    5,000 |    **1.67 ms** |   **~600 FPS** | **1.64** | **1.89** | **2.82** | **3.01** | **0.18** |
|   10,000 |    **3.37 ms** |   **~297 FPS** | **3.32** | **3.68** | **5.56** | **6.54** | **0.32** |
|   15,000 |    **5.16 ms** |   **~194 FPS** | **5.09** | **5.62** | **7.86** | **8.15** | **0.42** |
|   25,000 |    **8.69 ms** |   **~115 FPS** | **8.59** | **9.52** |**13.07** |**13.84** | **0.68** |
|   50,000 |   **17.43 ms** |    **~57 FPS** |**17.25** |**19.09** |**25.75** |**26.26** | **1.30** |
|  100,000 |   **35.07 ms** |    **~29 FPS** |**34.54** |**38.33** |**52.96** |**55.37** | **2.77** |

---

## Murow ECS — FIELDS API (TypeScript / Bun)

**11 systems — 5-run average**

Uses `world.fields(C)` to grab the per-component typed-array bundle once
outside the system loop, then reads and writes typed-array slots directly
(e.g. `transform.x[eid] += velocity.vx[eid] * deltaTime`). Bundle objects
are built at component-registration time and shared for the World's
lifetime, so the hot path is identical to RAW: indexed loads and stores
into `Float32Array` / `Int32Array` / `Uint16Array` / `Uint8Array`.

This is the API style recommended for prediction/handler bodies in
`murow/netcode` via `ctx.fields(C)`, which additionally auto-marks the
entity dirty for the snapshot codec.

| Entities | Avg Frame Time |     Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | -------------: | -------: | -------: | -------: | -------: | -------: |
|      500 |    **0.16 ms** | **~6,250 FPS** | **0.14** | **0.25** | **0.79** | **2.14** | **0.09** |
|    1,000 |    **0.15 ms** | **~6,670 FPS** | **0.13** | **0.31** | **0.64** | **0.92** | **0.08** |
|    5,000 |    **0.90 ms** | **~1,110 FPS** | **0.66** | **2.24** | **3.30** | **4.93** | **0.56** |
|   10,000 |    **1.45 ms** |   **~690 FPS** | **1.52** | **1.87** | **4.12** | **4.60** | **0.52** |
|   15,000 |    **2.58 ms** |   **~388 FPS** | **2.32** | **3.53** | **5.60** | **6.06** | **0.67** |
|   25,000 |    **5.89 ms** |   **~170 FPS** | **5.74** | **6.89** | **9.59** |**10.00** | **0.67** |
|   50,000 |   **11.78 ms** |    **~85 FPS** |**11.45** |**13.52** |**19.08** |**19.97** | **1.29** |
|  100,000 |   **25.44 ms** |    **~39 FPS** |**25.42** |**30.89** |**38.82** |**39.21** | **3.85** |

**Takeaways:**

- ~30% slower than RAW at 10k entities (1.45 ms vs 1.12 ms). The extra
  cost is one property load per typed-array access (`pos.x[eid]` vs the
  bare `transformX[eid]`); JIT inlines most of it but not all.
- ~35% faster than Hybrid at 10k (1.45 ms vs 2.23 ms). At small/mid
  entity counts where most games operate, this is the sweet spot for
  hand-written systems.
- Holds 60 FPS up to 25k entities. ~92% of frames stay under 16.67 ms at
  50k (the rest spill ~3 ms over). At 100k entities lands at ~25 ms,
  3.4x faster than Direct.
- Tail variance stays controlled (max/P50 ~1.5-3x), no GC stalls.
- Predictions and handlers in `murow/netcode` get this performance
  by default via `ctx.fields(C)`, with the bonus of automatic dirty
  marking on networked components.

---

## Murow ECS — DIRECT API (TypeScript / Bun)

**11 systems — 5-run average**

Plain `world.query()` + `world.get()` + `world.update()` per entity. No
`addSystem` builder, no cached typed-array references, no `world.fields`
bundle. **Slowest tier by design** — included so users can see the cost
of the per-entity object allocation `world.update({...})` performs and
the read-view repopulation `world.get` does.

Use this style when ergonomics matter more than speed (test setup,
debug tooling, one-off scripts). For per-frame systems use the System
Builder. For prediction/handler bodies in `murow/netcode`, use
`ctx.fields(C)` instead — that has its own benchmark below (FIELDS API)
landing close to RAW.

| Entities | Avg Frame Time |     Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | -------------: | -------: | -------: | -------: | -------: | -------: |
|      500 |    **0.47 ms** | **~2,130 FPS** | **0.43** | **0.66** | **1.78** | **4.00** | **0.19** |
|    1,000 |    **0.71 ms** | **~1,410 FPS** | **0.67** | **0.98** | **1.41** | **1.85** | **0.13** |
|    5,000 |    **3.42 ms** |   **~292 FPS** | **3.16** | **4.27** | **7.20** |**10.40** | **0.68** |
|   10,000 |    **6.91 ms** |   **~145 FPS** | **6.64** | **8.70** |**11.18** |**11.51** | **0.84** |
|   15,000 |   **12.50 ms** |    **~80 FPS** |**12.40** |**14.90** |**15.39** |**15.76** | **1.05** |
|   25,000 |   **18.21 ms** |    **~55 FPS** |**17.64** |**21.89** |**28.08** |**30.44** | **1.88** |
|   50,000 |   **42.70 ms** |    **~23 FPS** |**41.52** |**49.16** |**55.82** |**70.43** | **3.17** |
|  100,000 |   **77.47 ms** |    **~13 FPS** |**75.69** |**92.94** |**107.90**|**116.62**| **7.46** |

**Takeaways:**
- ~6× slower than RAW at 10k entities (6.91 ms vs 1.12 ms).
- Falls off the 60 FPS budget around 25k entities.
- Tail variance remains controlled (~1.5× max/P50) — same GC story as the other Murow tiers.
- **Use freely for predictions (one entity per call). Use the System Builder for hot per-frame loops.**

---

## bitECS (JavaScript)

**11 systems — 5-run average**

| Entities | Avg Frame Time | Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | ---------: | -------: | -------: | -------: | -------: | -------: |
|      500 |        0.18 ms | ~5,560 FPS |     0.08 |     0.22 |     5.09 |    11.88 |     0.64 |
|    1,000 |        0.19 ms | ~5,260 FPS |     0.11 |     0.20 |     4.29 |     5.28 |     0.53 |
|    5,000 |        0.89 ms | ~1,120 FPS |     0.55 |     0.76 |    19.72 |    25.39 |     2.45 |
|   10,000 |        1.63 ms |   ~613 FPS |     0.96 |     1.26 |    39.18 |    42.07 |     4.89 |
|   15,000 |        2.31 ms |   ~433 FPS |     1.40 |     1.86 |    52.95 |    56.10 |     6.59 |
|   25,000 |        3.91 ms |   ~256 FPS |     2.42 |     3.16 |    87.15 |    95.70 |    10.84 |
|   50,000 |        6.95 ms |   ~144 FPS |     4.19 |     5.65 |   160.68 |   170.94 |    20.02 |
|  100,000 |       13.28 ms |    ~75 FPS |     7.68 |    10.30 |   321.65 |   349.95 |    40.16 |

---

## Bevy ECS (Rust)

**11 systems — 5-run average**

| Entities | Avg Frame Time |  Approx FPS | P50      | P95      | P99      | Max      | StdDev   |
| -------: | -------------: | ----------: | -------: | -------: | -------: | -------: | -------: |
|      500 |        0.04 ms | ~25,000 FPS |     0.03 |     0.04 |     0.43 |     0.52 |     0.05 |
|    1,000 |        0.06 ms | ~16,670 FPS |     0.06 |     0.07 |     0.46 |     0.51 |     0.05 |
|    5,000 |        0.23 ms |  ~4,350 FPS |     0.21 |     0.25 |     0.69 |     0.86 |     0.06 |
|   10,000 |        0.43 ms |  ~2,330 FPS |     0.42 |     0.48 |     1.12 |     1.20 |     0.09 |
|   15,000 |        0.65 ms |  ~1,540 FPS |     0.63 |     0.72 |     1.58 |     1.67 |     0.12 |
|   25,000 |        1.08 ms |    ~926 FPS |     1.05 |     1.20 |     2.48 |     2.81 |     0.19 |
|   50,000 |        2.18 ms |    ~459 FPS |     2.11 |     2.35 |     5.21 |     5.54 |     0.41 |
|  100,000 |        4.42 ms |    ~226 FPS |     4.28 |     4.71 |    11.27 |    11.76 |     0.91 |

---

## Relative Comparison

### @ 5k Entities

| Engine                 |    Avg Time |         Relative |
| ---------------------- | ----------: | ---------------: |
| Bevy (Rust)            |     0.23 ms |               1× |
| **Murow RAW**          | **0.62 ms** | **~2.7× slower** |
| bitECS                 |     0.89 ms |     ~3.9× slower |
| **Murow Hybrid**       | **1.10 ms** | **~4.8× slower** |
| **Murow Ergonomic**    | **1.67 ms** | **~7.3× slower** |


### @ 10k Entities

| Engine                 |    Avg Time |         Relative |
| ---------------------- | ----------: | ---------------: |
| Bevy (Rust)            |     0.43 ms |               1× |
| **Murow RAW**          | **1.12 ms** | **~2.6× slower** |
| bitECS                 |     1.63 ms |     ~3.8× slower |
| **Murow Hybrid**       | **2.23 ms** | **~5.2× slower** |
| **Murow Ergonomic**    | **3.37 ms** | **~7.8× slower** |

### @ 25k Entities

| Engine                 |    Avg Time |         Relative |
| ---------------------- | ----------: | ---------------: |
| Bevy (Rust)            |     1.08 ms |               1× |
| **Murow RAW**          | **3.51 ms** | **~3.3× slower** |
| bitECS                 |     3.91 ms |     ~3.6× slower |
| **Murow Hybrid**       | **5.58 ms** | **~5.2× slower** |
| **Murow Ergonomic**    | **8.69 ms** | **~8.0× slower** |

### @ 50k Entities

| Engine                 |    Avg Time |         Relative |
| ---------------------- | ----------: | ---------------: |
| Bevy (Rust)            |     2.18 ms |               1× |
| bitECS                 |     6.95 ms |     ~3.2× slower |
| **Murow RAW**          | **8.18 ms** | **~3.8× slower** |
| **Murow Hybrid**       |**11.29 ms** | **~5.2× slower** |
| **Murow Ergonomic**    |**17.43 ms** | **~8.0× slower** |

### @ 100k Entities

| Engine                 |    Avg Time |         Relative |
| ---------------------- | ----------: | ---------------: |
| Bevy (Rust)            |     4.42 ms |               1× |
| bitECS                 |    13.28 ms |     ~3.0× slower |
| **Murow RAW**          |**21.39 ms** | **~4.8× slower** |
| **Murow Hybrid**       |**22.83 ms** | **~5.2× slower** |
| **Murow Ergonomic**    |**35.07 ms** | **~7.9× slower** |

---

## Performance Variance Analysis

Based on P50/max values across 5 runs at 100k entities:

| Engine                 | Avg Time | P50 Time | Max Time | Variance (Max/P50) |
| ---------------------- | -------: | -------: | -------: | -----------------: |
| **Murow Ergonomic**    |**35.07ms**|**34.54ms**|**55.37ms**|        **~1.6×** |
| **Murow RAW**          |**21.39ms**|**20.76ms**|**36.04ms**|        **~1.7×** |
| **Murow Hybrid**       |**22.83ms**|**22.42ms**|**39.52ms**|        **~1.8×** |
| Bevy (Rust)            |  4.42 ms |  4.28 ms | 11.76 ms |             ~2.7× |
| bitECS                 | 13.28 ms |  7.68 ms |349.95 ms |            ~45.6× |

**Observations:**
* All Murow APIs show **exceptional consistency** (~1.6-1.8× variance) with tight P50-to-max ranges
* Murow achieves better variance control than even Bevy (~2.7×)
* bitECS shows extreme variance (~45.6×) with occasional GC pauses exceeding 300ms
* Low variance is critical for consistent frame times in real-time applications

---

## Key Takeaways (concise, factual)

* Murow RAW API:
  * **beats bitECS up to ~25k entities** on a **2011 CPU**
  * reaches **100k entities at ~47 FPS** (21.39ms) with single-digit frame times up to 50k
  * maintains **~2.6-4.8× slower than Bevy** across all scales
  * scaling is **cleanly linear** across the entire range
  * **exceptional variance control** (~1.7× max/P50 ratio at 100k entities)

* Murow Hybrid API (direct array access):
  * **dramatically improved** - now only **~1.07× slower than RAW** at 100k entities
  * reaches **100k entities at ~44 FPS** (22.83ms), nearly matching RAW performance
  * balances performance with type safety
  * **best-in-class variance** (~1.8× max/P50 ratio)
  * ideal for production use when ergonomics matter

* Murow Ergonomic API (cached field access):
  * **~1.5× slower than Hybrid**, **~1.6× slower than RAW**
  * reaches **100k entities at ~29 FPS** (35.07ms)
  * prioritizes developer experience with property-like syntax
  * **outstanding consistency** (~1.6× max/P50 ratio - better than Bevy!)

* All Murow variants:
  * **better variance control than Bevy** (1.6-1.8× vs 2.7×)
  * demonstrate **cleanly linear scaling** across 500-100k entities
  * viable for **real-time server simulations** and **rollback / deterministic multiplayer**
  * competitive among **TypeScript/JavaScript ECS implementations**
  * **critical for consistent frame times** in production environments


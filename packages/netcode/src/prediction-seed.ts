/**
 * Bit-mixing constants for deterministic prediction RNG seeds.
 *
 * These are non-cryptographic mixing constants (MurmurHash3 finalizer and
 * common odd 32-bit multipliers). They are part of the determinism contract:
 * changing any of them changes every predicted random sequence.
 */
const MIX_GOLDEN = 0x9e3779b9;
const MIX_MURMUR_C1 = 0x85ebca6b;
const MIX_MURMUR_C2 = 0xc2b2ae35;
const MIX_FINAL_A = 0x27d4eb2f;
const MIX_FINAL_B = 0x2545f491;

/**
 * Derive a deterministic prediction RNG seed from the match seed and an
 * intent's canonical client tick, entity, and sequence.
 *
 * The live prediction and its rollback replay must pass the same tuple.
 * Server and client must use the intent's client tick, never the server tick.
 */
export function predictionSeed(
    seed: number,
    tick: number,
    entity: number,
    sequence: number,
): number {
    let h = (seed ^ MIX_GOLDEN) | 0;
    h = Math.imul(h ^ tick, MIX_MURMUR_C1);
    h = Math.imul(h ^ entity, MIX_MURMUR_C2);
    h = Math.imul(h ^ sequence, MIX_FINAL_A);
    h ^= h >>> 15;
    h = Math.imul(h, MIX_FINAL_B);
    h ^= h >>> 16;
    return h | 0;
}

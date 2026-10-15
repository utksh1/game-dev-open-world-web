/**
 * Deterministic RNG utilities — the same chunk always generates the same
 * city block (seeded by chunk coords + level id), so streaming in/out
 * never reshuffles the world.
 */

/** Fast, decent-quality 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash a chunk coordinate + level id into a 32-bit seed. */
export function chunkSeed(cx: number, cz: number, levelId: string): number {
  let h = 2166136261 ^ Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263)
  for (let i = 0; i < levelId.length; i++) {
    h ^= levelId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Random float in [min, max). */
export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

/** Random integer in [min, max] inclusive. */
export function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(randRange(rng, min, max + 1))
}

/** Pick a random element. */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

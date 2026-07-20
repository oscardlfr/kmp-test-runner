#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/randomizer.mjs -- seeded condition-order randomizer. Hand-rolled mulberry32
// PRNG (no new dependency, matching every other tools/*.mjs file) -- deterministic: the same
// seed always produces the same order, for reproducibility.

/** mulberry32: small, fast, seedable PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle using a seeded PRNG -- pure, does not mutate the input array. */
export function seededShuffle(array, seed) {
  const rng = mulberry32(seed);
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds the full ordered dispatch matrix for a set of scenarios x conditions x repeats,
 * shuffled deterministically by seed. Each cell records its order_index for the run record.
 */
export function buildRunMatrix(scenarios, conditions, repeats, seed) {
  const cells = [];
  for (const scenario of scenarios) {
    for (const condition of conditions) {
      for (let rep = 0; rep < repeats; rep++) {
        cells.push({ scenarioId: scenario.id ?? scenario, condition, repetition: rep });
      }
    }
  }
  const shuffled = seededShuffle(cells, seed);
  return shuffled.map((cell, orderIndex) => ({ ...cell, orderIndex, seed }));
}

/**
 * Deterministic condition-order counterbalancing for `repeats` paired trials (one `run`
 * invocation's `no-skill`/`current-skill` pair, repeated). A shuffle alone (e.g. feeding
 * buildRunMatrix a 2-valued conditions array and reading off which value landed first per pair)
 * only gives an UNBIASED order in expectation -- it does not GUARANTEE balance for small repeat
 * counts, since a fair coin flipped `repeats` times has a real chance of landing the same way every
 * time. "Counterbalanced" means a controlled, guaranteed split, not a probabilistic tendency.
 *
 * Draws exactly ONE seeded random value (which arm starts), then deterministically ALTERNATES
 * every repetition -- an exact 50/50 split for even `repeats`, an off-by-one split (the best
 * achievable) for odd `repeats`. Still fully seeded and reproducible: the only randomness is which
 * arm starts first; whether alternation happens is never left to chance.
 * @param {number} repeats
 * @param {number} seed
 * @returns {Array<['current-skill','no-skill']|['no-skill','current-skill']>} length === repeats;
 *   orders[i] is the [first, second] condition order for repetition i.
 */
export function buildConditionOrders(repeats, seed) {
  const rng = mulberry32(seed);
  const startsCurrentSkillFirst = rng() < 0.5;
  const orders = [];
  for (let rep = 0; rep < repeats; rep++) {
    const repStartsCurrentSkillFirst = rep % 2 === 0 ? startsCurrentSkillFirst : !startsCurrentSkillFirst;
    orders.push(repStartsCurrentSkillFirst ? ['current-skill', 'no-skill'] : ['no-skill', 'current-skill']);
  }
  return orders;
}

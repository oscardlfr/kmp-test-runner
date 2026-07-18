// tests/vitest/agentic-eval-randomizer.test.js
// Unit tests for tools/agentic-eval/randomizer.mjs -- seed reproducibility.
import { describe, it, expect } from 'vitest';
import { mulberry32, seededShuffle, buildRunMatrix } from '../../tools/agentic-eval/randomizer.mjs';

describe('mulberry32', () => {
  it('is deterministic: the same seed produces the same sequence', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('different seeds produce different sequences', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBe(b());
  });

  it('produces values in [0, 1)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('seededShuffle', () => {
  it('same seed -> identical order across calls', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(seededShuffle(arr, 123)).toEqual(seededShuffle(arr, 123));
  });

  it('different seeds -> different order (with high probability for this array size)', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(seededShuffle(arr, 1)).not.toEqual(seededShuffle(arr, 2));
  });

  it('does not mutate the input array', () => {
    const arr = [1, 2, 3];
    const copy = [...arr];
    seededShuffle(arr, 5);
    expect(arr).toEqual(copy);
  });

  it('preserves the same set of elements (a permutation, not a subset)', () => {
    const arr = ['a', 'b', 'c', 'd'];
    const shuffled = seededShuffle(arr, 9);
    expect([...shuffled].sort()).toEqual([...arr].sort());
  });
});

describe('buildRunMatrix', () => {
  it('produces scenarios x conditions x repeats total cells', () => {
    const matrix = buildRunMatrix(['s1', 's2'], ['no-skill', 'current-skill'], 3, 1);
    expect(matrix.length).toBe(2 * 2 * 3);
  });

  it('assigns a unique, contiguous order_index to each cell', () => {
    const matrix = buildRunMatrix(['s1', 's2'], ['no-skill'], 2, 1);
    const indices = matrix.map((c) => c.orderIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  it('same seed -> identical matrix order (reproducibility)', () => {
    const a = buildRunMatrix(['s1', 's2', 's3'], ['no-skill', 'current-skill'], 2, 77);
    const b = buildRunMatrix(['s1', 's2', 's3'], ['no-skill', 'current-skill'], 2, 77);
    expect(a).toEqual(b);
  });

  it('every cell records the seed used', () => {
    const matrix = buildRunMatrix(['s1'], ['no-skill'], 1, 55);
    expect(matrix.every((c) => c.seed === 55)).toBe(true);
  });
});

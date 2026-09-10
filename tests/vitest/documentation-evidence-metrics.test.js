import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './_parity-helpers.js';

const EVIDENCE_DIR = path.join(
  REPO_ROOT,
  'tools',
  'runs',
  'agentic-eval-evidence1-product-vs-free-canary-2026-09-10',
);

function metric(record, field) {
  const value = record[field];
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe('published Evidence1 operational metrics', () => {
  const records = readdirSync(EVIDENCE_DIR)
    .filter(name => name.startsWith('scenario-') && name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(path.join(EVIDENCE_DIR, name), 'utf8')));
  const product = records.filter(record => record.condition === 'current-skill');
  const baseline = records.filter(record => record.condition === 'no-skill');

  it('keeps the six one-shot records outside benchmark aggregates', () => {
    expect(records).toHaveLength(6);
    expect(product).toHaveLength(3);
    expect(baseline).toHaveLength(3);
    expect(records.every(record => record.benchmark_eligible === false)).toBe(true);
    expect(new Set(product.map(record => record.repo_commit))).toEqual(
      new Set(baseline.map(record => record.repo_commit)),
    );
  });

  it('grounds the README summary in committed sanitized records', () => {
    expect(product.filter(record => metric(record, 'expected_outcome_matched') === true)).toHaveLength(3);
    expect(baseline.filter(record => metric(record, 'expected_outcome_matched') === true)).toHaveLength(0);
    expect(median(product.map(record => record.wall_clock_ms))).toBe(121050);
    expect(median(baseline.map(record => record.wall_clock_ms))).toBe(170452);
    expect(product.map(record => metric(record, 'tool_calls_total')).sort((a, b) => a - b)).toEqual([3, 3, 3]);
    expect(baseline.map(record => metric(record, 'tool_calls_total')).sort((a, b) => a - b)).toEqual([14, 18, 22]);
    expect(product.map(record => metric(record, 'test_invocations_total'))).toEqual([1, 1, 1]);
    expect(baseline.map(record => metric(record, 'test_invocations_total'))).toEqual([0, 0, 0]);

    const readme = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    expect(readme).toContain('| Product | 3 | 3/3 | 121.1 s (116.3-125.1) | 3 / 2 |');
    expect(readme).toContain('| FreeBaseline | 3 | 0/3 | 170.5 s (165.7-237.1) | 18 / 18 |');
    expect(readme).toContain('`benchmark_eligible:false`');
  });

  it('does not turn a missing baseline signal into zero', () => {
    expect(product.every(record => metric(record, 'first_useful_signal_ms') > 0)).toBe(true);
    expect(baseline.every(record => metric(record, 'first_useful_signal_ms') === null)).toBe(true);

    const metrics = readFileSync(path.join(REPO_ROOT, 'docs', 'metrics.md'), 'utf8');
    expect(metrics).toContain('| First useful signal, median (range) | 116.7 s (113.6-122.4) | unavailable in 3/3 |');
    expect(metrics).toContain('operational canary, not a benchmark or causal estimate');
  });
});

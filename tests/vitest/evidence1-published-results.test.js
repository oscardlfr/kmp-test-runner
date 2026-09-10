import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { REPO_ROOT } from './_parity-helpers.js';

const EVIDENCE_DIR = path.join(REPO_ROOT, 'tools', 'runs',
  'agentic-eval-evidence1-product-vs-free-canary-2026-09-10');
const recordFiles = readdirSync(EVIDENCE_DIR)
  .filter(name => name.startsWith('scenario-') && name.endsWith('.json'))
  .sort();
const records = recordFiles.map(name => JSON.parse(readFileSync(path.join(EVIDENCE_DIR, name), 'utf8')));

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metric(record, key) {
  const value = record[key];
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

describe('published Evidence1 canary package', () => {
  it('contains three product and three free-baseline records with matching sidecars', () => {
    expect(records).toHaveLength(6);
    expect(records.filter(record => record.product_access_mode === 'product-assisted')).toHaveLength(3);
    expect(records.filter(record => record.product_access_mode === 'free-baseline-no-product')).toHaveLength(3);
    for (const [index, record] of records.entries()) {
      expect(record.schema).toBe(8);
      expect(record.benchmark_eligible).toBe(false);
      expect(existsSync(path.join(EVIDENCE_DIR, 'audit', recordFiles[index]))).toBe(true);
    }
  });

  it('every public record passes the production validator', () => {
    for (const file of recordFiles) {
      const result = spawnSync(process.execPath,
        ['tools/agentic-eval/cli.mjs', 'validate', '--run', path.join(EVIDENCE_DIR, file)],
        { cwd: REPO_ROOT, encoding: 'utf8' });
      expect(result.status, `${file}: ${result.stderr}`).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ errors: [], warnings: [] });
    }
  });

  it('locks the published descriptive headline to record fields', () => {
    const product = records.filter(record => record.product_access_mode === 'product-assisted');
    const baseline = records.filter(record => record.product_access_mode === 'free-baseline-no-product');

    expect(product.filter(record => metric(record, 'expected_outcome_matched') === true)).toHaveLength(3);
    expect(baseline.filter(record => metric(record, 'expected_outcome_matched') === true)).toHaveLength(0);
    expect(Math.round(mean(product.map(record => record.wall_clock_ms)))).toBe(120817);
    expect(Math.round(mean(baseline.map(record => record.wall_clock_ms)))).toBe(191080);
    expect(mean(product.map(record => metric(record, 'tool_calls_total')))).toBe(3);
    expect(mean(baseline.map(record => metric(record, 'tool_calls_total')))).toBe(18);
    expect(mean(product.map(record => metric(record, 'shell_commands_total')))).toBe(2);
    expect(mean(baseline.map(record => metric(record, 'shell_commands_total')))).toBe(18);
  });
});

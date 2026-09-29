// tests/vitest/agentic-eval-isolation-probe.test.js
// Unit tests for tools/agentic-eval/isolation-probe.mjs (eval-v2, design.md (c)'s automated
// pre-session probe). Every test uses a REAL temp directory tree (never a mocked filesystem) --
// the whole point of this probe is to catch a real leak on a real filesystem, so its own tests
// must exercise a real filesystem too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkIsolationProbe, findLeakedExpectedValues, findProductSurfaceForFreeCell,
  findForbiddenHarnessPaths, extractSensitiveValues,
} from '../../tools/agentic-eval/isolation-probe.mjs';

const REAL_EXPECTED = Object.freeze({
  module: ':core:domain',
  outcome_kind: 'coverage_threshold_exceeded',
  kmp_test: {
    tests: { total: 1, passed: 1, failed: 0, skipped: 0, individual_total: 4 },
    exit_code: 1,
    coverage: { tool: 'auto', min_missed_lines: 15, missed_lines: 23, with_data: [':core:domain'] },
  },
  gradle: {
    allowed_invocations: [':core:domain:test'],
    evidence_task: ':core:domain:test',
    tests: { total: 4, passed: 4, failed: 0 },
    exit_code: 0,
  },
});

let workspaceDir;
let siblingDir;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-isolation-probe-workspace-'));
  siblingDir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-isolation-probe-sibling-'));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
  rmSync(siblingDir, { recursive: true, force: true });
});

describe('extractSensitiveValues', () => {
  it('extracts exactly design.md (c)\'s own enumerated set: module, outcome_kind, missed_lines, threshold', () => {
    const values = extractSensitiveValues(REAL_EXPECTED);
    const labels = values.map((v) => v.label).sort();
    expect(labels).toEqual([
      'kmp_test.coverage.min_missed_lines', 'kmp_test.coverage.missed_lines', 'module', 'outcome_kind',
    ]);
    expect(values.find((v) => v.label === 'module').value).toBe(':core:domain');
    expect(values.find((v) => v.label === 'outcome_kind').value).toBe('coverage_threshold_exceeded');
    expect(values.find((v) => v.label === 'kmp_test.coverage.missed_lines').value).toBe('23');
    expect(values.find((v) => v.label === 'kmp_test.coverage.min_missed_lines').value).toBe('15');
  });

  it('deliberately never extracts individual_total or evidence_task -- outside design.md (c)\'s own enumerated set, and individual_total can legitimately be a single digit (this repo\'s own anchor scenario: 4)', () => {
    const values = extractSensitiveValues(REAL_EXPECTED);
    const labels = values.map((v) => v.label);
    expect(labels).not.toContain('kmp_test.tests.individual_total');
    expect(labels).not.toContain('gradle.evidence_task');
  });

  it('returns an empty array for a null/malformed expected block, never throws', () => {
    expect(extractSensitiveValues(null)).toEqual([]);
    expect(extractSensitiveValues(undefined)).toEqual([]);
    expect(extractSensitiveValues({})).toEqual([]);
  });
});

describe('findLeakedExpectedValues -- check 1 (design.md (c))', () => {
  it('RED: a planted file containing the real module path is detected as a leak', () => {
    writeFileSync(join(workspaceDir, 'leaked-scenario.json'), JSON.stringify({ note: 'the answer is :core:domain apparently' }));
    const violations = findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED });
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.code === 'expected_value_leaked' && v.detail.includes('module'))).toBe(true);
  });

  it('RED: a planted file containing the real outcome_kind string is detected as a leak', () => {
    writeFileSync(join(workspaceDir, 'notes.txt'), 'internal note: expect coverage_threshold_exceeded here');
    const violations = findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED });
    expect(violations.some((v) => v.code === 'expected_value_leaked' && v.detail.includes('outcome_kind'))).toBe(true);
  });

  it('RED: a planted file containing the real missed_lines count is detected as a leak', () => {
    writeFileSync(join(workspaceDir, 'stray.log'), 'computed missed_lines=23 during a prior debug run');
    const violations = findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED });
    expect(violations.some((v) => v.detail.includes('missed_lines'))).toBe(true);
  });

  it('RED: a leak in a TEMP-ROOT SIBLING (not the workspace itself) is still detected', () => {
    writeFileSync(join(siblingDir, 'debug-dump.json'), JSON.stringify({ evidence_task: ':core:domain:test' }));
    const violations = findLeakedExpectedValues({ roots: [workspaceDir, siblingDir], expected: REAL_EXPECTED });
    expect(violations.some((v) => v.path.startsWith(siblingDir))).toBe(true);
  });

  it('GREEN: a clean workspace with only unrelated, non-leaking content produces zero violations', () => {
    writeFileSync(join(workspaceDir, 'README.md'), 'This is a totally unrelated project readme with no scenario facts in it.');
    mkdirSync(join(workspaceDir, 'src'), { recursive: true });
    writeFileSync(join(workspaceDir, 'src', 'Main.kt'), 'fun main() { println("hello") }');
    const violations = findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED });
    expect(violations).toEqual([]);
  });

  it('GREEN once removed: the exact same planted leak from the first RED case is gone after cleanup', () => {
    const leakPath = join(workspaceDir, 'leaked-scenario.json');
    writeFileSync(leakPath, JSON.stringify({ note: 'the answer is :core:domain apparently' }));
    expect(findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED }).length).toBeGreaterThan(0);
    rmSync(leakPath);
    expect(findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED })).toEqual([]);
  });

  it('does not scan a file larger than the size cap, never crashing or hanging on it', () => {
    writeFileSync(join(workspaceDir, 'huge.bin'), Buffer.alloc(3 * 1024 * 1024, 'x'));
    expect(() => findLeakedExpectedValues({ roots: [workspaceDir], expected: REAL_EXPECTED })).not.toThrow();
  });

  it('a nonexistent root (a sibling this cell never created) is treated as empty, not an error', () => {
    const violations = findLeakedExpectedValues({ roots: [join(tmpdir(), 'kmp-agentic-eval-does-not-exist-at-all')], expected: REAL_EXPECTED });
    expect(violations).toEqual([]);
  });
});

describe('findProductSurfaceForFreeCell -- check 2 (design.md (c))', () => {
  it('RED: a SKILL.md anywhere under the roots is detected', () => {
    mkdirSync(join(siblingDir, '.skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(join(siblingDir, '.skills', 'kmp-test-runner', 'SKILL.md'), '# fake skill');
    const violations = findProductSurfaceForFreeCell({ roots: [workspaceDir, siblingDir] });
    expect(violations.some((v) => v.code === 'skill_snapshot_present_for_free_cell')).toBe(true);
  });

  it('RED: a kmp-test.js-shaped shim anywhere under the roots is detected', () => {
    mkdirSync(join(siblingDir, 'bin'), { recursive: true });
    writeFileSync(join(siblingDir, 'bin', 'kmp-test.js'), '#!/usr/bin/env node\n');
    const violations = findProductSurfaceForFreeCell({ roots: [workspaceDir, siblingDir] });
    expect(violations.some((v) => v.code === 'kmp_test_shim_present_for_free_cell')).toBe(true);
  });

  it('RED: a .codex/hooks.json anywhere under the roots is detected', () => {
    mkdirSync(join(workspaceDir, '.codex'), { recursive: true });
    writeFileSync(join(workspaceDir, '.codex', 'hooks.json'), '{}');
    const violations = findProductSurfaceForFreeCell({ roots: [workspaceDir] });
    expect(violations.some((v) => v.code === 'codex_hooks_present_for_free_cell')).toBe(true);
  });

  it('GREEN: a clean free-cell workspace with no product surface at all produces zero violations', () => {
    writeFileSync(join(workspaceDir, 'build.gradle.kts'), '// a normal project file');
    const violations = findProductSurfaceForFreeCell({ roots: [workspaceDir, siblingDir] });
    expect(violations).toEqual([]);
  });

  it('a file merely named "hooks.json" OUTSIDE a .codex directory is not flagged -- filename AND parent both matter', () => {
    mkdirSync(join(workspaceDir, 'config'), { recursive: true });
    writeFileSync(join(workspaceDir, 'config', 'hooks.json'), '{}');
    const violations = findProductSurfaceForFreeCell({ roots: [workspaceDir] });
    expect(violations).toEqual([]);
  });
});

describe('findForbiddenHarnessPaths -- check 3 (design.md (c))', () => {
  it('RED: a corpus/scenarios path segment anywhere under the roots is detected', () => {
    mkdirSync(join(workspaceDir, 'tools', 'agentic-eval', 'corpus', 'scenarios'), { recursive: true });
    writeFileSync(join(workspaceDir, 'tools', 'agentic-eval', 'corpus', 'scenarios', 'some-scenario.json'), '{}');
    const violations = findForbiddenHarnessPaths({ roots: [workspaceDir] });
    expect(violations.some((v) => v.code === 'corpus_scenarios_present')).toBe(true);
  });

  it('RED: a preregistration-shaped document anywhere under the roots is detected', () => {
    mkdirSync(join(workspaceDir, 'docs', 'audits'), { recursive: true });
    writeFileSync(join(workspaceDir, 'docs', 'audits', 'evidence2-preregistration-v1.md'), '# preregistration');
    const violations = findForbiddenHarnessPaths({ roots: [workspaceDir] });
    expect(violations.some((v) => v.code === 'preregistration_doc_present')).toBe(true);
  });

  it('GREEN: a clean checkout with only a corpus/expected directory (never corpus/scenarios) produces zero violations', () => {
    mkdirSync(join(workspaceDir, 'tools', 'agentic-eval', 'corpus', 'expected'), { recursive: true });
    writeFileSync(join(workspaceDir, 'tools', 'agentic-eval', 'corpus', 'expected', 'some-scenario.json'), '{}');
    const violations = findForbiddenHarnessPaths({ roots: [workspaceDir] });
    expect(violations).toEqual([]);
  });
});

describe('checkIsolationProbe -- the combined pre-session probe', () => {
  it('GREEN: a fully clean product-cell workspace passes with zero violations', () => {
    writeFileSync(join(workspaceDir, 'build.gradle.kts'), '// clean');
    mkdirSync(join(siblingDir, '.skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(join(siblingDir, '.skills', 'kmp-test-runner', 'SKILL.md'), '# legitimate for a product cell');
    const result = checkIsolationProbe({ roots: [workspaceDir, siblingDir], expected: REAL_EXPECTED, isFreeCell: false });
    expect(result).toEqual({ ok: true, violations: [] });
  });

  it('RED: the identical SKILL.md that is legitimate for a product cell FAILS for a free cell', () => {
    mkdirSync(join(siblingDir, '.skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(join(siblingDir, '.skills', 'kmp-test-runner', 'SKILL.md'), '# illegitimate for a free cell');
    const productResult = checkIsolationProbe({ roots: [workspaceDir, siblingDir], expected: REAL_EXPECTED, isFreeCell: false });
    const freeResult = checkIsolationProbe({ roots: [workspaceDir, siblingDir], expected: REAL_EXPECTED, isFreeCell: true });
    expect(productResult.ok).toBe(true);
    expect(freeResult.ok).toBe(false);
    expect(freeResult.violations.some((v) => v.code === 'skill_snapshot_present_for_free_cell')).toBe(true);
  });

  it('RED: a genuinely leaked expected value fails the probe for EITHER cell type -- never product-cell-exempt', () => {
    writeFileSync(join(workspaceDir, 'debug.json'), JSON.stringify({ outcome_kind: 'coverage_threshold_exceeded' }));
    const productResult = checkIsolationProbe({ roots: [workspaceDir], expected: REAL_EXPECTED, isFreeCell: false });
    const freeResult = checkIsolationProbe({ roots: [workspaceDir], expected: REAL_EXPECTED, isFreeCell: true });
    expect(productResult.ok).toBe(false);
    expect(freeResult.ok).toBe(false);
  });

  it('combines violations from all three checks in one report, never stopping at the first', () => {
    writeFileSync(join(workspaceDir, 'leak.json'), JSON.stringify({ module: ':core:domain' }));
    mkdirSync(join(workspaceDir, '.codex'), { recursive: true });
    writeFileSync(join(workspaceDir, '.codex', 'hooks.json'), '{}');
    mkdirSync(join(siblingDir, 'corpus', 'scenarios'), { recursive: true });
    writeFileSync(join(siblingDir, 'corpus', 'scenarios', 'x.json'), '{}');
    const result = checkIsolationProbe({ roots: [workspaceDir, siblingDir], expected: REAL_EXPECTED, isFreeCell: true });
    expect(result.ok).toBe(false);
    const codes = new Set(result.violations.map((v) => v.code));
    expect(codes.has('expected_value_leaked')).toBe(true);
    expect(codes.has('codex_hooks_present_for_free_cell')).toBe(true);
    expect(codes.has('corpus_scenarios_present')).toBe(true);
  });

  it('throws a clear TypeError for a missing/empty roots array -- a caller forgetting to pass roots must fail loud, never silently scan nothing and report ok:true', () => {
    expect(() => checkIsolationProbe({ roots: [], expected: REAL_EXPECTED, isFreeCell: false })).toThrow(/roots must be a non-empty array/);
    expect(() => checkIsolationProbe({ expected: REAL_EXPECTED, isFreeCell: false })).toThrow(/roots must be a non-empty array/);
  });
});

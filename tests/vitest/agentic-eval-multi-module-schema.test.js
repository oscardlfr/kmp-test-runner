// tests/vitest/agentic-eval-multi-module-schema.test.js
// Schema contract of the `multi-module-tests` scenario family: its fixture_setup `apply_patch`
// operation, its own `expected` shape and its `smoke` block. Every other family keeps today's rules.
// Each "rejects" case breaks exactly one rule of an otherwise valid scenario and asserts the EXACT
// set of error fields, so it cannot pass because some other part of the scenario was invalid.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario, FAMILY_VALUES } from '../../tools/agentic-eval/schemas.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'fixtures', 'agentic-eval-multi-module');
const corpusDir = path.join(here, '..', '..', 'tools', 'agentic-eval', 'corpus');
const task = JSON.parse(readFileSync(path.join(fixtureDir, 'scenario-draft.json'), 'utf8'));
const truth = JSON.parse(readFileSync(path.join(fixtureDir, 'expected-draft.json'), 'utf8'));

/** The merged shape loadScenarioById builds: the task file plus the ground-truth file. */
function merged(edit) {
  const scenario = structuredClone({
    ...task,
    expected_outcome: truth.expected_outcome,
    expected: truth.expected,
    smoke: truth.smoke,
    first_useful_signal_predicate: truth.first_useful_signal_predicate,
  });
  if (edit) edit(scenario);
  return scenario;
}

const fieldsOf = (result) => result.errors.map((e) => e.field).sort();

describe('multi-module-tests family -- the WO-06 drafts', () => {
  it('lists multi-module-tests among the family values', () => {
    expect(FAMILY_VALUES).toContain('multi-module-tests');
  });

  it('validates the scenario and expected drafts with no error and no warning', () => {
    const result = validateScenario(merged());
    expect(result).toEqual({ errors: [], warnings: [] });
  });

  it('validates a tests_passed scenario with empty failing sets, a zero count and no fixture_setup', () => {
    const result = validateScenario(merged((s) => {
      s.expected = { outcome_kind: 'tests_passed', failing_modules: [], failed_test_classes: [], failed_count: 0 };
      delete s.fixture_setup;
    }));
    expect(result).toEqual({ errors: [], warnings: [] });
  });
});

describe('multi-module-tests family -- fixture_setup apply_patch', () => {
  it('rejects a patch_file that is not a lowercase kebab name ending in .patch', () => {
    for (const bad of ['Bad Name.patch', '../x.patch', 'x.diff', 'sub/x.patch', 'X.patch', '.patch', 7, null]) {
      const result = validateScenario(merged((s) => { s.fixture_setup.patch_file = bad; }));
      expect(fieldsOf(result), String(bad)).toEqual(['fixture_setup.patch_file']);
    }
  });

  it('rejects an expected_paths entry that contains a .. segment', () => {
    const result = validateScenario(merged((s) => { s.fixture_setup.expected_paths = ['core/../etc/passwd']; }));
    expect(fieldsOf(result)).toEqual(['fixture_setup.expected_paths']);
  });

  it('rejects an expected_paths entry with a leading slash', () => {
    const result = validateScenario(merged((s) => { s.fixture_setup.expected_paths = ['/core/data/A.kt']; }));
    expect(fieldsOf(result)).toEqual(['fixture_setup.expected_paths']);
  });

  it('rejects an expected_paths entry with a backslash', () => {
    const result = validateScenario(merged((s) => { s.fixture_setup.expected_paths = ['core\\data\\A.kt']; }));
    expect(fieldsOf(result)).toEqual(['fixture_setup.expected_paths']);
  });

  it('rejects a duplicate expected_paths entry', () => {
    const result = validateScenario(merged((s) => {
      const p = s.fixture_setup.expected_paths[0];
      s.fixture_setup.expected_paths = [p, p];
    }));
    expect(fieldsOf(result)).toEqual(['fixture_setup.expected_paths']);
  });

  it('rejects an empty or non-array expected_paths', () => {
    for (const bad of [[], 'core/A.kt', null]) {
      const result = validateScenario(merged((s) => { s.fixture_setup.expected_paths = bad; }));
      expect(fieldsOf(result), JSON.stringify(bad)).toEqual(['fixture_setup.expected_paths']);
    }
  });

  it('rejects a key that belongs to append_comment', () => {
    const result = validateScenario(merged((s) => { s.fixture_setup.relative_path = 'core/A.kt'; }));
    expect(fieldsOf(result)).toEqual(['fixture_setup.relative_path']);
  });

  it('rejects apply_patch in a family other than multi-module-tests', () => {
    const scenario = JSON.parse(readFileSync(path.join(corpusDir, 'scenarios', 'deterministic-unit-test-failure.json'), 'utf8'));
    const truthFile = JSON.parse(readFileSync(path.join(corpusDir, 'expected', 'deterministic-unit-test-failure.json'), 'utf8'));
    const result = validateScenario({
      ...scenario,
      expected_outcome: truthFile.expected_outcome,
      expected: truthFile.expected,
      first_useful_signal_predicate: truthFile.first_useful_signal_predicate,
      fixture_setup: { operation: 'apply_patch', patch_file: 'x.patch', expected_paths: ['core/A.kt'] },
    });
    expect(result.errors.map((e) => e.field)).toEqual(['fixture_setup.operation']);
    expect(result.errors[0].message).toMatch(/apply_patch.*multi-module-tests/);
  });

  it('keeps rejecting append_comment on a multi-module-tests scenario', () => {
    const result = validateScenario(merged((s) => {
      s.fixture_setup = { operation: 'append_comment', relative_path: 'core/common/A.kt', expected_blob_oid: 'a'.repeat(40) };
    }));
    // Today's rule, unchanged: append_comment needs a matching expected.changed, which this family rejects.
    expect(result.errors.map((e) => e.field)).toEqual(['expected.changed']);
  });
});

describe('multi-module-tests family -- expected', () => {
  it('rejects a duplicate failing_modules entry', () => {
    const result = validateScenario(merged((s) => { s.expected.failing_modules = [':core:data', ':core:data']; }));
    expect(fieldsOf(result)).toEqual(['expected.failing_modules']);
  });

  it('rejects a failing_modules entry that is not a colon-prefixed Gradle path', () => {
    for (const bad of ['core:data', ':', ':core:', ':core data', ':core/data', 7]) {
      const result = validateScenario(merged((s) => { s.expected.failing_modules = [bad]; }));
      expect(fieldsOf(result), String(bad)).toEqual(['expected.failing_modules']);
    }
  });

  it('rejects a duplicate failed_test_classes entry', () => {
    const result = validateScenario(merged((s) => { s.expected.failed_test_classes = ['AFooTest', 'AFooTest', 'BFooTest']; }));
    expect(fieldsOf(result)).toEqual(['expected.failed_test_classes']);
  });

  it('rejects a failed_test_classes entry that is not a Java identifier', () => {
    for (const bad of ['a.b.CTest', '1Test', 'A Test', '', 7]) {
      const result = validateScenario(merged((s) => { s.expected.failed_test_classes = [bad, 'BFooTest', 'CFooTest']; }));
      expect(fieldsOf(result), JSON.stringify(bad)).toEqual(['expected.failed_test_classes']);
    }
  });

  it('rejects a failed_count below the number of failed classes', () => {
    const result = validateScenario(merged((s) => { s.expected.failed_count = s.expected.failed_test_classes.length - 1; }));
    expect(fieldsOf(result)).toEqual(['expected.failed_count']);
  });

  it('rejects a negative, fractional or non-numeric failed_count', () => {
    for (const bad of [-1, 1.5, '6', null]) {
      const result = validateScenario(merged((s) => { s.expected.failed_count = bad; }));
      expect(fieldsOf(result), String(bad)).toEqual(['expected.failed_count']);
    }
  });

  it('rejects tests_passed together with failing modules, classes and a count', () => {
    const result = validateScenario(merged((s) => { s.expected.outcome_kind = 'tests_passed'; }));
    expect(fieldsOf(result)).toEqual(['expected.failed_count', 'expected.failed_test_classes', 'expected.failing_modules']);
  });

  it('rejects tests_failed with empty failing sets', () => {
    const result = validateScenario(merged((s) => {
      s.expected.failing_modules = [];
      s.expected.failed_test_classes = [];
      s.expected.failed_count = 0;
    }));
    expect(fieldsOf(result)).toEqual(['expected.failed_test_classes', 'expected.failing_modules']);
  });

  it('rejects an outcome_kind that is neither tests_failed nor tests_passed', () => {
    for (const bad of ['tests_executed', 'coverage_threshold_exceeded', 'no_applicable_tests', undefined]) {
      const result = validateScenario(merged((s) => { s.expected.outcome_kind = bad; }));
      expect(fieldsOf(result), String(bad)).toEqual(['expected.outcome_kind']);
    }
  });

  it('rejects an expected.module key', () => {
    const result = validateScenario(merged((s) => { s.expected.module = ':core:data'; }));
    expect(fieldsOf(result)).toEqual(['expected.module']);
  });

  it('rejects expected.kmp_test, expected.gradle and expected.changed blocks', () => {
    const result = validateScenario(merged((s) => {
      s.expected.kmp_test = { tests: { total: 1, passed: 0, failed: 1, individual_total: 1, skipped: 0 }, exit_code: 1 };
      s.expected.gradle = { allowed_invocations: [':core:data:test'], evidence_task: ':core:data:test', exit_code: 1 };
      s.expected.changed = { detected_modules: ['core:data'], staged_only: false, base_ref: 'HEAD' };
    }));
    expect(fieldsOf(result)).toEqual(['expected.changed', 'expected.gradle', 'expected.kmp_test']);
  });

  it('still requires first_useful_signal_predicate.description', () => {
    const result = validateScenario(merged((s) => { s.first_useful_signal_predicate = {}; }));
    expect(fieldsOf(result)).toEqual(['first_useful_signal_predicate']);
  });
});

describe('multi-module-tests family -- smoke', () => {
  it('requires a smoke block', () => {
    const result = validateScenario(merged((s) => { delete s.smoke; }));
    expect(fieldsOf(result)).toEqual(['smoke']);
  });

  it('rejects an empty smoke.kmp_test_args array', () => {
    const result = validateScenario(merged((s) => { s.smoke.kmp_test_args = []; }));
    expect(fieldsOf(result)).toEqual(['smoke.kmp_test_args']);
  });

  it('rejects an empty smoke.warm_tasks array', () => {
    const result = validateScenario(merged((s) => { s.smoke.warm_tasks = []; }));
    expect(fieldsOf(result)).toEqual(['smoke.warm_tasks']);
  });

  it('rejects a non-string smoke entry', () => {
    const result = validateScenario(merged((s) => { s.smoke.warm_tasks = [':core:data:test', 7]; }));
    expect(fieldsOf(result)).toEqual(['smoke.warm_tasks']);
  });

  it('rejects an unrecognized smoke key', () => {
    const result = validateScenario(merged((s) => { s.smoke.extra = true; }));
    expect(fieldsOf(result)).toEqual(['smoke.extra']);
  });

  it('rejects a smoke block on a scenario of another family', () => {
    const scenario = JSON.parse(readFileSync(path.join(corpusDir, 'scenarios', 'deterministic-unit-test-failure.json'), 'utf8'));
    const truthFile = JSON.parse(readFileSync(path.join(corpusDir, 'expected', 'deterministic-unit-test-failure.json'), 'utf8'));
    const result = validateScenario({
      ...scenario,
      expected_outcome: truthFile.expected_outcome,
      expected: truthFile.expected,
      first_useful_signal_predicate: truthFile.first_useful_signal_predicate,
      smoke: truth.smoke,
    });
    expect(result.errors.map((e) => e.field)).toEqual(['smoke']);
  });
});

describe('multi-module-tests family -- no change for the existing families', () => {
  it('still rejects tests_passed as the outcome of a test-only scenario', () => {
    const scenario = JSON.parse(readFileSync(path.join(corpusDir, 'scenarios', 'deterministic-unit-test-failure.json'), 'utf8'));
    const truthFile = JSON.parse(readFileSync(path.join(corpusDir, 'expected', 'deterministic-unit-test-failure.json'), 'utf8'));
    const result = validateScenario({
      ...scenario,
      expected_outcome: truthFile.expected_outcome,
      expected: { ...truthFile.expected, outcome_kind: 'tests_passed' },
      first_useful_signal_predicate: truthFile.first_useful_signal_predicate,
    });
    expect(result.errors.map((e) => e.field)).toContain('expected.outcome_kind');
    expect(result.errors.find((e) => e.field === 'expected.outcome_kind').message).not.toMatch(/tests_passed/);
  });

  it('validates every committed scenario with no error and no warning', () => {
    const scenariosDir = path.join(corpusDir, 'scenarios');
    const files = readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const file of files) {
      const taskFile = JSON.parse(readFileSync(path.join(scenariosDir, file), 'utf8'));
      const truthPath = path.join(corpusDir, 'expected', file);
      expect(existsSync(truthPath), file).toBe(true);
      const t = JSON.parse(readFileSync(truthPath, 'utf8'));
      const result = validateScenario({
        ...taskFile,
        expected_outcome: t.expected_outcome,
        expected: t.expected,
        first_useful_signal_predicate: t.first_useful_signal_predicate,
      });
      expect(result, file).toEqual({ errors: [], warnings: [] });
    }
  });
});

describe('multi-module-tests family -- the loaders carry smoke through the merge', () => {
  const cleanup = [];
  afterEach(() => {
    delete process.env.KMP_EVAL_SCENARIOS_DIR;
    delete process.env.KMP_EVAL_EXPECTED_DIR;
    vi.resetModules();
    while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
  });

  function injectDrafts() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'aemm-corpus-'));
    cleanup.push(root);
    mkdirSync(path.join(root, 'scenarios'), { recursive: true });
    mkdirSync(path.join(root, 'expected'), { recursive: true });
    writeFileSync(path.join(root, 'scenarios', `${task.id}.json`), JSON.stringify(task));
    writeFileSync(path.join(root, 'expected', `${task.id}.json`), JSON.stringify(truth));
    process.env.KMP_EVAL_SCENARIOS_DIR = path.join(root, 'scenarios');
    process.env.KMP_EVAL_EXPECTED_DIR = path.join(root, 'expected');
  }

  it('loadScenarioById returns the smoke block of a multi-module scenario and validates it', async () => {
    injectDrafts();
    vi.resetModules();
    const { loadScenarioById } = await import('../../tools/agentic-eval/cli.mjs');
    const loaded = loadScenarioById(task.id);
    expect(loaded.reason).toBeUndefined();
    expect(loaded.ok).toBe(true);
    expect(loaded.scenario.smoke).toEqual(truth.smoke);
    expect(loaded.scenario.expected).toEqual(truth.expected);
  });

  it('loadScenarioById adds no smoke key to a scenario of an existing family', async () => {
    const { loadScenarioById } = await import('../../tools/agentic-eval/cli.mjs');
    const loaded = loadScenarioById('deterministic-unit-test-failure');
    expect(loaded.ok).toBe(true);
    expect('smoke' in loaded.scenario).toBe(false);
  });
});

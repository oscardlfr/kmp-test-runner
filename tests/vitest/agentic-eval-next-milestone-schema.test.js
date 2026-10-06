import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateScenario, FAMILY_VALUES } from '../../tools/agentic-eval/schemas.mjs';

const task = JSON.parse(readFileSync(new URL('../fixtures/agentic-eval-multi-module/scenario-draft.json', import.meta.url)));
const truth = JSON.parse(readFileSync(new URL('../fixtures/agentic-eval-multi-module/expected-draft.json', import.meta.url)));
function scenario(family, expected) {
  const value = structuredClone({ ...task, expected_outcome: truth.expected_outcome,
    expected, smoke: truth.smoke, first_useful_signal_predicate: truth.first_useful_signal_predicate });
  value.family = family;
  if (family === 'multi-module-coverage') delete value.fixture_setup;
  if (family === 'changed-dependents') value.fixture_setup = {
    operation: 'commit_patch', patch_file: 'planned-edit.patch', expected_paths: ['core/data/src/main/kotlin/Foo.kt'],
    expected_parent: value.project_commit,
  };
  return value;
}
const coverage = { outcome_kind: 'coverage_threshold_exceeded', threshold_percent: 80,
  below_threshold_modules: [':core:data'], no_data_modules: [':feature:search:impl'],
  module_line_coverage: { ':core:data': 75, ':core:domain': 90 } };
const changed = { outcome_kind: 'tests_failed', direct_modules: [':core:data'],
  dependent_modules: [':feature:bookmarks:impl'], selected_modules: [':core:data', ':feature:bookmarks:impl'],
  failing_modules: [':feature:bookmarks:impl'], failed_test_classes: ['BookmarksViewModelTest'], failed_count: 1 };
const compile = { outcome_kind: 'compilation_failed', compile_module: ':core:data',
  compile_task: ':core:data:compileKotlin', diagnostic_file: 'core/data/src/main/kotlin/Foo.kt',
  diagnostic_line: 12, diagnostic_message: 'Unresolved reference: broken',
  unrun_dependents: [':feature:bookmarks:impl'] };

describe('next milestone scenario contracts', () => {
  it('registers and accepts all three closed families', () => {
    for (const [family, expected] of [['multi-module-coverage', coverage],
      ['changed-dependents', changed], ['compile-failure', compile]]) {
      expect(FAMILY_VALUES).toContain(family);
      expect(validateScenario(scenario(family, expected)).errors, family).toEqual([]);
    }
  });
  it('rejects coverage disagreement and no-data values masquerading as numbers', () => {
    const bad = scenario('multi-module-coverage', { ...coverage,
      module_line_coverage: { ...coverage.module_line_coverage, ':feature:search:impl': 0 } });
    expect(validateScenario(bad).errors.some((error) => error.field === 'expected.module_line_coverage')).toBe(true);
  });
  it('rejects direct-module failure in a changed-dependent scenario', () => {
    const bad = scenario('changed-dependents', { ...changed, failing_modules: [':core:data'] });
    expect(validateScenario(bad).errors.some((error) => error.field === 'expected.selected_modules')).toBe(true);
  });
  it('requires a committed patch pinned to the project base', () => {
    const bad = scenario('changed-dependents', changed);
    bad.fixture_setup.expected_parent = '0'.repeat(40);
    expect(validateScenario(bad).errors.some((error) => error.field === 'fixture_setup.expected_parent')).toBe(true);
  });
  it('requires a compile task owned by the failed module', () => {
    const bad = scenario('compile-failure', { ...compile, compile_task: ':other:compileKotlin' });
    expect(validateScenario(bad).errors.some((error) => error.field === 'expected.compile_task')).toBe(true);
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadScenarioById } from '../../tools/agentic-eval/cli.mjs';
import { validateScenario } from '../../tools/agentic-eval/schemas.mjs';

const PIN = '7d45eae4f8720a0c77f507712ba2437ff974b6ed';
const FIXTURES = new URL('../../tools/agentic-eval/corpus/fixtures/', import.meta.url);

function scenario(id) {
  const loaded = loadScenarioById(id);
  expect(loaded.ok, loaded.reason).toBe(true);
  expect(validateScenario(loaded.scenario)).toEqual({ errors: [], warnings: [] });
  return loaded.scenario;
}

function patchSha(file) {
  return createHash('sha256').update(readFileSync(new URL(file, FIXTURES))).digest('hex');
}

describe('next-milestone NiA corpus pins', () => {
  it('uses an untouched pinned checkout and fresh per-module LINE coverage for the 26% gate', () => {
    const s = scenario('multi-module-line-coverage');
    expect(s.project_commit).toBe(PIN);
    expect(s).not.toHaveProperty('fixture_setup');
    expect(s.expected).toEqual({
      outcome_kind: 'coverage_threshold_exceeded',
      threshold_percent: 26,
      below_threshold_modules: [':feature:search:impl', ':feature:settings:impl', ':feature:topic:impl'],
      no_data_modules: [':core:common', ':core:navigation', ':feature:bookmarks:impl', ':lint'],
      module_line_coverage: {
        ':core:data': 63.7,
        ':core:datastore': 46.5,
        ':core:domain': 47.7,
        ':core:network': 33.3,
        ':feature:search:impl': 12.3,
        ':feature:settings:impl': 9.7,
        ':feature:topic:impl': 19.1,
      },
    });
    expect(s.smoke.kmp_test_args.slice(0, 3)).toEqual(['parallel', '--min-line-coverage', '26']);
    expect(s.smoke.kmp_test_args.some((arg) => arg.includes('--rerun-tasks'))).toBe(true);
    expect(s.smoke.warm_tasks.filter((task) => task.endsWith('UnitTestCoverageReport'))).toHaveLength(7);
    expect(s.smoke.warm_tasks.filter((task) => /:(?:test|testDemoDebugUnitTest)$/.test(task))).toHaveLength(11);
  });

  it('commits the observed one-line network edit on the exact base before changed detection', () => {
    const s = scenario('changed-dependents-network-topic');
    expect(s.project_commit).toBe(PIN);
    expect(s.fixture_setup).toEqual({
      operation: 'commit_patch',
      patch_file: 'changed-dependents-network-topic.patch',
      expected_paths: ['core/network/src/main/kotlin/com/google/samples/apps/nowinandroid/core/network/model/NetworkTopic.kt'],
      expected_parent: PIN,
    });
    expect(patchSha(s.fixture_setup.patch_file)).toBe('212666dd335738c444a73f730bd31e32711ef59ec14dcd0301da7afc9e097897');
    expect(s.expected.direct_modules).toEqual([':core:network']);
    expect(s.expected.dependent_modules).toHaveLength(18);
    expect(s.expected.selected_modules).toHaveLength(19);
    expect(new Set(s.expected.selected_modules)).toEqual(new Set([...s.expected.direct_modules, ...s.expected.dependent_modules]));
    expect(s.expected.failing_modules).toEqual([':core:data']);
    expect(s.expected.failed_test_classes).toEqual(['NetworkEntityTest']);
    expect(s.expected.failed_count).toBe(1);
    expect(s.smoke.kmp_test_args).toContain('--include-dependents');
    expect(s.smoke.kmp_test_args.slice(0, 3)).toEqual(['changed', '--base', PIN]);
  });

  it('keeps the observed Kotlin compiler root separate from unrun test dependents', () => {
    const s = scenario('compile-failure-data-repository');
    expect(s.project_commit).toBe(PIN);
    expect(s.fixture_setup).toEqual({
      operation: 'apply_patch',
      patch_file: 'compile-failure-data-repository.patch',
      expected_paths: ['core/data/src/main/kotlin/com/google/samples/apps/nowinandroid/core/data/repository/OfflineFirstTopicsRepository.kt'],
    });
    expect(patchSha(s.fixture_setup.patch_file)).toBe('cc1b753c343f68743a083086013a324dc3f6a6a4dea37e22e9cb949076b6fab4');
    expect(s.expected).toMatchObject({
      outcome_kind: 'compilation_failed',
      compile_module: ':core:data',
      compile_task: ':core:data:compileDemoDebugKotlin',
      diagnostic_file: s.fixture_setup.expected_paths[0],
      diagnostic_line: 47,
      diagnostic_message: "Unresolved reference 'asExternalModels'.",
    });
    expect(s.expected.unrun_dependents).toHaveLength(5);
    expect(s.expected.unrun_dependents).not.toContain(s.expected.compile_module);
    expect(s.smoke.kmp_test_args).toContain('parallel');
  });
});

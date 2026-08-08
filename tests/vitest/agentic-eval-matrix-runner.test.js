// tests/vitest/agentic-eval-matrix-runner.test.js
// Direct unit tests for tools/agentic-eval/matrix-runner.mjs's small, pure, exported helpers --
// deliberately separate from the heavier runScenarioMatrix/runSingleCondition integration paths
// (which spawn real processes and are covered by cli.mjs's own end-to-end fake-claude tests).
//
// isJunitEvidenceOutcome is the genuine regression guard CodeRabbit's review of PR #411 found
// missing: agentic-eval-graders.test.js's own tests inject `perAttemptJunit` evidence directly via
// buildConditionResult, which stays green regardless of what this function returns -- only a test
// that calls THIS function directly can catch a future regression that re-narrows it back to
// 'tests_executed' only.
import { describe, it, expect } from 'vitest';
import { isJunitEvidenceOutcome } from '../../tools/agentic-eval/matrix-runner.mjs';

describe('isJunitEvidenceOutcome', () => {
  it('returns true for tests_executed -- a genuine clean-pass execution has real JUnit XML to attribute', () => {
    expect(isJunitEvidenceOutcome('tests_executed')).toBe(true);
  });

  it('returns true for tests_failed -- a genuine failure also has real JUnit XML to attribute', () => {
    expect(isJunitEvidenceOutcome('tests_failed')).toBe(true);
  });

  it('returns false for no_applicable_tests -- no test task ever ran, so there is no real JUnit XML at all', () => {
    expect(isJunitEvidenceOutcome('no_applicable_tests')).toBe(false);
  });

  it('returns false for an unrecognized/future outcome_kind -- fails closed, never opts a new outcome in by default', () => {
    expect(isJunitEvidenceOutcome('some-future-outcome-kind')).toBe(false);
  });

  it('returns false for null/undefined (a scenario with no expected.outcome_kind at all)', () => {
    expect(isJunitEvidenceOutcome(null)).toBe(false);
    expect(isJunitEvidenceOutcome(undefined)).toBe(false);
  });
});

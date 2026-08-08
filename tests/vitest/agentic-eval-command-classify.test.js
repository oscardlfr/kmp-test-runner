// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-command-classify.test.js -- direct unit coverage for
// tools/agentic-eval/command-classify.mjs: classifyBashCommand/normalizeModuleName (relocated
// verbatim from graders.mjs, no prior dedicated unit test existed for them directly -- they were
// only ever exercised indirectly through gradeScenarioCondition's own suite) plus the two new
// relevance predicates junit-evidence.mjs's attributeCondition depends on.
import { describe, it, expect } from 'vitest';
import {
  classifyBashCommand, normalizeModuleName, isRelevantGradleInvocation, isRelevantKmpTestParallel,
} from '../../tools/agentic-eval/command-classify.mjs';

describe('classifyBashCommand', () => {
  it('a non-string command returns {kind:"other"}, never throws', () => {
    expect(classifyBashCommand(null)).toEqual({ kind: 'other' });
    expect(classifyBashCommand(undefined)).toEqual({ kind: 'other' });
    expect(classifyBashCommand(42)).toEqual({ kind: 'other' });
  });

  it('an empty/whitespace-only command returns {kind:"other"}', () => {
    expect(classifyBashCommand('')).toEqual({ kind: 'other' });
    expect(classifyBashCommand('   ')).toEqual({ kind: 'other' });
  });

  it('an unrelated command (ls, cat, etc.) returns {kind:"other"}', () => {
    expect(classifyBashCommand('ls -la')).toEqual({ kind: 'other' });
    expect(classifyBashCommand('cat package.json')).toEqual({ kind: 'other' });
  });

  it('kmp-test parallel with --module-filter (space form) extracts the module and subcommand', () => {
    const c = classifyBashCommand('kmp-test parallel --module-filter shared --json');
    expect(c).toEqual({ kind: 'kmp-test', subcommand: 'parallel', moduleFilter: 'shared', testType: null, minMissedLines: null, isPlanOnly: false });
  });

  it('kmp-test parallel with --module-filter=shared (equals form) extracts the module identically', () => {
    const c = classifyBashCommand('kmp-test parallel --module-filter=shared --json');
    expect(c.moduleFilter).toBe('shared');
  });

  it('kmp-test parallel with --test-type (space form) and --test-type=androidUnit (equals form) both extract testType', () => {
    expect(classifyBashCommand('kmp-test parallel --test-type androidUnit --json').testType).toBe('androidUnit');
    expect(classifyBashCommand('kmp-test parallel --test-type=androidUnit --json').testType).toBe('androidUnit');
  });

  it('--dry-run, --list, and --list-only all set isPlanOnly:true', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --dry-run --json').isPlanOnly).toBe(true);
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --list --json').isPlanOnly).toBe(true);
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --list-only --json').isPlanOnly).toBe(true);
  });

  it('an ordinary kmp-test parallel call (no plan-only flag) has isPlanOnly:false', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --json').isPlanOnly).toBe(false);
  });

  it('a non-parallel kmp-test subcommand (doctor) is classified with subcommand:"doctor", moduleFilter:null', () => {
    expect(classifyBashCommand('kmp-test doctor --json')).toEqual({ kind: 'kmp-test', subcommand: 'doctor', moduleFilter: null, testType: null, minMissedLines: null, isPlanOnly: false });
  });

  it('a kmp-test command with a terminal stderr merge retains its operation classification', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter :shared --json 2>&1')).toEqual({
      kind: 'kmp-test', subcommand: 'parallel', moduleFilter: ':shared', testType: null, minMissedLines: null, isPlanOnly: false,
    });
  });

  it('a Gradle command via ./gradlew.bat extracts task tokens and strips flag-shaped tokens', () => {
    const c = classifyBashCommand('./gradlew.bat :shared:testAndroidHostTest --console=plain');
    expect(c).toEqual({ kind: 'gradle', taskTokens: [':shared:testAndroidHostTest'], isPlanOnly: false });
  });

  it('a Gradle command via the bare ./gradlew wrapper (no .bat) is classified identically', () => {
    const c = classifyBashCommand('./gradlew :app:testDebugUnitTest --console=plain');
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  it('a Gradle command with multiple task tokens (e.g. a lifecycle alias plus another task) keeps all of them', () => {
    const c = classifyBashCommand('./gradlew.bat :app:test :app:tasks --console=plain');
    expect(c.taskTokens).toEqual([':app:test', ':app:tasks']);
  });

  it('a Gradle --dry-run invocation sets isPlanOnly:true', () => {
    expect(classifyBashCommand('./gradlew.bat :shared:testAndroidHostTest --dry-run --console=plain').isPlanOnly).toBe(true);
  });

  // --min-missed-lines -- extracted the same way moduleFilter/testType are: a raw string token,
  // never parsed to a number here (interpretation/validation is the caller's job -- graders.mjs's
  // exact-string comparison against the scenario's own String(min_missed_lines) implicitly
  // rejects non-canonical forms like "050"/"5e1" without a second regex).
  it('kmp-test parallel with --min-missed-lines (space form) extracts the raw string token', () => {
    expect(classifyBashCommand('kmp-test parallel --min-missed-lines 50 --json').minMissedLines).toBe('50');
  });

  it('kmp-test parallel with --min-missed-lines=50 (equals form) extracts identically', () => {
    expect(classifyBashCommand('kmp-test parallel --min-missed-lines=50 --json').minMissedLines).toBe('50');
  });

  it('absent --min-missed-lines yields minMissedLines:null', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --json').minMissedLines).toBeNull();
  });

  it('a dangling --min-missed-lines (last token, no value) yields minMissedLines:null, mirroring moduleFilter\'s own ?? null pattern', () => {
    expect(classifyBashCommand('kmp-test parallel --min-missed-lines').minMissedLines).toBeNull();
  });

  it('--min-missed-lines combined with --module-filter and --test-type on the same command line extracts all three independently', () => {
    const c = classifyBashCommand('kmp-test parallel --module-filter :core:datastore --test-type androidUnit --min-missed-lines 50 --json');
    expect(c.moduleFilter).toBe(':core:datastore');
    expect(c.testType).toBe('androidUnit');
    expect(c.minMissedLines).toBe('50');
  });
});

describe('normalizeModuleName', () => {
  it('strips exactly one leading colon', () => {
    expect(normalizeModuleName(':shared')).toBe('shared');
  });

  it('leaves a name with no leading colon unchanged', () => {
    expect(normalizeModuleName('shared')).toBe('shared');
  });

  it('passes non-string values through unchanged (never throws)', () => {
    expect(normalizeModuleName(null)).toBeNull();
    expect(normalizeModuleName(undefined)).toBeUndefined();
  });
});

describe('isRelevantGradleInvocation', () => {
  const ALLOWED = [':app:testDebugUnitTest', ':app:test'];

  it('a direct match on the evidence task itself is relevant', () => {
    const c = classifyBashCommand('./gradlew.bat :app:testDebugUnitTest --console=plain');
    expect(isRelevantGradleInvocation(c, ALLOWED)).toBe(true);
  });

  it('a policy-permitted LIFECYCLE ALIAS (present in allowed_invocations but not equal to the literal evidence_task) is ALSO relevant -- decision 3\'s contract', () => {
    const c = classifyBashCommand('./gradlew.bat :app:test --console=plain');
    expect(isRelevantGradleInvocation(c, ALLOWED)).toBe(true);
  });

  it('a task token outside allowed_invocations entirely is NOT relevant', () => {
    const c = classifyBashCommand('./gradlew.bat :app:build --console=plain');
    expect(isRelevantGradleInvocation(c, ALLOWED)).toBe(false);
  });

  it('a plan-only (--dry-run) Gradle call is never relevant, even when its task matches', () => {
    const c = classifyBashCommand('./gradlew.bat :app:testDebugUnitTest --dry-run --console=plain');
    expect(isRelevantGradleInvocation(c, ALLOWED)).toBe(false);
  });

  it('a non-Gradle classification (kmp-test or other) is never relevant here', () => {
    expect(isRelevantGradleInvocation(classifyBashCommand('kmp-test parallel --module-filter app --json'), ALLOWED)).toBe(false);
    expect(isRelevantGradleInvocation(classifyBashCommand('ls -la'), ALLOWED)).toBe(false);
  });

  it('an absent/undefined allowedInvocations list is tolerated as "nothing matches", never throws', () => {
    const c = classifyBashCommand('./gradlew.bat :app:testDebugUnitTest --console=plain');
    expect(isRelevantGradleInvocation(c, undefined)).toBe(false);
  });
});

describe('isRelevantKmpTestParallel', () => {
  it('an absent --module-filter is relevant regardless of the target module (a whole-project run touches every module, including the target)', () => {
    const c = classifyBashCommand('kmp-test parallel --json');
    expect(isRelevantKmpTestParallel(c, ':shared')).toBe(true);
  });

  it('a --module-filter matching the target module is relevant (colon-boundary tolerant on both sides)', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter shared --json'), ':shared')).toBe(true);
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter :shared --json'), 'shared')).toBe(true);
  });

  it('a --module-filter naming a DIFFERENT module is not relevant', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter app --json'), ':shared')).toBe(false);
  });

  it('a non-"parallel" kmp-test subcommand (doctor, describe) is never relevant here, even with a matching module filter', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test doctor --module-filter shared --json'), ':shared')).toBe(false);
  });

  it('a plan-only (--dry-run/--list/--list-only) kmp-test parallel call is never relevant, even with a matching module filter', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter shared --dry-run --json'), ':shared')).toBe(false);
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter shared --list-only --json'), ':shared')).toBe(false);
  });

  it('a non-kmp-test classification (Gradle or other) is never relevant here', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('./gradlew.bat :shared:testAndroidHostTest --console=plain'), ':shared')).toBe(false);
    expect(isRelevantKmpTestParallel(classifyBashCommand('ls -la'), ':shared')).toBe(false);
  });

  // Module-filter target-attribution parity: isRelevantKmpTestParallel's own moduleFilter/target
  // comparison now delegates to the real production matcher (lib/orchestrators/module-filter.js's
  // matchModuleFilter, imported directly -- not orchestrator-utils.js's fs/child_process-carrying
  // surface), not an exact-string equality check. Pre-fix, `normalizeModuleName(moduleFilter) ===
  // normalizeModuleName(targetModule)` rejected every one of these -- a short substring filter, an
  // anchored glob, or a CSV list containing the target -- even though the real CLI's own
  // `--module-filter` dispatch would have matched the nested `:core:common` module correctly.
  it('a --module-filter that is a SUBSTRING of a nested target module\'s leaf name is relevant (matchModuleFilter semantics, not exact-string equality)', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter common --json'), ':core:common')).toBe(true);
  });

  it('a --module-filter that is an anchored GLOB matching the target module is relevant', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter core:* --json'), ':core:common')).toBe(true);
  });

  it('a --module-filter CSV list that CONTAINS the target module is relevant', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter other,common --json'), ':core:common')).toBe(true);
  });

  it('a --module-filter that does not match the target module under real matchModuleFilter semantics is NOT relevant, even for a nested module path', () => {
    expect(isRelevantKmpTestParallel(classifyBashCommand('kmp-test parallel --module-filter other --json'), ':core:common')).toBe(false);
  });

  // Adversarial-review finding: matchModuleFilter (unlike normalizeModuleName) calls `.replace`
  // on its `name` argument unconditionally, so a missing/non-string targetModule would throw here
  // instead of safely returning false as the old exact-match comparison did. junit-evidence.mjs's
  // own `scenario.expected?.module` (optional chaining) shows this is a genuinely anticipated shape
  // in this codebase, not a purely hypothetical one.
  it('a missing (undefined) targetModule does not crash -- returns false, matching the old comparison\'s safe behavior', () => {
    const c = classifyBashCommand('kmp-test parallel --module-filter common --json');
    expect(() => isRelevantKmpTestParallel(c, undefined)).not.toThrow();
    expect(isRelevantKmpTestParallel(c, undefined)).toBe(false);
  });
});

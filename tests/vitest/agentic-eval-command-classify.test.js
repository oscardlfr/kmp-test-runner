// SPDX-License-Identifier: MIT
// tests/vitest/agentic-eval-command-classify.test.js -- direct unit coverage for
// tools/agentic-eval/command-classify.mjs: classifyBashCommand/normalizeModuleName (relocated
// verbatim from graders.mjs, no prior dedicated unit test existed for them directly -- they were
// only ever exercised indirectly through gradeScenarioCondition's own suite) plus the two new
// relevance predicates junit-evidence.mjs's attributeCondition depends on.
import { describe, it, expect } from 'vitest';
import {
  classifyBashCommand, normalizeModuleName, isRelevantGradleInvocation, isRelevantKmpTestParallel,
  isRelevantKmpTestChanged,
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
    expect(c).toEqual({ kind: 'kmp-test', subcommand: 'parallel', moduleFilter: 'shared', testType: null, minMissedLines: null, coverageDisabled: false, isPlanOnly: false });
  });

  it('recognizes the PowerShell command wrapper emitted by Codex CLI on Windows', () => {
    const command = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --json --project-root .'`;
    expect(classifyBashCommand(command)).toEqual({
      kind: 'kmp-test', subcommand: 'parallel', moduleFilter: ':core:domain', testType: null,
      minMissedLines: '15', coverageDisabled: false, isPlanOnly: false,
    });
  });

  // A PowerShell -Command program that holds `;`, `|`, `&`, `$`, `(`, `)`, `<` or `>` used to be left
  // unclassified (other). The segment pre-pass now classifies it by the kmp-test or Gradle segment it
  // contains: what follows that segment does not change the result, and a `$(...)` in an argument is
  // never evaluated -- it stays the literal text the classifier reads, so it is never taken for the module
  // it would print.
  it('classifies a compound PowerShell program by the kmp-test segment it contains, whatever follows it', () => {
    const command = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command 'kmp-test parallel --module-filter :core:domain --json; Write-Output forged'`;
    expect(classifyBashCommand(command)).toEqual({
      kind: 'kmp-test', subcommand: 'parallel', moduleFilter: ':core:domain', testType: null,
      minMissedLines: null, coverageDisabled: false, isPlanOnly: false,
    });
  });

  it('reads a $(...) substitution in a PowerShell program as literal text, never as the module it would print', () => {
    const c = classifyBashCommand(String.raw`powershell.exe -Command 'kmp-test parallel --module-filter $(Write-Output :core:domain) --json'`);
    expect(c.kind).toBe('kmp-test');
    expect(c.moduleFilter).toBe('$(Write-Output');
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

  // --show-modules-only -- changed's own dry-run-shaped inspection flag ("List detected modules
  // without running tests"). Must be recognized here too, exactly like --dry-run/--list/--list-only,
  // so it's excluded from terminal contention/retries/JUnit relevance downstream -- never a real
  // execution, only a preview.
  it('--show-modules-only on a changed command sets isPlanOnly:true', () => {
    expect(classifyBashCommand('kmp-test changed --show-modules-only --json').isPlanOnly).toBe(true);
  });

  it('--show-modules-only combined with other flags still sets isPlanOnly:true', () => {
    expect(classifyBashCommand('kmp-test changed --json --project-root . --show-modules-only').isPlanOnly).toBe(true);
  });

  it('an ordinary kmp-test changed call (no --show-modules-only) has isPlanOnly:false', () => {
    expect(classifyBashCommand('kmp-test changed --json --project-root .').isPlanOnly).toBe(false);
  });

  it('a non-parallel kmp-test subcommand (doctor) is classified with subcommand:"doctor", moduleFilter:null', () => {
    expect(classifyBashCommand('kmp-test doctor --json')).toEqual({ kind: 'kmp-test', subcommand: 'doctor', moduleFilter: null, testType: null, minMissedLines: null, coverageDisabled: false, isPlanOnly: false });
  });

  it('a kmp-test command with a terminal stderr merge retains its operation classification', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter :shared --json 2>&1')).toEqual({
      kind: 'kmp-test', subcommand: 'parallel', moduleFilter: ':shared', testType: null, minMissedLines: null, coverageDisabled: false, isPlanOnly: false,
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

  // H16 (AUDITORIA-EVIDENCE1-2026-09-27.md): real 011c89b6 transcripts used common Gradle
  // invocation forms this classifier didn't recognize at all -- it fell through to {kind:'other'},
  // silently hiding the command from the grader's policy-allowed / relevant-invocation checks.
  it.each([
    ['bare gradlew (no leading ./)', 'gradlew :app:testDebugUnitTest --console=plain'],
    ['bare gradlew.bat (no leading ./)', 'gradlew.bat :app:testDebugUnitTest --console=plain'],
    ['Windows-style .\\gradlew.bat', String.raw`.\gradlew.bat :app:testDebugUnitTest --console=plain`],
    ['Windows-style .\\gradlew (no .bat)', String.raw`.\gradlew :app:testDebugUnitTest --console=plain`],
    ['uppercase GRADLEW.BAT', 'GRADLEW.BAT :app:testDebugUnitTest --console=plain'],
  ])('recognizes the %s form identically to ./gradlew.bat', (_label, command) => {
    const c = classifyBashCommand(command);
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  // Codex CLI on Windows reports the shell launcher as the command_execution.command (see
  // commandTokens's own header comment) -- a bare-.\gradlew invocation must be recognized both
  // directly and through that PowerShell -Command unwrap, not just the ./gradlew.bat form already
  // covered above (recognizes the PowerShell command wrapper... kmp-test test, line 35).
  it('recognizes a bare .\\gradlew invocation wrapped in the PowerShell command launcher', () => {
    const command = String.raw`powershell.exe -Command '.\gradlew :app:testDebugUnitTest --console=plain'`;
    const c = classifyBashCommand(command);
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  // No literal Set entry can enumerate every checkout's own absolute repo path -- the basename
  // rule (GRADLEW_TOKEN_RE) must match on the trailing path segment regardless of what precedes it.
  it.each([
    ['bare', String.raw`C:\kmp-eval\agentic-eval-codex-runtime\gradlew.bat :app:testDebugUnitTest --console=plain`],
    ['PowerShell-wrapped', String.raw`powershell.exe -Command 'C:\kmp-eval\agentic-eval-codex-runtime\gradlew.bat :app:testDebugUnitTest --console=plain'`],
  ])('recognizes an absolute-path gradlew.bat invocation (%s)', (_label, command) => {
    const c = classifyBashCommand(command);
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  // Guards the basename rule against over-matching: none of these end in a real gradlew/gradlew.bat
  // path segment and must keep classifying as {kind:'other'} exactly like before this fix.
  it.each([
    ['a same-directory wrapper script, not the real gradlew', 'gradlew-wrapper.sh :app:testDebugUnitTest'],
    ['a run-together non-extension suffix', './gradlewbat :app:testDebugUnitTest --console=plain'],
    ['an unrelated recognized command (kmp-test)', 'kmp-test parallel --module-filter shared --json'],
  ])('does not misclassify %s as gradle', (_label, command) => {
    expect(classifyBashCommand(command).kind).not.toBe('gradle');
  });

  it('strips exactly one leading `cd <dir> &&` before classifying', () => {
    const c = classifyBashCommand('cd "$(pwd)" && ./gradlew :app:testDebugUnitTest --console=plain');
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  it('strips exactly one leading `timeout N` before classifying', () => {
    const c = classifyBashCommand('timeout 300 ./gradlew :app:testDebugUnitTest --console=plain');
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  it.each([
    ['trailing 2>&1', './gradlew :app:testDebugUnitTest --console=plain 2>&1'],
    ['trailing | tail -N', './gradlew :app:testDebugUnitTest --console=plain | tail -150'],
    ['trailing | head -N', './gradlew :app:testDebugUnitTest --console=plain | head -150'],
    ['trailing | Select-Object -Last N', './gradlew :app:testDebugUnitTest --console=plain | Select-Object -Last 150'],
  ])('strips a %s suffix before classifying, without touching the real task tokens', (_label, command) => {
    const c = classifyBashCommand(command);
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest']);
  });

  it('the literal 011c89b6 claude-code-1 transcript command: cd prefix + ./gradlew + 2>&1 | tail -150 suffix, all stripped together', () => {
    const command = 'cd "$(pwd)" && ./gradlew :core:domain:createDemoDebugUnitTestCoverageReport --console=plain --offline --no-configuration-cache 2>&1 | tail -150';
    const c = classifyBashCommand(command);
    expect(c.kind).toBe('gradle');
    expect(c.taskTokens).toEqual([':core:domain:createDemoDebugUnitTestCoverageReport']);
    expect(c.isPlanOnly).toBe(false);
  });

  it('does not strip a suffix that only partially matches a known pattern (e.g. | tail with a non-numeric arg)', () => {
    // Guards against over-eager stripping: `| tail -f` is a real, different Gradle invocation
    // shape (follow mode) that must stay {kind:'other'} rather than being silently misread as
    // Gradle with a spurious trailing "-f" swallowed.
    const c = classifyBashCommand('./gradlew :app:testDebugUnitTest --console=plain | tail -f');
    expect(c.kind).toBe('gradle');
    // Pre-existing, unrelated taskTokens quirk (not something H16 touches): the filter only drops
    // flag-shaped (`-*`) tokens, so the un-stripped `| tail` leaks through as if they were task
    // names. What this test actually guards is the suffix-stripper NOT matching `-f` as a numeric
    // tail/head argument -- kind stays 'gradle' via the leading ./gradlew token either way.
    expect(c.taskTokens).toEqual([':app:testDebugUnitTest', '|', 'tail']);
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
    const c = classifyBashCommand('kmp-test parallel --module-filter :core:domain --test-type androidUnit --min-missed-lines 15 --json');
    expect(c.moduleFilter).toBe(':core:domain');
    expect(c.testType).toBe('androidUnit');
    expect(c.minMissedLines).toBe('15');
  });

  // --no-coverage -- policy-hook.mjs authorizes this flag (KMP_TEST_BOOLEAN_FLAGS), but
  // expandNoCoverageAlias (lib/orchestrators/orchestrator-utils.js) rewrites it to
  // `--coverage-tool none`, and runParallel's own coverage hand-off never calls coverage
  // aggregation at all when that's set (parallel-orchestrator.js:816) -- captured here so
  // graders.mjs can reject a self-reported coverage_threshold_exceeded claim a real --no-coverage
  // invocation could never have produced.
  it('--no-coverage sets coverageDisabled:true', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --no-coverage --json').coverageDisabled).toBe(true);
  });

  it('an ordinary command (no --no-coverage) has coverageDisabled:false', () => {
    expect(classifyBashCommand('kmp-test parallel --module-filter shared --json').coverageDisabled).toBe(false);
  });

  it('--no-coverage combined with --module-filter/--min-missed-lines on the same command line still extracts everything independently', () => {
    const c = classifyBashCommand('kmp-test parallel --module-filter :core:domain --min-missed-lines 15 --no-coverage --json');
    expect(c.moduleFilter).toBe(':core:domain');
    expect(c.minMissedLines).toBe('15');
    expect(c.coverageDisabled).toBe(true);
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

// isRelevantKmpTestChanged -- deliberately NO module-filter parameter/logic (unlike
// isRelevantKmpTestParallel above): `changed` has no `--module-filter` flag at all (the real CLI
// rejects it as unknown_flag), so every non-plan-only `changed` invocation is unconditionally
// relevant. Callers (junit-evidence.mjs) are responsible for only folding this predicate in when
// the scenario itself expects a changed subcommand (scenario.expected.changed != null) -- this
// predicate itself has no scenario awareness, by design, so it stays a pure, reusable classifier.
describe('isRelevantKmpTestChanged', () => {
  it('a bare, non-plan-only kmp-test changed call is relevant', () => {
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test changed --json --project-root .'))).toBe(true);
  });

  it('a changed call with --no-coverage is still relevant (no flag disqualifies a real execution)', () => {
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test changed --json --project-root . --no-coverage'))).toBe(true);
  });

  it('a --show-modules-only changed call is NOT relevant -- plan-only, never a real execution', () => {
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test changed --show-modules-only --json'))).toBe(false);
  });

  it('a --dry-run changed call is NOT relevant', () => {
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test changed --dry-run --json'))).toBe(false);
  });

  it('a non-"changed" kmp-test subcommand (parallel, doctor, describe) is never relevant here', () => {
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test parallel --json'))).toBe(false);
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test doctor --json'))).toBe(false);
    expect(isRelevantKmpTestChanged(classifyBashCommand('kmp-test describe --json'))).toBe(false);
  });

  it('a non-kmp-test classification (Gradle or other) is never relevant here', () => {
    expect(isRelevantKmpTestChanged(classifyBashCommand('./gradlew.bat :core:common:test --console=plain'))).toBe(false);
    expect(isRelevantKmpTestChanged(classifyBashCommand('ls -la'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commands that chain, redirect, pipe into a filter, or are wrapped in a PowerShell launcher are
// classified by the kmp-test or Gradle command they contain. Before this, three real shapes fell
// through to {kind:'other'}: a quoted word directly followed by `;` (Evidence2 claude-code-6), a
// PowerShell -Command program that contains any of `; | & $ ( ) < >`, and output piped through a
// filter such as `| grep`.

describe('classifyBashCommand: commands that chain, redirect, pipe or are wrapped in PowerShell', () => {
  const kmpTest = (overrides = {}) => ({
    kind: 'kmp-test', subcommand: 'parallel', moduleFilter: null, testType: null, minMissedLines: null,
    coverageDisabled: false, isPlanOnly: false, ...overrides,
  });
  const gradle = (taskTokens, isPlanOnly = false) => ({ kind: 'gradle', taskTokens, isPlanOnly });
  const POWERSHELL = String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"`;

  describe('the rows of the work order', () => {
    it('the Evidence2 claude-code-6 command (envelope to a file, then echo and wc) is the kmp-test parallel call it contains', () => {
      const command = 'kmp-test parallel --min-missed-lines 15 --module-filter core:domain --json --project-root . > parallel_result.json 2>&1; echo "EXIT:$?"; wc -c parallel_result.json';
      expect(classifyBashCommand(command)).toEqual(kmpTest({ moduleFilter: 'core:domain', minMissedLines: '15' }));
    });

    it('a Gradle run redirected to a log and then tailed is the Gradle task it runs', () => {
      expect(classifyBashCommand('./gradlew :core:domain:testDemoDebugUnitTest > build.log 2>&1; tail -n 40 build.log'))
        .toEqual(gradle([':core:domain:testDemoDebugUnitTest']));
    });

    it('a Gradle run piped into grep is the Gradle task it runs', () => {
      expect(classifyBashCommand('./gradlew test | grep FAILED')).toEqual(gradle(['test']));
    });

    it('a Gradle run inside a PowerShell -Command program, with a cd before it and a Select-String after it, is that Gradle task', () => {
      const command = `${POWERSHELL} -Command 'cd x; ./gradlew testDemoDebugUnitTest 2>&1 | Select-String FAILED'`;
      expect(classifyBashCommand(command)).toEqual(gradle(['testDemoDebugUnitTest']));
    });

    it('a kmp-test call after an echo is the kmp-test call', () => {
      expect(classifyBashCommand('echo start; kmp-test parallel --json')).toEqual(kmpTest());
    });

    it('a kmp-test call piped into tee is the kmp-test call', () => {
      expect(classifyBashCommand('kmp-test parallel --json | tee out.json')).toEqual(kmpTest());
    });

    it('a kmp-test call after cd and && with its output redirected is the kmp-test call', () => {
      expect(classifyBashCommand('cd proj && kmp-test parallel --json > out.json')).toEqual(kmpTest());
    });

    it('a semicolon inside double quotes does not split: the whole command keeps its existing result (other)', () => {
      expect(classifyBashCommand('echo "a;b" && ls')).toEqual({ kind: 'other' });
    });

    it('unbalanced quotes skip the pre-pass and fail closed to the whole-command result (other)', () => {
      expect(classifyBashCommand('echo "unbalanced && kmp-test parallel')).toEqual({ kind: 'other' });
    });
  });

  // The two Start-Process rows are real commands copied from the Evidence2 Codex transcripts, with the
  // machine-specific temp paths shortened (the quoting, the `'"'` concatenations and the doubled
  // backslashes are as Codex recorded them).
  describe('Start-Process, as Codex launches long runs (real Evidence2 commands)', () => {
    it('codex-cli-4: the first Start-Process command, a bare -FilePath .\\gradlew.bat with a comma list, is gradle with its tasks', () => {
      const command = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$taskLog = Join-Path (Get-Location) '"'gradle-domain-test.log'; "'$taskErr = Join-Path (Get-Location) '"'gradle-domain-test.err.log'; Remove-Item -LiteralPath "'$taskLog,$taskErr -ErrorAction SilentlyContinue; $p = Start-Process -FilePath .'"\\gradlew.bat -ArgumentList ':core:domain:testDemoDebugUnitTest',':core:domain:createDemoDebugUnitTestCoverageReport','--console=plain' -WorkingDirectory (Get-Location) -WindowStyle Hidden -RedirectStandardOutput "'$taskLog -RedirectStandardError $taskErr -PassThru; $p.Id'`;
      expect(classifyBashCommand(command)).toEqual(gradle([':core:domain:testDemoDebugUnitTest', ':core:domain:createDemoDebugUnitTestCoverageReport']));
    });

    it('codex-cli-3: command 14, a quoted -FilePath ...\\kmp-test.cmd with an @(...) list, is kmp-test parallel', () => {
      const command = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$kmpOutput = '"'C:\\tmp\\kmp-result.out'; "'$kmpError = '"'C:\\tmp\\kmp-result.err'; "'$kmpProcess = Start-Process -FilePath '"'C:\\tmp\\shim\\kmp-test.cmd' -ArgumentList @('parallel','--module-filter',':core:domain','--min-missed-lines','15','--json','--project-root','.') -WorkingDirectory 'C:\\tmp\\scenario' -RedirectStandardOutput "'$kmpOutput -RedirectStandardError $kmpError -WindowStyle Hidden -PassThru; $kmpProcess.Id'`;
      expect(classifyBashCommand(command)).toEqual(kmpTest({ moduleFilter: ':core:domain', minMissedLines: '15' }));
    });
  });

  describe('splitting into segments', () => {
    it('splits at ||', () => {
      expect(classifyBashCommand('false || kmp-test parallel --json')).toEqual(kmpTest());
    });

    it('splits at a newline, LF or CRLF', () => {
      expect(classifyBashCommand('echo hi\nkmp-test parallel --json')).toEqual(kmpTest());
      expect(classifyBashCommand('echo hi\r\n./gradlew test')).toEqual(gradle(['test']));
    });

    it('does not split at a semicolon or && inside single quotes', () => {
      expect(classifyBashCommand("echo 'a; kmp-test parallel --json'")).toEqual({ kind: 'other' });
      expect(classifyBashCommand("echo 'a && ./gradlew test'")).toEqual({ kind: 'other' });
    });

    it('does not split at && inside double quotes', () => {
      expect(classifyBashCommand('echo "a && ./gradlew test"')).toEqual({ kind: 'other' });
    });

    it('does not split after a backslash escape', () => {
      expect(classifyBashCommand(String.raw`echo x\; kmp-test parallel --json`)).toEqual({ kind: 'other' });
    });

    it('a single & or | is not a separator', () => {
      expect(classifyBashCommand('echo a & ./gradlew test')).toEqual({ kind: 'other' });
    });

    it('the first kmp-test or Gradle segment is the result, even when later segments are kmp-test or Gradle too', () => {
      expect(classifyBashCommand('kmp-test describe --json; kmp-test parallel --json').subcommand).toBe('describe');
      expect(classifyBashCommand('./gradlew :a:test; kmp-test parallel --json').kind).toBe('gradle');
    });

    it('with no kmp-test or Gradle segment the whole-command result stands (other)', () => {
      expect(classifyBashCommand('echo a; echo b && ls | wc -l')).toEqual({ kind: 'other' });
    });

    it('unbalanced quotes leave a command that is kmp-test as a whole to the existing logic, never to a half-parsed segment', () => {
      expect(classifyBashCommand('kmp-test parallel --json "unterminated; echo done')).toEqual({ kind: 'other' });
    });
  });

  describe('stripping output redirections from the end of a segment', () => {
    it.each([
      ['> file', './gradlew test > out.log'],
      ['>> file', './gradlew test >> out.log'],
      ['2> file', './gradlew test 2> err.log'],
      ['2>> file', './gradlew test 2>> err.log'],
      ['&> file', './gradlew test &> all.log'],
      ['*> file', './gradlew test *> all.log'],
      ['2>&1', './gradlew test 2>&1'],
      ['1>&2', './gradlew test 1>&2'],
      ['a redirect glued to its file', './gradlew test >out.log'],
      ['a stderr redirect glued to its file', './gradlew test 2>err.log'],
      ['several redirections', './gradlew test > out.log 2>&1'],
      ['redirections in the other order', './gradlew test 2>&1 >> out.log'],
    ])('strips %s, leaving the real task tokens', (_label, command) => {
      expect(classifyBashCommand(command)).toEqual(gradle(['test']));
    });

    it('strips the redirections of each segment, not only the last one', () => {
      expect(classifyBashCommand('./gradlew test > a.log 2>&1; echo done > b.log')).toEqual(gradle(['test']));
    });

    it('does not strip a redirection that is followed by more arguments', () => {
      expect(classifyBashCommand('./gradlew test > out.log --console=plain').taskTokens).toContain('>');
    });
  });

  describe('stripping a trailing pipe into a filter', () => {
    it.each([
      ['tee', './gradlew test | tee out.log'],
      ['tail', './gradlew test | tail -n 40'],
      ['head', './gradlew test | head -n 5'],
      ['grep', './gradlew test | grep FAILED'],
      ['findstr', './gradlew test | findstr FAILED'],
      ['Select-String', './gradlew test | Select-String FAILED'],
      ['Select-Object', './gradlew test | Select-Object -First 5'],
      ['wc', './gradlew test | wc -l'],
      ['sort', './gradlew test | sort'],
      ['cat', './gradlew test | cat'],
      ['Out-String', './gradlew test | Out-String'],
      ['a filter whose name is in another case', './gradlew test | select-string FAILED'],
      ['a filter with a quoted argument that holds a pipe', "./gradlew test | grep 'a|b'"],
    ])('strips a pipe into %s', (_label, command) => {
      expect(classifyBashCommand(command)).toEqual(gradle(['test']));
    });

    it('strips a chain of filters, and a filter after a redirection', () => {
      expect(classifyBashCommand('./gradlew test 2>&1 | grep FAILED | tail -n 5')).toEqual(gradle(['test']));
      expect(classifyBashCommand('./gradlew test 2>&1 | tee out.log')).toEqual(gradle(['test']));
    });

    it('does not strip a pipe into a command that is not a known filter', () => {
      expect(classifyBashCommand('./gradlew test | jq .').taskTokens).toContain('|');
    });
  });

  describe('the PowerShell launcher', () => {
    it.each([
      ['powershell', "powershell -Command 'cd x; ./gradlew test'"],
      ['powershell.exe', "powershell.exe -Command 'cd x; ./gradlew test'"],
      ['pwsh', "pwsh -Command 'cd x; ./gradlew test'"],
      ['pwsh with -c', "pwsh -c 'cd x; ./gradlew test'"],
      ['a launcher in upper case with -COMMAND', "POWERSHELL.EXE -COMMAND 'cd x; ./gradlew test'"],
      ['a launcher with a Windows path', String.raw`"C:\Program Files\PowerShell\7\pwsh.exe" -Command 'cd x; ./gradlew test'`],
      ['a launcher with a POSIX path', "'/usr/bin/pwsh' -Command 'cd x; ./gradlew test'"],
      ['a double-quoted program', 'pwsh -Command "cd x; ./gradlew test"'],
    ])('unwraps %s', (_label, command) => {
      expect(classifyBashCommand(command)).toEqual(gradle(['test']));
    });

    it('joins quote pieces into one program, as Codex records a program that holds single quotes', () => {
      const command = `${POWERSHELL} -Command 'Write-Output '"'hi'"'; ./gradlew test'`;
      expect(classifyBashCommand(command)).toEqual(gradle(['test']));
    });

    it('reads an escaped double quote inside a double-quoted program, and doubled backslashes as one (as Codex records them)', () => {
      const command = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command ".\\gradlew.bat :core:domain:tasks --all | Select-String -Pattern \"test|Jacoco\""`;
      expect(classifyBashCommand(command)).toEqual(gradle([':core:domain:tasks']));
    });

    it('does not unwrap a launcher that has options before -Command', () => {
      expect(classifyBashCommand("powershell.exe -NoProfile -Command 'cd x; ./gradlew test'")).toEqual({ kind: 'other' });
    });

    it('does not unwrap when the program is not a single argument', () => {
      expect(classifyBashCommand("pwsh -Command 'cd x; ./gradlew test' 'extra'")).toEqual({ kind: 'other' });
    });
  });

  describe('Start-Process', () => {
    it.each([
      ['a comma list', "Start-Process -FilePath ./gradlew -ArgumentList ':a:test','--console=plain'", gradle([':a:test'])],
      ['a comma list with spaces after the commas', "Start-Process -FilePath ./gradlew -ArgumentList ':a:test', ':b:test', '--console=plain'", gradle([':a:test', ':b:test'])],
      ['an @() list', "Start-Process -FilePath gradlew.bat -ArgumentList @(':a:test', '--stacktrace')", gradle([':a:test'])],
      ['a variable assignment in front', "$p = Start-Process -FilePath ./gradlew -ArgumentList ':a:test'", gradle([':a:test'])],
      ['the parameters in another order, with switches', "Start-Process -NoNewWindow -ArgumentList @(':a:test') -FilePath ./gradlew -PassThru", gradle([':a:test'])],
      ['parameter names in another case', "start-process -filepath ./gradlew -argumentlist ':a:test'", gradle([':a:test'])],
      ['a parenthesized value and a window style', "Start-Process -FilePath ./gradlew -WorkingDirectory (Get-Location) -ArgumentList ':a:test' -WindowStyle Hidden", gradle([':a:test'])],
      ['a quoted -FilePath that holds a space', "Start-Process -FilePath 'C:\\Program Files\\x\\gradlew.bat' -ArgumentList ':a:test'", gradle([':a:test'])],
      ['a Start-Process segment after other segments', "$a = 1; Write-Output x; Start-Process -FilePath ./gradlew -ArgumentList ':a:test'", gradle([':a:test'])],
    ])('classifies by -FilePath and -ArgumentList: %s', (_label, command, expected) => {
      expect(classifyBashCommand(command)).toEqual(expected);
    });

    it('marks a Gradle Start-Process with --dry-run as plan-only', () => {
      expect(classifyBashCommand("Start-Process -FilePath ./gradlew -ArgumentList ':a:test','--dry-run'")).toEqual(gradle([':a:test'], true));
    });

    it.each([
      ['kmp-test', 'Start-Process -FilePath kmp-test -ArgumentList @(\'parallel\',\'--json\')'],
      ['kmp-test.cmd', "Start-Process -FilePath 'C:\\tools\\kmp-test.cmd' -ArgumentList @('parallel','--json')"],
      ['kmp-test.ps1', "Start-Process -FilePath ./kmp-test.ps1 -ArgumentList @('parallel','--json')"],
    ])('classifies a -FilePath ending in %s as kmp-test, with the first list item as the subcommand', (_label, command) => {
      expect(classifyBashCommand(command)).toEqual(kmpTest());
    });

    it('reads the kmp-test flags out of the argument list with the existing rules', () => {
      const command = "Start-Process -FilePath kmp-test -ArgumentList @('parallel','--module-filter','core:domain','--min-missed-lines','15','--test-type','androidUnit','--no-coverage','--dry-run')";
      expect(classifyBashCommand(command)).toEqual(kmpTest({
        moduleFilter: 'core:domain', minMissedLines: '15', testType: 'androidUnit', coverageDisabled: true, isPlanOnly: true,
      }));
    });

    it('classifies a -FilePath by its kind even when -ArgumentList is a variable, with no tasks', () => {
      expect(classifyBashCommand('Start-Process -FilePath .\\gradlew.bat -ArgumentList $taskArgs -PassThru')).toEqual(gradle([]));
      expect(classifyBashCommand('Start-Process -FilePath kmp-test -ArgumentList $kmpArgs')).toEqual(kmpTest({ subcommand: null }));
    });

    it.each([
      ['another program', "Start-Process -FilePath node.exe -ArgumentList 'gradlew'"],
      ['a file that only starts with kmp-test', "Start-Process -FilePath C:\\tools\\kmp-test-runner.cmd -ArgumentList 'parallel'"],
      ['a same-directory wrapper script', "Start-Process -FilePath gradlew-wrapper.sh -ArgumentList ':a:test'"],
      ['no -FilePath', "Start-Process -ArgumentList ':a:test'"],
    ])('does not classify %s', (_label, command) => {
      expect(classifyBashCommand(command)).toEqual({ kind: 'other' });
    });

    it('does not classify text that only mentions Start-Process', () => {
      expect(classifyBashCommand("echo 'Start-Process -FilePath ./gradlew -ArgumentList :a:test'")).toEqual({ kind: 'other' });
    });
  });

  describe('malformed input', () => {
    it('never throws and always returns a known kind, for random mixes of quotes, escapes, separators and Start-Process pieces', () => {
      const pieces = ["'", '"', '\\', ';', '&&', '||', '|', '&', '>', '>>', '2>&1', '(', ')', '@(', '$', '`', ',', '-', ' ', ' ', ' ', '\n',
        'Start-Process', '-FilePath', '-ArgumentList', 'gradlew', 'kmp-test', 'parallel', 'test', 'powershell.exe', '-Command', 'pwsh', '-c',
        'tee', 'tail', '-f', 'grep', 'a', 'b', '.', ':', '='];
      let seed = 12345; // a fixed linear congruential sequence, so a failure is reproducible
      const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
      for (let i = 0; i < 3000; i++) {
        let command = '';
        for (let n = 1 + Math.floor(next() * 30); n > 0; n--) command += pieces[Math.floor(next() * pieces.length)];
        expect(['kmp-test', 'gradle', 'other'], JSON.stringify(command)).toContain(classifyBashCommand(command).kind);
      }
    });
  });
});

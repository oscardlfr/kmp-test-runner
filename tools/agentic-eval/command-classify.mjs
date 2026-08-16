#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/command-classify.mjs -- shared Bash-command classification for JUnit-evidence
// attribution. A tiny, dependency-light leaf module: imports only `tokenize` from policy-hook.mjs
// (that file's tokenize()/GRADLE_LEADING_TOKENS never move here -- policy_sha256, computed over
// policy-hook.mjs's own bytes only, would otherwise silently stop covering the grammar that
// actually drives the allow/deny decision). Deliberately not merged into graders.mjs: the new
// junit-evidence-hook.mjs is a hook subprocess that must start up fast and must not transitively
// load graders.mjs's much larger dependency tree just to classify one command string.
import { tokenize } from './policy-hook.mjs';
import { matchModuleFilter } from '../../lib/orchestrators/module-filter.js';

/** Classifies one Bash tool_use's raw command string. Relocated verbatim from graders.mjs (the
 * grammar itself is unchanged) so it can be shared by graders.mjs, junit-evidence.mjs, and
 * junit-evidence-hook.mjs without a second, potentially divergent parser. Returns
 * `{kind:'kmp-test', subcommand, moduleFilter, testType, minMissedLines, coverageDisabled, isPlanOnly}` |
 * `{kind:'gradle', taskTokens, isPlanOnly}` | `{kind:'other'}`. */
export function classifyBashCommand(command) {
  if (typeof command !== 'string') return { kind: 'other' };
  const tokens = tokenize(command);
  if (tokens == null || tokens.length === 0) return { kind: 'other' };
  if (tokens[0] === 'kmp-test') {
    let moduleFilter = null;
    let testType = null;
    let minMissedLines = null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--module-filter') { moduleFilter = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--module-filter=')) { moduleFilter = tokens[i].slice('--module-filter='.length); }
      else if (tokens[i] === '--test-type') { testType = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--test-type=')) { testType = tokens[i].slice('--test-type='.length); }
      // --min-missed-lines -- raw string token, never parsed to a number here (same convention as
      // moduleFilter/testType above): interpretation/validation is the caller's job. graders.mjs's
      // exact-string comparison against the scenario's own String(min_missed_lines) implicitly
      // rejects non-canonical forms (e.g. "050"/"5e1") without a second regex here.
      else if (tokens[i] === '--min-missed-lines') { minMissedLines = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--min-missed-lines=')) { minMissedLines = tokens[i].slice('--min-missed-lines='.length); }
    }
    // --show-modules-only -- changed's own dry-run-shaped inspection flag (never a real
    // execution, only a preview of which modules a real run would touch): excluded from terminal
    // contention/retries/JUnit relevance downstream exactly like --dry-run/--list/--list-only.
    const isPlanOnly = tokens.includes('--dry-run') || tokens.includes('--list') || tokens.includes('--list-only') || tokens.includes('--show-modules-only');
    // --no-coverage -- policy-hook.mjs's own KMP_TEST_BOOLEAN_FLAGS authorizes this flag, but it is
    // real and consequential: expandNoCoverageAlias (lib/orchestrators/orchestrator-utils.js)
    // rewrites it to `--coverage-tool none`, and runParallel's own coverage hand-off
    // (`if (opts.coverageTool !== 'none') { ... runCoverageInProcess ... }`,
    // lib/orchestrators/parallel-orchestrator.js:816) never even CALLS coverage aggregation when
    // that's set -- a real `--no-coverage` invocation can therefore never produce a
    // coverage_threshold_exceeded outcome. Captured here (unlike --coverage-tool/--coverage-modules/
    // --exclude-coverage, none of which this classifier extracts, since none of them are policy
    // hook -- authorized) specifically so graders.mjs can reject a self-reported
    // coverage_threshold_exceeded claim paired with a command that could never have produced one.
    const coverageDisabled = tokens.includes('--no-coverage');
    return { kind: 'kmp-test', subcommand: tokens[1] ?? null, moduleFilter, testType, minMissedLines, coverageDisabled, isPlanOnly };
  }
  if (tokens[0] === './gradlew' || tokens[0] === './gradlew.bat') {
    const taskTokens = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const isPlanOnly = tokens.includes('--dry-run');
    return { kind: 'gradle', taskTokens, isPlanOnly };
  }
  return { kind: 'other' };
}

/** A Gradle-project-path-shaped module identifier, normalized to bare-no-leading-colon form for
 * comparison. Relocated verbatim from graders.mjs. */
export function normalizeModuleName(name) {
  return typeof name === 'string' ? name.replace(/^:/, '') : name;
}

/** True only for a non-plan-only Gradle invocation whose task tokens include at least one entry
 * from `allowedInvocations` (the scenario's `expected.gradle.allowed_invocations`) -- deliberately
 * NOT "any Gradle command" and NOT "only the literal evidence_task": a policy-permitted lifecycle
 * alias (e.g. `:app:test`) must count as relevant even though its own task token never literally
 * equals `evidence_task` (schemas.mjs's own "decision 3" contract, graders.mjs:759-764's own
 * confirmed real-Gradle-behavior comment: the alias still prints the underlying leaf task's own
 * status line as part of its dependency chain). The JUnit XML itself is still always read from
 * `evidence_task`'s own directory -- this predicate only decides relevance/tracking, never where to
 * look for evidence. */
export function isRelevantGradleInvocation(classification, allowedInvocations) {
  if (classification.kind !== 'gradle' || classification.isPlanOnly) return false;
  return classification.taskTokens.some((t) => (allowedInvocations ?? []).includes(t));
}

/** True only for a non-plan-only `kmp-test parallel` invocation whose `--module-filter` is either
 * absent (ran every module, including the target) or MATCHES the target module under the real
 * production matcher (`matchModuleFilter`, `lib/orchestrators/module-filter.js`) -- mirrors the
 * original `classifyJunitProvenance` per-command rule (graders.mjs:939-944): a `parallel` call
 * dispatches the same underlying Gradle task and can write/overwrite the same JUnit XML, so it is
 * just as much a potential producer as a raw Gradle invocation, scoped the same way. Follow-up fix:
 * this originally compared `moduleFilter` to `targetModule` via exact string equality, so a command
 * correctly targeting a NESTED module (`:core:common`) via a short substring filter (`common`) or
 * an anchored glob (`core:*`) was invisible to this relevance check even though the real CLI's own
 * dispatch would have matched it -- silently hiding a genuine same-turn JUnit-evidence conflict
 * from `junit-evidence.mjs`'s `attributeCondition`. `targetModule` is expected to be a string
 * (`attributeCondition` reads it from `scenario.expected?.module`, note the existing optional
 * chaining there); unlike `normalizeModuleName`'s safe passthrough for a non-string value,
 * `matchModuleFilter` calls `.replace` on its `name` argument unconditionally, so a missing/
 * non-string `targetModule` is guarded explicitly rather than left to throw. */
export function isRelevantKmpTestParallel(classification, targetModule) {
  if (classification.kind !== 'kmp-test' || classification.subcommand !== 'parallel' || classification.isPlanOnly) return false;
  if (classification.moduleFilter == null) return true;
  return typeof targetModule === 'string' && matchModuleFilter(targetModule, classification.moduleFilter);
}

/** True only for a non-plan-only `kmp-test changed` invocation -- deliberately NO module-filter
 * parameter/logic, unlike isRelevantKmpTestParallel above: `changed` has no `--module-filter` flag
 * at all (the real CLI rejects it as `unknown_flag`), so there is no "ran the wrong module" shape
 * to reconcile here -- every non-plan-only `changed` call is unconditionally relevant. This
 * predicate itself carries no scenario awareness (no targetModule, no outcome_kind check) by
 * design -- callers (junit-evidence.mjs's attributeCondition) are responsible for only folding it
 * into their own `relevant` set when the scenario itself actually expects a `changed` subcommand
 * (`scenario.expected.changed != null`), so the other 5 scenarios' behavior stays untouched. */
export function isRelevantKmpTestChanged(classification) {
  return classification.kind === 'kmp-test' && classification.subcommand === 'changed' && !classification.isPlanOnly;
}

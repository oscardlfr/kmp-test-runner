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

/** Classifies one Bash tool_use's raw command string. Relocated verbatim from graders.mjs (the
 * grammar itself is unchanged) so it can be shared by graders.mjs, junit-evidence.mjs, and
 * junit-evidence-hook.mjs without a second, potentially divergent parser. Returns
 * `{kind:'kmp-test', subcommand, moduleFilter, testType, isPlanOnly}` |
 * `{kind:'gradle', taskTokens, isPlanOnly}` | `{kind:'other'}`. */
export function classifyBashCommand(command) {
  if (typeof command !== 'string') return { kind: 'other' };
  const tokens = tokenize(command);
  if (tokens == null || tokens.length === 0) return { kind: 'other' };
  if (tokens[0] === 'kmp-test') {
    let moduleFilter = null;
    let testType = null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--module-filter') { moduleFilter = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--module-filter=')) { moduleFilter = tokens[i].slice('--module-filter='.length); }
      else if (tokens[i] === '--test-type') { testType = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--test-type=')) { testType = tokens[i].slice('--test-type='.length); }
    }
    const isPlanOnly = tokens.includes('--dry-run') || tokens.includes('--list') || tokens.includes('--list-only');
    return { kind: 'kmp-test', subcommand: tokens[1] ?? null, moduleFilter, testType, isPlanOnly };
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
 * absent (ran every module, including the target) or equals the target module -- mirrors the
 * original `classifyJunitProvenance` per-command rule (graders.mjs:939-944): a `parallel` call
 * dispatches the same underlying Gradle task and can write/overwrite the same JUnit XML, so it is
 * just as much a potential producer as a raw Gradle invocation, scoped the same way. */
export function isRelevantKmpTestParallel(classification, targetModule) {
  if (classification.kind !== 'kmp-test' || classification.subcommand !== 'parallel' || classification.isPlanOnly) return false;
  if (classification.moduleFilter == null) return true;
  return normalizeModuleName(classification.moduleFilter) === normalizeModuleName(targetModule);
}

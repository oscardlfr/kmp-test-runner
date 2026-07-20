#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/graders.mjs -- deterministic, structured, evidence-anchored scenario
// graders. Pure functions over already-collected transcript + JUnit-evidence data (see
// matrix-runner.mjs's captureGradleJunitEvidence for where the latter comes from) -- never an LLM
// judge, never a broad free-text keyword scan as the primary signal.
//
// A first version of this file (deleted before ever shipping, commit 3f81208) was rejected on
// review for exactly one, verbatim reason: "six scenario-specific graders using broad keyword
// matching, not structured outcome verification" -- e.g. `makeTextContainsGrader([/fail/i])`
// against the raw final-answer string, which passes on a correct-sounding sentence regardless of
// what (if anything) actually ran. This file is the corrected design: every check below
// correlates a tokenized Bash tool_use, its own tool_result, an authoritative kmp-test JSON
// envelope OR independently-read Gradle/JUnit evidence, and the scenario's exact expected
// module/task/outcome identifiers -- the agent's own final-answer text is checked too (decision 8
// of the design), but only as a secondary, positive-fact requirement layered on top of real
// evidence, never as the primary or sole signal.
import { tokenize } from './policy-hook.mjs';
import { classifyTaskExecutionMode } from '../../lib/orchestrators/parallel/result-rollup.js';
import { findTranscriptStructuralIssuesToleratingTimeout, findIncompleteToolResultsToleratingTimeout } from './stream-parser.mjs';

/** The fixed, canonical set of check names every gradeScenarioCondition() result's `checks` array
 * must contain -- exactly these 8, no more, no fewer, enforced by schemas.mjs's validateRun() for
 * any committed run record. Exported so the schema validator and this module can never drift
 * apart into two independently-maintained lists. */
export const GRADING_CHECK_NAMES = [
  'no_transcript_structural_issues',
  'bash_tool_use_present',
  'tool_result_correlated',
  'authoritative_evidence_well_formed',
  'authoritative_target_matches_expected',
  'authoritative_outcome_matches_expected',
  'no_provider_contradiction',
  'final_answer_consistent_with_evidence',
];

// ---------------------------------------------------------------------------------------------
// Command classification -- reuses policy-hook.mjs's OWN tokenizer, never a second, potentially
// divergent parser. Grading correlates against the exact same grammar the policy hook enforced
// live.
// ---------------------------------------------------------------------------------------------

/** Classifies one Bash tool_use's raw command string. Returns `{kind:'kmp-test', subcommand,
 * moduleFilter}` | `{kind:'gradle', taskTokens}` | `{kind:'other'}` -- `'other'` covers both a
 * genuinely unrelated command AND one the tokenizer itself rejects (unbalanced quotes --
 * tokenize() returns null per its own contract), since either way it can't be correlated against
 * kmp-test/gradle evidence. `moduleFilter` is the exact value the agent passed to
 * `--module-filter`/`--module-filter=`, if any -- needed because a `no_test_modules` envelope has
 * an EMPTY `modules[]` array (there was nothing to resolve), so the only place the agent's
 * intended target module is directly observable for that outcome is the command itself, not the
 * envelope. */
function classifyBashCommand(command) {
  if (typeof command !== 'string') return { kind: 'other' };
  const tokens = tokenize(command);
  if (tokens == null || tokens.length === 0) return { kind: 'other' };
  if (tokens[0] === 'kmp-test') {
    let moduleFilter = null;
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === '--module-filter') { moduleFilter = tokens[i + 1] ?? null; i++; }
      else if (tokens[i].startsWith('--module-filter=')) { moduleFilter = tokens[i].slice('--module-filter='.length); }
    }
    return { kind: 'kmp-test', subcommand: tokens[1] ?? null, moduleFilter };
  }
  if (tokens[0] === './gradlew' || tokens[0] === './gradlew.bat') {
    const taskTokens = tokens.slice(1).filter((t) => !t.startsWith('-'));
    return { kind: 'gradle', taskTokens };
  }
  return { kind: 'other' };
}

/** A Gradle-project-path-shaped module identifier, normalized to bare-no-leading-colon form for
 * comparison -- kmp-test's own `--json` output is internally inconsistent about this (`parallel`'s
 * `modules[].name` is bare, e.g. `"shared"`; `describe`'s is colon-prefixed, e.g. `":shared"`),
 * and an agent typing `--module-filter` may reasonably use either form too (both were observed in
 * real prior sessions against this exact project). Comparing normalized on both sides avoids a
 * false "wrong module" purely from a cosmetic colon-prefix difference. */
function normalizeModuleName(name) {
  return typeof name === 'string' ? name.replace(/^:/, '') : name;
}

// ---------------------------------------------------------------------------------------------
// kmp-test JSON envelope extraction (decision 10 of the design -- defensive by construction,
// since the real Claude-Code-native tool_result.content wrapping shape for these specific
// commands is not yet confirmed by a live capture; this repo's own direct-CLI stdout captures
// during implementation showed a clean single-JSON-line stdout with banner/notice text on
// stderr, never mixed into the same stream, but that is not the same thing as having observed a
// genuine Claude Code tool_result for these commands).
// ---------------------------------------------------------------------------------------------

const KMP_TEST_ENVELOPE_REQUIRED_SHAPE = (obj) =>
  obj != null && typeof obj === 'object' && !Array.isArray(obj)
  && obj.tool === 'kmp-test'
  && typeof obj.schema_version === 'number'
  && typeof obj.subcommand === 'string'
  && obj.tests != null && typeof obj.tests === 'object'
  && Array.isArray(obj.modules)
  && Array.isArray(obj.errors);

function tryParseJsonObject(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Scans for EVERY substring that looks like a balanced top-level `{...}` JSON object --
 * brace-depth counting (with string/escape awareness), not a regex, since a regex cannot in
 * general match nested braces correctly. Defensive fallback for when the whole trimmed string
 * doesn't parse directly (e.g. banner text before/after the JSON line). Scans ALL of them, not
 * just the first -- a review pass reproduced a real gap where a decoy/wrapper object appearing
 * BEFORE the real envelope in the same content (e.g. `{"wrapper":"meta"}\n<real envelope>`) made
 * the real envelope invisible entirely, since only the first balanced object was ever examined. */
function extractAllJsonObjectSubstrings(text) {
  const substrings = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '\\') { escapeNext = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) break; // unbalanced from here on -- nothing further to find
    substrings.push(text.slice(start, end + 1));
    i = end + 1;
  }
  return substrings;
}

/** Locates and parses a kmp-test `--json` envelope within possibly-noisy tool_result content.
 * Tries a direct whole-string parse first (the clean, expected case: the whole content IS one
 * JSON document) -- if that parses but doesn't conform to the envelope shape, returns `null`
 * immediately without digging further (the content is already fully accounted for by that one
 * value; hunting for a DIFFERENT envelope nested somewhere inside it would be reaching beyond
 * what's honestly parseable). Only when the whole-string parse fails outright (content is NOT one
 * single valid JSON document -- e.g. two objects concatenated) does it fall back to scanning EVERY
 * balanced top-level `{...}` substring and collecting every one that conforms to
 * `KMP_TEST_ENVELOPE_REQUIRED_SHAPE`. Returns the single conforming envelope only if EXACTLY one
 * was found; `null` otherwise -- covers "not JSON at all", "JSON, but not a kmp-test envelope",
 * AND "more than one conforming envelope found" (itself an ambiguous, untrustworthy shape)
 * identically, since a grader only needs to know "is this UNAMBIGUOUSLY usable evidence," not
 * which specific way it failed to be. */
export function extractKmpTestEnvelope(content) {
  if (typeof content !== 'string' || content.length === 0) return null;
  const direct = tryParseJsonObject(content.trim());
  if (direct != null) return KMP_TEST_ENVELOPE_REQUIRED_SHAPE(direct) ? direct : null;
  const candidates = extractAllJsonObjectSubstrings(content)
    .map((s) => tryParseJsonObject(s))
    .filter((obj) => KMP_TEST_ENVELOPE_REQUIRED_SHAPE(obj));
  return candidates.length === 1 ? candidates[0] : null;
}

// ---------------------------------------------------------------------------------------------
// Per-attempt evaluation -- one entry per Bash tool_use capable of producing target evidence
// (kmp-test's `parallel` subcommand; a Gradle invocation naming a policy-allowed task). `doctor`/
// `describe` (kmp-test) are recognized and simply never evaluated here -- auxiliary, never a
// candidate for target evidence, so a normal doctor-then-parallel session (or a legitimate
// parallel retry) never trips a false "multiple envelopes" problem the way the deleted PR #372
// draft's design would have.
// ---------------------------------------------------------------------------------------------

/** @returns {null | {provider:'kmp_test', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, outcomeMatches:boolean}} */
function evaluateKmpTestAttempt(bashResult, scenario) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'kmp-test' || classification.subcommand !== 'parallel') return null;

  const envelope = extractKmpTestEnvelope(bashResult.resultContent);
  const malformed = bashResult.resultContent != null && envelope == null;
  const hasEvidence = envelope != null;

  const targetModule = normalizeModuleName(scenario.expected.module);
  let observedModule = null;
  if (hasEvidence) {
    if (envelope.modules.length > 0) observedModule = normalizeModuleName(envelope.modules[0]?.name);
    else if (classification.moduleFilter != null) observedModule = normalizeModuleName(classification.moduleFilter);
  }
  const targetMatches = hasEvidence && observedModule === targetModule;

  let outcomeMatches = false;
  if (hasEvidence && targetMatches) {
    const kt = scenario.expected.kmp_test;
    // A review pass reproduced a real gap: a resultIsError:true tool_result (the Bash call itself
    // was flagged as failed) alongside an envelope claiming exit_code:0 still graded as a match,
    // since resultIsError was never consulted at all. Checked in ONLY this one direction --
    // resultIsError:true contradicting a CLEAN exit_code:0 claim is wrong under any plausible
    // convention, but the REVERSE (resultIsError:false alongside a non-zero exit_code) is NOT
    // flagged: kmp-test's own exit codes encode multiple LEGITIMATE non-zero states (exit_code:2/
    // CONFIG_ERROR for no_test_modules is the CORRECT outcome for the no_applicable_tests
    // scenario, not a failure), and the real Claude-Code-native is_error convention for a
    // non-zero CLI exit code remains unconfirmed (decision 10) -- asserting that direction risks
    // a wrong assumption breaking the legitimate case once this harness runs live.
    const resultIsErrorContradiction = bashResult.resultIsError === true && envelope.exit_code === 0;
    if (scenario.expected.outcome_kind === 'tests_executed') {
      // `tests.total/passed/failed` alone is a TASK-level count (a module resolves to exactly one
      // Gradle task here, so this is always {1,1,0} on success) -- checking only that would not
      // catch a "task nominally succeeded but silently ran zero real tests" false-positive (the
      // same class of bug this project's own main CLI documents as "cache-only-greens": a stale
      // cache or a not-actually-executed run can still report task-level success). `individual_total`
      // is the real per-test-case count from kmp-test's own JUnit-XML walk, exposed directly on
      // the envelope -- comparing it too is what actually proves real tests ran and passed.
      // `envelope.errors.length === 0` closes a second real gap: nothing previously checked that a
      // "tests executed cleanly" claim wasn't ALSO carrying a no_test_modules-shaped error entry
      // (a review pass reproduced exactly this self-contradictory envelope still passing).
      outcomeMatches = !resultIsErrorContradiction
        && envelope.errors.length === 0
        && envelope.exit_code === (kt.exit_code ?? 0)
        && envelope.tests?.total === kt.tests.total
        && envelope.tests?.passed === kt.tests.passed
        && envelope.tests?.failed === kt.tests.failed
        && envelope.tests?.individual_total === kt.tests.individual_total;
    } else {
      const matchingError = envelope.errors.find((e) => e && e.code === kt.error_code);
      // tests.{total,passed,failed} must all be exactly zero -- the converse of the same
      // self-contradiction check above: a no_test_modules-shaped error claim alongside NON-zero
      // test counts is just as internally inconsistent as the reverse.
      outcomeMatches = !resultIsErrorContradiction
        && envelope.exit_code === kt.exit_code
        && matchingError != null
        && matchingError.caused_by_filter === kt.caused_by_filter
        && envelope.tests?.total === 0 && envelope.tests?.passed === 0 && envelope.tests?.failed === 0;
    }
  }

  return { provider: 'kmp_test', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence, malformed, targetMatches, outcomeMatches };
}

/** Parses the terminal Gradle build-outcome from possibly-noisy tool_result content: the LAST
 * COMPLETE Gradle footer LINE matching `BUILD SUCCESSFUL`/`BUILD FAILED` at the start of its own
 * line (Gradle always prints exactly one such footer as its own last informational line, e.g.
 * "BUILD SUCCESSFUL in 8s") -- line-anchored, never a bare substring search: a review pass pointed
 * out that `lastIndexOf` would misattribute the footer to any LATER diagnostic/log text that
 * merely MENTIONS either phrase mid-sentence (e.g. a warning quoting it), not just a genuine
 * second footer. Taking the LAST matching line (rather than "does either pattern appear
 * ANYWHERE") is what correctly handles an earlier retry's own footer line still sitting earlier
 * in the same accumulated content. Cross-checked against the tool_result's own `resultIsError`: a
 * review pass reproduced a real gap where `resultIsError:true` (the Bash call itself failed)
 * alongside `BUILD SUCCESSFUL` text appearing anywhere in the content was graded as a genuine
 * success, since `resultIsError` was never consulted at all. A contradiction between the text's
 * own last footer and `resultIsError` means the content cannot be trusted -- returns `null` in
 * that case (never silently prefers one signal over the other), same as when neither footer is
 * found at all. Returns 0 (success), 1 (failed), or null (untrustworthy). */
function parseGradleBuildOutcome(resultContent, resultIsError) {
  const successMatches = [...resultContent.matchAll(/^[ \t]*BUILD SUCCESSFUL\b/gm)];
  const failedMatches = [...resultContent.matchAll(/^[ \t]*BUILD FAILED\b/gm)];
  const lastSuccessIndex = successMatches.length > 0 ? successMatches[successMatches.length - 1].index : -1;
  const lastFailedIndex = failedMatches.length > 0 ? failedMatches[failedMatches.length - 1].index : -1;
  if (lastSuccessIndex === -1 && lastFailedIndex === -1) return null;
  const lastWasSuccess = lastSuccessIndex > lastFailedIndex;
  // resultIsError is only ever a MEANINGFUL contradiction signal when it's an explicit true/false
  // observation -- null (never determined) neither confirms nor contradicts either footer.
  if (resultIsError === true && lastWasSuccess) return null;
  if (resultIsError === false && !lastWasSuccess) return null;
  return lastWasSuccess ? 0 : 1;
}

/** @returns {null | {provider:'gradle', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, outcomeMatches:boolean}} */
function evaluateGradleAttempt(bashResult, scenario, gradleJunitEvidence, ambiguousJunitEvidence) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'gradle') return null;
  const g = scenario.expected.gradle;
  const invokedAllowed = classification.taskTokens.some((t) => g.allowed_invocations.includes(t));
  if (!invokedAllowed) return null;

  const hasEvidence = typeof bashResult.resultContent === 'string' && bashResult.resultContent.length > 0;
  if (!hasEvidence) {
    return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: false, malformed: false, targetMatches: true, outcomeMatches: false };
  }
  // Membership in allowed_invocations (already proven above) IS the target-match for the Gradle
  // path -- the agent invoked one of the scenario-declared acceptable commands for this module.
  const targetMatches = true;

  // The marker/exit-code evidence is always parsed from `evidence_task`'s OWN status line --
  // regardless of which allowed_invocations entry the agent actually typed (decision 3/14): the
  // real Gradle behavior confirmed during implementation is that invoking the lifecycle alias
  // (`:app:test`) still prints the underlying leaf task's own status line (`Task
  // :app:testDebugUnitTest NO-SOURCE`) as part of its dependency chain, so this is never blind to
  // which invocation was actually used.
  const modes = classifyTaskExecutionMode(bashResult.resultContent, '', [g.evidence_task]);
  const mode = modes.get(g.evidence_task) ?? 'no_evidence';
  const observedExitCode = parseGradleBuildOutcome(bashResult.resultContent, bashResult.resultIsError);
  // A footer/resultIsError contradiction (or no recognizable footer at all) means the build
  // outcome itself cannot be trusted -- the Gradle-provider equivalent of the kmp-test provider's
  // own "content exists but doesn't parse as valid evidence" malformed shape.
  const malformed = observedExitCode == null;

  let outcomeMatches = false;
  if (!malformed) {
    if (scenario.expected.outcome_kind === 'tests_executed') {
      const executedModes = new Set(['fresh', 'up_to_date', 'from_cache']);
      // JUnit XML is captured ONCE per condition, after the whole cell finishes (see
      // matrix-runner.mjs's captureGradleJunitEvidence) -- if more than one Gradle attempt in
      // this condition could have produced/overwritten it, that one snapshot cannot be reliably
      // attributed to THIS specific attempt (a review pass found this could misattribute a
      // later-or-earlier attempt's evidence, falsifying first_useful_signal/retries/contradiction
      // detection). ambiguousJunitEvidence fails this closed rather than guessing.
      outcomeMatches = observedExitCode === (g.exit_code ?? 0)
        && executedModes.has(mode)
        && !ambiguousJunitEvidence
        && gradleJunitEvidence != null
        && gradleJunitEvidence.total === g.tests.total
        && gradleJunitEvidence.passed === g.tests.passed
        && gradleJunitEvidence.failed === g.tests.failed;
    } else {
      // no_applicable_tests never depends on cross-attempt JUnit evidence at all -- the NO-SOURCE
      // marker is parsed from THIS attempt's own resultContent, so ambiguousJunitEvidence does
      // not apply here.
      outcomeMatches = observedExitCode === g.exit_code && mode === 'no_source' && g.marker === 'NO-SOURCE';
    }
  }

  return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: true, malformed, targetMatches, outcomeMatches };
}

// ---------------------------------------------------------------------------------------------
// Final-answer text check (decision 8) -- a POSITIVE requirement built from the scenario's own
// exact, structured identifiers, never a generic keyword scan. Secondary only: this never gates
// `expectedOutcomeMatched`, only `success` on top of it (decision 13).
// ---------------------------------------------------------------------------------------------

/** Escapes regex metacharacters in `s` so it can be embedded literally inside a RegExp pattern. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True iff `identifier` (a module name or a bare token like a test count) appears in `text` as
 * its own standalone token -- bounded by a character OUTSIDE `[A-Za-z0-9_:-]` (or the string edge)
 * on both sides, never merely as a substring. A review pass reproduced a real false positive with
 * plain `.includes()`: `expected.module=':app'` (bare `app`) matched inside "This application has
 * no applicable tests." Plain `\b` alone is not sufficient either for a hyphen-containing
 * identifier (e.g. a Gradle module like `core-network`): `\b` treats `-` itself as a boundary
 * character, so a bare `\bnetwork\b` would incorrectly match the "network" INSIDE "core-network"
 * too. `:` is ALSO in the identifier class -- a second review pass reproduced a real false
 * positive without it: a bare `app` check matched inside a nested Gradle module path like
 * `:foo:app`, since `:` was (wrongly) treated as a legitimate boundary between `foo` and `app`,
 * even though `:foo:app` is a completely different, unrelated nested module. Treating the full
 * `[A-Za-z0-9_:-]` class as "identifier" for boundary purposes closes all three directions at
 * once. */
function textMentionsIdentifier(text, identifier) {
  const escaped = escapeRegExp(String(identifier));
  const re = new RegExp(`(?<![A-Za-z0-9_:-])${escaped}(?![A-Za-z0-9_:-])`);
  return re.test(text);
}

// Words that describe an OUTCOME of tests that DID run (failed/passed/etc.), never "no tests
// exist here at all" -- a "no/zero ... test(s)" span containing one of these means the OPPOSITE
// of a genuine no-applicable-tests claim.
const NO_TESTS_OUTCOME_ADJECTIVE_RE = /\b(?:failing|failed|failure|passing|passed|broken|skipped)\b/i;

/** True iff `text` states that no applicable tests exist for the module -- narrower than a bare
 * "no...test" span match. A review pass reproduced a real ambiguity: "The :app module has no
 * failing tests" (semantically the OPPOSITE claim -- tests exist and none of them failed) matched
 * the original broad `\bno\b[^.]{0,20}\btest` pattern just as readily as a genuine "no applicable
 * tests" statement, since the pattern never inspected WHAT sat between "no" and "test". Captures
 * that span for each candidate pattern and rejects the match if it contains an outcome word
 * (failing/failed/passing/etc.) -- those describe tests that DID run, never non-existence. */
function statesNoApplicableTests(text) {
  const candidatePatterns = [
    /\bno\b([^.]{0,20})\btest/i,
    /\bzero\b([^.]{0,20})\btest/i,
    /\bnot\s+have\b([^.]{0,15})\btest/i,
  ];
  for (const re of candidatePatterns) {
    const m = text.match(re);
    if (m && !NO_TESTS_OUTCOME_ADJECTIVE_RE.test(m[1])) return true;
  }
  // "applicable" itself is unambiguous (always about non-existence, never an outcome claim) --
  // no adjective guard needed for this specific fallback.
  if (/\bno\s+applicable\b/i.test(text)) return true;
  return false;
}

function evaluateFinalAnswer(resultEvent, scenario) {
  const text = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  if (text.length === 0) return { passed: false, detail: 'no final answer text found' };

  const moduleBare = normalizeModuleName(scenario.expected.module);
  const mentionsModule = textMentionsIdentifier(text, scenario.expected.module) || textMentionsIdentifier(text, moduleBare);
  if (!mentionsModule) {
    return { passed: false, detail: `final answer never mentions the expected module (${scenario.expected.module})` };
  }

  if (scenario.expected.outcome_kind === 'tests_executed') {
    // The individual (per-testcase) count is what a human/agent would actually say ("24 tests
    // passed") -- the kmp-test envelope's task-level `tests.total` is always 1 here (one module
    // resolves to one task) and would never appear in a natural final answer.
    const totalToken = String(scenario.expected.kmp_test?.tests?.individual_total ?? scenario.expected.gradle?.tests?.total);
    const mentionsCount = textMentionsIdentifier(text, totalToken);
    // A bare "fail"/"failed"/"failure" NOT itself negated by an adjacent "0"/"no" is treated as
    // asserting the opposite conclusion -- narrow, evidence-relative (checked against THIS
    // scenario's own expected zero-failures fact), never a blanket "/fail/i anywhere" scan.
    const assertsFailure = /\bfail(s|ed|ure)?\b/i.test(text) && !/\b(0|zero|no)\b[^.]{0,20}\bfail/i.test(text);
    if (assertsFailure) return { passed: false, detail: 'final answer asserts a failure despite the evidence showing a clean pass' };
    if (!mentionsCount) return { passed: false, detail: `final answer never mentions the observed test count (${totalToken})` };
    return { passed: true, detail: 'final answer states the expected module and test count, with no contradicting claim' };
  }

  if (!statesNoApplicableTests(text)) {
    return { passed: false, detail: 'final answer never states that no applicable tests exist for the module' };
  }
  const fabricatesPassCount = /\d+\s*(\/|\s+of\s+)\s*\d+\s+test/i.test(text) || /\d+\s+tests?\s+pass/i.test(text);
  if (fabricatesPassCount) {
    return { passed: false, detail: 'final answer fabricates a pass count for a module with no applicable tests' };
  }
  return { passed: true, detail: 'final answer states the expected module has no applicable tests, with no fabricated count' };
}

// ---------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------

/**
 * Grades one condition's transcript against a scenario's structured expectations. Pure: takes
 * already-collected data (the same per-condition result shape matrix-runner.mjs's
 * runSingleCondition produces, plus `gradleJunitEvidence` attached by runScenarioMatrix) and a
 * validated scenario object; never touches the filesystem, spawns anything, or calls an LLM.
 * @param {object} conditionResult - {events, bashResults, result, spawnResult, gradleJunitEvidence, ...}
 * @param {object} scenario - a validated scenario object (schemas.mjs's validateScenario shape)
 * @returns {{expectedOutcomeMatched: boolean, success: boolean, checks: Array<{name, passed,
 *   detail, evidence_event_indices: number[]}>, firstUsefulSignalEventIndex: number|null,
 *   testInvocationsTotal: number, retries: number, harnessEvidenceAmbiguous: boolean}}
 */
export function gradeScenarioCondition(conditionResult, scenario) {
  const checks = [];
  const addCheck = (name, passed, detail, evidenceEventIndices = []) => {
    checks.push({ name, passed, detail, evidence_event_indices: evidenceEventIndices.filter((i) => i != null) });
  };

  const terminated = conditionResult.spawnResult?.terminated === true;
  const terminationReason = conditionResult.spawnResult?.terminationReason ?? null;
  const events = conditionResult.events ?? [];
  const bashResults = conditionResult.bashResults ?? [];

  // Check 1 -- blocking precondition.
  const structuralIssues = findTranscriptStructuralIssuesToleratingTimeout(events, { terminated, terminationReason });
  addCheck('no_transcript_structural_issues', structuralIssues.length === 0,
    structuralIssues.length === 0 ? 'no structural issues' : `${structuralIssues.length} issue(s): ${structuralIssues.map((i) => i.type).join(', ')}`);

  // Check 2 -- any policy-allowed command attempted at all (broader than check 4's evidence scope).
  const policyAllowedResults = bashResults.filter((b) => {
    const c = classifyBashCommand(b.command);
    if (c.kind === 'kmp-test') return (scenario.policy?.allowed_kmptest_subcommands ?? []).includes(c.subcommand);
    if (c.kind === 'gradle') return c.taskTokens.some((t) => (scenario.policy?.allowed_gradle_tasks ?? []).includes(t));
    return false;
  });
  addCheck('bash_tool_use_present', policyAllowedResults.length > 0,
    policyAllowedResults.length > 0 ? `${policyAllowedResults.length} policy-allowed command(s) attempted` : 'no policy-allowed command was ever attempted',
    policyAllowedResults.map((b) => b.index));

  // Check 3.
  const incomplete = findIncompleteToolResultsToleratingTimeout(events, { terminated, terminationReason });
  addCheck('tool_result_correlated', incomplete.length === 0,
    incomplete.length === 0 ? 'every relevant tool_use has a correlated tool_result' : `${incomplete.length} orphaned tool_use(s)`,
    incomplete.map((i) => i.index));

  // JUnit XML is captured ONCE per condition (after the whole cell finishes -- see
  // matrix-runner.mjs's captureGradleJunitEvidence), never per individual Gradle attempt. If more
  // than one Gradle attempt in this condition could have produced/overwritten evidence_task's
  // JUnit output, that one snapshot cannot be reliably attributed to any SPECIFIC attempt --
  // counted here (once, from the full bashResults list) and threaded into every
  // evaluateGradleAttempt call so the ambiguity fails closed rather than silently attributing the
  // snapshot to whichever attempt happens to be evaluated.
  const gradleAttemptCandidateCount = bashResults.filter((b) => {
    const c = classifyBashCommand(b.command);
    return c.kind === 'gradle' && c.taskTokens.some((t) => (scenario.expected?.gradle?.allowed_invocations ?? []).includes(t));
  }).length;
  const ambiguousJunitEvidence = gradleAttemptCandidateCount > 1;

  // Evaluate every attempt capable of producing target evidence, from either provider, in
  // transcript order -- "terminal" is the LAST one overall (decision 5's last-relevant-attempt
  // rule applied uniformly, including to whether it individually succeeded or was malformed; a
  // retry that fixes an earlier malformed/wrong attempt is exactly what this is for).
  const kmpTestAttempts = bashResults.map((b) => evaluateKmpTestAttempt(b, scenario)).filter(Boolean);
  const gradleAttempts = bashResults.map((b) => evaluateGradleAttempt(b, scenario, conditionResult.gradleJunitEvidence, ambiguousJunitEvidence)).filter(Boolean);
  const allAttempts = [...kmpTestAttempts, ...gradleAttempts].sort((a, b) => a.bashIndex - b.bashIndex);
  const terminal = allAttempts.length > 0 ? allAttempts[allAttempts.length - 1] : null;

  // Check 4.
  const evidenceWellFormed = terminal != null && terminal.hasEvidence && !terminal.malformed;
  addCheck('authoritative_evidence_well_formed', evidenceWellFormed,
    terminal == null ? 'no attempt capable of producing target evidence was ever made'
      : terminal.malformed ? 'the terminal attempt produced content that did not parse as valid evidence'
        : !terminal.hasEvidence ? 'the terminal attempt produced no result at all'
          : 'the terminal attempt produced well-formed evidence',
    terminal ? [terminal.resultIndex] : []);

  // Check 5 -- required conjunct of expectedOutcomeMatched, not merely reported alongside it
  // (decision 13's corrected formula -- a wrong-module attempt with coincidentally-matching
  // counts must not read as a match).
  addCheck('authoritative_target_matches_expected', evidenceWellFormed && terminal.targetMatches,
    !evidenceWellFormed ? 'no well-formed terminal evidence to check' : terminal.targetMatches ? 'terminal attempt targeted the expected module' : 'terminal attempt targeted the WRONG module',
    terminal ? [terminal.resultIndex] : []);

  // Check 6 -- also a required conjunct.
  const outcomeMatches = evidenceWellFormed && terminal.targetMatches && terminal.outcomeMatches;
  addCheck('authoritative_outcome_matches_expected', outcomeMatches,
    !evidenceWellFormed || !terminal.targetMatches ? 'no well-formed, correctly-targeted terminal evidence to check' : outcomeMatches ? 'terminal attempt outcome matches expected' : 'terminal attempt outcome does NOT match expected',
    terminal ? [terminal.resultIndex] : []);

  // Check 7 -- diagnostic only (decision 13): never gates expectedOutcomeMatched/success. Only
  // meaningful when BOTH providers were actually used; compares each provider's OWN last
  // evidenced attempt against its OWN expected contract independently.
  const kmpLast = [...kmpTestAttempts].reverse().find((a) => a.hasEvidence) ?? null;
  const gradleLast = [...gradleAttempts].reverse().find((a) => a.hasEvidence) ?? null;
  let noContradiction = true;
  let contradictionDetail = 'only one provider (or neither) produced evidence -- trivially no contradiction';
  if (kmpLast != null && gradleLast != null) {
    const kmpOk = kmpLast.targetMatches && kmpLast.outcomeMatches;
    const gradleOk = gradleLast.targetMatches && gradleLast.outcomeMatches;
    noContradiction = kmpOk === gradleOk;
    contradictionDetail = noContradiction ? 'both providers agree on the outcome' : 'the two providers DISAGREE on the outcome';
  }
  addCheck('no_provider_contradiction', noContradiction, contradictionDetail,
    [kmpLast?.resultIndex, gradleLast?.resultIndex]);

  // expectedOutcomeMatched = check4 && check5 && check6 (decision 13's corrected formula).
  const expectedOutcomeMatched = checks[3].passed && checks[4].passed && checks[5].passed;

  // Check 8 (decision 8) -- positive, specific, secondary; feeds `success` together with
  // expectedOutcomeMatched, never expectedOutcomeMatched itself.
  const finalAnswer = evaluateFinalAnswer(conditionResult.result, scenario);
  addCheck('final_answer_consistent_with_evidence', finalAnswer.passed, finalAnswer.detail);

  const success = expectedOutcomeMatched && finalAnswer.passed;

  // first_useful_signal: the EARLIEST attempt (by resultIndex, across either provider) whose own
  // result already matched its own expected contract -- never tied to which attempt ended up
  // "terminal", and never a textual match (decision 13).
  const firstCorrect = allAttempts
    .filter((a) => a.hasEvidence && a.targetMatches && a.outcomeMatches && a.resultIndex != null)
    .sort((a, b) => a.resultIndex - b.resultIndex)[0] ?? null;

  // decision 12: test_invocations_total/retries, computed from the SAME attempt list grading
  // itself already built -- never a second, independently-derived count that could silently
  // drift from what grading actually saw. testInvocationsTotal counts every attempt capable of
  // producing target evidence (kmp-test `parallel` or a policy-allowed Gradle task invocation),
  // across both providers; retries is that count minus one, floored at zero.
  const testInvocationsTotal = allAttempts.length;
  const retries = Math.max(0, testInvocationsTotal - 1);

  return {
    expectedOutcomeMatched,
    success,
    checks,
    firstUsefulSignalEventIndex: firstCorrect ? firstCorrect.resultIndex : null,
    testInvocationsTotal,
    retries,
    // A review pass established that ambiguous JUnit evidence (decision: more than one Gradle
    // attempt in this condition could have produced/overwritten it -- see ambiguousJunitEvidence
    // above) is a HARNESS-INTEGRITY defect, not a legitimate agent outcome: degrading only
    // outcomeMatches to false let it read as "the agent got it wrong," a valid negative result,
    // when it actually means "the harness cannot produce trustworthy evidence for this cell at
    // all." Exposed here so the caller (cmdRun) can surface it onto the run record for
    // scenarioCellIntegrityOk to block the WHOLE matrix's promotion, matching decision 4's
    // existing "one bad cell blocks the whole matrix" treatment of every other integrity defect.
    harnessEvidenceAmbiguous: ambiguousJunitEvidence,
  };
}

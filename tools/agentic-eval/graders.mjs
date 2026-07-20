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
// what (if anything) actually ran. Three later review rounds (documented inline below, at each
// affected function) fixed a long tail of regex/keyword-adjacent edge cases in the areas that
// still parsed free text -- and kept finding MORE of the same class in sharper form, which was the
// signal that patching individual phrasings could never fully close it. This version removes free
// prose from the grading path entirely: the agent's final answer must carry one strict,
// machine-parseable `KMP_EVAL_RESULT` block (see `extractKmpEvalResultBlock`), validated against
// an exact schema; natural prose remains in the record for human review only, never inspected for
// grading. Every other check still correlates a tokenized Bash `tool_use`, its own `tool_result`,
// and an authoritative kmp-test JSON envelope OR independently-read Gradle/JUnit evidence against
// the scenario's exact expected module/task/outcome identifiers.
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
 * moduleFilter, isPlanOnly}` | `{kind:'gradle', taskTokens, isPlanOnly}` | `{kind:'other'}` --
 * `'other'` covers both a genuinely unrelated command AND one the tokenizer itself rejects
 * (unbalanced quotes -- tokenize() returns null per its own contract), since either way it can't
 * be correlated against kmp-test/gradle evidence. `moduleFilter` is the exact value the agent
 * passed to `--module-filter`/`--module-filter=`, if any -- needed because a `no_test_modules`
 * envelope has an EMPTY `modules[]` array (there was nothing to resolve), so the only place the
 * agent's intended target module is directly observable for that outcome is the command itself,
 * not the envelope.
 *
 * `isPlanOnly` detects any literal token that makes the invocation report only PLANNED work
 * without ever actually executing anything: `--dry-run` on either command shape, plus kmp-test's
 * `--list`/`--list-only` (documented in `lib/cli.js` as exiting before any Gradle dispatch at
 * all -- semantically identical to `--dry-run` for this purpose, just a different real flag). A
 * round-6 fresh architecture review reproduced this as a real gap: the file's own `--dry-run`
 * exclusion (added earlier in round 5) left `--list-only` completely unrecognized, so a
 * `--list-only` follow-up call after a genuinely correct execution could still become "terminal"
 * and flip a correct result to a reported failure -- exactly the bug class `--dry-run` exclusion
 * was already built to prevent, just via a different real flag this file hadn't been told about.
 * (No Gradle-side analogue exists for `--list`/`--list-only` -- Gradle's own allowed-flag set has
 * no other plan-only flag beyond `--dry-run`, which is already covered.) Every caller that treats
 * a command as evidence checks this flag and excludes plan-only attempts entirely -- see
 * evaluateKmpTestAttempt/evaluateGradleAttempt/classifyJunitProvenance. */
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
    const isPlanOnly = tokens.includes('--dry-run') || tokens.includes('--list') || tokens.includes('--list-only');
    return { kind: 'kmp-test', subcommand: tokens[1] ?? null, moduleFilter, isPlanOnly };
  }
  if (tokens[0] === './gradlew' || tokens[0] === './gradlew.bat') {
    const taskTokens = tokens.slice(1).filter((t) => !t.startsWith('-'));
    const isPlanOnly = tokens.includes('--dry-run');
    return { kind: 'gradle', taskTokens, isPlanOnly };
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

/** Escapes regex metacharacters in `s` so it can be embedded literally inside a RegExp pattern. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
// (kmp-test's `parallel` subcommand, EXECUTED not planned; a Gradle invocation naming a
// policy-allowed task, EXECUTED not planned). `doctor`/`describe` (kmp-test) are recognized and
// simply never evaluated here -- auxiliary, never a candidate for target evidence, so a normal
// doctor-then-parallel session (or a legitimate parallel retry) never trips a false "multiple
// envelopes" problem the way the deleted PR #372 draft's design would have. A `--dry-run`
// invocation of either provider is excluded the same way, for the same underlying reason: it
// reports only what WOULD happen, never what DID.
// ---------------------------------------------------------------------------------------------

/**
 * Validates one parsed kmp-test envelope as authoritative evidence for a Bash attempt already
 * classified as `kmp-test parallel` -- both semantic correctness (matches the scenario's expected
 * outcome) AND internal coherence (the envelope's own fields don't contradict each other or the
 * command that was actually run). A systematic adversarial pass reproduced five independent ways
 * a purely field-by-field-equals-expected check let an internally incoherent envelope through:
 *
 * 1. `envelope.subcommand` was never checked against the command that was actually classified as
 *    `parallel` -- an envelope whose own `subcommand` field said `"doctor"` (stale/wrong content)
 *    still passed as if it were real `parallel` evidence, as long as its OTHER fields happened to
 *    match. Required here to equal `invokedSubcommand` exactly.
 * 2. `resultIsError:true` (the Bash call itself was flagged as failed) alongside a CLEAN
 *    `exit_code:0` claim -- checked in only this one direction (see the inline comment below for
 *    why the reverse direction is deliberately not asserted).
 * 3. `tests_executed`: a clean-pass claim carrying a non-empty `errors[]` (a genuine `tests_executed`
 *    envelope has none).
 * 4. `no_applicable_tests`: EITHER a stale `individual_total` alongside otherwise-all-zero task
 *    counts, OR a second, unrelated error entry alongside the matching `no_test_modules`-shaped
 *    one (both are internally self-contradictory: "cleanly determined no tests apply" must not
 *    simultaneously claim per-test-case executions occurred, or carry evidence of a DIFFERENT
 *    failure).
 * 5. `skipped` was never validated at all, on EITHER outcome_kind branch -- a round-5 review
 *    reproduced a clean-looking `tests_executed` envelope (correct total/passed/failed/
 *    individual_total) that ALSO carried a stray non-zero `skipped` count still passing as a
 *    genuine clean-pass claim. `skipped` is now compared exactly, same as every other counter.
 *    (Scoped to the kmp-test path only. A round-6 fresh architecture review sharpened WHY the
 *    Gradle/JUnit-XML evidence path (`matrix-runner.mjs`'s `captureGradleJunitEvidence`) has no
 *    equivalent check: it isn't merely that a skipped count is unavailable there -- verified
 *    against the real `lib/parsers/junit-xml.js`, a genuinely `<skipped/>` JUnit testcase counts
 *    toward that path's own `total` but NOT toward its `failures`, so its `passed = total -
 *    failures.length` computation silently MISATTRIBUTES a real skip to `passed`. Both shipped
 *    scenarios have zero real skips (independently re-verified 3x during ground-truth capture),
 *    so this is currently dormant, not an active false credit -- but it is a real latent gap, not
 *    just an absent one, and is disclosed precisely as such in the PR body rather than fixed here;
 *    correcting `captureGradleJunitEvidence` itself would mean extending the shared
 *    `lib/parsers/junit-xml.js` utility with a dedicated skipped-count accessor, out of scope for
 *    a grading-correctness pass scoped to `tools/agentic-eval/`.)
 * @returns {boolean}
 */
function validateKmpEnvelopeForAttempt(envelope, invokedSubcommand, resultIsError, scenario) {
  if (envelope.subcommand !== invokedSubcommand) return false;
  // resultIsError:true contradicting a CLEAN exit_code:0 claim is wrong under any plausible
  // convention, but the REVERSE (resultIsError:false alongside a non-zero exit_code) is NOT
  // flagged: kmp-test's own exit codes encode multiple LEGITIMATE non-zero states (exit_code:2/
  // CONFIG_ERROR for no_test_modules is the CORRECT outcome for the no_applicable_tests scenario,
  // not a failure), and the real Claude-Code-native is_error convention for a non-zero CLI exit
  // code remains unconfirmed (decision 10) -- asserting that direction risks a wrong assumption
  // breaking the legitimate case once this harness runs live.
  if (resultIsError === true && envelope.exit_code === 0) return false;

  const kt = scenario.expected.kmp_test;
  if (scenario.expected.outcome_kind === 'tests_executed') {
    // `tests.total/passed/failed` alone is a TASK-level count (a module resolves to exactly one
    // Gradle task here, so this is always {1,1,0} on success) -- checking only that would not
    // catch a "task nominally succeeded but silently ran zero real tests" false-positive (the same
    // class of bug this project's own main CLI documents as "cache-only-greens"). `individual_total`
    // is the real per-test-case count from kmp-test's own JUnit-XML walk -- comparing it too is
    // what actually proves real tests ran and passed. `errors.length === 0`: a "tests executed
    // cleanly" claim must never ALSO carry a no_test_modules-shaped (or any other) error entry.
    return envelope.errors.length === 0
      && envelope.exit_code === (kt.exit_code ?? 0)
      && envelope.tests?.total === kt.tests.total
      && envelope.tests?.passed === kt.tests.passed
      && envelope.tests?.failed === kt.tests.failed
      && envelope.tests?.skipped === kt.tests.skipped
      && envelope.tests?.individual_total === kt.tests.individual_total;
  }
  // `errors.length === 1` (exactly the matching entry, nothing else): a second, unrelated error
  // entry contradicts "cleanly determined that no tests apply". `individual_total === 0`/
  // `skipped === 0` are the converse of the tests_executed branch's own checks: a no_test_modules
  // claim alongside a stale non-zero counter is just as internally inconsistent as the reverse.
  const matchingErrors = envelope.errors.filter((e) => e && e.code === kt.error_code);
  return envelope.errors.length === 1 && matchingErrors.length === 1
    && envelope.exit_code === kt.exit_code
    && matchingErrors[0].caused_by_filter === kt.caused_by_filter
    && envelope.tests?.total === 0 && envelope.tests?.passed === 0 && envelope.tests?.failed === 0
    && envelope.tests?.skipped === 0 && envelope.tests?.individual_total === 0;
}

/**
 * Decides whether a parsed kmp-test envelope can be safely attributed to the scenario's expected
 * module -- command/envelope coherence AND no unproven multi-module attribution. A round-5 fresh
 * adversarial review reproduced two distinct gaps in the prior (round-4) design, which searched
 * `envelope.modules[]` for ANY entry matching the target:
 *
 * 1. The command's OWN invoked `--module-filter` was never cross-checked against what the
 *    envelope itself claims. A command explicitly filtered to `--module-filter app` whose
 *    envelope nonetheless reported `modules:[{name:"shared"}]` passed as valid `:shared` evidence
 *    -- even though the command and its own envelope flatly contradict each other (you asked for
 *    app, you got shared back), which is incoherent regardless of whether the reported module
 *    happens to match the scenario's real target. This mirrors `validateKmpEnvelopeForAttempt`'s
 *    existing `envelope.subcommand !== invokedSubcommand` check, generalized to module identity.
 * 2. Searching a MULTI-entry `modules[]` array for a match let a target module's presence
 *    anywhere in the array stand in for proof that the AGGREGATE `tests.total/passed/failed`
 *    counters (compared separately, in `validateKmpEnvelopeForAttempt`) belong to that module
 *    specifically -- they do not; a `parallel` envelope's top-level `tests` object is a
 *    project-wide aggregate, not a per-module breakdown, so a multi-module response can never
 *    safely attribute those numbers to any ONE of its listed modules. `tests_executed` now
 *    requires `envelope.modules.length === 1` -- the envelope's own module list must resolve to
 *    EXACTLY the target and nothing else -- before its aggregate counters are trusted at all.
 *
 * `no_applicable_tests` has no envelope-side module data to corroborate at all -- `modules[]` is
 * SUPPOSED to be empty by definition (nothing resolved), but nothing previously verified that. A
 * round-6 fresh architecture review reproduced this as a real, if lower-severity, asymmetry with
 * the `tests_executed` branch's own strict check: an envelope whose `modules[]` was NOT empty
 * (self-contradictory alongside a `no_test_modules` error) still passed as valid evidence as long
 * as the command's own filter happened to match. `envelope.modules.length === 0` is now required
 * here too. The target module itself is still identified SOLELY by the command's own explicit
 * `--module-filter` (there is no non-empty envelope-side module claim to corroborate it against);
 * a whole-project run (no filter) can never prove a `no_test_modules` result was specifically
 * about the target module in a multi-module project, so it is not accepted as target-matching
 * evidence for this outcome_kind either.
 * @returns {boolean}
 */
function computeKmpTestTargetMatch(envelope, classification, scenario) {
  const targetModule = normalizeModuleName(scenario.expected.module);
  if (scenario.expected.outcome_kind === 'tests_executed') {
    if (envelope.modules.length !== 1) return false;
    const envelopeModule = normalizeModuleName(envelope.modules[0]?.name);
    if (envelopeModule !== targetModule) return false;
    if (classification.moduleFilter != null && normalizeModuleName(classification.moduleFilter) !== envelopeModule) return false;
    return true;
  }
  if (envelope.modules.length !== 0) return false;
  return classification.moduleFilter != null && normalizeModuleName(classification.moduleFilter) === targetModule;
}

/** @returns {null | {provider:'kmp_test', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, intendedTargetMatches:boolean,
 *   outcomeMatches:boolean}} */
function evaluateKmpTestAttempt(bashResult, scenario) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'kmp-test' || classification.subcommand !== 'parallel') return null;
  // A round-5 fresh adversarial review reproduced three real bugs from treating a --dry-run
  // invocation identically to a real execution: (a) it inflated testInvocationsTotal/retries when
  // followed by a real run; (b) a real, correct run followed by a LATER --dry-run call became
  // "terminal" purely by running last, flipping a genuinely correct result to a reported failure;
  // (c) it could be counted as a JUnit producer (classifyJunitProvenance) and trigger a false
  // ambiguity, even though a dry-run never actually touches the Gradle task or its JUnit XML.
  // Excluded here, at the earliest point -- identical treatment to doctor/describe above -- so it
  // never becomes a candidate attempt for evidence, terminal selection, retries, first_useful_
  // signal, or JUnit provenance anywhere downstream.
  if (classification.isPlanOnly) return null;

  const envelope = extractKmpTestEnvelope(bashResult.resultContent);
  const malformed = bashResult.resultContent != null && envelope == null;
  const hasEvidence = envelope != null;

  const targetMatches = hasEvidence && computeKmpTestTargetMatch(envelope, classification, scenario);

  const outcomeMatches = hasEvidence && targetMatches
    && validateKmpEnvelopeForAttempt(envelope, classification.subcommand, bashResult.resultIsError, scenario);

  // Whether this attempt was even ATTEMPTING to check the expected module, independent of
  // whether its response was well-formed -- derived from the INVOKED --module-filter (absent
  // means "every module, including the target"), never from the response content. Distinct from
  // `targetMatches` (which requires real, coherent, uniquely-attributable evidence) so that
  // `terminal` selection (below, in gradeScenarioCondition) can tell "a later attempt that never
  // even tried to check the target module" apart from "a later attempt that DID try, but its
  // response was malformed or incoherent" -- only the former should be excluded from contention
  // for "terminal."
  const targetModule = normalizeModuleName(scenario.expected.module);
  const intendedTargetMatches = classification.moduleFilter == null || normalizeModuleName(classification.moduleFilter) === targetModule;

  return { provider: 'kmp_test', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence, malformed, targetMatches, intendedTargetMatches, outcomeMatches };
}

/** Parses the terminal Gradle build-outcome from possibly-noisy tool_result content: EXACTLY ONE
 * complete Gradle footer LINE matching `BUILD SUCCESSFUL`/`BUILD FAILED`, anchored at BOTH the
 * start AND the end of the line, with a real, bounded duration grammar (not free text) after
 * "in " -- Gradle's own footer is always either the bare phrase or the phrase plus a genuine
 * duration (`8s`, `1m 30s`, `500ms`), and nothing else legitimately shares its line.
 *
 * Two independent fixes from a round-5 fresh adversarial review, both empirically reproduced as
 * real bugs against the prior (round-3) version:
 * 1. The prior version accepted ANY trailing text after " in " (`(?: in [^\r\n]+)?`) -- a
 *    diagnostic sentence shaped exactly like a footer, "BUILD SUCCESSFUL in this diagnostic
 *    only", passed as genuine evidence. The duration group is now a real, bounded grammar (each
 *    of hours/minutes/seconds-or-milliseconds independently optional, but at least one unit
 *    required, so an elided trailing unit -- Gradle's own real "1m" with no seconds shown -- still
 *    matches, per a round-6 fresh architecture review that reproduced the ORIGINAL all-mandatory-
 *    trailing-unit grammar rejecting that genuine, already-fixture-evidenced duration shape
 *    elsewhere in this repo's own test suite) -- text that isn't a real duration no longer
 *    completes a footer-shaped match at all.
 * 2. The prior version took the chronologically LAST matching footer line when more than one was
 *    present in a single tool_result's content (deliberately, to let a genuine retry-within-one-
 *    command sequence resolve to its real final outcome). A round-5 review reproduced this as
 *    its own risk: since every OTHER evidence type in this file already treats one tool_result as
 *    representing exactly one attempt (the whole `bashIndex`/`resultIndex` attribution model),
 *    silently resolving multiple footer lines within that ONE attempt via "last wins" contradicts
 *    that same premise -- it cannot be proven which invocation actually produced the SUBSEQUENT
 *    JUnit XML/exit state the rest of this file's evidence depends on. Now requires EXACTLY one
 *    footer line; zero or more than one both fail closed as untrustworthy content, the same as a
 *    kmp-test envelope that doesn't parse at all. (An agent that wants credit for a genuine retry
 *    must issue it as a SEPARATE Bash tool_use, which this file already handles correctly via the
 *    existing last-relevant-ATTEMPT rule across attempts, not within one.)
 *
 * Tolerates an optional trailing `\r` (CRLF content) and optional trailing whitespace.
 * Cross-checked against the tool_result's own `resultIsError`, same as before: a contradiction
 * between the text's own footer and `resultIsError` means the content cannot be trusted -- returns
 * `null` in that case (never silently prefers one signal over the other), same as when no genuine
 * footer line is found, or more than one is. Returns 0 (success), 1 (failed), or null
 * (untrustworthy). */
function parseExactGradleFooter(resultContent, resultIsError) {
  // Each unit (hours/minutes/seconds-or-ms) is independently optional, but Gradle always prints
  // at least one -- ordered longest-alternative-first so a compound duration is matched in full
  // rather than the engine settling for a shorter prefix (backtracking would still find the full
  // match either way, but this ordering makes the intent explicit). Seconds-or-ms is REQUIRED
  // whenever hours/minutes is absent (a bare duration always has SOME unit), but becomes optional
  // once hours or minutes is already present -- Gradle elides a trailing zero-valued unit (e.g.
  // "1m", never "1m 0s").
  const SECONDS_OR_MS_RE = '\\d+(?:\\.\\d+)?(?:ms|s)';
  const MINUTES_RE = `\\d+m(?:\\s*${SECONDS_OR_MS_RE})?`;
  const HOURS_RE = `\\d+h(?:\\s*(?:${MINUTES_RE}|${SECONDS_OR_MS_RE}))?`;
  const DURATION_RE = `(?:${HOURS_RE}|${MINUTES_RE}|${SECONDS_OR_MS_RE})`;
  const FOOTER_LINE_RE = new RegExp(`^[ \\t]*BUILD (SUCCESSFUL|FAILED)(?: in ${DURATION_RE})?[ \\t]*\\r?$`, 'gm');
  const matches = [...resultContent.matchAll(FOOTER_LINE_RE)];
  if (matches.length !== 1) return null;
  const wasSuccess = matches[0][1] === 'SUCCESSFUL';
  // resultIsError is only ever a MEANINGFUL contradiction signal when it's an explicit true/false
  // observation -- null (never determined) neither confirms nor contradicts either footer.
  if (resultIsError === true && wasSuccess) return null;
  if (resultIsError === false && !wasSuccess) return null;
  return wasSuccess ? 0 : 1;
}

/** @returns {null | {provider:'gradle', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, intendedTargetMatches:boolean,
 *   outcomeMatches:boolean}} */
function evaluateGradleAttempt(bashResult, scenario, gradleJunitEvidence, ambiguousJunitEvidence) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'gradle') return null;
  // Same planning-vs-execution exclusion as the kmp-test path above -- a Gradle `--dry-run`
  // invocation reports only what tasks WOULD run, never their real outcome or any real JUnit XML.
  if (classification.isPlanOnly) return null;
  const g = scenario.expected.gradle;
  const invokedAllowed = classification.taskTokens.some((t) => g.allowed_invocations.includes(t));
  if (!invokedAllowed) return null;

  const hasEvidence = typeof bashResult.resultContent === 'string' && bashResult.resultContent.length > 0;
  if (!hasEvidence) {
    return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: false, malformed: false, targetMatches: true, intendedTargetMatches: true, outcomeMatches: false };
  }
  // Membership in allowed_invocations (already proven above) IS the target-match for the Gradle
  // path -- the agent invoked one of the scenario-declared acceptable commands for this module.
  // It is therefore ALSO always the "intended" target (see evaluateKmpTestAttempt's own field for
  // why the distinction exists) -- a Gradle command naming a task outside allowed_invocations
  // never becomes a candidate attempt at all (the early `return null` above), so unlike the
  // kmp-test path there is no "invoked but for the wrong module" shape to represent here.
  const targetMatches = true;
  const intendedTargetMatches = true;

  // The marker/exit-code evidence is always parsed from `evidence_task`'s OWN status line --
  // regardless of which allowed_invocations entry the agent actually typed (decision 3/14): the
  // real Gradle behavior confirmed during implementation is that invoking the lifecycle alias
  // (`:app:test`) still prints the underlying leaf task's own status line (`Task
  // :app:testDebugUnitTest NO-SOURCE`) as part of its dependency chain, so this is never blind to
  // which invocation was actually used.
  const modes = classifyTaskExecutionMode(bashResult.resultContent, '', [g.evidence_task]);
  const mode = modes.get(g.evidence_task) ?? 'no_evidence';
  const observedExitCode = parseExactGradleFooter(bashResult.resultContent, bashResult.resultIsError);
  // A footer/resultIsError contradiction (or no recognizable footer at all, or MORE than one)
  // means the build outcome itself cannot be trusted -- the Gradle-provider equivalent of the
  // kmp-test provider's own "content exists but doesn't parse as valid evidence" malformed shape.
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

  return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: true, malformed, targetMatches, intendedTargetMatches, outcomeMatches };
}

// ---------------------------------------------------------------------------------------------
// Final-answer check (decision 8) -- structured, not prose. Three review rounds (round-2 through
// round-4) kept finding NEW ways free-form prose parsing let a false claim through, or rejected a
// genuinely correct one: an outcome-adjective denylist that could never enumerate every adjective,
// a predicate-position negation defeated by inserting one adverb, cross-clause/cross-module
// binding broken by conjunctions this file hadn't thought to split on yet ("but", then plausibly
// "and" or others next). A round-4 review concluded (correctly) that splitting prose and hunting
// for relationships via regex can never close every form of coordination, ellipsis, negation, and
// subject change -- there is no fixed regex budget that structurally closes an open-ended natural-
// language surface. This version removes that surface from the grading path entirely: the agent's
// final answer must carry one strict, uniquely parseable, schema-validated `KMP_EVAL_RESULT` block
// (required identically of both the current-skill and no-skill conditions, via the scenario's own
// prompt text). Free prose stays in the record for a human to read later, but never participates
// in grading -- this check now succeeds or fails purely on whether the block exists, is
// unambiguous, parses as valid JSON, and exactly matches the scenario's expected module, outcome
// kind, and (for tests_executed) counts.
// ---------------------------------------------------------------------------------------------

const KMP_EVAL_RESULT_BLOCK_RE = /^[ \t]*KMP_EVAL_RESULT[ \t]*\r?\n([\s\S]*?)^[ \t]*KMP_EVAL_RESULT_END[ \t]*\r?$/gm;

/** Locates every `KMP_EVAL_RESULT ... KMP_EVAL_RESULT_END` block in `text` and attempts to parse
 * the content between the markers as one JSON object. Returns `{found, parsed, ambiguous}`:
 * `found:false` when no block exists at all; `ambiguous:true` when MORE than one block is present
 * (the agent wrote two, e.g. second-guessing itself) -- untrustworthy in the same sense a
 * kmp-test envelope with two conforming candidates is untrustworthy, never resolved by picking
 * one; `parsed:null` (with `found:true`, `ambiguous:false`) when exactly one block exists but its
 * content is not valid JSON. */
function extractKmpEvalResultBlock(text) {
  if (typeof text !== 'string' || text.length === 0) return { found: false, parsed: null, ambiguous: false };
  const rawMatches = [...text.matchAll(KMP_EVAL_RESULT_BLOCK_RE)];
  if (rawMatches.length === 0) return { found: false, parsed: null, ambiguous: false };
  if (rawMatches.length > 1) return { found: true, parsed: null, ambiguous: true };
  return { found: true, parsed: tryParseJsonObject(rawMatches[0][1].trim()), ambiguous: false };
}

const KMP_EVAL_RESULT_TESTS_EXECUTED_KEYS = new Set(['module', 'outcome_kind', 'total', 'passed', 'failed']);
const KMP_EVAL_RESULT_NO_APPLICABLE_KEYS = new Set(['module', 'outcome_kind']);
const KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS = ['total', 'passed', 'failed'];

/** Strictly validates a parsed `KMP_EVAL_RESULT` block against the scenario's own expected
 * module/outcome/counts -- EXACT key set (no missing, no extra -- an agent hedging with additional
 * fields is rejected, not silently ignored), exact module identity (boundary-safe via
 * `normalizeModuleName`, same colon-prefix tolerance as everywhere else in this file), exact
 * `outcome_kind`, and for `tests_executed`, exact integer total/passed/failed matching the real,
 * independently-verified ground truth already carried on `scenario.expected.gradle.tests` (the
 * canonical human-readable `{total,passed,failed}` triple -- the same real-world fact kmp_test's
 * own `individual_total` records as a single number).
 *
 * `no_applicable_tests` is a narrow, explicit exception to "exact key set": the scenario prompt
 * instructs omitting `total`/`passed`/`failed` entirely, but a round-6 fresh architecture review
 * found this needlessly brittle against a plausible LLM hedge -- an agent that includes them
 * anyway with genuinely correct all-zero values is substantively right, just more verbose than
 * asked. Tolerated ONLY as a complete, all-zero triple (never a partial hedge, never any non-zero
 * value, which would be a real internal contradiction: "no applicable tests" alongside a claimed
 * non-zero count). This is a single, bounded, explicitly-reasoned rule -- not the start of a new
 * enumerated-phrasings problem the rest of this file's redesign exists to avoid. */
function kmpEvalResultBlockMatchesScenario(block, scenario) {
  if (block == null || typeof block !== 'object' || Array.isArray(block)) return false;
  const targetModule = normalizeModuleName(scenario.expected.module);
  if (typeof block.module !== 'string' || normalizeModuleName(block.module) !== targetModule) return false;
  if (block.outcome_kind !== scenario.expected.outcome_kind) return false;

  const keys = Object.keys(block);
  if (scenario.expected.outcome_kind === 'tests_executed') {
    if (keys.length !== KMP_EVAL_RESULT_TESTS_EXECUTED_KEYS.size || keys.some((k) => !KMP_EVAL_RESULT_TESTS_EXECUTED_KEYS.has(k))) return false;
    const expectedTests = scenario.expected.gradle.tests;
    return Number.isInteger(block.total) && Number.isInteger(block.passed) && Number.isInteger(block.failed)
      && block.total === expectedTests.total && block.passed === expectedTests.passed && block.failed === expectedTests.failed;
  }
  if (keys.some((k) => !KMP_EVAL_RESULT_NO_APPLICABLE_KEYS.has(k) && !KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS.includes(k))) return false;
  const presentCountKeys = KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS.filter((k) => keys.includes(k));
  if (presentCountKeys.length === 0) return true;
  if (presentCountKeys.length !== KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS.length) return false;
  return block.total === 0 && block.passed === 0 && block.failed === 0;
}

function evaluateFinalAnswer(resultEvent, scenario) {
  const text = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  if (text.length === 0) return { passed: false, detail: 'no final answer text found' };

  const { found, parsed, ambiguous } = extractKmpEvalResultBlock(text);
  if (!found) return { passed: false, detail: 'final answer contains no KMP_EVAL_RESULT block' };
  if (ambiguous) return { passed: false, detail: 'final answer contains more than one KMP_EVAL_RESULT block -- ambiguous, not resolved by picking one' };
  if (parsed == null) return { passed: false, detail: 'the KMP_EVAL_RESULT block did not parse as valid JSON' };
  if (!kmpEvalResultBlockMatchesScenario(parsed, scenario)) {
    return { passed: false, detail: 'the KMP_EVAL_RESULT block does not exactly match the expected module/outcome_kind/counts (or carries unexpected/missing keys)' };
  }
  return { passed: true, detail: 'the KMP_EVAL_RESULT block exactly matches the expected module, outcome_kind, and counts' };
}

/**
 * Determines whether the SINGLE per-condition JUnit XML snapshot (matrix-runner.mjs's
 * `captureGradleJunitEvidence`, captured once after the whole condition finishes, `sinceMs=0`) can
 * be reliably attributed to exactly one attempt. A systematic architecture review traced this as
 * the ROOT CAUSE behind repeated JUnit-ambiguity false positives/negatives across earlier review
 * rounds: two of three evidence types (kmp-test envelope, Gradle footer) bind to their own
 * `tool_result`, but JUnit counts are a single disk snapshot fanned out to every Gradle attempt.
 *
 * Five independent fixes, each empirically reproduced as a real bug against a prior version:
 * 1. Only meaningful when `scenario.expected.outcome_kind === 'tests_executed'` -- a
 *    `no_applicable_tests` scenario NEVER reads JUnit XML at all (the NO-SOURCE marker is parsed
 *    from each attempt's own stdout instead), so ambiguity in a snapshot nothing consumes must
 *    never block promotion.
 * 2. Counts a `kmp-test parallel` call as a potential producer alongside a matching Gradle
 *    invocation -- it runs the exact same underlying Gradle test task and writes to the same
 *    JUnit XML path under the hood, so it is just as much a potential producer as a raw Gradle
 *    invocation.
 * 3. The pooled snapshot is ONLY EVER READ by the Gradle-provider evaluation path
 *    (`evaluateGradleAttempt` reads `conditionResult.gradleJunitEvidence` directly) -- the
 *    kmp-test path never reads it at all, since each envelope carries its own self-contained
 *    `individual_total`. So ambiguity of a snapshot that nothing in THIS condition actually
 *    consumes is moot: if no Gradle attempt targeting `allowed_invocations` exists at all, there
 *    is no real consumer to protect, regardless of how many kmp-test `parallel` calls occurred.
 * 4. Fix 2's kmp-test-producer counting is scoped to the SAME module the scenario targets (a bare
 *    `--module-filter` mismatch, or no filter at all -- which runs every module including the
 *    target -- both handled), mirroring how the Gradle branch is already scoped to
 *    `allowed_invocations` (a specific task) rather than any Gradle invocation whatsoever.
 * 5. Neither producer count considers a plan-only (`--dry-run`, or kmp-test's `--list`/
 *    `--list-only`) invocation of either provider a producer at all -- a round-5 fresh
 *    adversarial review reproduced this as a real false positive: a `kmp-test parallel --dry-run`
 *    call followed by a genuine Gradle execution was flagged ambiguous, even though the dry-run
 *    call never touches the real Gradle task or writes any real JUnit XML, so it cannot possibly
 *    be a competing producer of it.
 * @returns {{ambiguous: boolean, producerCount: number}}
 */
function classifyJunitProvenance(bashResults, scenario) {
  if (scenario.expected?.outcome_kind !== 'tests_executed') {
    return { ambiguous: false, producerCount: 0 };
  }
  const gradleProducerCount = bashResults.filter((b) => {
    const c = classifyBashCommand(b.command);
    return c.kind === 'gradle' && !c.isPlanOnly && c.taskTokens.some((t) => (scenario.expected?.gradle?.allowed_invocations ?? []).includes(t));
  }).length;
  // No Gradle-provider attempt exists at all in this condition -- there is no consumer of the
  // pooled snapshot to protect, so ambiguity among kmp-test-only attempts (which never read it) is
  // moot. Short-circuits before even inspecting kmp-test attempts' module filters.
  if (gradleProducerCount === 0) return { ambiguous: false, producerCount: 0 };
  const targetModule = normalizeModuleName(scenario.expected.module);
  const kmpTestProducerCount = bashResults.filter((b) => {
    const c = classifyBashCommand(b.command);
    if (c.kind !== 'kmp-test' || c.subcommand !== 'parallel' || c.isPlanOnly) return false;
    if (c.moduleFilter == null) return true; // no filter -- ran every module, including the target
    return normalizeModuleName(c.moduleFilter) === targetModule;
  }).length;
  const producerCount = gradleProducerCount + kmpTestProducerCount;
  return { ambiguous: producerCount > 1, producerCount };
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

  // Check 2 -- any policy-allowed command attempted at all (broader than check 4's evidence scope;
  // deliberately does not exclude --dry-run -- a dry-run call is still genuine engagement with the
  // tool, even though it can never itself count as target evidence below).
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

  // See classifyJunitProvenance's own doc comment for the full rationale (scoped to
  // tests_executed only; counts kmp-test parallel attempts as JUnit producers too; excludes
  // --dry-run entirely) -- threaded into every evaluateGradleAttempt call so the ambiguity fails
  // closed rather than silently attributing the snapshot to whichever attempt happens to be
  // evaluated.
  const { ambiguous: ambiguousJunitEvidence } = classifyJunitProvenance(bashResults, scenario);

  // Evaluate every attempt capable of producing target evidence, from either provider, in
  // transcript order -- excludes --dry-run entirely (evaluateKmpTestAttempt/evaluateGradleAttempt
  // return null for it) -- "terminal" is the LAST one overall AMONG THOSE THAT AT LEAST ATTEMPTED
  // the expected module (decision 5's last-relevant-attempt rule, sharpened by round-4 review): a
  // retry that fixes an earlier malformed/wrong-OUTCOME attempt on the SAME module is exactly what
  // "last one wins" is for, and still applies here (both attempts have intendedTargetMatches:true,
  // so the later one -- even if malformed -- still wins). But a LATER attempt that never even
  // tried to target the expected module at all (e.g. the agent double-checking an unrelated module
  // afterward) must not silently become "terminal" just by virtue of running last -- that would
  // fail an otherwise-correct, complete answer solely because of unrelated trailing exploration.
  // Falls back to "last of ALL attempts" only when NONE of them ever targeted the expected module
  // (preserves the single-wrong-module-only failure case).
  const kmpTestAttempts = bashResults.map((b) => evaluateKmpTestAttempt(b, scenario)).filter(Boolean);
  const gradleAttempts = bashResults.map((b) => evaluateGradleAttempt(b, scenario, conditionResult.gradleJunitEvidence, ambiguousJunitEvidence)).filter(Boolean);
  const allAttempts = [...kmpTestAttempts, ...gradleAttempts].sort((a, b) => a.bashIndex - b.bashIndex);
  const onTargetAttempts = allAttempts.filter((a) => a.intendedTargetMatches);
  const terminalPool = onTargetAttempts.length > 0 ? onTargetAttempts : allAttempts;
  const terminal = terminalPool.length > 0 ? terminalPool[terminalPool.length - 1] : null;

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

  // Check 8 (decision 8) -- structured, not prose (see this file's own header + the block above
  // evaluateFinalAnswer for the full rationale); positive, specific, secondary; feeds `success`
  // together with expectedOutcomeMatched, never expectedOutcomeMatched itself.
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
  // drift from what grading actually saw. testInvocationsTotal counts every EXECUTED (never
  // --dry-run) attempt capable of producing target evidence (kmp-test `parallel` or a
  // policy-allowed Gradle task invocation), across both providers; retries is that count minus
  // one, floored at zero.
  const testInvocationsTotal = allAttempts.length;
  const retries = Math.max(0, testInvocationsTotal - 1);

  return {
    expectedOutcomeMatched,
    success,
    checks,
    firstUsefulSignalEventIndex: firstCorrect ? firstCorrect.resultIndex : null,
    testInvocationsTotal,
    retries,
    // A review pass established that ambiguous JUnit evidence (decision: more than one attempt in
    // this condition could have produced/overwritten it -- see classifyJunitProvenance above) is a
    // HARNESS-INTEGRITY defect, not a legitimate agent outcome: degrading only outcomeMatches to
    // false let it read as "the agent got it wrong," a valid negative result, when it actually
    // means "the harness cannot produce trustworthy evidence for this cell at all." Exposed here
    // so the caller (cmdRun) can surface it onto the run record for scenarioCellIntegrityOk to
    // block the WHOLE matrix's promotion, matching decision 4's existing "one bad cell blocks the
    // whole matrix" treatment of every other integrity defect.
    harnessEvidenceAmbiguous: ambiguousJunitEvidence,
  };
}

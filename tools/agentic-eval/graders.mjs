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

/**
 * Validates one parsed kmp-test envelope as authoritative evidence for a Bash attempt already
 * classified as `kmp-test parallel` -- both semantic correctness (matches the scenario's expected
 * outcome) AND internal coherence (the envelope's own fields don't contradict each other or the
 * command that was actually run). A systematic adversarial pass reproduced four independent ways
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
      && envelope.tests?.individual_total === kt.tests.individual_total;
  }
  // `errors.length === 1` (exactly the matching entry, nothing else): a second, unrelated error
  // entry contradicts "cleanly determined that no tests apply". `individual_total === 0` is the
  // converse of the tests_executed branch's own check: a no_test_modules claim alongside a stale
  // non-zero individual_total is just as internally inconsistent as the reverse.
  const matchingErrors = envelope.errors.filter((e) => e && e.code === kt.error_code);
  return envelope.errors.length === 1 && matchingErrors.length === 1
    && envelope.exit_code === kt.exit_code
    && matchingErrors[0].caused_by_filter === kt.caused_by_filter
    && envelope.tests?.total === 0 && envelope.tests?.passed === 0 && envelope.tests?.failed === 0
    && envelope.tests?.individual_total === 0;
}

/** @returns {null | {provider:'kmp_test', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, intendedTargetMatches:boolean,
 *   outcomeMatches:boolean}} */
function evaluateKmpTestAttempt(bashResult, scenario) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'kmp-test' || classification.subcommand !== 'parallel') return null;

  const envelope = extractKmpTestEnvelope(bashResult.resultContent);
  const malformed = bashResult.resultContent != null && envelope == null;
  const hasEvidence = envelope != null;

  const targetModule = normalizeModuleName(scenario.expected.module);
  let targetMatches = false;
  if (hasEvidence) {
    if (envelope.modules.length > 0) {
      // A `parallel` run may legitimately cover more than one module (e.g. no --module-filter --
      // ran every module in the project) -- search the WHOLE list for the scenario's target, not
      // just the first entry. A round-4 fresh invariant review reproduced a real false negative:
      // the target module's genuine data sitting at modules[1+] was rejected as "the WRONG module"
      // purely because modules[0] happened to be a different module first in the array.
      targetMatches = envelope.modules.some((m) => normalizeModuleName(m?.name) === targetModule);
    } else if (classification.moduleFilter != null) {
      targetMatches = normalizeModuleName(classification.moduleFilter) === targetModule;
    }
  }

  const outcomeMatches = hasEvidence && targetMatches
    && validateKmpEnvelopeForAttempt(envelope, classification.subcommand, bashResult.resultIsError, scenario);

  // Whether this attempt was even ATTEMPTING to check the expected module, independent of
  // whether its response was well-formed -- derived from the INVOKED --module-filter (absent
  // means "every module, including the target"), never from the response content. Distinct from
  // `targetMatches` (which requires real, parsed evidence) so that `terminal` selection (below,
  // in gradeScenarioCondition) can tell "a later attempt that never even tried to check the
  // target module" apart from "a later attempt that DID try, but its response was malformed" --
  // only the former should be excluded from contention for "terminal."
  const intendedTargetMatches = classification.moduleFilter == null || normalizeModuleName(classification.moduleFilter) === targetModule;

  return { provider: 'kmp_test', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence, malformed, targetMatches, intendedTargetMatches, outcomeMatches };
}

/** Parses the terminal Gradle build-outcome from possibly-noisy tool_result content: the LAST
 * COMPLETE Gradle footer LINE matching `BUILD SUCCESSFUL`/`BUILD FAILED`, anchored at BOTH the
 * start AND the end of the line (Gradle's own footer is always either the bare phrase or the
 * phrase plus " in <duration>", e.g. "BUILD SUCCESSFUL in 8s", and nothing else legitimately
 * shares its line) -- a systematic adversarial pass reproduced that a start-only anchor accepted
 * "BUILD SUCCESSFUL but this is not a Gradle footer" as a genuine footer, and (worse) let a LATER
 * line merely BEGINNING "BUILD SUCCESSFUL ..." outrank a REAL, earlier `BUILD FAILED in 3s`
 * footer under the "last match wins" rule, flipping an actual failure to a reported success.
 * Tolerates an optional trailing `\r` (CRLF content) and optional trailing whitespace. Taking the
 * LAST matching line (rather than "does either pattern appear ANYWHERE") is what correctly
 * handles an earlier retry's own footer line still sitting earlier in the same accumulated
 * content. Cross-checked against the tool_result's own `resultIsError`, same as before: a
 * contradiction between the text's own last footer and `resultIsError` means the content cannot
 * be trusted -- returns `null` in that case (never silently prefers one signal over the other),
 * same as when no genuine footer line is found at all. Returns 0 (success), 1 (failed), or null
 * (untrustworthy). */
function parseExactGradleFooter(resultContent, resultIsError) {
  const FOOTER_LINE_RE = /^[ \t]*BUILD (SUCCESSFUL|FAILED)(?: in [^\r\n]+)?[ \t]*\r?$/gm;
  let lastMatch = null;
  for (const m of resultContent.matchAll(FOOTER_LINE_RE)) lastMatch = m;
  if (lastMatch == null) return null;
  const lastWasSuccess = lastMatch[1] === 'SUCCESSFUL';
  // resultIsError is only ever a MEANINGFUL contradiction signal when it's an explicit true/false
  // observation -- null (never determined) neither confirms nor contradicts either footer.
  if (resultIsError === true && lastWasSuccess) return null;
  if (resultIsError === false && !lastWasSuccess) return null;
  return lastWasSuccess ? 0 : 1;
}

/** @returns {null | {provider:'gradle', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, intendedTargetMatches:boolean,
 *   outcomeMatches:boolean}} */
function evaluateGradleAttempt(bashResult, scenario, gradleJunitEvidence, ambiguousJunitEvidence) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'gradle') return null;
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

  return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: true, malformed, targetMatches, intendedTargetMatches, outcomeMatches };
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

/** Splits a final-answer text into clause-scoped spans on sentence-ending punctuation, semicolons,
 * and strong contrastive conjunctions (but/however/while/whereas/yet/although/though). Deliberately
 * does NOT split on a BARE comma -- natural prose routinely uses commas WITHIN one semantic clause
 * (e.g. "The :shared module, which is the core library, ran 24 tests"), and over-splitting there
 * would introduce new false negatives. Semicolons and contrastive conjunctions are different: both
 * conventionally join two syntactically-INDEPENDENT clauses, each with its own subject -- exactly
 * the shape a round-4 fresh adversarial pass reproduced as a real false positive when this function
 * only split on `.!?`: "The :app module ran 24 tests, but :shared has no applicable tests." is ONE
 * period-terminated sentence, so (before this fix) the whole thing was ONE clause -- which meant
 * the count-and-"tests" proximity check and the target-module-mention check could each be
 * satisfied by a DIFFERENT half of that one clause (the count near ":app", the module mention near
 * ":shared"), wrongly reading as "the target module ran 24 tests" when the text actually says the
 * OPPOSITE about the target module. Splitting on "but" isolates each half so neither can lend the
 * other's evidence to a subject it was never actually about. */
function splitIntoClauses(text) {
  return text.split(/[.!?;]+|\s+\b(?:but|however|while|whereas|yet|although|though)\b\s*/i).map((c) => c.trim()).filter(Boolean);
}

/** True iff `clause` states that no applicable tests exist -- a POSITIVE, bounded grammar, not a
 * denylist of outcome adjectives (a systematic adversarial pass showed a denylist can never be
 * complete: "successful" wasn't on the original list, and any future adjective would have the
 * same gap). The intervening-word set allowed between the quantifier and "test(s)" is limited to
 * `applicable`/`unit` -- an outcome adjective in PRENOMINAL position ("no failing tests", "no
 * successful tests") therefore never matches this pattern AT ALL, by construction, with no need to
 * enumerate it. The one direction a quantifier-then-noun grammar can't examine is an outcome word
 * appearing AFTER "test(s)" as a predicate ("no tests failing" == tests exist, none are CURRENTLY
 * failing -- the OPPOSITE of "no tests exist"); that direction is still an explicit, bounded
 * denylist, not a broad span scan, since predicate position genuinely has no positive alternative
 * grammar to assert instead. */
const NO_TESTS_QUANTIFIED_RE = /\b(?:no|zero)\s+(?:applicable\s+|unit\s+)?tests?\b/i;
const NOT_HAVE_TESTS_RE = /\b(?:does|do)\s+not\s+have\s+(?:any\s+)?(?:applicable\s+|unit\s+)?tests?\b/i;
const NO_APPLICABLE_RE = /\bno\s+applicable\b/i;
// A bounded word-gap (not immediate adjacency) between "test(s)" and the outcome participle -- a
// round-4 fresh adversarial pass reproduced a real false positive from the original immediate-
// adjacency-only version: "No tests are failing." (a linking verb inserted between "tests" and
// "failing") did not match `\btests?\s+failing\b`, so it wrongly passed as "no applicable tests"
// even though it asserts the opposite (tests exist, none are CURRENTLY failing). The bounded gap
// tolerates a linking verb ("are"/"is"/"were") and a short adverb ("currently") without opening
// this back up to matching an unrelated, distant mention of an outcome word later in the clause.
const OUTCOME_PREDICATE_AFTER_TESTS_RE = /\btests?\b(?:\s+\S+){0,3}\s+(?:failing|failed|passing|passed|running|skipped|succeeding|succeeded)\b/i;

function clauseStatesNoApplicableTests(clause) {
  const positive = NO_TESTS_QUANTIFIED_RE.test(clause) || NOT_HAVE_TESTS_RE.test(clause) || NO_APPLICABLE_RE.test(clause);
  if (!positive) return false;
  return !OUTCOME_PREDICATE_AFTER_TESTS_RE.test(clause);
}

/** True iff `clause` asserts `totalToken` (a test-count integer, as a string) in genuine
 * test-count CONTEXT -- adjacent to a "test(s)" word in either order -- never a bare
 * standalone-token search anywhere in the clause. A systematic adversarial pass reproduced an
 * incidental match: "See line 24 for details" satisfied a bare `textMentionsIdentifier(text,
 * '24')` check with no test-word anywhere nearby (the same failure mode would also accept
 * "v0.24.0" or "24kb"). `.` is included in the token's own boundary class (beyond the usual
 * identifier class) specifically so a decimal-adjacent number like "0.24.0" can never have its
 * "24" segment misread as the standalone count either.
 *
 * Two proximity patterns, not one blanket word-count gap: a TIGHT generic gap (at most 2 words)
 * handles the common direct phrasings ("24 tests passed", "ran 24 tests", "tests: 24"); a WIDER,
 * but STRUCTURALLY anchored gap is tried only when `moduleToken` is supplied, and requires the
 * scenario's OWN module name to be the thing sitting between the count and "test(s)" (e.g. "24 of
 * the :shared module's tests passed"). A round-4 fresh adversarial pass reproduced two opposite
 * bugs from earlier, unanchored designs: a fixed 15-CHARACTER gap rejected that exact genuine
 * answer as a false negative (the module's own name inflates the character distance past the cap,
 * and a character cap has no way to account for module-name length); widening it to a blanket
 * 5-WORD gap fixed that but reopened a false positive this function was already locked against --
 * "...documented on line 24 of the report" sits a similar word-distance from an unrelated "test"
 * mention elsewhere in the same clause. Anchoring the wider gap to the real, expected module name
 * (rather than accepting ANY 5 words) admits the genuine case without reopening the incidental
 * one, since "line 24 of the report" never contains the scenario's own module identifier. */
function clauseAssertsTestCount(clause, totalToken, moduleToken) {
  const escaped = escapeRegExp(totalToken);
  const countTok = `(?<![A-Za-z0-9_:.-])${escaped}(?![A-Za-z0-9_:.-])`;
  const tightGap = '(?:\\s+\\S+){0,2}\\s+';
  const countThenTest = new RegExp(`${countTok}${tightGap}tests?\\b`, 'i');
  const testThenCount = new RegExp(`\\btests?\\b${tightGap}${countTok}`, 'i');
  if (countThenTest.test(clause) || testThenCount.test(clause)) return true;
  if (!moduleToken) return false;
  const escapedModule = escapeRegExp(moduleToken);
  const moduleConnector = `(?:of\\s+(?:the\\s+)?)?${escapedModule}(?:'s|s')?\\s+(?:module(?:'s|s')?\\s+)?`;
  const countThenModuleThenTest = new RegExp(`${countTok}\\s+${moduleConnector}tests?\\b`, 'i');
  const testThenModuleThenCount = new RegExp(`\\btests?\\b\\s+(?:of|for|in)\\s+(?:the\\s+)?${escapedModule}(?:\\s+\\S+){0,2}\\s+${countTok}`, 'i');
  return countThenModuleThenTest.test(clause) || testThenModuleThenCount.test(clause);
}

/** True iff `clause` asserts a test failure -- a bare "fail"/"failed"/"failure"/"failures" NOT
 * itself negated by an adjacent "0"/"no"/"none"/"zero" is treated as asserting the opposite
 * conclusion; narrow, evidence-relative (checked against THIS scenario's own expected
 * zero-failures fact), never a blanket "/fail/i anywhere" scan. "none" is included in the negation
 * set alongside "no" -- a systematic adversarial pass reproduced a false NEGATIVE (a genuinely
 * correct clean-pass answer incorrectly rejected) because `\bno\b` cannot match inside "none" (no
 * word-boundary between "no" and the following "ne"), so "...none failed" was misread as asserting
 * a failure. The suffix alternation is `(s|ed|ures?)?`, not `(s|ed|ure)?` -- a round-4 fresh
 * adversarial pass reproduced a second false NEGATIVE: the plural noun "failures" (e.g. "3
 * failures") never reached a word boundary under the original alternation, since "fail"+"ure"
 * consumed 7 characters and left a trailing "s" that is itself a word character, so `\b` never
 * matched immediately after "failure". */
function clauseAssertsFailure(clause) {
  const mentionsFailWord = /\bfail(s|ed|ures?)?\b/i.test(clause);
  if (!mentionsFailWord) return false;
  return !/\b(?:0|zero|no|none)\b[^.]{0,20}\bfail/i.test(clause);
}

/** True iff `clause` BOTH mentions the scenario's expected module AND states the CORRECT
 * conclusion for `scenario.expected.outcome_kind` -- module and conclusion bound in the SAME
 * clause, never checked independently over the whole answer text. A systematic adversarial pass
 * reproduced real cross-clause/cross-module false positives from independent whole-text checks:
 * "The :app module exists. The :shared module has no applicable tests." wrongly satisfied a check
 * for `:app` (the module-mention half matched the first sentence, the outcome half matched the
 * second, about an entirely different module) -- and the mirror case for `tests_executed`. */
function evaluateOutcomeClauseForModule(clause, scenario, expectedCountToken) {
  const moduleBare = normalizeModuleName(scenario.expected.module);
  if (!textMentionsIdentifier(clause, scenario.expected.module) && !textMentionsIdentifier(clause, moduleBare)) return false;
  if (scenario.expected.outcome_kind === 'tests_executed') {
    return clauseAssertsTestCount(clause, expectedCountToken, scenario.expected.module) && !clauseAssertsFailure(clause);
  }
  return clauseStatesNoApplicableTests(clause);
}

function evaluateFinalAnswer(resultEvent, scenario) {
  const text = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  if (text.length === 0) return { passed: false, detail: 'no final answer text found' };

  const clauses = splitIntoClauses(text);
  const moduleBare = normalizeModuleName(scenario.expected.module);
  const clauseMentionsModule = (c) => textMentionsIdentifier(c, scenario.expected.module) || textMentionsIdentifier(c, moduleBare);
  const anyModuleMention = clauses.some(clauseMentionsModule);

  if (scenario.expected.outcome_kind === 'tests_executed') {
    // The individual (per-testcase) count is what a human/agent would actually say ("24 tests
    // passed") -- the kmp-test envelope's task-level `tests.total` is always 1 here (one module
    // resolves to one task) and would never appear in a natural final answer.
    const totalToken = String(scenario.expected.kmp_test?.tests?.individual_total ?? scenario.expected.gradle?.tests?.total);
    if (clauses.some((c) => evaluateOutcomeClauseForModule(c, scenario, totalToken))) {
      return { passed: true, detail: 'a single clause states the expected module and test count, with no contradicting claim' };
    }
    if (!anyModuleMention) return { passed: false, detail: `final answer never mentions the expected module (${scenario.expected.module})` };
    if (clauses.some((c) => clauseMentionsModule(c) && clauseAssertsFailure(c))) {
      return { passed: false, detail: 'final answer asserts a failure despite the evidence showing a clean pass' };
    }
    return { passed: false, detail: `final answer never states the module and the observed test count (${totalToken}) in the same statement` };
  }

  if (clauses.some((c) => evaluateOutcomeClauseForModule(c, scenario, null))) {
    // fabricatesPassCount stays a whole-text disqualifier -- a fabricated count ANYWHERE in the
    // answer is suspicious regardless of clause structure, even if a different clause correctly
    // states no-applicable-tests for the right module.
    const fabricatesPassCount = /\d+\s*(\/|\s+of\s+)\s*\d+\s+test/i.test(text) || /\d+\s+tests?\s+pass/i.test(text);
    if (fabricatesPassCount) {
      return { passed: false, detail: 'final answer fabricates a pass count for a module with no applicable tests' };
    }
    return { passed: true, detail: 'a single clause states the expected module has no applicable tests, with no fabricated count' };
  }
  if (!anyModuleMention) return { passed: false, detail: `final answer never mentions the expected module (${scenario.expected.module})` };
  return { passed: false, detail: 'final answer never states, in the same statement as the expected module, that no applicable tests exist' };
}

/**
 * Determines whether the SINGLE per-condition JUnit XML snapshot (matrix-runner.mjs's
 * `captureGradleJunitEvidence`, captured once after the whole condition finishes, `sinceMs=0`) can
 * be reliably attributed to exactly one attempt. A systematic architecture review traced this as
 * the ROOT CAUSE behind repeated JUnit-ambiguity false positives/negatives across earlier review
 * rounds: two of three evidence types (kmp-test envelope, Gradle footer) bind to their own
 * `tool_result`, but JUnit counts are a single disk snapshot fanned out to every Gradle attempt.
 *
 * Four independent fixes, each empirically reproduced as a real bug against a prior version:
 * 1. Only meaningful when `scenario.expected.outcome_kind === 'tests_executed'` -- a
 *    `no_applicable_tests` scenario NEVER reads JUnit XML at all (the NO-SOURCE marker is parsed
 *    from each attempt's own stdout instead), so ambiguity in a snapshot nothing consumes must
 *    never block promotion. (Reproduced false positive: two Gradle retries under
 *    `no_applicable_tests` wrongly flagged the whole matrix.)
 * 2. Counts a `kmp-test parallel` call as a potential producer alongside a matching Gradle
 *    invocation -- it runs the exact same underlying Gradle test task and writes to the same
 *    JUnit XML path under the hood, so it is just as much a potential producer as a raw Gradle
 *    invocation. (Reproduced false negative: one Gradle attempt + one kmp-test `parallel` attempt,
 *    both plausible producers of the one shared snapshot, undercounted to 1 because only Gradle
 *    invocations were tallied.)
 * 3. The pooled snapshot is ONLY EVER READ by the Gradle-provider evaluation path
 *    (`evaluateGradleAttempt` reads `conditionResult.gradleJunitEvidence` directly) -- the
 *    kmp-test path never reads it at all, since each envelope carries its own self-contained
 *    `individual_total`. So ambiguity of a snapshot that nothing in THIS condition actually
 *    consumes is moot: if no Gradle attempt targeting `allowed_invocations` exists at all, there
 *    is no real consumer to protect, regardless of how many kmp-test `parallel` calls occurred. A
 *    round-4 fresh adversarial pass reproduced a false positive here: a kmp-test-only condition
 *    (first call against the wrong module, second call -- self-contained, correct -- against the
 *    right one) was flagged ambiguous purely from counting BOTH kmp-test calls as producers, even
 *    though no Gradle attempt existed for that ambiguity to ever matter to; per decision 4 this
 *    silently discarded an entire correctly-graded matrix.
 * 4. Fix 2's kmp-test-producer counting is scoped to the SAME module the scenario targets (a bare
 *    `--module-filter` mismatch, or no filter at all -- which runs every module including the
 *    target -- both handled), mirroring how the Gradle branch is already scoped to
 *    `allowed_invocations` (a specific task) rather than any Gradle invocation whatsoever. A
 *    kmp-test call against a DIFFERENT, unrelated module never touches the target module's Gradle
 *    task or its JUnit XML, so it is not a real potential producer of it.
 * @returns {{ambiguous: boolean, producerCount: number}}
 */
function classifyJunitProvenance(bashResults, scenario) {
  if (scenario.expected?.outcome_kind !== 'tests_executed') {
    return { ambiguous: false, producerCount: 0 };
  }
  const gradleProducerCount = bashResults.filter((b) => {
    const c = classifyBashCommand(b.command);
    return c.kind === 'gradle' && c.taskTokens.some((t) => (scenario.expected?.gradle?.allowed_invocations ?? []).includes(t));
  }).length;
  // No Gradle-provider attempt exists at all in this condition -- there is no consumer of the
  // pooled snapshot to protect, so ambiguity among kmp-test-only attempts (which never read it) is
  // moot. Short-circuits before even inspecting kmp-test attempts' module filters.
  if (gradleProducerCount === 0) return { ambiguous: false, producerCount: 0 };
  const targetModule = normalizeModuleName(scenario.expected.module);
  const kmpTestProducerCount = bashResults.filter((b) => {
    const c = classifyBashCommand(b.command);
    if (c.kind !== 'kmp-test' || c.subcommand !== 'parallel') return false;
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

  // See classifyJunitProvenance's own doc comment for the full rationale (scoped to
  // tests_executed only; counts kmp-test parallel attempts as JUnit producers too) -- threaded
  // into every evaluateGradleAttempt call so the ambiguity fails closed rather than silently
  // attributing the snapshot to whichever attempt happens to be evaluated.
  const { ambiguous: ambiguousJunitEvidence } = classifyJunitProvenance(bashResults, scenario);

  // Evaluate every attempt capable of producing target evidence, from either provider, in
  // transcript order -- "terminal" is the LAST one overall AMONG THOSE THAT AT LEAST ATTEMPTED
  // the expected module (decision 5's last-relevant-attempt rule, sharpened by a round-4 fresh
  // invariant review): a retry that fixes an earlier malformed/wrong-OUTCOME attempt on the SAME
  // module is exactly what "last one wins" is for, and still applies here (both attempts have
  // intendedTargetMatches:true, so the later one -- even if malformed -- still wins). But a LATER
  // attempt that never even tried to target the expected module at all (e.g. the agent double-
  // checking an unrelated module afterward) must not silently become "terminal" just by virtue of
  // running last -- that would fail an otherwise-correct, complete answer solely because of
  // unrelated trailing exploration. Falls back to "last of ALL attempts" only when NONE of them
  // ever targeted the expected module (preserves the single-wrong-module-only failure case).
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

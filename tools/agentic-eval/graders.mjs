#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/graders.mjs -- deterministic, structured, evidence-anchored scenario
// graders. Pure functions over already-collected transcript + JUnit-evidence data (see
// junit-evidence.mjs's attributeCondition, called once per condition by matrix-runner.mjs's
// runScenarioMatrix, for where the latter comes from) -- never an LLM judge, never a broad
// free-text keyword scan as the primary signal.
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
import { classifyTaskExecutionMode, classifyTaskResults } from '../../lib/orchestrators/parallel/result-rollup.js';
import { findTranscriptStructuralIssuesToleratingTimeout, findIncompleteToolResultsToleratingTimeout } from './stream-parser.mjs';
import { ENVELOPE_SCHEMA_VERSION, classifyExitCode } from '../../lib/envelope/exit-codes.js';
import { TEST_TYPE_VALUES } from '../../lib/parsers/argv-constants.js';
import { classifyBashCommand, normalizeModuleName } from './command-classify.mjs';
import { matchModuleFilter } from '../../lib/orchestrators/module-filter.js';

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
// Command classification -- classifyBashCommand/normalizeModuleName now live in
// command-classify.mjs (relocated verbatim, imported above), shared with junit-evidence.mjs and
// junit-evidence-hook.mjs so the JUnit-evidence-attribution mechanism never re-implements the
// grammar a third time. That module imports only `tokenize` from policy-hook.mjs -- never
// `GRADLE_LEADING_TOKENS`/`tokenize` itself relocated out of policy-hook.mjs, so `policy_sha256`
// (computed over policy-hook.mjs's own bytes only) still covers every byte of the grammar that
// actually drives the allow/deny decision.
// ---------------------------------------------------------------------------------------------

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

// `schema_version` must match the CURRENT envelope schema exactly, not merely be typeof
// 'number' -- a fresh review flagged this as a real gap: a stale or wrong-schema envelope (a
// different schema version could give the same field NAMES an entirely different meaning) still
// passed as trustworthy evidence as long as its shape happened to superficially match. Treated
// identically to "not a kmp-test envelope at all" -- both are equally untrustworthy, and this
// naturally flows into the existing `malformed` classification downstream (evaluateKmpTestAttempt
// already treats "content exists but extractKmpTestEnvelope returns null" as malformed).
const KMP_TEST_ENVELOPE_REQUIRED_SHAPE = (obj) =>
  obj != null && typeof obj === 'object' && !Array.isArray(obj)
  && obj.tool === 'kmp-test'
  && obj.schema_version === ENVELOPE_SCHEMA_VERSION
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
 *    (Scoped to the kmp-test path only. A round-6 fresh architecture review found the Gradle/
 *    JUnit-XML evidence path had no equivalent check: a genuinely `<skipped/>` JUnit testcase
 *    counts toward `lib/parsers/junit-xml.js`'s own `total` but NOT toward its `failures`, so a
 *    naive `passed = total - failures.length` computation would silently misattribute a real skip
 *    to `passed`. This is now closed -- not merely disclosed -- by `junit-evidence.mjs`'s
 *    `countEvidenceTaskJunit`, which detects a genuine `<skipped>` testcase and reports
 *    `{status:'integrity_error', reason:'skipped_testcase_unsupported'}` per attempt instead of a
 *    miscounted total; see that function's own doc comment and its dedicated coverage in
 *    `agentic-eval-junit-evidence.test.js`.)
 * @returns {boolean}
 */
// Concrete per-leg test types a real `--test-type all` dispatch can ever produce
// (lib/orchestrators/parallel/dispatch.js's legsForAll: 'common'/'desktop'/'androidUnit'
// unconditionally, '+androidInstrumented' unless KMP_TEST_SKIP_ADB=1, '+ios'/'+macos' only on a
// macOS host) -- 'all' itself is NEVER a per-leg test_type, only ever the top-level
// parallel.test_type value for a multi-leg dispatch. legsForAll always returns >= 3 legs
// (the three unconditional entries), so a top-level 'all' with fewer than 3 legs cannot be real.
const ALL_LEG_TEST_TYPES = ['common', 'desktop', 'androidUnit', 'androidInstrumented', 'ios', 'macos'];
// The 3 leg types legsForAll (lib/orchestrators/parallel/dispatch.js) NEVER omits, in any
// environment -- a real 'all' dispatch's leg-type set is always a superset of exactly these 3.
const UNCONDITIONAL_ALL_LEG_TYPES = ['common', 'desktop', 'androidUnit'];
const MIN_LEGS_FOR_ALL = 3;
// `TEST_TYPE_VALUES` is the set of valid CLI INPUT values for --test-type -- it deliberately does
// NOT include 'auto', since 'auto' is never a real CLI input (cli.js's own validateEnum would
// reject `--test-type auto`). But the ENVELOPE's own `parallel.test_type` field legitimately
// renders as the string 'auto' when --test-type was never supplied at all (opts.testType='' -->
// 'auto' at the envelope boundary, confirmed in parallel-orchestrator.js/result-rollup.js) -- so
// the set of values valid ON THE ENVELOPE is TEST_TYPE_VALUES plus this one rendering-only value.
const ENVELOPE_TEST_TYPE_VALUES = [...TEST_TYPE_VALUES, 'auto'];
// The complete, unconditional per-leg `execution` shape (lib/orchestrators/parallel/
// result-rollup.js's summarizeExecutionModes/recordLegResults) -- per-TASK counts within this
// leg, never booleans, always non-negative integers.
const EXECUTION_MODE_KEYS = ['fresh', 'up_to_date', 'from_cache', 'no_source', 'skipped_by_gradle', 'failed', 'no_evidence'];

// The exact, closed key set `result-rollup.js`'s buildParallelParsed constructs `envelope.parallel`
// with -- test_type/legs/max_workers/timeout_s, unconditionally, every real invocation (verified
// directly against that function's own literal object construction). A Docker/local-ci audit found
// validateParallelEvidence checked test_type/legs but never max_workers/timeout_s at all, so a
// missing max_workers, a wrong-typed timeout_s, or an extra fabricated key all validated clean.
const PARALLEL_BLOCK_KEYS = ['test_type', 'legs', 'max_workers', 'timeout_s'];

// `buildIsolatedField` (lib/orchestrators/orchestrator-utils.js)'s exact, closed return shape --
// always these 4 keys, every real invocation (the disabled/no-op case collapses to a stable shape
// rather than omitting the field, per that function's own doc comment). Same audit finding as
// PARALLEL_BLOCK_KEYS above: envelope.isolated (a TOP-LEVEL envelope field, a sibling of `parallel`,
// not nested inside it -- confirmed directly against buildParallelParsed's own object literal) was
// never validated at all.
const ISOLATED_FIELD_KEYS = ['enabled', 'cache_dir', 'kept', 'locked'];

// Every shipped scenario's policy block permits only `kmp-test parallel`/`doctor` and a bounded
// Gradle task list -- none of them allows --max-workers, --timeout, or any --isolated* flag.
// Confirmed directly against production defaults (lib/orchestrators/parallel/dispatch.js's
// argument-parsing defaults: maxWorkers:0, timeout:600) and buildIsolatedField's disabled-case
// composition (called with enabled:false, cacheDir:null from parseIsolatedArgs's own unset
// defaults; kept:false since isolatedKept short-circuits on !enabled; locked:true since
// `!isolatedFlags.noLock` is true when noLock's own default, false, is never overridden) -- a
// real, policy-compliant envelope for any scenario can only ever carry exactly these values. Not
// a general claim about every possible kmp-test invocation; scoped to what THIS harness's own
// policy ever permits an agent to run.
const EXPECTED_MAX_WORKERS = 0;
const EXPECTED_TIMEOUT_S = 600;
const EXPECTED_ISOLATED_FIELD = Object.freeze({ enabled: false, cache_dir: null, kept: false, locked: true });

/** Validates `envelope.isolated` against `buildIsolatedField`'s exact closed shape AND this
 * harness's own policy-coherent disabled defaults (no scenario's policy ever permits an
 * `--isolated*` flag, so a real, policy-compliant envelope can only ever carry the one disabled
 * shape a real orchestrator run produces when isolation was never requested). */
function isPolicyCoherentIsolatedField(isolatedField) {
  if (isolatedField == null || typeof isolatedField !== 'object' || Array.isArray(isolatedField)) return false;
  if (Object.keys(isolatedField).length !== ISOLATED_FIELD_KEYS.length) return false;
  if (typeof isolatedField.enabled !== 'boolean') return false;
  if (isolatedField.cache_dir !== null && typeof isolatedField.cache_dir !== 'string') return false;
  if (typeof isolatedField.kept !== 'boolean') return false;
  if (typeof isolatedField.locked !== 'boolean') return false;
  return isolatedField.enabled === EXPECTED_ISOLATED_FIELD.enabled
    && isolatedField.cache_dir === EXPECTED_ISOLATED_FIELD.cache_dir
    && isolatedField.kept === EXPECTED_ISOLATED_FIELD.kept
    && isolatedField.locked === EXPECTED_ISOLATED_FIELD.locked;
}

/** Validates one `parallel.legs[]` entry against the exact, complete production shape
 * (`lib/orchestrators/parallel-orchestrator.js`'s per-leg dispatch loop): `test_type` (string),
 * `exit_code` (integer), `execution` (a plain object with EXACTLY the 7 `EXECUTION_MODE_KEYS`,
 * each a non-negative integer), `cascade_detected`/`retry_fired` (booleans). `device`/`retries`/
 * `pre_run_actions` are legitimately additive/conditional in real production output (present only
 * for an androidInstrumented leg with a resolved device serial, or when retries/pre-run actions
 * actually occurred) -- tolerated if present, never required. */
function isWellFormedParallelLeg(leg) {
  if (leg == null || typeof leg !== 'object' || Array.isArray(leg)) return false;
  if (typeof leg.test_type !== 'string') return false;
  if (!Number.isInteger(leg.exit_code)) return false;
  if (typeof leg.cascade_detected !== 'boolean') return false;
  if (typeof leg.retry_fired !== 'boolean') return false;
  const exec = leg.execution;
  if (exec == null || typeof exec !== 'object' || Array.isArray(exec)) return false;
  // A round-2 test-fidelity review found this function's own doc comment (above) claims
  // "EXACTLY the 7 EXECUTION_MODE_KEYS", but the code only ever validated that the 7 known keys
  // are well-shaped -- it never rejected an EXTRA, unrecognized key, so a leg with a fabricated
  // additional `execution` field (impossible from real production, which always constructs
  // exactly these 7 via summarizeExecutionModes) silently passed as well-formed. The explicit
  // length check closes this asymmetry (missing keys were already caught by the `every` below;
  // extra keys were not).
  if (Object.keys(exec).length !== EXECUTION_MODE_KEYS.length) return false;
  return EXECUTION_MODE_KEYS.every((k) => Number.isInteger(exec[k]) && exec[k] >= 0);
}

/**
 * Validates `envelope.parallel` against the real production contract for a `tests_executed`
 * outcome. A systematic-closure pass (after 9 patch-by-patch review rounds) replacing round 9's
 * narrow "parallel.legs is a non-empty array" check, which a fresh review reproduced as still
 * accepting `[null]`, `[{}]`, `[1]`, a failed leg contradicting a clean envelope, a wrong-test-type
 * leg, and a command/envelope `--test-type` mismatch -- all with `success:true`. Contract extracted
 * directly from `lib/orchestrators/parallel-orchestrator.js` (leg dispatch loop, `legsForAll`) and
 * `lib/orchestrators/parallel/result-rollup.js` (`buildParallelParsed`, `recordLegResults`'s
 * `execSummary.failed === errors.filter(module_failed).length` per-leg invariant) -- never guessed.
 *
 * `invokedTestType` is the literal `--test-type` value the command itself passed (from
 * `classifyBashCommand`), or `null` if the flag is absent (an implicit `auto` dispatch --
 * `opts.testType` is internally `''`, always rendered as the string `'auto'` at the envelope
 * boundary; `'auto'` itself is never a valid `--test-type` CLI input, so there is no ambiguity
 * between "auto because unset" and "auto because explicitly typed").
 *
 * Single-type (or implicit `auto`) vs `all` semantics -- the one place a leg's own `test_type`
 * LEGITIMATELY disagreeing with the top-level `parallel.test_type` is correct, not a red flag:
 * for a specific single type, `legsForAll` never runs -- exactly one leg dispatches, and its own
 * `test_type` must equal the top-level value exactly. For `all`, `legsForAll` enumerates 3-6
 * CONCRETE per-leg types (never `'all'` itself on any individual leg) while the top-level
 * `parallel.test_type` stays `'all'` -- confirmed directly in `parallel-orchestrator.js`.
 *
 * Aggregate consistency: the SUM of every leg's own `execution.failed` count must equal the
 * envelope's own top-level `tests.failed` -- a production-guaranteed invariant (every task
 * classified 'failed' increments both `execSummary.failed` for its leg AND the top-level
 * `state.tests.failed` exactly once, in the same pass). A leg reporting real task failures while
 * the envelope's top-level counters claim a clean run (or vice versa) is not a real production
 * shape -- it is internally self-contradictory, fabricated, or tampered evidence. This is an
 * envelope SELF-consistency check, independent of what any particular scenario expects -- the
 * caller separately compares the (now-validated-coherent) top-level counters against the
 * scenario's own expected values.
 *
 * Also validates `envelope.parallel`'s own key set (`test_type`/`legs`/`max_workers`/`timeout_s`,
 * exactly -- `buildParallelParsed`'s literal construction) and the sibling top-level
 * `envelope.isolated` field, both against this harness's policy-coherent defaults (no shipped
 * scenario's policy ever permits `--max-workers`/`--timeout`/`--isolated*`) -- a Docker/local-ci
 * audit found neither was validated at all, so a missing `max_workers` or a fabricated `isolated`
 * shape both passed as authoritative evidence.
 */
export function validateParallelEvidence(envelope, invokedTestType) {
  const parallelBlock = envelope.parallel;
  if (parallelBlock == null || typeof parallelBlock !== 'object' || Array.isArray(parallelBlock)) return false;
  // Exact, closed key set (PARALLEL_BLOCK_KEYS) -- a missing max_workers, an extra fabricated key,
  // or any other deviation from buildParallelParsed's own literal 4-key construction is impossible
  // real evidence, regardless of whether test_type/legs individually look plausible.
  if (Object.keys(parallelBlock).length !== PARALLEL_BLOCK_KEYS.length) return false;

  const topTestType = parallelBlock.test_type;
  if (typeof topTestType !== 'string' || !ENVELOPE_TEST_TYPE_VALUES.includes(topTestType)) return false;

  const expectedTopTestType = invokedTestType == null ? 'auto' : invokedTestType;
  if (topTestType !== expectedTopTestType) return false;

  if (!Array.isArray(parallelBlock.legs) || parallelBlock.legs.length === 0) return false;

  // max_workers/timeout_s -- required non-negative integers, AND policy-coherent (see
  // EXPECTED_MAX_WORKERS/EXPECTED_TIMEOUT_S's own doc comment for the production-confirmed
  // derivation). A Docker/local-ci audit found these were never validated at all -- a missing
  // max_workers or a wrong-typed timeout_s both passed as authoritative evidence.
  if (!Number.isInteger(parallelBlock.max_workers) || parallelBlock.max_workers < 0) return false;
  if (!Number.isInteger(parallelBlock.timeout_s) || parallelBlock.timeout_s < 0) return false;
  if (parallelBlock.max_workers !== EXPECTED_MAX_WORKERS || parallelBlock.timeout_s !== EXPECTED_TIMEOUT_S) return false;

  // envelope.isolated -- same audit finding, for the sibling top-level field no scenario's
  // policy ever permits an agent to actually enable (see isPolicyCoherentIsolatedField).
  if (!isPolicyCoherentIsolatedField(envelope.isolated)) return false;

  if (topTestType === 'all') {
    if (parallelBlock.legs.length < MIN_LEGS_FOR_ALL) return false;
    if (!parallelBlock.legs.every((leg) => isWellFormedParallelLeg(leg) && ALL_LEG_TEST_TYPES.includes(leg.test_type))) return false;
    // A fresh review reproduced a real gap: membership-per-leg alone doesn't reject a fabricated
    // set with a DUPLICATE type and a MISSING one (e.g. [common, common, desktop], androidUnit
    // never dispatched) -- legsForAll (lib/orchestrators/parallel/dispatch.js) can never produce a
    // repeated leg type in any environment, so a duplicate is unconditionally impossible evidence.
    const distinctLegTypes = new Set(parallelBlock.legs.map((leg) => leg.test_type));
    if (distinctLegTypes.size !== parallelBlock.legs.length) return false;
    // A follow-up review found the distinctness check above still didn't validate the SURVIVING
    // set is one legsForAll can actually produce -- e.g. ['androidInstrumented','ios','macos'],
    // missing all three UNCONDITIONAL types, is distinct and every member is individually valid,
    // but no real dispatch could ever produce it. legsForAll always includes 'common'/'desktop'/
    // 'androidUnit' unconditionally, and adds 'ios'/'macos' only TOGETHER as a pair (macOS host
    // only) -- never one without the other. Both invariants are unconditional across every
    // environment (confirmed directly in dispatch.js), so violating either is impossible evidence
    // regardless of platform/env-var state, not merely "environment-specific and thus a guess."
    if (!UNCONDITIONAL_ALL_LEG_TYPES.every((t) => distinctLegTypes.has(t))) return false;
    if (distinctLegTypes.has('ios') !== distinctLegTypes.has('macos')) return false;
  } else {
    if (parallelBlock.legs.length !== 1) return false;
    if (!isWellFormedParallelLeg(parallelBlock.legs[0]) || parallelBlock.legs[0].test_type !== topTestType) return false;
  }

  // Per-leg exit-code/failed coherence -- a follow-up review reproduced `leg.exit_code:99`
  // (well-typed, but arbitrary) passing full credit alongside an otherwise-clean leg. Derived
  // directly from classifyTaskResults/recordLegResults (result-rollup.js): a task is classified
  // 'failed' either via a literal "TASK FAILED" match in gradle's own output, or via the
  // defense-in-depth branch, whose own trigger condition requires `legExit !== 0` -- so
  // `execution.failed > 0` implies a non-zero leg exit_code for every task-level failure path this
  // orchestrator's own classification logic models. Deliberately does NOT constrain exit_code to a
  // small enumerated domain (a raw gradle process status can legitimately be any integer) -- only
  // checks it agrees with THIS leg's own failed count.
  //
  // IMPORTANT (correction from a fresh review): this is a CONSERVATIVE BENCHMARK-INTEGRITY POLICY
  // for this eval harness, not a claimed universal production invariant. A real Gradle process can
  // in principle complete the target task cleanly and still exit non-zero afterward (e.g. a build
  // finalizer, a listener, or a daemon-level failure unrelated to any tracked task) -- a case this
  // validator cannot rule out from reading the orchestrator's source alone, and one never observed
  // in this harness's own real invocations. The check stays fail-closed on any mismatch (rejecting
  // an ambiguous leg is the safe default for benchmark evidence), but does not claim the
  // exit_code!==0-with-failed:0 combination is impossible in production generally -- a rollup that
  // legitimately hit this shape would currently read as "malformed" here, not as "a genuine, if
  // unusual, negative result." Disclosed as a known limitation (see this PR's own "Known
  // limitations" section) and tracked as a separate follow-up, not a product-code fix -- out of
  // scope for this eval-harness-only pass.
  if (!parallelBlock.legs.every((leg) => (leg.exit_code === 0) === (leg.execution.failed === 0))) return false;

  // Global cardinality -- a follow-up review reproduced `execution.fresh:999` alongside
  // `envelope.tests.total:1` passing full credit. Every task dispatched by ANY leg falls into
  // EXACTLY one of that leg's own 7 execution buckets (summarizeExecutionModes/recordLegResults,
  // result-rollup.js) AND increments the envelope's own top-level `tests.total` exactly once, in
  // the same per-task loop -- so the SUM of every bucket, across every leg, must equal
  // `envelope.tests.total` exactly. A leg claiming far more (or fewer) tasks in its own buckets
  // than the envelope's own total task count is impossible real evidence, regardless of whether
  // any individual counter or the failed-specific sum (below) happens to look plausible.
  const bucketsTotalSum = parallelBlock.legs.reduce(
    (sum, leg) => sum + EXECUTION_MODE_KEYS.reduce((legSum, k) => legSum + leg.execution[k], 0),
    0,
  );
  if (bucketsTotalSum !== envelope.tests?.total) return false;

  const legsFailedSum = parallelBlock.legs.reduce((sum, leg) => sum + leg.execution.failed, 0);
  return legsFailedSum === envelope.tests?.failed;
}

// Round-2 review finding: a `tests_failed` envelope's `modules[0].test_failures` array was
// previously checked ONLY by `.length` -- its own elements were never inspected, so an
// array of `null`/scalars/malformed objects of the right length satisfied validation. Mirrors
// junit-xml.js's own `junitTestFailuresFor`/`extractTestcaseFailures`, the ONLY real producer of
// this shape: `test` and `cause` are always non-empty strings (both have hard fallbacks --
// '<unknown>' / 'error'|'failure' -- and are never empty or absent in real output), `type` is
// `type ?? null` -- legitimately `null` when the captured XML's <failure>/<error> tag has no
// `type="..."` attribute, otherwise a non-empty string. Deliberately does NOT compare specific
// test identities/names against the schema -- that would require modeling per-test identity in
// the schema itself, out of scope for this first tests_failed scenario (see this file's own
// "exactly one target task" scoping note).
function isWellFormedTestFailureEntry(entry) {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.test !== 'string' || entry.test.length === 0) return false;
  if (typeof entry.cause !== 'string' || entry.cause.length === 0) return false;
  if (entry.type !== null && (typeof entry.type !== 'string' || entry.type.length === 0)) return false;
  return true;
}

/** Pure shape/type check ONLY on `envelope.changed` -- object, exactly 3 keys, `detected_modules`
 * a non-empty array of non-empty strings, `staged_only` a boolean, `base_ref` a non-empty string.
 * Deliberately never compares against `scenario.expected` (that's changedBlockMatchesExpected's
 * job, below) -- this function alone decides whether a `changed{}` block is trustworthy evidence
 * AT ALL, independent of whether its VALUES happen to be correct, so a malformed block can fail as
 * evidence integrity (check 4, via evaluateKmpTestAttempt's own changedEvidenceInvalid) rather than
 * silently reading as "well-formed but wrong" (check 6). */
function isWellFormedChangedBlock(changedBlock) {
  if (changedBlock == null || typeof changedBlock !== 'object' || Array.isArray(changedBlock)) return false;
  const keys = Object.keys(changedBlock);
  if (keys.length !== 3 || !['detected_modules', 'staged_only', 'base_ref'].every((k) => keys.includes(k))) return false;
  if (!Array.isArray(changedBlock.detected_modules) || changedBlock.detected_modules.length === 0
    || changedBlock.detected_modules.some((m) => typeof m !== 'string' || m.length === 0)) return false;
  if (typeof changedBlock.staged_only !== 'boolean') return false;
  if (typeof changedBlock.base_ref !== 'string' || changedBlock.base_ref.length === 0) return false;
  return true;
}

/** Exact-value comparison of `envelope.changed` against the scenario's own `expected.changed`
 * contract -- ALWAYS calls isWellFormedChangedBlock first and fails closed immediately if not
 * well-formed (never assumes the caller already checked; a naive `.every()`/`.sort()` on a
 * malformed non-array `detected_modules` would otherwise throw, crashing grading instead of
 * failing closed). Array comparison is order-independent (both sides sorted) -- this scenario
 * shape is schema-locked to exactly one module, but sorting costs nothing and avoids a spurious
 * order-dependent mismatch either way. */
function changedBlockMatchesExpected(changedBlock, expectedChanged) {
  if (!isWellFormedChangedBlock(changedBlock)) return false;
  const actual = [...changedBlock.detected_modules].sort();
  const expected = [...expectedChanged.detected_modules].sort();
  if (actual.length !== expected.length || !actual.every((m, i) => m === expected[i])) return false;
  return changedBlock.staged_only === expectedChanged.staged_only && changedBlock.base_ref === expectedChanged.base_ref;
}

function validateKmpEnvelopeForAttempt(envelope, invokedSubcommand, resultIsError, scenario, invokedTestType, invokedMinMissedLines) {
  if (envelope.subcommand !== invokedSubcommand) return false;
  // Execution/plan-mode coherence: the envelope's OWN self-reported mode must agree with a real
  // execution, not merely with what the invoking command's text happened to say. A fresh review
  // reproduced this as a real gap -- this grader already excludes a command whose OWN text
  // contains --dry-run/--list-only (see classifyBashCommand's isPlanOnly), but never cross-checked
  // the RETURNED envelope's own dry_run/list_only fields (both real, confirmed fields --
  // lib/envelope/builder.js's buildDryRunReport sets `dry_run:true` at the top level;
  // parallel-orchestrator.js's --list-only path sets `parallel.list_only:true`) against a command
  // that looked like a real execution. This grader presents itself as fail-closed against stale or
  // mis-correlated evidence -- a command with no --dry-run/--list-only in its own text, paired
  // (whether by a caching bug, a mismatched tool_result, or anything else) with an envelope that
  // itself claims plan-only mode, must not be trusted just because its counts happen to coincide.
  // A fresh review reproduced this failing OPEN on a wrong-typed value: `envelope.dry_run === true`
  // only rejects the LITERAL boolean `true` -- `dry_run:"true"` (string) or `dry_run:1` (number)
  // still semantically claim plan-only mode but are not `=== true`, so the old check silently let
  // them through. Fixed as a fail-closed allowlist: the ONLY acceptable states are "field absent" (a
  // real envelope for an actual execution never sets dry_run at all -- see
  // lib/envelope/builder.js's buildJsonReport) or "field explicitly false". Anything else -- any
  // truthy-or-not wrong-typed value -- is rejected, not just literal `true`.
  if (envelope.dry_run !== undefined && envelope.dry_run !== false) return false;
  if (envelope.parallel?.list_only !== undefined && envelope.parallel?.list_only !== false) return false;
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
    //
    // For `no_applicable_tests`, `parallel` is legitimately ABSENT entirely: the `no_test_modules`
    // early-exit (parallel-orchestrator.js) calls buildJsonReport before any `parallel` block is
    // ever constructed -- so `validateParallelEvidence`'s full structural/leg/test-type contract
    // is scoped to `tests_executed` only, never applied to the other branch.
    //
    // `changed` is a SECOND, structurally different tests_executed shape (never reuses
    // validateParallelEvidence at all): a real `changed` envelope has NO `parallel:{}` block
    // whatsoever (ground truth independently confirmed live, despite changed.md's own stale doc
    // example showing one) -- validateParallelEvidence would unconditionally reject it regardless
    // of correctness, making the scenario ungradeable by any agent. `envelope.parallel ===
    // undefined` is required here too (defense in depth, redundant with evaluateKmpTestAttempt's
    // own changedEvidenceInvalid computation -- the requirement must hold even if a future
    // refactor ever decoupled the two call sites).
    if (invokedSubcommand === 'changed') {
      return envelope.parallel === undefined
        && envelope.errors.length === 0
        && envelope.exit_code === (kt.exit_code ?? 0)
        && envelope.tests?.total === kt.tests.total
        && envelope.tests?.passed === kt.tests.passed
        && envelope.tests?.failed === kt.tests.failed
        && envelope.tests?.skipped === kt.tests.skipped
        && envelope.tests?.individual_total === kt.tests.individual_total
        && changedBlockMatchesExpected(envelope.changed, scenario.expected.changed);
    }
    return validateParallelEvidence(envelope, invokedTestType)
      && envelope.errors.length === 0
      && envelope.exit_code === (kt.exit_code ?? 0)
      && envelope.tests?.total === kt.tests.total
      && envelope.tests?.passed === kt.tests.passed
      && envelope.tests?.failed === kt.tests.failed
      && envelope.tests?.skipped === kt.tests.skipped
      && envelope.tests?.individual_total === kt.tests.individual_total;
  }
  if (scenario.expected.outcome_kind === 'tests_failed') {
    // A genuine module-task failure surfaces exactly ONE real `module_failed` error entry
    // (parallel-orchestrator.js's own error-reporting convention, ground-truth confirmed directly
    // against a real kmp-test capture -- see corpus/scenarios/deterministic-unit-test-failure.json's
    // own provenance) -- REQUIRED here, the mirror of the tests_executed branch's own
    // `errors.length === 0` requirement above. A review pass reproduced three real gaps in an
    // earlier version of this check, all closed below, none guessed -- each reproduced directly
    // against this scenario's own real envelope shape before being fixed:
    // 1. `matchingModuleFailures.length >= 1` tolerated MORE than one -- two duplicate module_failed
    //    entries for the same module (never a real production shape; a module fails once) still
    //    satisfied this check as long as no OTHER unrelated error was also present. Tightened to
    //    `=== 1`.
    // 2. The matching entry's own `task` field was never cross-checked against this scenario's
    //    `expected.gradle.evidence_task` -- a module_failed entry naming a DIFFERENT task within the
    //    same module (e.g. a genuine compile failure on `:lint:compileKotlin`, which never runs
    //    `:lint:test` at all) still satisfied tests_failed purely because the MODULE name matched,
    //    directly contradicting step 17's "a compile/setup failure must never satisfy tests_failed"
    //    guarantee for the kmp-test path specifically (the Gradle path already closed this via
    //    `classifyTaskResults`/`junitOk` in evaluateGradleAttempt, below).
    // 3. `setup_failed:true` (result-rollup.js's own real discriminator for "the failure happened
    //    pre-test -- compile, plugin error, classpath, runner setup, etc.; tests never actually
    //    ran", added specifically so agents can distinguish this from a genuine test failure) was
    //    never checked at all.
    //
    // Round-2 review finding: `setup_failed !== true` (the original fix for #3, above) only
    // rejects the LITERAL boolean `true` -- the exact same class of gap this file's own
    // `dry_run`/`list_only` checks were already fixed for (see validateParallelEvidence's own
    // fail-closed-allowlist comment). Verified directly against result-rollup.js: its real
    // errEntry object literal (`{code, module, task, message}`) never carries a `setup_failed` key
    // at all for a genuine test failure -- the key is only ever ADDED, and only ever set to the
    // literal boolean `true`, when `taskTestcaseCount === 0` (a real pre-test failure; see
    // recordLegResults's `if (failures.length > 0) {...} else if (taskTestcaseCount === 0) {
    // errEntry.setup_failed = true }` branch). So the only real production states are "key
    // absent" (genuine test failure) or "key present, value true" (genuine setup failure) --
    // fixed to require genuine ABSENCE, not merely inequality with `true`, so a wrong-typed value
    // (a string, a number, an explicit null) is rejected exactly like `true` itself would be.
    const targetModuleName = normalizeModuleName(scenario.expected.module);
    const g = scenario.expected.gradle;
    const matchingModuleFailures = envelope.errors.filter((e) => e && e.code === 'module_failed' && normalizeModuleName(e.module) === targetModuleName);
    const soleModuleFailure = matchingModuleFailures.length === 1 ? matchingModuleFailures[0] : null;
    const moduleFailureOk = envelope.errors.length === 1 && soleModuleFailure != null
      && soleModuleFailure.task === g.evidence_task
      && !('setup_failed' in soleModuleFailure);
    // A further review pass found the aggregate `tests.*` counters were the ONLY thing checked --
    // `modules[0].test_failures` (the real per-test detail array a genuine envelope always carries
    // alongside a module_failed entry, ground-truth confirmed) was never inspected, so an envelope
    // could claim a matching AGGREGATE count while its own detailed list told a different story
    // (missing entirely, or too short) and still pass. Existence + LENGTH match against BOTH
    // `kt.tests.individual_total` (kmp-test's own real per-test-case count) and
    // `g.tests.failed` (Gradle/JUnit's own real per-testcase failure count -- schema-forced equal to
    // `individual_total` already, checked again here defensively) is the minimal, honest bar for
    // this scenario shape (exactly one target task, every one of its individual cases failed) --
    // deliberately NOT matching individual test NAMES, which would require modeling per-test
    // identity in the schema itself; out of scope for this first tests_failed scenario (see this
    // PR's own "Not in this PR" note on mixed results/skips needing additional observability).
    //
    // Round-2 review finding: length alone proves nothing about CONTENT -- an array of the right
    // LENGTH but filled with `null`/scalars/malformed objects previously satisfied this check.
    // Every entry must now also be individually well-formed -- see isWellFormedTestFailureEntry,
    // above.
    const targetModuleEntry = Array.isArray(envelope.modules) && envelope.modules.length === 1 ? envelope.modules[0] : null;
    const testFailuresOk = targetModuleEntry != null && Array.isArray(targetModuleEntry.test_failures)
      && targetModuleEntry.test_failures.length === kt.tests.individual_total
      && targetModuleEntry.test_failures.length === g.tests.failed
      && targetModuleEntry.test_failures.every(isWellFormedTestFailureEntry);
    return validateParallelEvidence(envelope, invokedTestType)
      && moduleFailureOk
      && testFailuresOk
      && envelope.exit_code === kt.exit_code
      && envelope.tests?.total === kt.tests.total
      && envelope.tests?.passed === kt.tests.passed
      && envelope.tests?.failed === kt.tests.failed
      && envelope.tests?.skipped === kt.tests.skipped
      && envelope.tests?.individual_total === kt.tests.individual_total;
  }
  if (scenario.expected.outcome_kind === 'coverage_threshold_exceeded') {
    // Corroborating (parallel genuinely runs tests -- fact #4/#6): the real test execution must
    // show a genuine clean pass -- never itself a failure (the core distinction from tests_failed,
    // even though both produce exit_code:1).
    const testsOk = validateParallelEvidence(envelope, invokedTestType)
      && envelope.tests?.total === kt.tests.total
      && envelope.tests?.passed === kt.tests.passed
      && envelope.tests?.failed === 0
      && envelope.tests?.skipped === kt.tests.skipped
      && envelope.tests?.individual_total === kt.tests.individual_total;

    // Coherence: the ACTUALLY-INVOKED --min-missed-lines token must agree with what the envelope's
    // own errors[] entry echoes back as `threshold` -- mirrors computeKmpTestTargetMatch's own
    // moduleFilter-vs-envelope coherence check (a mismatched/stale tool_result attached to the
    // wrong tool_use cannot be trusted regardless of whether its own number happens to match this
    // scenario's expected constant). The real CLI's default (0, flag omitted) can never
    // legitimately trigger this outcome, so an absent invokedMinMissedLines is always
    // disqualifying.
    const cov = kt.coverage;
    if (invokedMinMissedLines == null || String(cov.min_missed_lines) !== invokedMinMissedLines) return false;

    // The authoritative proof itself -- envelope.coverage.*, NOT envelope.tests (fact #1/#3: Gradle
    // has no equivalent event, so only the real coverage envelope + errors[] can prove this).
    const covBlock = envelope.coverage;
    const buckets = covBlock?.module_buckets;
    const withData = buckets?.with_data;
    const targetModule = normalizeModuleName(scenario.expected.module);
    const bucketExclusive = Array.isArray(buckets?.no_xml) && !buckets.no_xml.some((m) => normalizeModuleName(m) === targetModule)
      && Array.isArray(buckets?.parse_errored) && !buckets.parse_errored.some((m) => normalizeModuleName(m) === targetModule)
      && Array.isArray(buckets?.skipped_by_user) && !buckets.skipped_by_user.some((m) => normalizeModuleName(m) === targetModule);
    const coverageOk = covBlock != null && typeof covBlock === 'object'
      && covBlock.tool === cov.tool
      && covBlock.missed_lines === cov.missed_lines
      && covBlock.modules_contributing === 1
      && Array.isArray(withData) && withData.length === 1 && normalizeModuleName(withData[0]) === targetModule
      && bucketExclusive;

    // errors[] -- EXACTLY one entry, and it is the matching coverage_threshold_exceeded one (this
    // outcome's exit_code:1 is caused by a SINGLE coherent threshold error, never anything else).
    const matchingErrors = envelope.errors.filter((e) => e && e.code === 'coverage_threshold_exceeded');
    const soleError = matchingErrors.length === 1 ? matchingErrors[0] : null;
    const errorOk = envelope.errors.length === 1 && soleError != null
      && soleError.threshold === cov.min_missed_lines && soleError.missed_lines === cov.missed_lines;

    return testsOk && coverageOk && errorOk && envelope.exit_code === kt.exit_code;
  }
  // `errors.length === 1` (exactly the matching entry, nothing else): a second, unrelated error
  // entry contradicts "cleanly determined that no tests apply". `individual_total === 0`/
  // `skipped === 0` are the converse of the tests_executed branch's own checks: a no_test_modules
  // claim alongside a stale non-zero counter is just as internally inconsistent as the reverse.
  //
  // A round-2 follow-up review reproduced the identical class of gap this round closed for
  // tests_executed, in the SIBLING branch: nothing here checked `envelope.parallel` at all, so a
  // fabricated envelope carrying a genuinely matching no_test_modules error PLUS an arbitrarily
  // malformed `parallel` block (e.g. `{legs:[null]}` -- the exact shape this file's own
  // adversarial matrix rejects for tests_executed) still graded success:true. Real production
  // NEVER sets `parallel` on this early-exit at all (confirmed in buildJsonReport, which only ever
  // adds the key `if (parsed.parallel)` -- the no_test_modules early-exit's own `state` never has
  // that key) -- so, unlike tests_executed (which requires `parallel` to be PRESENT and valid),
  // this branch requires it to be ABSENT entirely; any presence, malformed or not, is impossible
  // real evidence for this scenario shape. This directly affects one of this PR's two real
  // shipped scenarios (kampkit-no-applicable-tests.json).
  if (envelope.parallel !== undefined) return false;
  const matchingErrors = envelope.errors.filter((e) => e && e.code === kt.error_code);
  return envelope.errors.length === 1 && matchingErrors.length === 1
    && envelope.exit_code === kt.exit_code
    && matchingErrors[0].caused_by_filter === kt.caused_by_filter
    && envelope.tests?.total === 0 && envelope.tests?.passed === 0 && envelope.tests?.failed === 0
    && envelope.tests?.skipped === 0 && envelope.tests?.individual_total === 0;
}

// CodeRabbit nitpick (PR #411 review): the `outcome_kind === 'tests_executed' || outcome_kind ===
// 'tests_failed'` disjunction previously appeared inline at 4 separate sites in this file
// (computeKmpTestTargetMatch, evaluateKmpTestAttempt's parallelEvidenceInvalid and
// intendedTargetMatches computations, kmpEvalResultBlockMatchesObserved) -- both outcome_kinds
// share the same envelope-side shape at every one of those sites because both represent a genuine
// test EXECUTION (the target task actually ran), just with a different real outcome. A future
// third "ran" outcome_kind would otherwise need updating at every site individually; this single
// predicate is now the one place that ever changes.
function isRanOutcome(outcomeKind) {
  return outcomeKind === 'tests_executed' || outcomeKind === 'tests_failed' || outcomeKind === 'coverage_threshold_exceeded';
}

// terminalEligible -- coverage_threshold_exceeded is the one outcome_kind where Gradle can never
// become the authoritative "terminal" attempt (or produce first_useful_signal): --min-missed-lines
// is a kmp-test-only decision (no raw Gradle task ever evaluates a coverage threshold), so a
// Gradle attempt can at most CORROBORATE its own contract (a clean, matching test-task pass) --
// it can never prove the threshold itself. The other 3 outcome_kinds keep both providers eligible
// (no regression -- ground truth for tests_executed/tests_failed/no_applicable_tests never
// depended on this distinction).
function isTerminalEligibleAttempt(attempt, scenario) {
  const outcomeKind = scenario.expected.outcome_kind;
  if (outcomeKind === 'coverage_threshold_exceeded' && attempt.provider !== 'kmp_test') return false;
  // A scenario declaring expected.changed requires `kmp-test changed` specifically as the ONLY
  // acceptable terminal proof -- `parallel` (even with matching counts) never targets the right
  // evidence for THIS scenario shape (it never proves the agent scoped testing to the actual
  // change), and Gradle can only ever corroborate the test outcome, never the module-scoping
  // decision itself (a kmp-test-only concept, exactly like coverage_threshold_exceeded's own
  // --min-missed-lines decision above). A `parallel` attempt is still fully EVALUATED elsewhere
  // (visible to check 7's own diagnostic) -- only excluded from ever becoming terminal here.
  if (scenario.expected.changed != null) {
    return attempt.provider === 'kmp_test' && attempt.subcommand === 'changed';
  }
  return true;
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
 *    That cross-check itself now goes through `matchModuleFilter` (the real production matcher,
 *    `lib/orchestrators/module-filter.js`) rather than exact string equality -- a follow-up fix:
 *    the original round-5 version compared the raw filter to the envelope module with `!==`, so a
 *    correct agent targeting a NESTED module (`:core:common`, not `:shared`/`:app`) via a short
 *    substring filter (`common`) or an anchored glob (`core:*`) -- both of which the real CLI
 *    resolves correctly -- was graded a false FAILURE purely on string form. `matchModuleFilter`
 *    is the exact function `lib/orchestrators/orchestrator-utils.js`'s own dispatch uses to decide
 *    which modules a `--module-filter` argument selects; this file must judge agent commands by
 *    the SAME rule, never a second, independently-maintained approximation of it.
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
  // tests_failed shares tests_executed's envelope-side module-attribution shape exactly -- kmp-test
  // still resolves and lists the module it attempted (envelope.modules[]) regardless of whether the
  // task ultimately passed or failed, ground-truth confirmed directly against a real capture.
  if (isRanOutcome(scenario.expected.outcome_kind)) {
    // coverage_threshold_exceeded shares this exact same single-module exclusivity requirement --
    // an earlier revision special-cased it to tolerate envelope.modules.length > 1 (reasoning: a
    // substring --module-filter could sweep in a harmless sibling), but that leniency was itself a
    // real bug: it only checked the TARGET module's own presence + filter-coherence, never that
    // every OTHER reported module was also something the invoked filter would legitimately select
    // -- an adversarial/wrong envelope naming the target PLUS an unrelated third module the filter
    // could never have matched would still have passed. The real fix is scenario selection, not a
    // grader exception: the pinned candidate module's own name has zero substring collision with
    // any other real module in the pinned project (verified against the full module list), so
    // reusing the identical strict check below is both correct and sufficient.
    if (envelope.modules.length !== 1) return false;
    const envelopeModule = normalizeModuleName(envelope.modules[0]?.name);
    if (envelopeModule !== targetModule) return false;
    // typeof guard: matchModuleFilter (unlike normalizeModuleName) assumes a real string `name` and
    // calls `.replace` on it unconditionally -- a malformed envelope (agent-controlled, adversarial
    // input) whose sole module entry has no `name` at all, coinciding with an equally-malformed
    // scenario fixture, would otherwise throw here instead of failing closed like every other
    // adversarial shape this function rejects.
    if (typeof envelopeModule !== 'string') return false;
    if (classification.moduleFilter != null && !matchModuleFilter(envelopeModule, classification.moduleFilter)) return false;
    return true;
  }
  // no_applicable_tests has no envelope-side module data at all (modules[] is required empty, just
  // below) -- there is nothing to corroborate a loose substring/glob filter against, so this branch
  // deliberately stays exact-match fail-closed, unlike the tests_executed branch above.
  if (envelope.modules.length !== 0) return false;
  return classification.moduleFilter != null && normalizeModuleName(classification.moduleFilter) === targetModule;
}

/** Fail-closed helper for `no_applicable_tests`: the invoked `--module-filter` string is the ONLY
 * module-identity signal available (envelope.modules[] is empty by definition for this shape) --
 * usable as a canonical identity only when it is a single literal token, no glob metacharacters
 * (`*`/`?`) and no comma-separated list (see lib/orchestrators/module-filter.js's matchModuleFilter,
 * the real grammar this mirrors). A pattern/list could match zero, one, or many real modules --
 * reporting it as THE observed module would be a guess. Mirrors computeKmpTestTargetMatch's own
 * no_applicable_tests branch, which already treats a plain literal filter as an exact module
 * identity (never fuzzy-matched) for the identical reason. */
function canonicalModuleFilterIdentity(moduleFilter) {
  if (typeof moduleFilter !== 'string' || moduleFilter.length === 0 || moduleFilter === '*') return null;
  if (/[*?,]/.test(moduleFilter)) return null;
  return normalizeModuleName(moduleFilter);
}

/** Validates `envelope.tests`'s own closed-form arithmetic coherence: all 5 counters are
 * non-negative integers, and the task-level `total === passed + failed` (`skipped` is validated
 * separately as always-zero at each derivation branch's own call site, since none of this
 * harness's supported KMP_EVAL_RESULT closed forms can represent a genuine per-individual-test
 * skip). A task-level counter set that doesn't even add up to itself is never trustworthy
 * evidence, independent of what the DERIVED outcome's own total/passed/failed end up being (those
 * come from `individual_total`/`test_failures` -- a different granularity entirely: task-level vs
 * per-test-case). */
function isCoherentTestsCounters(tests) {
  if (tests == null || typeof tests !== 'object' || Array.isArray(tests)) return false;
  const fields = [tests.total, tests.passed, tests.failed, tests.skipped, tests.individual_total];
  if (!fields.every((n) => Number.isInteger(n) && n >= 0)) return false;
  return tests.total === tests.passed + tests.failed;
}

/** Closed-form validation of `moduleEntry.test_failures` for a clean-pass or coverage-gate claim
 * (both mean "every test that ran also passed"): the field being genuinely ABSENT is fine (a real
 * clean envelope simply never adds the key at all), and an explicit EMPTY array is tolerated too
 * (also consistent with "nothing failed") -- but a NON-EMPTY array is real per-test failure detail
 * that directly contradicts the claim, and any OTHER type at all (a string, a number, `null`, ...)
 * is neither a well-formed absence nor a well-formed empty list, so it cannot be trusted to mean
 * "no failures" either -- both read as a contradiction, never silently treated as if the field
 * were simply missing. */
function hasContradictoryTestFailures(moduleEntry) {
  const failures = moduleEntry?.test_failures;
  if (failures === undefined) return false;
  if (!Array.isArray(failures)) return true;
  return failures.length > 0;
}

/** True iff `warnings[]` carries ANY `junit_xml_oversized` entry at all -- per result-rollup.js's
 * own doc comment (the real producer of this warning), every skipped file means
 * `tests.individual_total` undercounts and `test_failures[]` may be incomplete for that task.
 * Deliberately NOT scoped to the observed module: this harness's own scenarios only ever dispatch
 * one module per attempt, so a warning naming a DIFFERENT module is not "an unrelated module's own
 * problem" the way it might be in a genuinely multi-module dispatch -- it is itself an
 * unattributable, incoherent shape (see deriveObservedKmpTestResult's own module-cardinality
 * checks) that cannot be reconciled with a single-module observation without guessing which side
 * of the contradiction to trust. And for `no_applicable_tests` (envelope.modules the empty array),
 * there is no "observed module" to scope a match against at all, yet the warning is exactly as
 * disqualifying: the outcome shape of a `no_test_modules` claim is untrustworthy evidence when
 * this warning is present anywhere in the same envelope. Called once, universally, before any
 * modules.length branching -- see deriveObservedKmpTestResult's own call site. */
function hasOversizedJunitWarning(warnings) {
  return warnings.some((w) => w && w.code === 'junit_xml_oversized');
}

// The closed set of warnings[].code values `lib/orchestrators/coverage-orchestrator.js` and
// `lib/orchestrators/parallel-orchestrator.js` produce that mean the coverage AGGREGATION pipeline
// itself was incomplete, skipped, disabled, unparseable, or drifted -- any of these directly
// contradicts trusting `envelope.coverage`'s own missed_lines/modules_contributing/module_buckets
// as a complete, accurate picture, regardless of how internally self-consistent those fields look
// in isolation. Deliberately does NOT include `coverage_report_write_failed`: that producer's own
// message is explicit that "coverage data in this envelope is still valid -- only the on-disk
// report file failed to write" (docs/envelope-contract.md's identical wording confirms this is the
// one coverage-adjacent warning that names a problem with an OUTPUT ARTIFACT, never the envelope's
// own JSON coverage data).
const COVERAGE_INCOMPLETE_WARNING_CODES = new Set([
  'coverage_report_dispatch_failed',
  'coverage_aggregation_failed',
  'coverage_aggregation_skipped',
  'no_coverage_data',
  'coverage_xml_disabled',
  'coverage_xml_oversized',
  'coverage_parse_failed',
  'coverage_aggregation_drift',
]);

/** Validates `envelope.coverage`'s own internal coherence for a single-module coverage claim, and
 * returns the coherent `{missed_lines, threshold, modules_contributing}` triple, or `null` if any
 * of the coverage block's own internal claims contradict each other, the observed module, or the
 * envelope's own coverage-aggregation warnings. Mirrors `validateKmpEnvelopeForAttempt`'s identical
 * `coverageOk` computation (bucket-exclusivity, exact single-entry `with_data`,
 * `modules_contributing===1`) -- scoped to the OBSERVED module rather than a scenario's expected
 * one, since this function never compares against scenario.expected at all. Only ever called from
 * the `envelope.modules.length === 1` branch -- exactly ONE module was ever dispatched, so
 * `with_data` must name exactly that module, and the other three buckets (which classify modules
 * that WERE dispatched but produced no usable coverage data) must be entirely empty, not merely
 * free of the observed module -- no OTHER real module could legitimately appear in any of them
 * either. `warnings` is checked against `COVERAGE_INCOMPLETE_WARNING_CODES` universally (not
 * scoped to any particular module named inside the warning) -- a coverage claim's own bucket/count
 * fields can look perfectly self-consistent while the aggregation pipeline that PRODUCED them
 * independently reported it never completed. */
function deriveCoherentCoverageFacts(covBlock, err, module, warnings) {
  if (warnings.some((w) => w && COVERAGE_INCOMPLETE_WARNING_CODES.has(w.code))) return null;
  if (covBlock == null || typeof covBlock !== 'object' || Array.isArray(covBlock)) return null;
  if (!Number.isInteger(err.missed_lines) || err.missed_lines < 0) return null;
  if (!Number.isInteger(err.threshold) || err.threshold < 0) return null;
  // The error's own echoed missed_lines must agree with the coverage summary block -- if they
  // disagree, there is no way to tell which one reflects reality without guessing.
  if (covBlock.missed_lines !== err.missed_lines) return null;
  // Exactly one module was ever dispatched (the caller is already inside the modules.length===1
  // branch) -- a coherent claim can never say more than one module "contributed" real data.
  if (covBlock.modules_contributing !== 1) return null;
  const buckets = covBlock.module_buckets;
  const withData = buckets?.with_data;
  if (!Array.isArray(withData) || withData.length !== 1 || normalizeModuleName(withData[0]) !== module) return null;
  const emptyBucketKeys = ['no_xml', 'parse_errored', 'skipped_by_user'];
  if (!emptyBucketKeys.every((key) => Array.isArray(buckets[key]) && buckets[key].length === 0)) return null;
  return { missed_lines: err.missed_lines, threshold: err.threshold, modules_contributing: covBlock.modules_contributing };
}

/**
 * Derives the closed-form canonical facts a kmp-test envelope's OWN content actually shows --
 * never scenario.expected, never a comparison against it, purely a structural reading of
 * already-extracted, already-classified evidence. Returns `null` whenever the envelope's shape
 * can't be attributed to exactly one real outcome without guessing (competing/incoherent error
 * shapes, an unattributable module, missing/malformed per-test detail, incoherent counters, or an
 * execution/plan-mode contradiction) -- the caller (gradeScenarioCondition, via
 * evaluateFinalAnswer) treats `null` as "no observed facts to compare the final answer against,"
 * failing check 8 closed rather than falling back to any expected value.
 * @param {boolean|null|undefined} resultIsError - this attempt's own tool_result-level error flag
 *   (bashResult.resultIsError) -- checked for the identical resultIsError:true+exit_code:0
 *   contradiction validateKmpEnvelopeForAttempt's expected-comparison path already guards against.
 * @returns {null
 *   | {module:string, outcome_kind:'tests_executed', total:number, passed:number, failed:number}
 *   | {module:string, outcome_kind:'tests_failed', total:number, passed:number, failed:number}
 *   | {module:string, outcome_kind:'coverage_threshold_exceeded', total:number, passed:number,
 *       failed:number, missed_lines:number, threshold:number, modules_contributing:number}
 *   | {module:string, outcome_kind:'no_applicable_tests'}}
 */
function deriveObservedKmpTestResult(envelope, classification, resultIsError) {
  // The envelope's own self-reported subcommand must agree with what was actually invoked -- a
  // stale or mismatched tool_result (the command said `parallel`, the attached envelope's own
  // `subcommand` field says something else, e.g. `doctor`) cannot be trusted to describe THIS
  // attempt at all, regardless of how plausible its other fields look. Mirrors
  // validateKmpEnvelopeForAttempt's own identical first check for the expected-comparison path --
  // observed-facts derivation must be no less careful than that.
  if (envelope.subcommand !== classification.subcommand) return null;
  // Execution/plan-mode coherence -- mirrors validateKmpEnvelopeForAttempt's own identical
  // fail-closed allowlist (see that function's own doc comment for the full "wrong-typed value"
  // rationale): the ONLY acceptable states are "field absent" or "field explicitly false". A
  // command with no --dry-run/--list-only in its own text (so it was never excluded earlier as
  // plan-only) paired with an envelope that itself claims plan-only mode must not be trusted.
  if (envelope.dry_run !== undefined && envelope.dry_run !== false) return null;
  if (envelope.parallel?.list_only !== undefined && envelope.parallel?.list_only !== false) return null;
  // resultIsError:true contradicting a CLEAN exit_code:0 claim is wrong under any plausible
  // convention -- same deliberately ONE-directional check as validateKmpEnvelopeForAttempt's own
  // (see that function's own doc comment for why the reverse direction is not asserted).
  if (resultIsError === true && envelope.exit_code === 0) return null;
  // Shared closed-form arithmetic coherence (non-negative integers, total===passed+failed) for
  // ALL branches below -- a task-level counter set that doesn't add up to itself is never
  // trustworthy evidence, independent of which specific outcome shape it's otherwise claiming.
  if (!isCoherentTestsCounters(envelope.tests)) return null;
  // `warnings`/`skipped` must both structurally be arrays -- a real envelope always carries both
  // keys this way (possibly empty), so anything else (absent, wrong-typed) is itself untrustworthy
  // evidence, independent of whether any SPECIFIC entry ends up mattering below.
  if (!Array.isArray(envelope.warnings)) return null;
  if (!Array.isArray(envelope.skipped)) return null;
  // An oversized-XML skip anywhere in the envelope means individual_total/test_failures may be
  // incomplete -- checked here, universally, BEFORE branching on modules.length, so it covers
  // no_applicable_tests (modules:[], no "observed module" to scope a match against at all) exactly
  // as it covers the three count-bearing outcome shapes below (see hasOversizedJunitWarning's own
  // doc comment for why this is deliberately NOT limited to the observed module).
  if (hasOversizedJunitWarning(envelope.warnings)) return null;

  const individualTotal = envelope.tests.individual_total;
  // A genuinely zero task-level total can never legitimately carry individual test cases -- if no
  // task ran at all (total:0), there is nothing for individual_total to count. The REVERSE is not
  // asserted: a real executed task can legitimately have individual_total:0 (e.g. a task with zero
  // real test cases of its own), so this is deliberately one-directional, exactly like the
  // resultIsError/exit_code check above.
  if (envelope.tests.total === 0 && individualTotal !== 0) return null;

  if (envelope.modules.length === 1) {
    const module = normalizeModuleName(envelope.modules[0]?.name);
    if (typeof module !== 'string') return null;
    // A module the envelope itself also lists as skipped cannot simultaneously be the module this
    // branch is about to report real test facts FOR -- "executed with real results" and "skipped
    // entirely" are mutually exclusive claims about the SAME module within one attempt. Scoped to
    // a `changed` dispatch or a single-leg `parallel` dispatch specifically: a genuine `test_type:
    // "all"` dispatch (legsForAll, MIN_LEGS_FOR_ALL === 3) can legitimately execute a module in one
    // leg while a DIFFERENT leg skips that same module for an unrelated platform-specific reason,
    // so multi-leg envelopes are deliberately exempted from this check.
    const isSingleTargetDispatch = classification.subcommand === 'changed' || envelope.parallel?.legs?.length === 1;
    if (isSingleTargetDispatch && envelope.skipped.some((s) => s && normalizeModuleName(s.module) === module)) return null;
    // A genuine per-individual-test skip has no representation in any closed form below (the
    // KMP_EVAL_RESULT schema itself carries no `skipped` key) -- with any skipped case present,
    // `passed`/`failed` could not be derived from `individualTotal` alone without guessing which
    // of the skipped cases would otherwise have counted as which.
    if (envelope.tests.skipped !== 0) return null;
    // A genuine `parallel` envelope's own internal coherence (leg shapes, per-leg exit/failed
    // agreement, and both aggregate-cardinality invariants against envelope.tests.total/failed) is
    // independently re-checked here via the SAME validator the rest of this file already trusts --
    // evidenceWellFormed's own parallelEvidenceInvalid flag only ever runs this check for an
    // on-target, "ran"-outcome-expecting attempt (see that flag's own doc comment above
    // evaluateKmpTestAttempt), so a wrong-module, or wrong-outcome-kind-for-THIS-scenario, attempt
    // could otherwise reach this point with self-contradictory parallel.legs[] data untouched --
    // deriveObservedKmpTestResult must not inherit that same narrow scoping, since its own facts
    // feed check 8 regardless of whether checks 5/6 already failed for an unrelated reason. A
    // `changed` envelope never carries a `parallel` block at all (real production invariant -- see
    // changedEvidenceInvalid's own doc comment) -- scoped to `parallel` specifically, mirroring
    // parallelEvidenceInvalid's own identical `classification.subcommand !== 'changed'` guard.
    if (classification.subcommand !== 'changed' && !validateParallelEvidence(envelope, classification.testType)) return null;

    if (envelope.errors.length === 0) {
      // A genuinely clean run -- every individual test that ran also passed. Cross-checked against
      // the task-level failed counter too -- an envelope claiming no error entries while its own
      // tests.failed counter disagrees is self-contradictory, not real clean-pass evidence. A
      // clean-pass claim must also not carry stray per-test failure detail for this module.
      if (envelope.tests.failed !== 0) return null;
      if (hasContradictoryTestFailures(envelope.modules[0])) return null;
      // The envelope's own exit_code must agree with classifyExitCode's real, single-source-of-truth
      // mapping (lib/envelope/exit-codes.js -- the SAME function every real orchestrator's own
      // exit-code decision goes through) for a clean run with no errors: SUCCESS (0). An envelope
      // otherwise reading "clean" but reporting a nonzero exit_code contradicts itself.
      if (envelope.exit_code !== classifyExitCode(envelope.errors, { testsFailed: 0 })) return null;
      return { module, outcome_kind: 'tests_executed', total: individualTotal, passed: individualTotal, failed: 0 };
    }

    const coverageErrors = envelope.errors.filter((e) => e && e.code === 'coverage_threshold_exceeded');
    if (envelope.errors.length === 1 && coverageErrors.length === 1) {
      // A coverage-gate failure is still a genuinely clean TEST pass underneath (see this
      // function's own coverage_threshold_exceeded return, below) -- the task-level failed counter
      // must agree, and the same stray-failure-detail contradiction applies as the clean-run
      // branch above.
      if (envelope.tests.failed !== 0) return null;
      if (hasContradictoryTestFailures(envelope.modules[0])) return null;
      const err = coverageErrors[0];
      const coverageFacts = deriveCoherentCoverageFacts(envelope.coverage, err, module, envelope.warnings);
      if (coverageFacts == null) return null;
      // The error's own echoed threshold must agree with the --min-missed-lines value actually
      // invoked on THIS command -- a stale/mismatched tool_result whose error names a different
      // threshold than the one this specific command line asked for cannot be trusted, regardless
      // of the error's own internal coverage self-consistency (mirrors
      // validateKmpEnvelopeForAttempt's identical command-vs-envelope coherence check).
      if (classification.minMissedLines == null || String(coverageFacts.threshold) !== classification.minMissedLines) return null;
      if (envelope.exit_code !== classifyExitCode(envelope.errors, { testsFailed: 0 })) return null;
      return {
        module, outcome_kind: 'coverage_threshold_exceeded',
        total: individualTotal, passed: individualTotal, failed: 0,
        missed_lines: coverageFacts.missed_lines, threshold: coverageFacts.threshold, modules_contributing: coverageFacts.modules_contributing,
      };
    }

    const moduleFailedErrors = envelope.errors.filter((e) => e && e.code === 'module_failed' && normalizeModuleName(e.module) === module);
    if (envelope.errors.length === 1 && moduleFailedErrors.length === 1) {
      const soleError = moduleFailedErrors[0];
      // A genuine test failure never carries this key at all -- result-rollup.js only ever ADDS it,
      // set to the literal boolean true, for a pre-test (setup/compile) failure where the target
      // task's tests never actually ran (see evaluateGradleAttempt's identical, longer-standing
      // reasoning for the Gradle-provider equivalent of this same discriminator). Required genuine
      // ABSENCE, not merely inequality with true, so a wrong-typed value is rejected identically.
      if ('setup_failed' in soleError) return null;
      if (typeof soleError.task !== 'string' || soleError.task.length === 0) return null;
      // A genuine module-task failure requires a positive task-level failed count -- a
      // `module_failed` error entry alongside `tests.failed:0` is self-contradictory (the error
      // claims the task failed, the aggregate counter claims it didn't). Explicit Number.isInteger
      // guard (not a loose `> 0` comparison) -- mirrors this file's own established idiom
      // everywhere else, and avoids JS's numeric-coercion surprises on a wrong-typed value.
      if (!Number.isInteger(envelope.tests.failed) || envelope.tests.failed === 0) return null;
      const failures = envelope.modules[0].test_failures;
      if (!Array.isArray(failures) || failures.length === 0 || !failures.every(isWellFormedTestFailureEntry)) return null;
      if (failures.length > individualTotal) return null; // impossible shape -- more real failures than total cases
      if (envelope.exit_code !== classifyExitCode(envelope.errors, { testsFailed: envelope.tests.failed })) return null;
      return { module, outcome_kind: 'tests_failed', total: individualTotal, passed: individualTotal - failures.length, failed: failures.length };
    }

    return null; // competing or unrecognized error shape -- fail closed rather than guess
  }

  if (envelope.modules.length === 0) {
    // Real production never sets `parallel` on this early-exit at all -- see
    // validateParallelEvidence's own sibling comment on this exact invariant. A `parallel` block
    // present alongside an empty modules[] is self-contradictory: no way to tell which half lies.
    if (envelope.parallel !== undefined) return null;
    // `caused_by_filter:true` specifically -- the ONLY no_test_modules shape this closed form
    // models (an agent-invoked --module-filter resolving to zero modules; the OTHER real shape,
    // a project genuinely lacking any test infrastructure at all, is a structurally different fact
    // this corpus's own no_applicable_tests scenario never represents -- see
    // lib/envelope/exit-codes.js's own CONFIG_ERROR_CODES/ENV_ERROR_CODES split).
    const noTestErrors = envelope.errors.filter((e) => e && e.code === 'no_test_modules' && e.caused_by_filter === true);
    if (envelope.errors.length !== 1 || noTestErrors.length !== 1) return null;
    // A genuine "nothing resolved" claim must carry all-zero counters -- any nonzero value here
    // directly contradicts "no applicable tests were ever found or run."
    if (envelope.tests.total !== 0 || envelope.tests.passed !== 0 || envelope.tests.failed !== 0
      || envelope.tests.skipped !== 0 || individualTotal !== 0) return null;
    if (envelope.exit_code !== classifyExitCode(envelope.errors, { testsFailed: 0 })) return null;
    const module = canonicalModuleFilterIdentity(classification.moduleFilter);
    if (module == null) return null;
    return { module, outcome_kind: 'no_applicable_tests' };
  }

  return null; // more than one dispatched module -- no single module can be safely attributed
}

/** @returns {null | {provider:'kmp_test', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, intendedTargetMatches:boolean,
 *   outcomeMatches:boolean, parallelEvidenceInvalid:boolean, observedResult:object|null}}
 * @param {string|null|undefined} decision - this attempt's own resolved policy decision
 *   (`'allow'`/`'deny'`/`null`, from junit-evidence.mjs's attributeCondition), or `undefined` when
 *   the JUnit-evidence-attribution mechanism was never enabled for this condition at all
 *   (no_applicable_tests scenarios, calibrate, smoke) -- deliberately distinct from `null`
 *   (mechanism enabled, but this attempt's own decision record was missing/incoherent, itself
 *   already surfaced separately as a whole-condition captureIncomplete flag). Only `'deny'`/`null`
 *   exclude the attempt here; `undefined` never gates anything, since there is no decision data to
 *   gate on when the mechanism was never enabled. Do not "simplify" the caller's lookup with a
 *   `?? null` fallback -- that would collapse this exact distinction and break `no_applicable_tests`
 *   scenarios (see gradeScenarioCondition's own comment on this). */
function evaluateKmpTestAttempt(bashResult, scenario, decision) {
  const classification = classifyBashCommand(bashResult.command);
  // Scenario-scoped (round-9 fix): `changed` only ever becomes a second accepted subcommand for a
  // scenario that actually declares `expected.changed`. For the other 5 scenarios (expectsChanged
  // false) this reduces to the exact prior `!== 'parallel'` gate, byte-for-byte -- a `changed`
  // command in an unrelated scenario's transcript stays excluded exactly like any other
  // non-`parallel` subcommand, so nothing about their behavior changes. `parallel` stays
  // universally accepted -- even for a changed-shaped scenario -- so it's still EVALUATED (visible
  // to check 7's own diagnostic below); isTerminalEligibleAttempt is what excludes it from ever
  // becoming terminal there.
  const expectsChanged = scenario.expected.changed != null;
  const acceptedSubcommands = expectsChanged ? ['parallel', 'changed'] : ['parallel'];
  if (classification.kind !== 'kmp-test' || !acceptedSubcommands.includes(classification.subcommand)) return null;
  // A round-5 fresh adversarial review reproduced three real bugs from treating a --dry-run
  // invocation identically to a real execution: (a) it inflated testInvocationsTotal/retries when
  // followed by a real run; (b) a real, correct run followed by a LATER --dry-run call became
  // "terminal" purely by running last, flipping a genuinely correct result to a reported failure;
  // (c) it could be counted as a JUnit producer and trigger a false ambiguity, even though a
  // dry-run never actually touches the Gradle task or its JUnit XML. Excluded here, at the
  // earliest point -- identical treatment to doctor/describe above -- so it never becomes a
  // candidate attempt for evidence, terminal selection, retries, first_useful_signal, or JUnit
  // attribution anywhere downstream.
  if (classification.isPlanOnly) return null;
  // A policy-denied attempt (or one whose own decision record is missing/incoherent while the
  // mechanism IS enabled) never actually executed -- excluded the same way a plan-only call is,
  // never counted as a test-execution attempt at all. Still fully visible in the unrelated,
  // already-existing tool-call/hook_deny_count metrics (countHookEvents) -- this is a
  // metrics/grading distinction, not a visibility one.
  if (decision === 'deny' || decision === null) return null;

  const envelope = extractKmpTestEnvelope(bashResult.resultContent);
  const malformed = bashResult.resultContent != null && envelope == null;
  const hasEvidence = envelope != null;

  const targetMatches = hasEvidence && computeKmpTestTargetMatch(envelope, classification, scenario);

  const outcomeMatches = hasEvidence && targetMatches
    && validateKmpEnvelopeForAttempt(envelope, classification.subcommand, bashResult.resultIsError, scenario, classification.testType, classification.minMissedLines);

  // A systematic-closure review found this: `validateParallelEvidence` rejecting a genuinely
  // incoherent `parallel` block was previously laundered ONLY through `outcomeMatches`, which check
  // 4 (authoritative_evidence_well_formed) never inspects -- that check only looks at `malformed`
  // (whether the envelope's TOP-LEVEL shape parsed at all). The result: a self-contradictory tool
  // JSON output (e.g. a leg missing a required field) read as "well-formed evidence that simply
  // didn't match the expected outcome" -- a valid negative result -- when it actually means the
  // tool's own output cannot be trusted at all. Exactly the same class of problem
  // `harnessEvidenceAmbiguous` already exists to catch for JUnit-XML provenance (see that field's
  // own doc comment below), just for a different evidence shape. Computed independently of
  // `outcomeMatches` (which ALSO folds in ordinary count-mismatches against a legitimately
  // different real outcome -- those must stay a plain negative result, not a harness defect) by
  // re-checking `validateParallelEvidence` directly, scoped to only fire when the envelope
  // otherwise looks like real, on-target, subcommand-matching evidence for a scenario that expects
  // `parallel` to be present at all.
  const parallelEvidenceInvalid = hasEvidence && targetMatches && envelope.subcommand === classification.subcommand
    && classification.subcommand !== 'changed'
    && isRanOutcome(scenario.expected.outcome_kind)
    && !validateParallelEvidence(envelope, classification.testType);

  // The `changed`-specific sibling of parallelEvidenceInvalid, above. A real `changed` envelope
  // never carries a `parallel` block at all (ground truth independently confirmed live via a
  // direct hasOwnProperty check on 3 real runs, despite changed.md's own stale doc example showing
  // one) -- true when EITHER the changed{} block itself is structurally malformed OR the envelope
  // also carries that production-impossible parallel block, both proof of mismatched/incoherent
  // evidence (e.g. a stale or wrongly-correlated tool_result), never merely "a different, wrong
  // answer". Deliberately excludes `targetMatches` from this gate -- a post-open-PR review found a
  // real bug here: with `targetMatches` in the conjunct, a WRONG-module attempt whose changed{}
  // block was ALSO structurally malformed read as `changedEvidenceInvalid:false` (short-circuited
  // before the malformed-check ever ran), so `authoritative_evidence_well_formed` came back `true`
  // -- promoting untrustworthy, garbage evidence as if it were an ordinary, trustworthy negative
  // (wrong-target) result and silently defeating this integrity gate. Structural well-formedness of
  // the evidence must be judged independently of whether the target happens to match. This does not
  // change the WRONG-module + WELL-FORMED case: that combination still correctly falls through to
  // fail only via check 5 (authoritative_target_matches_expected), exactly as before.
  const changedEvidenceInvalid = hasEvidence && envelope.subcommand === classification.subcommand
    && classification.subcommand === 'changed' && expectsChanged
    && (!isWellFormedChangedBlock(envelope.changed) || envelope.parallel !== undefined);

  // Whether this attempt was even ATTEMPTING to check the expected module, independent of
  // whether its response was well-formed -- derived from the INVOKED --module-filter (absent
  // means "every module, including the target"), never from the response content. Distinct from
  // `targetMatches` (which requires real, coherent, uniquely-attributable evidence) so that
  // `terminal` selection (below, in gradeScenarioCondition) can tell "a later attempt that never
  // even tried to check the target module" apart from "a later attempt that DID try, but its
  // response was malformed or incoherent" -- only the former should be excluded from contention
  // for "terminal."
  //
  // Mirrors `computeKmpTestTargetMatch`'s own outcome_kind split exactly, for the identical
  // reason: for `tests_executed`, via the SAME `matchModuleFilter` real-CLI semantics (not
  // exact-string equality -- a genuinely on-target short/glob filter must not be silently
  // excluded from terminal contention, letting an unrelated LATER attempt win by default). For
  // `no_applicable_tests`, the ORIGINAL exact-string comparison -- this branch has no envelope-
  // side module data to corroborate a loose filter against (see computeKmpTestTargetMatch's own
  // comment), so a later attempt using a shorter/glob filter must NOT be treated as "also
  // intended" here, or it can silently steal terminal selection away from a genuinely correct
  // earlier exact-filter attempt and flip a real success to a false failure. Confirmed as a real,
  // reproduced regression (not merely a hypothetical) when this branch was first written
  // outcome_kind-agnostic: a valid `--module-filter app` attempt followed by a later
  // `--module-filter a*` attempt (same evidence shape) incorrectly became terminal and flipped
  // `success` from true to false, purely because the later attempt's looser filter also
  // "intended" the target under matchModuleFilter semantics -- exactly the asymmetry
  // `computeKmpTestTargetMatch` was always careful to avoid.
  const targetModule = normalizeModuleName(scenario.expected.module);
  const intendedTargetMatches = classification.moduleFilter == null || (
    isRanOutcome(scenario.expected.outcome_kind)
      // typeof guard: matchModuleFilter calls `.replace` on its `name` argument unconditionally,
      // unlike normalizeModuleName's own safe passthrough for a non-string value.
      ? typeof targetModule === 'string' && matchModuleFilter(targetModule, classification.moduleFilter)
      : normalizeModuleName(classification.moduleFilter) === targetModule
  );

  // Best-effort structural derivation, gated only on an envelope actually existing to read --
  // deriveObservedKmpTestResult is independently fail-closed on its own incoherent/uncanonicalizable
  // shapes (see its own doc comment). The caller (gradeScenarioCondition) only ever trusts this
  // field once it has ALSO confirmed evidenceWellFormed (hasEvidence && !malformed &&
  // !parallelEvidenceInvalid && !changedEvidenceInvalid) for whichever attempt becomes terminal.
  const observedResult = hasEvidence ? deriveObservedKmpTestResult(envelope, classification, bashResult.resultIsError) : null;

  return {
    provider: 'kmp_test', subcommand: classification.subcommand, bashIndex: bashResult.index, resultIndex: bashResult.resultIndex,
    hasEvidence, malformed, targetMatches, intendedTargetMatches, outcomeMatches, parallelEvidenceInvalid, changedEvidenceInvalid, observedResult,
  };
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

/**
 * Scans `resultContent` directly for EVERY status line matching `task` -- not just the first, the
 * way `classifyTaskExecutionMode` (`lib/orchestrators/parallel/result-rollup.js`, deliberately left
 * unmodified here -- this function duplicates its matching grammar rather than touching that
 * module's own, different real-envelope-construction contract) is built to return via its own bare,
 * non-global `.exec()` call. Returns the closed SET of distinct execution states found (duplicate
 * occurrences of the identical state collapse, since the return value is a `Set`). A real Gradle
 * invocation prints exactly one terminal status line per task -- TWO OR MORE distinct states
 * collected for the SAME target task within one attempt's output is therefore an impossible
 * real-world shape (e.g. a stale/adversarial tool_result, or two genuinely different task runs
 * concatenated) -- exposing that ambiguity directly, as a multi-member set, is what lets
 * `deriveObservedGradleResult` fail closed on it instead of silently trusting whichever status
 * happened to be matched first. */
function collectTaskExecutionStates(resultContent, task) {
  const escaped = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('Task\\s+' + escaped + '(?:\\s+(UP-TO-DATE|FROM-CACHE|NO-SOURCE|SKIPPED|FAILED))?\\s*$', 'gm');
  const states = new Set();
  let m;
  while ((m = re.exec(resultContent)) !== null) {
    const suffix = m[1];
    if (!suffix) states.add('fresh');
    else if (suffix === 'UP-TO-DATE') states.add('up_to_date');
    else if (suffix === 'FROM-CACHE') states.add('from_cache');
    else if (suffix === 'NO-SOURCE') states.add('no_source');
    else if (suffix === 'SKIPPED') states.add('skipped_by_gradle');
    else if (suffix === 'FAILED') states.add('failed');
  }
  return states;
}

/** True iff `states` is EXACTLY the given set of state names (same size, every named state
 * present) -- never a subset/superset match. */
function statesEqual(states, names) {
  return states.size === names.length && names.every((n) => states.has(n));
}

/**
 * Derives the closed-form canonical facts a Gradle attempt's OWN already-parsed evidence actually
 * shows -- the already-parsed footer exit code, the target task's own closed set of distinct
 * execution states (see `collectTaskExecutionStates`, above -- never a single first-match mode
 * value, which cannot by itself prove no OTHER, contradictory status line exists for the same
 * task), and the JUnit evidence already resolved and attributed to THIS attempt by
 * junit-evidence.mjs. Never reads scenario.expected.gradle.tests/exit_code/marker. `module` is
 * taken from the scenario's own task-to-module binding (what makes this attempt a Gradle
 * "candidate" for this scenario at all -- see evaluateGradleAttempt's own `invokedAllowed` gate
 * above) purely as an identity label, never to judge correctness -- a raw Gradle task name never
 * structurally announces its own module the way a kmp-test envelope's `modules[]` does. Returns
 * `null` when the observed shape doesn't cleanly resolve to exactly one of the three
 * Gradle-provable outcomes -- including whenever `taskStates` holds anything other than one of the
 * three closed, allowed combinations below; Gradle can never prove coverage_threshold_exceeded at
 * all (--min-missed-lines is a kmp-test-only concept -- see isTerminalEligibleAttempt, which
 * already excludes Gradle from ever becoming terminal for that outcome_kind).
 */
function deriveObservedGradleResult(module, taskStates, observedExitCode, resolvedEvidence, taskGenuinelyFailed) {
  if (typeof module !== 'string') return null;
  if (taskStates.size === 0) return null; // no status line found for the target task at all
  if (statesEqual(taskStates, ['no_source']) && observedExitCode === 0) {
    // A genuine NO-SOURCE task can never ALSO be genuinely failed -- "nothing to run" and "ran and
    // failed" describe mutually exclusive real facts about the SAME target task (classifyTaskResults
    // is the unanchored, authoritative failure signal -- see evaluateGradleAttempt's own doc
    // comment on why a single first-match mode value is unreliable for detecting a genuine failure).
    if (taskGenuinelyFailed) return null;
    // Only two states are compatible with a genuine NO-SOURCE claim: no JUnit-evidence record at
    // all, or an explicit 'no_xml' resolution -- a real NO-SOURCE task never produces JUnit-XML
    // output, so 'ok' (real, resolved XML), 'integrity_error', and 'conflict' are all equally
    // incompatible with it, not merely 'ok'.
    if (resolvedEvidence !== undefined && resolvedEvidence?.status !== 'no_xml') return null;
    return { module, outcome_kind: 'no_applicable_tests' };
  }
  // Guard the shape of resolvedEvidence.junit BEFORE destructuring it -- an adversarial/malformed
  // `{status:'ok'}` record with no real junit object at all (or a non-object one) must fail closed
  // here, never throw.
  const junit = resolvedEvidence?.status === 'ok' ? resolvedEvidence.junit : null;
  if (junit != null && typeof junit === 'object' && !Array.isArray(junit)) {
    const { total, passed, failed } = junit;
    if (!Number.isInteger(total) || total < 0) return null;
    if (!Number.isInteger(passed) || passed < 0) return null;
    if (!Number.isInteger(failed) || failed < 0) return null;
    // Every real test case counts toward exactly one of passed/failed -- a JUnit summary where
    // they don't sum to the total is internally incoherent, not real evidence.
    if (passed + failed !== total) return null;
    // A genuinely successful execution is EXACTLY one of these three single-member states -- never
    // a mix (a task is either freshly executed, up-to-date, or from-cache; never two of those
    // simultaneously for one invocation).
    const isSingleExecutedState = ['fresh', 'up_to_date', 'from_cache'].some((s) => statesEqual(taskStates, [s]));
    if (observedExitCode === 0 && isSingleExecutedState) {
      // BUILD SUCCESSFUL contradicted by a real JUnit failure, or by the task's own independent
      // FAILED classification -- Gradle does not report a task successful while it genuinely
      // failed, whichever signal is checked.
      if (failed !== 0 || taskGenuinelyFailed) return null;
      return { module, outcome_kind: 'tests_executed', total, passed, failed };
    }
    // A genuine task failure's own status line(s) reliably classify as EXACTLY one of two closed
    // combinations: `{failed}` alone (the FAILED line matched directly, with no preceding bare
    // announcement), or `{fresh, failed}` together (the common real-world case -- Gradle prints a
    // BARE "> Task <name>" announcement line FIRST, since the task also produces console output
    // for the JUnit failure reporting, and only prints the terminal "> Task <name> FAILED" line
    // AFTER -- see this function's own call site in evaluateGradleAttempt for the full
    // ground-truth-confirmed rationale). Any OTHER combination -- a third state present alongside
    // `failed` (e.g. `no_source`/`up_to_date` genuinely coexisting with a FAILED line for the SAME
    // task, an impossible-in-real-Gradle but adversarially-constructible shape), or `failed` absent
    // entirely -- means the task's own status lines do not agree on a real, singular failure, and
    // no outcome can be safely derived from them, regardless of what taskGenuinelyFailed/
    // observedExitCode otherwise say.
    const isFailurePattern = statesEqual(taskStates, ['failed']) || statesEqual(taskStates, ['fresh', 'failed']);
    if (observedExitCode === 1 && taskGenuinelyFailed && isFailurePattern) {
      // A genuinely failed task contradicted by zero real JUnit failures -- the task-failure
      // signal and its own JUnit detail must agree on there being an actual failing case.
      if (failed === 0) return null;
      return { module, outcome_kind: 'tests_failed', total, passed, failed };
    }
  }
  return null;
}

/** @returns {null | {provider:'gradle', bashIndex:number, resultIndex:number|null,
 *   hasEvidence:boolean, malformed:boolean, targetMatches:boolean, intendedTargetMatches:boolean,
 *   outcomeMatches:boolean, observedResult:object|null}}
 * @param {string|null|undefined} decision - see evaluateKmpTestAttempt's identical parameter doc.
 * @param {object|undefined} resolvedEvidence - this attempt's own resolved JUnit-evidence status
 *   from junit-evidence.mjs's attributeCondition: `{status:'ok', junit:{total,passed,failed}}` |
 *   `{status:'no_xml'}` | `{status:'integrity_error', reason}` | `{status:'conflict'}` | `undefined`
 *   (decision wasn't 'allow', this wasn't a Gradle-relevant attempt, or the mechanism is disabled).
 *   Per-attempt, keyed by tool_use_id -- never a pooled condition-wide snapshot. */
function evaluateGradleAttempt(bashResult, scenario, decision, resolvedEvidence) {
  const classification = classifyBashCommand(bashResult.command);
  if (classification.kind !== 'gradle') return null;
  // Same planning-vs-execution exclusion as the kmp-test path above -- a Gradle `--dry-run`
  // invocation reports only what tasks WOULD run, never their real outcome or any real JUnit XML.
  if (classification.isPlanOnly) return null;
  const g = scenario.expected.gradle;
  const invokedAllowed = classification.taskTokens.some((t) => g.allowed_invocations.includes(t));
  if (!invokedAllowed) return null;
  // See evaluateKmpTestAttempt's identical check and doc comment -- a denied (or
  // missing/incoherent-decision) attempt never actually executed.
  if (decision === 'deny' || decision === null) return null;

  const hasEvidence = typeof bashResult.resultContent === 'string' && bashResult.resultContent.length > 0;
  if (!hasEvidence) {
    return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: false, malformed: false, targetMatches: true, intendedTargetMatches: true, outcomeMatches: false, observedResult: null };
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
  let observedResult = null;
  if (!malformed) {
    // This attempt's OWN resolved JUnit-evidence status (junit-evidence.mjs's attributeCondition,
    // keyed by tool_use_id -- replaces the old pooled per-condition snapshot entirely). Only
    // status:'ok' can ever satisfy outcomeMatches -- 'no_xml' (no XML found at all),
    // 'integrity_error' (real XML, but not trustworthy: a skip this path can't count, an
    // oversized/unreadable file, or the capture bounds were exceeded), 'conflict' (a proven
    // same-assistant-turn concurrent producer), and `undefined` (no evidence record at all) all
    // correctly fail closed here -- each is separately surfaced as its own distinct
    // gradleJunitEvidenceUnreliable/gradleJunitEvidenceCaptureIncomplete/harnessEvidenceAmbiguous
    // signal by gradeScenarioCondition, never conflated with a legitimate wrong-answer result.
    // CodeRabbit nitpick (PR #411 review): hoisted out of the tests_executed/tests_failed branches
    // below -- both consumed an IDENTICAL computation, previously duplicated verbatim. Computed
    // unconditionally (also for no_applicable_tests, where it is simply unused) -- `g.tests` is
    // optional-chained since it does not exist at all on a no_applicable_tests contract.
    const junitOk = resolvedEvidence?.status === 'ok'
      && resolvedEvidence.junit.total === g.tests?.total
      && resolvedEvidence.junit.passed === g.tests?.passed
      && resolvedEvidence.junit.failed === g.tests?.failed;
    // Computed unconditionally (not just inside the tests_failed branch below, where the ONLY
    // consumer used to live) -- deriveObservedGradleResult, below, needs the REAL observed outcome
    // shape regardless of what THIS scenario happens to expect, so it can no longer be gated behind
    // an `if (scenario.expected.outcome_kind === 'tests_failed')` branch the way it used to be. Pure
    // function of already-available data; computing it here changes no existing behavior.
    //
    // Deliberately does NOT reuse `mode` (classifyTaskExecutionMode's own single-match `$`-anchored
    // regex) to decide "did the task fail" -- ground-truth confirmed directly against a real
    // `:lint:test` BUILD FAILED capture that this is unreliable for exactly this outcome: Gradle
    // prints a BARE "> Task :lint:test" announcement line (since the task produces console output
    // -- the JUnit failure reporting) FIRST, and only prints the terminal "> Task :lint:test
    // FAILED" line AFTER. `classifyTaskExecutionMode`'s bare (non-global) `.exec()` returns only
    // the FIRST match -- the suffix-less announcement -- misclassifying a genuinely failed task as
    // 'fresh'. Real kmp-test envelopes never hit this gap because parallel-orchestrator.js's own
    // pipeline reconciles it (a task classifyTaskResults says 'failed' is PROMOTED into the
    // 'failed' execution bucket regardless of what classifyTaskExecutionMode alone found) --
    // `classifyTaskResults` (an unanchored search that finds a terminal FAILED line wherever it
    // appears, imported directly rather than re-derived as a second, independently-maintained
    // approximation of the same rule) is that same authoritative signal, reused here directly. It
    // ALSO correctly rejects the inverse false-positive -- a target task that itself succeeded
    // (mentioned, no FAILED line) while an unrelated LATER task in the same leg failed -- since
    // `taskMentioned` being true skips its own defense-in-depth failed-promotion branch.
    const taskGenuinelyFailed = classifyTaskResults(bashResult.resultContent, '', [g.evidence_task], observedExitCode ?? 0).get(g.evidence_task) === 'failed';
    // coverage_threshold_exceeded shares tests_executed's Gradle-side claim byte-for-byte: a raw
    // Gradle task has no coverage-threshold concept at all (--min-missed-lines is a kmp-test-only
    // flag), so its own contract (schemas.mjs reuses GRADLE_CONTRACT_KEYS_TESTS_EXECUTED verbatim)
    // is just an ordinary clean, executed test-task pass -- the identical claim, identical check.
    if (scenario.expected.outcome_kind === 'tests_executed' || scenario.expected.outcome_kind === 'coverage_threshold_exceeded') {
      const executedModes = new Set(['fresh', 'up_to_date', 'from_cache']);
      outcomeMatches = observedExitCode === (g.exit_code ?? 0) && executedModes.has(mode) && junitOk;
    } else if (scenario.expected.outcome_kind === 'tests_failed') {
      // The Gradle-provider mirror of tests_executed's own branch above -- identical JUnit-evidence
      // consumption (junitOk), identical fail-closed treatment of every non-'ok' resolvedEvidence
      // status, `g.exit_code` schema-required to be exactly 1 (never defaulted via `?? 0`).
      //
      // Step 17's compile/setup-failure case (the target task never even starts -- no status line
      // for it anywhere) is NOT distinguished by `taskGenuinelyFailed` alone: classifyTaskResults'
      // own defense-in-depth branch (legExit!==0 && !buildSucceeded && !taskMentioned) empirically
      // ALSO labels an un-mentioned task 'failed' in this case (confirmed directly: a genuine
      // :lint:compileKotlin-only failure still classifies :lint:test as 'failed'), by original
      // design elsewhere in this codebase (WS-1: never silent-pass an unmentioned task on a failed
      // leg). `junitOk` is what actually closes this case here: a task that never ran can never have
      // produced real, matching JUnit XML, so `resolvedEvidence` reads 'no_xml' and `junitOk` is
      // false regardless of what `taskGenuinelyFailed` says -- BUILD FAILED plus a real nonzero
      // exit_code plus an over-inclusive 'failed' label is still never sufficient on its own.
      outcomeMatches = observedExitCode === g.exit_code && taskGenuinelyFailed && junitOk;
    } else {
      // no_applicable_tests never depends on the JUnit-evidence-attribution mechanism at all -- the
      // NO-SOURCE marker is parsed from THIS attempt's own resultContent; the mechanism is not even
      // enabled for this outcome_kind (matrix-runner.mjs's runScenarioMatrix never sets
      // junitEvidenceEnabled for it).
      outcomeMatches = observedExitCode === g.exit_code && mode === 'no_source' && g.marker === 'NO-SOURCE';
    }
    // deriveObservedGradleResult needs the target task's own COMPLETE set of distinct status
    // lines, not just `mode`'s single first-match value (see collectTaskExecutionStates's own doc
    // comment for why a single value can never prove no OTHER, contradictory status line exists
    // for the same task) -- computed here, additionally, without touching `mode`/`modes` above,
    // which check 6's own outcomeMatches formula (untouched) still consumes as before.
    const taskStates = collectTaskExecutionStates(bashResult.resultContent, g.evidence_task);
    observedResult = deriveObservedGradleResult(normalizeModuleName(scenario.expected.module), taskStates, observedExitCode, resolvedEvidence, taskGenuinelyFailed);
  }

  return { provider: 'gradle', bashIndex: bashResult.index, resultIndex: bashResult.resultIndex, hasEvidence: true, malformed, targetMatches, intendedTargetMatches, outcomeMatches, observedResult };
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
// unambiguous, parses as valid JSON, and exactly matches the module/outcome_kind/counts actually
// OBSERVED on the scenario's own terminal attempt (see deriveObservedKmpTestResult/
// deriveObservedGradleResult, and the `observedResult` field the attempt objects
// evaluateKmpTestAttempt/evaluateGradleAttempt return) -- never scenario.expected directly, and
// never terminal.outcomeMatches (itself already a comparison against scenario.expected; reusing it
// here would just reproduce the same defect in a different shape). Consistency with the evidence
// and correctness for the scenario are two independent questions: an agent that honestly reports a
// wrong-for-the-scenario result (wrong module, wrong outcome, wrong counts) still passes THIS
// check; only checks 5/6 (authoritative_target_matches_expected/authoritative_outcome_matches_
// expected) and the overall `success` formula care whether the observed result was the CORRECT
// one. Evidence that isn't well-formed, or whose facts can't be canonicalized without guessing,
// yields no observedResult at all -- this check then fails closed, regardless of what the final
// answer claims.
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

// Shared by BOTH 'tests_executed' and 'tests_failed' -- the agent's own final-answer block has an
// identical shape either way (it reports the same real total/passed/failed triple it observed);
// only the VALUES (failed:0 vs failed>=1) and the compared outcome_kind differ.
const KMP_EVAL_RESULT_TESTS_EXECUTED_KEYS = new Set(['module', 'outcome_kind', 'total', 'passed', 'failed']);

// coverage_threshold_exceeded's own closed key set -- deliberately NOT the tests_executed shape:
// the whole point of this scenario is that the agent correctly read and reported the coverage-gate
// numbers, which check 8 cannot verify at all unless the block actually carries them.
const KMP_EVAL_RESULT_COVERAGE_THRESHOLD_KEYS = new Set(['module', 'outcome_kind', 'total', 'passed', 'failed', 'missed_lines', 'threshold', 'modules_contributing']);
const KMP_EVAL_RESULT_NO_APPLICABLE_KEYS = new Set(['module', 'outcome_kind']);
const KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS = ['total', 'passed', 'failed'];

/** Strictly validates a parsed `KMP_EVAL_RESULT` block against the terminal attempt's OWN observed
 * facts (`observedResult`, derived by deriveObservedKmpTestResult/deriveObservedGradleResult from
 * already-parsed, already-attributed evidence -- never against scenario.expected) -- EXACT key set
 * (no missing, no extra -- an agent hedging with additional fields is rejected, not silently
 * ignored), exact module identity (boundary-safe via `normalizeModuleName`, same colon-prefix
 * tolerance as everywhere else in this file), exact `outcome_kind`, and for
 * `tests_executed`/`tests_failed` (identical block shape either way), exact integer
 * total/passed/failed matching the REAL observed counts.
 *
 * This is deliberately a different question from whether the observed evidence itself was correct
 * for the scenario (checks 5/6, `expectedOutcomeMatched`) -- an agent that honestly reports a wrong
 * result for the scenario (wrong module, wrong outcome, wrong counts) still passes THIS check; only
 * a block that misrepresents what its own terminal attempt actually showed fails it.
 *
 * `no_applicable_tests` is a narrow, explicit exception to "exact key set": the scenario prompt
 * instructs omitting `total`/`passed`/`failed` entirely, but a round-6 fresh architecture review
 * found this needlessly brittle against a plausible LLM hedge -- an agent that includes them
 * anyway with genuinely correct all-zero values is substantively right, just more verbose than
 * asked. Tolerated ONLY as a complete, all-zero triple (never a partial hedge, never any non-zero
 * value, which would be a real internal contradiction: "no applicable tests" alongside a claimed
 * non-zero count). This is a single, bounded, explicitly-reasoned rule -- not the start of a new
 * enumerated-phrasings problem the rest of this file's redesign exists to avoid. */
function kmpEvalResultBlockMatchesObserved(block, observedResult) {
  if (observedResult == null) return false;
  if (block == null || typeof block !== 'object' || Array.isArray(block)) return false;
  if (typeof block.module !== 'string' || normalizeModuleName(block.module) !== observedResult.module) return false;
  if (block.outcome_kind !== observedResult.outcome_kind) return false;

  const keys = Object.keys(block);
  // Checked BEFORE the isRanOutcome()-style grouping below -- coverage_threshold_exceeded's own key
  // set genuinely differs (it needs missed_lines/threshold/modules_contributing, which the shared
  // tests_executed/tests_failed shape has no room for).
  if (observedResult.outcome_kind === 'coverage_threshold_exceeded') {
    if (keys.length !== KMP_EVAL_RESULT_COVERAGE_THRESHOLD_KEYS.size || keys.some((k) => !KMP_EVAL_RESULT_COVERAGE_THRESHOLD_KEYS.has(k))) return false;
    return Number.isInteger(block.total) && Number.isInteger(block.passed) && Number.isInteger(block.failed)
      && block.total === observedResult.total && block.passed === observedResult.passed && block.failed === observedResult.failed
      && Number.isInteger(block.missed_lines) && block.missed_lines === observedResult.missed_lines
      && Number.isInteger(block.threshold) && block.threshold === observedResult.threshold
      && Number.isInteger(block.modules_contributing) && block.modules_contributing === observedResult.modules_contributing;
  }
  if (observedResult.outcome_kind === 'tests_executed' || observedResult.outcome_kind === 'tests_failed') {
    if (keys.length !== KMP_EVAL_RESULT_TESTS_EXECUTED_KEYS.size || keys.some((k) => !KMP_EVAL_RESULT_TESTS_EXECUTED_KEYS.has(k))) return false;
    return Number.isInteger(block.total) && Number.isInteger(block.passed) && Number.isInteger(block.failed)
      && block.total === observedResult.total && block.passed === observedResult.passed && block.failed === observedResult.failed;
  }
  // no_applicable_tests
  if (keys.some((k) => !KMP_EVAL_RESULT_NO_APPLICABLE_KEYS.has(k) && !KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS.includes(k))) return false;
  const presentCountKeys = KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS.filter((k) => keys.includes(k));
  if (presentCountKeys.length === 0) return true;
  if (presentCountKeys.length !== KMP_EVAL_RESULT_NO_APPLICABLE_OPTIONAL_COUNT_KEYS.length) return false;
  return block.total === 0 && block.passed === 0 && block.failed === 0;
}

/** @param {object|null} observedResult - the terminal attempt's own canonical observed facts (see
 *   deriveObservedKmpTestResult/deriveObservedGradleResult), or `null` when no well-formed,
 *   canonicalizable terminal evidence exists -- in which case this check fails closed regardless
 *   of what the final-answer block itself claims. */
function evaluateFinalAnswer(resultEvent, observedResult) {
  const text = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  if (text.length === 0) return { passed: false, detail: 'no final answer text found' };

  const { found, parsed, ambiguous } = extractKmpEvalResultBlock(text);
  if (!found) return { passed: false, detail: 'final answer contains no KMP_EVAL_RESULT block' };
  if (ambiguous) return { passed: false, detail: 'final answer contains more than one KMP_EVAL_RESULT block -- ambiguous, not resolved by picking one' };
  if (parsed == null) return { passed: false, detail: 'the KMP_EVAL_RESULT block did not parse as valid JSON' };
  if (observedResult == null) {
    return { passed: false, detail: 'no well-formed, canonicalizable observed result from the terminal attempt to compare the KMP_EVAL_RESULT block against' };
  }
  if (!kmpEvalResultBlockMatchesObserved(parsed, observedResult)) {
    return { passed: false, detail: "the KMP_EVAL_RESULT block does not exactly match the facts observed in the terminal attempt's own evidence (module/outcome_kind/counts, or carries unexpected/missing keys)" };
  }
  return { passed: true, detail: "the KMP_EVAL_RESULT block exactly matches the facts observed in the terminal attempt's own evidence" };
}

// classifyJunitProvenance (the old condition-wide producer-count heuristic) has been removed --
// junit-evidence.mjs's attributeCondition replaces it with real per-attempt attribution, keyed by
// tool_use_id. Its per-command classification rules (which Gradle/kmp-test-parallel calls count as
// potential producers) are preserved, relocated into command-classify.mjs's
// isRelevantGradleInvocation/isRelevantKmpTestParallel.

// ---------------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------------

/**
 * Grades one condition's transcript against a scenario's structured expectations. Pure: takes
 * already-collected data (the same per-condition result shape matrix-runner.mjs's
 * runSingleCondition produces, plus `gradleJunitEvidence` attached by runScenarioMatrix) and a
 * validated scenario object; never touches the filesystem, spawns anything, or calls an LLM.
 * @param {object} conditionResult - {events, bashResults, result, spawnResult, junitAttribution, ...}
 *   -- junitAttribution is junit-evidence.mjs's attributeCondition() return value (or null for
 *   no_applicable_tests/calibrate/smoke, where the mechanism is never enabled).
 * @param {object} scenario - a validated scenario object (schemas.mjs's validateScenario shape)
 * @returns {{expectedOutcomeMatched: boolean, success: boolean, checks: Array<{name, passed,
 *   detail, evidence_event_indices: number[]}>, firstUsefulSignalEventIndex: number|null,
 *   testInvocationsTotal: number, retries: number, harnessEvidenceAmbiguous: boolean,
 *   parallelEvidenceMalformed: boolean, gradleJunitEvidenceCaptureIncomplete: boolean,
 *   gradleJunitEvidenceUnreliable: boolean}}
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

  // Computed here (moved up from its original position, round-7 fix) so check 2 below can also
  // consult decisionByAttempt -- see this const's own original doc comment, still attached where
  // it's consumed for terminal selection further down, for the full `undefined`-vs-`null`-vs-real-
  // value rationale. `null` on conditionResult for calibrate/smoke (the mechanism is never enabled
  // there at all); a real, populated object for every scenario condition since round-7 (previously
  // `null` for no_applicable_tests specifically -- see matrix-runner.mjs's own comment).
  const junitAttribution = conditionResult.junitAttribution ?? {
    perAttemptJunit: new Map(), decisionByAttempt: new Map(),
    ambiguousJunitEvidence: false, captureIncomplete: false, unreliable: false,
  };

  // Check 1 -- blocking precondition.
  const structuralIssues = findTranscriptStructuralIssuesToleratingTimeout(events, { terminated, terminationReason });
  addCheck('no_transcript_structural_issues', structuralIssues.length === 0,
    structuralIssues.length === 0 ? 'no structural issues' : `${structuralIssues.length} issue(s): ${structuralIssues.map((i) => i.type).join(', ')}`);

  // Check 2 -- any policy-allowed command attempted at all (broader than check 4's evidence scope;
  // deliberately does not exclude --dry-run -- a dry-run call is still genuine engagement with the
  // tool, even though it can never itself count as target evidence below). A policy-DENIED
  // attempt is excluded here too (round-7/round-8 fix), UNIFORMLY for every command kind -- not
  // just kmp-test-parallel/Gradle: the command's own text can look policy-shaped (subcommand
  // 'parallel', 'doctor', 'describe', or a policy-listed Gradle task) while the hook denied that
  // SPECIFIC invocation for a finer-grained reason (a wildcard filter, an unapproved flag
  // combination) -- counting it as "genuine engagement" would let a denied attempt alone satisfy
  // this check, exactly the kind of phantom-execution signal decisionByAttempt exists to rule out
  // elsewhere. round-7's fix only excluded 'parallel'/Gradle specifically, since that was all
  // attributeCondition's own (relevance-scoped) decisionByAttempt covered at the time -- a denied
  // `kmp-test doctor`/`describe`, or a denied `kmp-test parallel --dry-run` (plan-only, so never
  // "relevant" either), still slipped through. round-8's resolveDecisions() now resolves a
  // decision for EVERY bashResult, closing that gap generally rather than adding another
  // per-subcommand conditional. Same `deny`-or-`null` exclusion predicate as
  // evaluateKmpTestAttempt/evaluateGradleAttempt below (`undefined` -- the mechanism genuinely
  // disabled entirely, e.g. calibrate/smoke, which never reaches this function anyway -- never
  // excludes).
  const policyAllowedResults = bashResults.filter((b) => {
    const decision = junitAttribution.decisionByAttempt.get(b.id);
    if (decision === 'deny' || decision === null) return false;
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

  // Per-attempt JUnit-evidence attribution (junit-evidence.mjs's attributeCondition, called once
  // per condition by matrix-runner.mjs's runScenarioMatrix -- replaces the old pooled
  // captureGradleJunitEvidence + classifyJunitProvenance heuristic entirely; junitAttribution
  // itself is computed once, near the top of this function, so check 2 above can also consult
  // decisionByAttempt). `null` on conditionResult only for calibrate/smoke now (the mechanism is
  // never enabled there at all) -- every field below defaults to a fully-inert value in that case,
  // and (critically) `decisionByAttempt`/`perAttemptJunit` stay EMPTY Maps rather than being
  // populated with `null` entries: `.get()` on an empty Map returns `undefined` for every key,
  // which `evaluateKmpTestAttempt`/`evaluateGradleAttempt` deliberately treat differently from an
  // explicit `null` (see those functions' own parameter docs) -- `undefined` never gates anything
  // (no decision data exists to gate on), while an explicit `null` means the mechanism WAS enabled
  // but this specific attempt's own decision record was missing/incoherent. Do not "simplify" the
  // two `.get(...)` calls below with a `?? null` fallback -- that would collapse this exact
  // distinction. Both maps are keyed by each attempt's own `b.id` (`tool_use_id`), never `b.index`
  // -- an earlier revision keyed by `.index`, which is only unique per assistant TURN, not per
  // attempt, so two attempts dispatched in the same turn (e.g. one allowed, one denied) silently
  // collided into one map slot (see attributeCondition's own doc comment for the full incident).
  const { ambiguousJunitEvidence, captureIncomplete: gradleJunitEvidenceCaptureIncomplete, unreliable: gradleJunitEvidenceUnreliable } = junitAttribution;

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
  const kmpTestAttempts = bashResults.map((b) => evaluateKmpTestAttempt(b, scenario, junitAttribution.decisionByAttempt.get(b.id))).filter(Boolean);
  const gradleAttempts = bashResults.map((b) => evaluateGradleAttempt(b, scenario, junitAttribution.decisionByAttempt.get(b.id), junitAttribution.perAttemptJunit.get(b.id))).filter(Boolean);
  const allAttempts = [...kmpTestAttempts, ...gradleAttempts].sort((a, b) => a.bashIndex - b.bashIndex);
  // terminalEligible (isTerminalEligibleAttempt) restricts which attempts can ever become
  // `terminal` -- for coverage_threshold_exceeded, Gradle attempts are excluded entirely (see that
  // function's own doc comment); the other 3 outcome_kinds keep both providers eligible, no
  // regression. Applied BEFORE the on-target filter so a Gradle-only condition correctly has an
  // EMPTY eligible pool (never falls back to "last of all attempts", which would silently make an
  // ineligible Gradle attempt terminal by default).
  const eligibleAttempts = allAttempts.filter((a) => isTerminalEligibleAttempt(a, scenario));
  const onTargetAttempts = eligibleAttempts.filter((a) => a.intendedTargetMatches);
  const terminalPool = onTargetAttempts.length > 0 ? onTargetAttempts : eligibleAttempts;
  const terminal = terminalPool.length > 0 ? terminalPool[terminalPool.length - 1] : null;

  // Check 4. `!terminal.parallelEvidenceInvalid` closes a gap a fresh review found: a genuinely
  // incoherent `parallel` block (malformed leg shape, wrong test-type correlation, or a leg/
  // top-level failure-count contradiction) parses fine at the TOP level (`malformed:false`), so
  // this check previously read it as "well-formed evidence" -- exactly the same class of mistake
  // `harnessEvidenceAmbiguous` already exists to avoid for JUnit-XML provenance, just for a
  // different evidence shape (see `parallelEvidenceMalformed`, below, for the harness-integrity
  // propagation this enables).
  const evidenceWellFormed = terminal != null && terminal.hasEvidence && !terminal.malformed && !terminal.parallelEvidenceInvalid && !terminal.changedEvidenceInvalid;
  addCheck('authoritative_evidence_well_formed', evidenceWellFormed,
    terminal == null ? 'no attempt capable of producing target evidence was ever made'
      : terminal.malformed ? 'the terminal attempt produced content that did not parse as valid evidence'
        : !terminal.hasEvidence ? 'the terminal attempt produced no result at all'
          : terminal.parallelEvidenceInvalid ? 'the terminal attempt\'s own parallel.legs[] structure is internally incoherent -- not trustworthy evidence'
            : terminal.changedEvidenceInvalid ? 'the terminal attempt\'s own changed{} block is internally malformed, or it incoherently carries a parallel{} block alongside it (real changed output never produces both) -- not trustworthy evidence'
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
  // together with expectedOutcomeMatched, never expectedOutcomeMatched itself. Compared against the
  // terminal attempt's OWN observed facts, only once that attempt's evidence is independently known
  // to be well-formed (the identical gate check 4 already applies) -- an attempt whose evidence
  // isn't trustworthy contributes no observedResult to compare against, regardless of what its own
  // best-effort derivation might otherwise have produced.
  const observedResult = evidenceWellFormed ? terminal.observedResult : null;
  const finalAnswer = evaluateFinalAnswer(conditionResult.result, observedResult);
  addCheck('final_answer_consistent_with_evidence', finalAnswer.passed, finalAnswer.detail);

  const success = expectedOutcomeMatched && finalAnswer.passed;

  // first_useful_signal: the EARLIEST attempt (by resultIndex, across either provider) whose own
  // result already matched its own expected contract -- never tied to which attempt ended up
  // "terminal", and never a textual match (decision 13).
  // Same terminalEligible restriction as `terminal`, above (decision: first_useful_signal must
  // never be attributed to a provider that could never have proven the outcome in the first
  // place -- a Gradle attempt with a real, matching corroborating contract is still not proof the
  // coverage threshold was exceeded, for coverage_threshold_exceeded specifically).
  const firstCorrect = eligibleAttempts
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
    // terminalAuthoritativeEventIndex (accepted-run-observability PR, additive): this function's
    // OWN already-selected `terminal` attempt's result event index -- never re-derived by a
    // caller parsing grading_checks.detail or guessing from the last Bash call. Genuinely distinct
    // from firstUsefulSignalEventIndex whenever more than one on-target attempt exists (the
    // terminal one is the LAST on-target attempt, firstCorrect is the EARLIEST correct one) --
    // null when `terminal` itself is null (no attempt capable of producing target evidence).
    terminalAuthoritativeEventIndex: terminal ? terminal.resultIndex : null,
    testInvocationsTotal,
    retries,
    // Ambiguous JUnit evidence (a proven same-assistant-turn conflict between two or more
    // policy-allowed producers -- see junit-evidence.mjs's attributeCondition) is a HARNESS-
    // INTEGRITY defect, not a legitimate agent outcome. Exposed here so the caller (cmdRun) can
    // surface it onto the run record for scenarioCellIntegrityOk to block the WHOLE matrix's
    // promotion, matching decision 4's existing "one bad cell blocks the whole matrix" treatment
    // of every other integrity defect. This is a whole-condition signal (unlike the two below) --
    // a same-turn conflict calls the whole session's tool-execution model into question, not just
    // whichever attempt ends up terminal.
    harnessEvidenceAmbiguous: ambiguousJunitEvidence,
    // The identical HARNESS-INTEGRITY treatment, for the identical reason, applied to the
    // TERMINAL attempt's own `parallel`-evidence coherence (see evaluateKmpTestAttempt's
    // `parallelEvidenceInvalid` doc comment) -- a systematic-closure review found this was
    // previously laundered only through expectedOutcomeMatched:false, which reads as a legitimate
    // negative result rather than "the tool's own JSON output cannot be trusted at all." This one
    // IS deliberately terminal-scoped: it describes the product's own evidence quality (kmp-test's
    // JSON output), which legitimately varies attempt-to-attempt and is correctly superseded by a
    // later clean retry -- unlike gradleJunitEvidenceCaptureIncomplete/gradleJunitEvidenceUnreliable
    // below, which describe the HARNESS's own capture mechanism failing and are scanned across
    // every relevant attempt, not just terminal (see junit-evidence.mjs's own doc comment for why
    // that distinction matters -- a missing/broken capture mechanism on an earlier attempt can
    // silently corrupt testInvocationsTotal/retries/firstUsefulSignalEventIndex even when the
    // terminal attempt's own data looks fine).
    parallelEvidenceMalformed: terminal?.parallelEvidenceInvalid === true,
    // The identical HARNESS-INTEGRITY treatment as parallelEvidenceMalformed above, for a
    // `changed`-classified terminal attempt's own changed{} block coherence (see
    // evaluateKmpTestAttempt's changedEvidenceInvalid doc comment).
    changedEvidenceMalformed: terminal?.changedEvidenceInvalid === true,
    // A capture-MECHANISM failure -- distinct from ambiguity (a proven conflict) and from
    // unreliable evidence (real XML that isn't trustworthy) -- computed by junit-evidence.mjs's
    // attributeCondition by scanning every relevant attempt in the condition (any provider), not
    // only whichever one later becomes terminal. See that function's own doc comment for the full
    // rationale and the one narrow timeout tolerance.
    gradleJunitEvidenceCaptureIncomplete,
    // The identical HARNESS-INTEGRITY treatment for a per-attempt JUnit-XML evidence-completeness
    // problem (a genuine skip this evidence path cannot correctly count, an oversized/unreadable
    // file, or the capture bounds were exceeded, on some relevant Gradle attempt) -- see
    // junit-evidence.mjs's countEvidenceTaskJunit/attributeCondition.
    gradleJunitEvidenceUnreliable,
  };
}

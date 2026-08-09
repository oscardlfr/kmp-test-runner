#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/junit-evidence.mjs -- the dedicated pure attribution module for per-attempt
// JUnit evidence. Two independently-testable halves: countEvidenceTaskJunit (a genuinely
// single-pass, bounded JUnit-XML read, called by junit-evidence-hook.mjs at each attempt's own
// PostToolUse/PostToolUseFailure time) and attributeCondition (the correlation logic, called once
// per condition by matrix-runner.mjs, replacing the old pooled captureGradleJunitEvidence).
//
// Never touches lib/parsers/junit-xml.js's exports beyond calling them -- that shared, production
// parser is unmodified. Imports command-classify.mjs (not graders.mjs) for classification, so a
// hook subprocess importing this module never transitively loads graders.mjs's much larger
// dependency tree.
import { join } from 'node:path';
import { forEachJunitXml, extractTestcaseFailures } from '../../lib/parsers/junit-xml.js';
import { classifyBashCommand, isRelevantGradleInvocation, isRelevantKmpTestParallel, isRelevantKmpTestChanged } from './command-classify.mjs';
import { sha256Hex, listSidecarIds, readSidecarRecord } from './junit-evidence-io.mjs';

/** Concrete, documented aggregate bounds for a single capture (round 5 -- fixed now, not decided
 * during implementation). `MAX_JUNIT_XML_FILES` is comfortably above any realistic single Gradle
 * task's `TEST-*.xml` output; `MAX_JUNIT_XML_AGGREGATE_BYTES` (twice
 * `lib/parsers/junit-xml.js`'s own per-file `DEFAULT_JUNIT_XML_MAX_MB`) allows several
 * realistically-sized reports while still catching "many small files whose total is huge" -- the
 * exact gap the existing per-file guard alone cannot close. */
export const MAX_JUNIT_XML_FILES = 2000;
export const MAX_JUNIT_XML_AGGREGATE_BYTES = 64 * 1024 * 1024;

/** Thrown by countEvidenceTaskJunit's own visitor once an aggregate bound is exceeded, caught only
 * around the single forEachJunitXml call site -- forEachJunitXml itself ignores its visitor's
 * return value entirely (confirmed by reading it: `visit(xml, filePath);` is a bare, uncaptured
 * call), so an early stop can only work by throwing, never by returning a "stop" signal. */
class JunitCaptureBoundsExceeded extends Error {}

/**
 * Reads the evidence task's CURRENT JUnit-XML state in exactly one `forEachJunitXml` pass (never
 * the old `captureGradleJunitEvidence`'s three separate walks -- one direct, one via
 * `junitTestCountFor`, one via `junitTestFailuresFor`). Inside the single visitor: counts
 * `<testcase\b>`, detects `<skipped\b>`, calls the existing per-file-content
 * `extractTestcaseFailures` (safe inline -- it does not itself walk a directory), and accumulates a
 * running file count and byte total against the two aggregate bounds above -- exceeding either
 * throws the private sentinel, caught here and reported as `integrity_error`.
 * @returns {{status:'ok', junit:{total:number,passed:number,failed:number}} |
 *   {status:'no_xml'} | {status:'integrity_error', reason:string}}
 */
export function countEvidenceTaskJunit(fixtureRoot, evidenceTask) {
  let anyXmlFound = false;
  let hasSkippedTestcase = false;
  let fileCount = 0;
  let totalBytes = 0;
  const anomalies = [];
  let total = 0;
  const failures = [];

  function visit(xml) {
    anyXmlFound = true;
    fileCount++;
    totalBytes += Buffer.byteLength(xml, 'utf8');
    if (fileCount > MAX_JUNIT_XML_FILES || totalBytes > MAX_JUNIT_XML_AGGREGATE_BYTES) {
      throw new JunitCaptureBoundsExceeded();
    }
    if (/<skipped\b/.test(xml)) hasSkippedTestcase = true;
    const matches = xml.match(/<testcase\b/g);
    if (matches) total += matches.length;
    extractTestcaseFailures(xml, failures);
  }

  let capExceeded = false;
  try {
    forEachJunitXml(fixtureRoot, evidenceTask, 0, visit, {
      onOversized: (info) => anomalies.push(info),
      onReadError: (info) => anomalies.push(info),
    });
  } catch (err) {
    if (!(err instanceof JunitCaptureBoundsExceeded)) throw err;
    capExceeded = true;
  }

  if (capExceeded) return { status: 'integrity_error', reason: 'capture_bounds_exceeded' };
  // An oversized/unreadable file is itself proof a relevant XML file existed for this task --
  // checked BEFORE the !anyXmlFound early-return for the same reason captureGradleJunitEvidence's
  // own doc comment already established: reversed, a directory with only such a file would
  // silently read as "no evidence at all", discarding the anomaly entirely.
  if (anomalies.length > 0) return { status: 'integrity_error', reason: 'junit_xml_read_anomaly' };
  if (!anyXmlFound) return { status: 'no_xml' };
  // A genuine <skipped> testcase counts toward `total` (junitTestCountFor's bare <testcase\b> scan)
  // but never appears in extractTestcaseFailures' output -- passed = total - failures.length would
  // silently misattribute it to passed. Reported as an evidence-completeness anomaly, never a
  // miscounted pass, mirroring captureGradleJunitEvidence's own existing treatment.
  if (hasSkippedTestcase) return { status: 'integrity_error', reason: 'skipped_testcase_unsupported' };
  return { status: 'ok', junit: { total, passed: total - failures.length, failed: failures.length } };
}

/**
 * Resolves EVERY Bash attempt's own PreToolUse:Bash policy-hook decision -- never filtered by
 * relevance to any particular evidence-producing command shape (round-8 fix, closing a gap round-7
 * left open). Deliberately kept separate from attributeCondition's own JUnit-XML-specific concerns
 * below: any Bash call that could contribute to bash_tool_use_present, terminal selection, or a
 * counted metric needs its own correlated decision, regardless of whether it is a "relevant"
 * (potential evidence-producing) command in the JUnit-attribution sense -- a denied
 * `kmp-test doctor`, a denied `kmp-test describe`, or a denied `kmp-test parallel --dry-run` is
 * just as real a policy denial as a denied real `kmp-test parallel` run, and none of them should
 * ever be able to satisfy a check like bash_tool_use_present that otherwise only inspects command
 * SHAPE. Concretely reproduced: a denied `kmp-test doctor` attempt previously left no trace in
 * decisionByAttempt at all (attributeCondition's own relevance filter never covered doctor/
 * describe/plan-only calls), so bash_tool_use_present's command-shape-only check counted it as
 * genuine engagement regardless.
 *
 * Same fail-closed contract graders.mjs's evaluateKmpTestAttempt/evaluateGradleAttempt already
 * document for their own `decision` parameter: `'allow'`/`'deny'` on a coherent, cross-checked
 * sidecar; `null` (never bare `undefined`) on anything else -- missing, unreadable, incoherent, an
 * anomaly tombstone, or a command cross-check mismatch -- which also raises `captureIncomplete`.
 * The ONLY tolerance: the single LAST attempt overall (by transcript order, identity never index --
 * see attributeCondition's own doc comment for why identity matters here), when the condition was
 * terminated by a genuine timeout and this specific Bash call itself has no correlated tool_result
 * at all. This generalizes attributeCondition's own identical timeout-tolerance rationale from
 * "the last RELEVANT attempt" to "the last attempt, period" -- there is no narrower relevance
 * concept to scope it to here, since this function covers every attempt uniformly.
 * @param {string} evidenceDir - KMP_EVAL_JUNIT_EVIDENCE_DIR for this condition
 * @param {Array} bashResults - conditionResult.bashResults (real transcript order, real `.id`)
 * @param {{terminated?: boolean, terminationReason?: string|null}} [terminationInfo]
 * @returns {{decisionByAttempt: Map<string, string|null>, captureIncomplete: boolean}} keyed by
 *   each attempt's own `tool_use_id` string (`b.id`), never `b.index`.
 */
export function resolveDecisions(evidenceDir, bashResults, terminationInfo = {}) {
  const { terminated = false, terminationReason = null } = terminationInfo;
  const decisionsDir = join(evidenceDir, 'decisions');
  const anomaliesDir = join(evidenceDir, 'anomalies');
  const anomalyIds = new Set(listSidecarIds(anomaliesDir));
  const lastAttemptId = bashResults.length > 0 ? bashResults[bashResults.length - 1].id : null;

  const decisionByAttempt = new Map();
  let captureIncomplete = false;
  for (const b of bashResults) {
    const idHash = sha256Hex(b.id);
    const isTrailingUnderTimeout = terminated && terminationReason === 'timeout' && b.id === lastAttemptId && b.resultFound === false;

    if (anomalyIds.has(idHash)) {
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    const decisionRecord = readSidecarRecord(decisionsDir, idHash);
    if (decisionRecord == null) {
      if (!isTrailingUnderTimeout) captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    if (decisionRecord.decision !== 'allow' && decisionRecord.decision !== 'deny') {
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    if (decisionRecord.command !== b.command) {
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    decisionByAttempt.set(b.id, decisionRecord.decision);
  }
  return { decisionByAttempt, captureIncomplete };
}

/**
 * The JUnit-XML-specific half of per-attempt attribution: which Gradle-relevant, ALLOWED attempt's
 * own JUnit XML is trustworthy (`perAttemptJunit`), and whether two or more allowed, relevant
 * attempts raced in the same assistant turn (`ambiguousJunitEvidence`). Every attempt's own basic
 * allow/deny decision -- needed for EVERY Bash call, not just relevant ones -- is delegated
 * entirely to `resolveDecisions()` above (round-8 fix): this function no longer computes
 * `decisionByAttempt` itself, it only CONSUMES the result `resolveDecisions()` already produced,
 * layering its own narrower, JUnit-XML-specific concerns on top.
 *
 * "Relevant" = a potential producer for `evidence_task`: a Gradle call whose task tokens intersect
 * `expected.gradle.allowed_invocations` (never "any Gradle command", never only the literal
 * `evidence_task` -- a policy-permitted lifecycle alias must count, schemas.mjs's own "decision 3"
 * contract), or a `kmp-test parallel` call whose `--module-filter` is absent or matches the target
 * module -- always excluding plan-only, regardless of anything else.
 *
 * Everything in this function only ever runs when `junitXmlAttributionEnabled` is true (round-8
 * fix, also independently flagged by CodeRabbit): a scenario whose outcome_kind is neither
 * 'tests_executed' nor 'tests_failed' never reads real JUnit XML at all, and a same-turn pair of ALLOWED
 * `kmp-test parallel` attempts is not actually ambiguous in that case either -- each has its own
 * self-contained, directly-correlated tool_result envelope, never a shared external resource a
 * genuine race could corrupt the way concurrent Gradle JUnit-XML writes could.
 * `ambiguousJunitEvidence`/`perAttemptJunit`/`unreliable` all stay at their inert defaults
 * (`false`/empty Map/`false`) when `junitXmlAttributionEnabled` is false.
 *
 * Concurrency proof (never a filesystem lock -- a real TOCTOU race in an earlier revision):
 * `bashResults[i].index` is the containing `assistant` event's own array index -- two Bash calls
 * dispatched in the same turn share it, and Claude Code cannot generate a second assistant turn
 * with new tool calls before the first turn's own tool results are back, so different-index
 * attempts are always safely sequential relative to each other. Grouping relevant, `decision:'allow'`
 * attempts by `.index` and flagging any group of more than one is therefore a transcript-grounded
 * proof, not an inferred-from-order guess (this proof assumes one assistant-turn line always
 * carries every tool_use dispatched together -- true only because buildBaseArgv never passes
 * `--include-partial-messages`; adding that flag would need this grouping revisited). Every
 * attempt in a conflicting group gets `{status:'conflict'}` (never the evidence record it happens
 * to carry, which could reflect a real race) -- scoped to exactly those attempts, not a blanket
 * condition-wide poison of unrelated, cleanly-captured attempts elsewhere in the same condition.
 *
 * **Per-attempt results are keyed by each attempt's own `tool_use_id` (`b.id`), never by
 * `b.index`.** An earlier revision keyed the maps below by `.index` directly -- but `.index` is
 * only unique PER ASSISTANT TURN, not per attempt: two attempts dispatched in the same turn (one
 * policy-allowed, one policy-denied -- a real, reachable shape, since Gradle-task *relevance*
 * (`allowed_invocations`) and Gradle-task *policy-allowance* (the hook's own separately-configured
 * allowlist) are two independently-configured lists) would both write to the SAME map slot, the
 * later-processed attempt's value silently overwriting the earlier one's. `tool_use_id` is globally
 * unique per Bash call (Claude Code's own ID generation), so keying by it instead gives every
 * attempt its own independent slot regardless of same-turn siblings.
 *
 * The whole-condition JUnit-evidence instrumentation-integrity scan (folded into the returned
 * `captureIncomplete`, alongside `resolveDecisions()`'s own general one -- see the return doc
 * below) examines EVERY Gradle-relevant, allowed attempt, not only whichever one later becomes
 * `terminal` (an earlier revision mirrored `parallelEvidenceMalformed`'s terminal-only scoping,
 * which is the wrong precedent here: `parallelEvidenceMalformed` describes the *product's own*
 * evidence quality, which legitimately varies attempt-to-attempt and is correctly superseded by a
 * later clean retry; a missing/broken *capture mechanism* on any relevant attempt can silently
 * corrupt `retries`/`test_invocations_total`/`first_useful_signal_ms`, all computed across every
 * attempt, even when the terminal attempt's own data looks fine). The ONLY tolerance: for the
 * single *last* Gradle-relevant attempt (by transcript order -- identity, never an index
 * comparison, for the same reason the map keys are identity-based), when the condition was
 * terminated by a genuine timeout **and this specific Bash call itself genuinely has no correlated
 * `tool_result` at all** (`b.resultFound === false`), its evidence record being entirely
 * ABSENT-OR-UNREADABLE is tolerated -- nothing else about that same attempt gets a pass: a command
 * cross-check mismatch or an evidence record showing `integrity_error` both unconditionally block,
 * timeout or not. (Its own DECISION's absence/incoherence is `resolveDecisions()`'s own,
 * separately-scoped tolerance -- this function is only ever reached, for the evidence-read part,
 * for an attempt whose decision already resolved to `'allow'`.) A duplicate-write anomaly on a
 * Gradle-relevant attempt always poisons its own evidence status to `{status:'integrity_error',
 * reason:'duplicate_write'}` regardless of what its own decision resolved to (`resolveDecisions()`
 * already folded the anomaly into the general `captureIncomplete`; this is purely the
 * Gradle-evidence-specific status marking `evaluateGradleAttempt` reads).
 * @param {string} evidenceDir - KMP_EVAL_JUNIT_EVIDENCE_DIR for this condition
 * @param {object} scenario - the validated scenario object
 * @param {Array} bashResults - conditionResult.bashResults (real transcript order, real `.id`/`.index`)
 * @param {{terminated?: boolean, terminationReason?: string|null}} [terminationInfo]
 * @param {boolean} [junitXmlAttributionEnabled] - see this function's own doc above; default true
 *   preserves this function's exact pre-existing behavior for every caller that predates this
 *   parameter.
 * @returns {{perAttemptJunit: Map<string, object>, decisionByAttempt: Map<string, string|null>,
 *   ambiguousJunitEvidence: boolean, captureIncomplete: boolean, unreliable: boolean}}
 *   `captureIncomplete` is the OR of `resolveDecisions()`'s own general result and this function's
 *   own Gradle-evidence-specific scan; both maps are keyed by each attempt's own `tool_use_id`
 *   string (`b.id`), never `b.index`.
 */
export function attributeCondition(evidenceDir, scenario, bashResults, terminationInfo = {}, junitXmlAttributionEnabled = true) {
  const { terminated = false, terminationReason = null } = terminationInfo;
  const allowedInvocations = scenario.expected?.gradle?.allowed_invocations ?? [];
  const targetModule = scenario.expected?.module;
  const evidenceRecordsDir = join(evidenceDir, 'evidence');

  const { decisionByAttempt, captureIncomplete: decisionCaptureIncomplete } = resolveDecisions(evidenceDir, bashResults, terminationInfo);

  let ambiguousJunitEvidence = false;
  let evidenceCaptureIncomplete = false;
  let unreliable = false;
  // Keyed by b.id (tool_use_id) -- see this function's own doc comment for why .index is wrong here.
  const perAttemptJunit = new Map();

  if (junitXmlAttributionEnabled) {
    const anomalyIds = new Set(listSidecarIds(join(evidenceDir, 'anomalies')));
    const classified = bashResults.map((b) => ({ b, c: classifyBashCommand(b.command) }));
    // Scenario-gated, not global (round-9 fix): isRelevantKmpTestChanged is only folded into the
    // relevant set for a scenario that actually declares expected.changed. Without this gate, a
    // `changed` command appearing anywhere in an UNRELATED scenario's transcript would shift
    // lastRelevantAttemptId away from the true last Gradle-relevant attempt, silently corrupting
    // that attempt's own timeout-tolerance check below -- expectsChanged:false makes this identical,
    // byte-for-byte, to the pre-existing two-predicate filter for every one of the other 5 scenarios.
    const expectsChanged = scenario.expected?.changed != null;
    const relevant = classified.filter(({ c }) => isRelevantGradleInvocation(c, allowedInvocations) || isRelevantKmpTestParallel(c, targetModule) || (expectsChanged && isRelevantKmpTestChanged(c)));
    // Identity, not index -- relevant's own array order mirrors bashResults' (Array.filter/.map both
    // preserve order), so the last entry is unambiguously the one and only last-dispatched relevant
    // attempt, even when it shares its .index with an earlier-in-array same-turn sibling.
    const lastRelevantAttemptId = relevant.length > 0 ? relevant[relevant.length - 1].b.id : null;

    // Concurrency proof: among relevant attempts whose OWN decision is 'allow', group by transcript
    // .index -- any group with more than one entry is a proven same-turn conflict.
    const allowedRelevant = relevant.filter(({ b }) => decisionByAttempt.get(b.id) === 'allow');
    const byIndex = new Map();
    for (const entry of allowedRelevant) {
      const list = byIndex.get(entry.b.index) ?? [];
      list.push(entry);
      byIndex.set(entry.b.index, list);
    }
    const conflictingIds = new Set();
    for (const group of byIndex.values()) {
      if (group.length > 1) {
        ambiguousJunitEvidence = true;
        for (const { b } of group) conflictingIds.add(b.id);
      }
    }

    for (const { b, c } of relevant) {
      if (!isRelevantGradleInvocation(c, allowedInvocations)) continue; // kmp-test-parallel: self-contained envelope, nothing further to read here
      const idHash = sha256Hex(b.id);
      if (anomalyIds.has(idHash)) {
        perAttemptJunit.set(b.id, { status: 'integrity_error', reason: 'duplicate_write' });
        continue;
      }
      const decision = decisionByAttempt.get(b.id);
      if (decision !== 'allow') continue; // deny/null already fully resolved by resolveDecisions()
      if (conflictingIds.has(b.id)) {
        // Already counted in ambiguousJunitEvidence above; scoped to exactly this attempt, never a
        // blanket poison of other, non-conflicting attempts elsewhere in the same condition.
        perAttemptJunit.set(b.id, { status: 'conflict' });
        continue;
      }
      const isTrailingUnderTimeout = terminated && terminationReason === 'timeout' && b.id === lastRelevantAttemptId && b.resultFound === false;
      const evidenceRecord = readSidecarRecord(evidenceRecordsDir, idHash);
      if (evidenceRecord == null) {
        if (!isTrailingUnderTimeout) evidenceCaptureIncomplete = true;
        continue;
      }
      if (evidenceRecord.command !== b.command) {
        evidenceCaptureIncomplete = true;
        continue;
      }
      if (evidenceRecord.status === 'integrity_error') unreliable = true;
      // 'ok' / 'no_xml' / 'integrity_error' all carried through as this attempt's own resolved value
      // -- evaluateGradleAttempt reads it directly; only 'ok' can ever satisfy outcomeMatches.
      perAttemptJunit.set(b.id, evidenceRecord);
    }
  }

  return {
    perAttemptJunit, decisionByAttempt, ambiguousJunitEvidence,
    captureIncomplete: decisionCaptureIncomplete || evidenceCaptureIncomplete,
    unreliable,
  };
}

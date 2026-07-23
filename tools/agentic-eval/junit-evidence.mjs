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
import { classifyBashCommand, isRelevantGradleInvocation, isRelevantKmpTestParallel } from './command-classify.mjs';
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
 * Replaces the old pooled `captureGradleJunitEvidence` call site. Resolves, per relevant attempt,
 * exactly one of: excluded (denied, or not a potential producer at all), a Gradle attempt's own
 * capture status (`ok`/`no_xml`/`integrity_error`/`conflict`), or a kmp-test-parallel attempt's bare
 * decision (its own envelope stays self-contained evidence, graded independently of this module).
 *
 * "Relevant" = a potential producer for `evidence_task`: a Gradle call whose task tokens intersect
 * `expected.gradle.allowed_invocations` (never "any Gradle command", never only the literal
 * `evidence_task` -- a policy-permitted lifecycle alias must count, schemas.mjs's own "decision 3"
 * contract), or a `kmp-test parallel` call whose `--module-filter` is absent or matches the target
 * module -- always excluding plan-only, regardless of anything else.
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
 * `b.index`.** An earlier revision keyed the two maps below by `.index` directly -- but `.index` is
 * only unique PER ASSISTANT TURN, not per attempt: two attempts dispatched in the same turn (one
 * policy-allowed, one policy-denied -- a real, reachable shape, since Gradle-task *relevance*
 * (`allowed_invocations`) and Gradle-task *policy-allowance* (the hook's own separately-configured
 * allowlist) are two independently-configured lists) would both write to the SAME map slot, the
 * later-processed attempt's value silently overwriting the earlier one's. The ambiguity check above
 * correctly does NOT flag this shape (only one of the two ever actually executed, so there is no
 * genuine multi-producer race to prove) -- but the map collision it left behind was invisible to
 * every other check here, silently corrupting either `expectedOutcomeMatched` (a genuinely correct
 * attempt's own decision overwritten by a denied sibling's, incorrectly excluding it) or
 * `testInvocationsTotal`/`retries` (a denied, never-executed sibling's decision overwritten by the
 * allowed one's, phantom-counting it as real). `tool_use_id` is globally unique per Bash call
 * (Claude Code's own ID generation), so keying by it instead gives every attempt its own
 * independent slot regardless of same-turn siblings.
 *
 * The whole-condition instrumentation-integrity scan (captureIncomplete/unreliable) examines EVERY
 * relevant attempt, not only whichever one later becomes `terminal` (an earlier revision mirrored
 * `parallelEvidenceMalformed`'s terminal-only scoping, which is the wrong precedent here:
 * `parallelEvidenceMalformed` describes the *product's own* evidence quality, which legitimately
 * varies attempt-to-attempt and is correctly superseded by a later clean retry; a missing/broken
 * *capture mechanism* on any relevant attempt can silently corrupt `retries`/`test_invocations_total`/
 * `first_useful_signal_ms`, all computed across every attempt, even when the terminal attempt's own
 * data looks fine). The ONLY tolerance: for the single *last* relevant attempt (by transcript order
 * -- identity, never an index comparison, for the same reason the map keys above are identity-based:
 * two attempts sharing the max `.index` would otherwise BOTH read as "the last one"), when the
 * condition was terminated by a genuine timeout **and this specific Bash call itself genuinely has
 * no correlated `tool_result` at all** (`b.resultFound === false` -- mirroring
 * `findIncompleteToolResultsToleratingTimeout`'s own convention elsewhere in this codebase; a
 * session-wide timeout can kill a LATER step after the last relevant Bash call already completed
 * normally, so "the condition timed out" alone is never sufficient), a decision record (or, if a
 * decision of `'allow'` was found, an evidence record) that is entirely ABSENT-OR-UNREADABLE
 * (`readSidecarRecord`'s own contract never distinguishes the two -- an unreadable record is
 * exactly as untrustworthy as a missing one) is tolerated -- nothing else about that same attempt
 * gets a pass: a completed attempt's own missing sidecar, an anomaly tombstone, a decision record
 * that EXISTS but is incoherent, a command cross-check mismatch, or an evidence record showing
 * `integrity_error` all unconditionally block, timeout or not.
 *
 * A `kmp-test parallel` attempt targeting a *different* module than the scenario expects is
 * intentionally excluded from `relevant` above (it is not a candidate producer of the *target*
 * module's evidence) but graders.mjs's own `evaluateKmpTestAttempt` still evaluates it (deferring
 * its own target-match check to after its deny/null gate, so a wrong-module-only condition can
 * still fall back to "the last attempt overall" for terminal selection). A separate, decision-only
 * pass below additionally resolves such an attempt to an explicit `'allow'`/`'deny'`/`null` --
 * **never left as bare `undefined`**, which is graders.mjs's own reserved signal for "the
 * mechanism was never enabled for this condition at all" and therefore never gates. A missing,
 * incoherent, tombstoned, or command-mismatched decision on a wrong-module attempt now resolves to
 * `null` AND sets the whole-condition `captureIncomplete` flag (a further review found the
 * null-only fix was itself still fail-open: excluding the attempt from `testInvocationsTotal`/
 * `retries` without also flagging it silently UNDERcounts a real, executed-but-unverifiable
 * attempt -- a real Bash call whose own decision the harness failed to record is exactly the kind
 * of capture-mechanism failure `captureIncomplete` exists to surface, regardless of which module it
 * targeted). A valid `'deny'` resolution remains a legitimate, non-blocking observation (no flag);
 * a valid `'allow'` remains a plain counted execution (no flag). This pass never touches
 * `perAttemptJunit`/`unreliable` (a wrong-module attempt's own JUnit-XML trustworthiness says
 * nothing about the target module's evidence) -- only `captureIncomplete`, which is a
 * condition-wide harness-integrity signal, never scoped to any one module's own evidence.
 * @param {string} evidenceDir - KMP_EVAL_JUNIT_EVIDENCE_DIR for this condition
 * @param {object} scenario - the validated scenario object
 * @param {Array} bashResults - conditionResult.bashResults (real transcript order, real `.id`/`.index`)
 * @param {{terminated?: boolean, terminationReason?: string|null}} [terminationInfo]
 * @param {boolean} [junitXmlAttributionEnabled] - round-7 addition: when false (a scenario whose
 *   outcome_kind isn't 'tests_executed' -- real JUnit XML never exists there), this function still
 *   fully resolves `decisionByAttempt` for every relevant attempt of EITHER provider (that data
 *   comes from the decision sidecars alone, always meaningful regardless of outcome_kind) but
 *   skips reading the Gradle-specific evidence sidecars entirely for Gradle-relevant attempts --
 *   `perAttemptJunit` simply stays unset for them, exactly as if they weren't Gradle at all.
 *   graders.mjs's own evaluateGradleAttempt never reads `resolvedEvidence` at all for a
 *   non-'tests_executed' outcome_kind (it derives outcomeMatches purely from the attempt's own
 *   NO-SOURCE marker text), so this is a safe no-op for that path -- it exists specifically to
 *   avoid a missing-evidence-sidecar false `captureIncomplete` for an ALLOWED Gradle attempt when
 *   junit-evidence-hook.mjs was never even registered to write one (matrix-runner.mjs only
 *   registers that hook when junitEvidenceEnabled). Default true preserves this function's exact
 *   pre-existing behavior for every caller that predates this parameter.
 * @returns {{perAttemptJunit: Map<string, object>, decisionByAttempt: Map<string, string|null>,
 *   ambiguousJunitEvidence: boolean, captureIncomplete: boolean, unreliable: boolean}} both maps are
 *   keyed by each attempt's own `tool_use_id` string (`b.id`), never `b.index`.
 */
export function attributeCondition(evidenceDir, scenario, bashResults, terminationInfo = {}, junitXmlAttributionEnabled = true) {
  const { terminated = false, terminationReason = null } = terminationInfo;
  const allowedInvocations = scenario.expected?.gradle?.allowed_invocations ?? [];
  const targetModule = scenario.expected?.module;

  const decisionsDir = join(evidenceDir, 'decisions');
  const evidenceRecordsDir = join(evidenceDir, 'evidence');
  const anomaliesDir = join(evidenceDir, 'anomalies');
  const anomalyIds = new Set(listSidecarIds(anomaliesDir));

  const classified = bashResults.map((b) => ({ b, c: classifyBashCommand(b.command) }));
  const relevant = classified.filter(({ c }) => isRelevantGradleInvocation(c, allowedInvocations) || isRelevantKmpTestParallel(c, targetModule));
  // Identity, not index -- relevant's own array order mirrors bashResults' (Array.filter/.map both
  // preserve order), so the last entry is unambiguously the one and only last-dispatched relevant
  // attempt, even when it shares its .index with an earlier-in-array same-turn sibling.
  const lastRelevantAttemptId = relevant.length > 0 ? relevant[relevant.length - 1].b.id : null;

  // Concurrency proof: among relevant attempts whose OWN decision is 'allow', group by transcript
  // .index -- any group with more than one entry is a proven same-turn conflict. Detection-only:
  // never itself used as a storage key (see perAttemptJunit/decisionByAttempt below).
  const allowedRelevant = relevant.filter(({ b }) => readSidecarRecord(decisionsDir, sha256Hex(b.id))?.decision === 'allow');
  const byIndex = new Map();
  for (const entry of allowedRelevant) {
    const list = byIndex.get(entry.b.index) ?? [];
    list.push(entry);
    byIndex.set(entry.b.index, list);
  }
  let ambiguousJunitEvidence = false;
  const conflictingIds = new Set();
  for (const group of byIndex.values()) {
    if (group.length > 1) {
      ambiguousJunitEvidence = true;
      for (const { b } of group) conflictingIds.add(sha256Hex(b.id));
    }
  }

  let captureIncomplete = false;
  let unreliable = false;
  // Keyed by b.id (tool_use_id) -- see this function's own doc comment for why .index is wrong here.
  const perAttemptJunit = new Map();
  const decisionByAttempt = new Map();

  for (const { b, c } of relevant) {
    const idHash = sha256Hex(b.id);
    const isGradle = isRelevantGradleInvocation(c, allowedInvocations);
    // EXACT REPRODUCTION (a fresh adversarial review found this): the tolerance previously checked
    // only "is this the last relevant attempt AND did the whole condition end in a timeout" --
    // never whether THIS SPECIFIC Bash call actually lacks a tool_result. A session-wide timeout
    // can kill a LATER step (e.g. final-answer generation) after the last relevant Bash call
    // already completed normally (a real tool_result present) -- reproduced directly: an attempt
    // with resultFound:true but a genuinely missing sidecar (an unrelated harness capture bug)
    // incorrectly read as captureIncomplete:false. Fixed by requiring b.resultFound === false too,
    // mirroring findIncompleteToolResultsToleratingTimeout's own convention elsewhere in this
    // codebase (only a tool_use with NO correlated tool_result is ever timeout-tolerated) -- a
    // completed attempt missing its sidecar is a genuine harness-capture failure, timeout or not.
    const isTrailingUnderTimeout = terminated && terminationReason === 'timeout' && b.id === lastRelevantAttemptId && b.resultFound === false;

    if (anomalyIds.has(idHash)) {
      // A duplicate-write anomaly ALWAYS blocks -- never timeout-tolerant, never silently ignored.
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      if (isGradle) perAttemptJunit.set(b.id, { status: 'integrity_error', reason: 'duplicate_write' });
      continue;
    }

    const decisionRecord = readSidecarRecord(decisionsDir, idHash);
    if (decisionRecord == null) {
      // Genuinely absent-or-unreadable -- the ONLY thing the trailing-timeout exception tolerates.
      if (!isTrailingUnderTimeout) captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    if (decisionRecord.decision !== 'allow' && decisionRecord.decision !== 'deny') {
      // Present but INCOHERENT -- never timeout-tolerant; only true absence is.
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    if (decisionRecord.command !== b.command) {
      // Cross-check mismatch -- always a hard anomaly, timeout or not.
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    decisionByAttempt.set(b.id, decisionRecord.decision);
    if (decisionRecord.decision === 'deny') continue; // legitimate, non-blocking observation

    // kmp-test-parallel: self-contained envelope, no further check here. Same skip when JUnit-XML
    // attribution is disabled for this condition's outcome_kind (round-7) -- a Gradle attempt's
    // own decision is already recorded above; there is simply no real evidence sidecar to read
    // (junit-evidence-hook.mjs was never registered to write one), so reading evidenceRecordsDir
    // here would only ever find nothing and wrongly raise captureIncomplete.
    if (!isGradle || !junitXmlAttributionEnabled) continue;

    if (conflictingIds.has(idHash)) {
      // Already counted in ambiguousJunitEvidence above; scoped to exactly this attempt, never a
      // blanket poison of other, non-conflicting attempts elsewhere in the same condition.
      perAttemptJunit.set(b.id, { status: 'conflict' });
      continue;
    }

    const evidenceRecord = readSidecarRecord(evidenceRecordsDir, idHash);
    if (evidenceRecord == null) {
      if (!isTrailingUnderTimeout) captureIncomplete = true;
      continue;
    }
    if (evidenceRecord.command !== b.command) {
      captureIncomplete = true;
      continue;
    }
    if (evidenceRecord.status === 'integrity_error') unreliable = true;
    // 'ok' / 'no_xml' / 'integrity_error' all carried through as this attempt's own resolved value
    // -- evaluateGradleAttempt reads it directly; only 'ok' can ever satisfy outcomeMatches.
    perAttemptJunit.set(b.id, evidenceRecord);
  }

  // Decision-only pass for a kmp-test-parallel attempt targeting a DIFFERENT module -- see this
  // function's own doc comment for the full rationale. Never touches perAttemptJunit/unreliable
  // (its own JUnit-XML trustworthiness says nothing about the TARGET module's evidence) -- but
  // EVERY such attempt gets an explicit, coherent resolution ('allow'/'deny'/null), never left as
  // bare `undefined`, and a null resolution ALSO raises the whole-condition captureIncomplete flag.
  //
  // EXACT REPRODUCTION, ROUND 1 (a fresh adversarial review found this, reproduced against the code
  // before that fix): `undefined` is graders.mjs's OWN signal for "the mechanism was never enabled
  // for this condition at all" (see evaluateKmpTestAttempt's parameter doc) -- it deliberately
  // never gates. An earlier version of this pass only ever SET the map for a fully coherent
  // record, leaving it unset (reads back as `undefined`) for a missing, incoherent, tombstoned, or
  // command-mismatched decision on a WRONG-MODULE attempt. Since graders.mjs's own
  // evaluateKmpTestAttempt evaluates ANY non-plan-only `parallel` attempt regardless of module
  // BEFORE its target-match check, that `undefined` silently passed its deny/null gate -- an
  // attempt whose own decision status the harness could not even verify (denied? a capture bug?)
  // was phantom-counted as a real execution in testInvocationsTotal/retries. Fixed, that round, by
  // resolving every non-plan-only kmp-test-parallel attempt to an explicit 'allow'/'deny'/null.
  //
  // EXACT REPRODUCTION, ROUND 2 (this fix -- round 1's fix was itself still fail-open): resolving
  // to `null` correctly stopped the OVERcounting above, but this pass still never touched
  // `captureIncomplete` -- so a wrong-module attempt whose decision was genuinely unverifiable
  // (missing/incoherent/tombstoned/mismatched sidecar) was silently EXCLUDED with no integrity
  // flag raised at all, UNDERcounting a real, executed attempt with zero signal anything went
  // wrong. Concretely reproducible: a wrong-module attempt with `resultFound:true` (it genuinely
  // ran) whose own sidecar was lost, followed by a clean, correctly-targeted attempt, previously
  // produced success:true, captureIncomplete:false, testInvocationsTotal:1, retries:0 -- when two
  // attempts actually executed. A harness that cannot verify whether a real Bash call was allowed
  // or denied has failed to capture it -- exactly what captureIncomplete exists to surface,
  // regardless of which module it targeted. Fixed by additionally setting captureIncomplete=true on
  // every null resolution in this pass; a valid 'deny' remains a legitimate, non-blocking
  // observation, and a valid 'allow' remains a plain counted execution -- only the unverifiable
  // (null) case now raises the flag.
  for (const { b, c } of classified) {
    if (decisionByAttempt.has(b.id)) continue; // already handled above (a relevant attempt)
    if (c.kind !== 'kmp-test' || c.subcommand !== 'parallel' || c.isPlanOnly) continue;
    const idHash = sha256Hex(b.id);
    if (anomalyIds.has(idHash)) {
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    const decisionRecord = readSidecarRecord(decisionsDir, idHash);
    if (decisionRecord == null || (decisionRecord.decision !== 'allow' && decisionRecord.decision !== 'deny') || decisionRecord.command !== b.command) {
      captureIncomplete = true;
      decisionByAttempt.set(b.id, null);
      continue;
    }
    decisionByAttempt.set(b.id, decisionRecord.decision); // valid allow/deny -- no flag either way
  }

  return { perAttemptJunit, decisionByAttempt, ambiguousJunitEvidence, captureIncomplete, unreliable };
}

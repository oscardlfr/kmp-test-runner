#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/analysis.mjs -- deterministic, offline, axis-separated analysis over already-
// committed schema-v5 scenario run records and their validated accepted-run-audit sidecars. See
// cli.mjs's `analyze --runs-dir <dir>` subcommand.
//
// Separates 5 axes a single benchmark_eligible/success pair otherwise collapses together:
//   1. target-skill activation      (activation_expected, target_skill_invoked, ...ordinal)
//   2. post-invocation execution    (post_skill_pre_signal_tool_calls, post_signal_tool_calls)
//   3. policy interaction           (pre/post-skill policy denial counts)
//   4. authoritative evidence       (authoritative_evidence_present)
//   5. final task outcome           (expected_outcome_matched, success)
// plus one closed-vocabulary `failure_class` per run, resolved by an explicit, tested precedence
// (classifyFailure) so a single run can never carry two competing causes.
//
// Reuses cli.mjs's own validateRunRecordFile() (schema + accepted-run-audit sidecar validation) as
// the ONLY gate for trusting a file -- this module never re-implements or loosens that check. Pure
// analysis (classifyFailure/deriveSkillRelativeFields/analyzeRunRecord/buildSummary) is kept
// entirely separate from I/O (loadAcceptedAuditSidecar/analyzeRunsDir), mirroring accepted-run-
// audit.mjs's own "pure builder vs. I/O orchestrator" split -- every pure function here is directly
// unit-testable with plain objects, no filesystem required.
//
// Structural only, exactly like the sidecar it reads: every field this module emits is a boolean,
// a non-negative integer, a closed-vocabulary string, or null -- never a raw command, tool input,
// path, or skill name. scenario_id/run_id are the only free-form-looking strings surfaced, and both
// are already treated as safe/loggable everywhere else in this harness (corpus scenario ids are
// public and committed; run_id is a UUID-suffixed identifier, never derived from session content).
//
// No subprocess, network access, filesystem write, or live Claude call happens anywhere in this
// module -- readFileSync/readdirSync only.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { validateRunRecordFile } from './cli.mjs';
import { HARD_PARTITION_FIELDS, canonicalStructuredValue } from './schemas.mjs';
import { realpath } from './materialize.mjs';

export const ANALYSIS_SCHEMA = 1;

/** Closed vocabulary for `failure_class` -- exactly one per run, resolved by classifyFailure's own
 * documented precedence. `success` is not a "failure" in the literal sense; it is included so every
 * run gets exactly one label from one enum, rather than a separate is-it-a-failure boolean plus a
 * conditionally-present reason string. */
export const FAILURE_CLASS_VALUES = [
  'success', 'target-skill-not-invoked', 'pre-skill-exploration', 'policy-blocked',
  'no-authoritative-evidence', 'wrong-target', 'outcome-mismatch', 'unclassified',
];

const CHECK_EVIDENCE_WELL_FORMED = 'authoritative_evidence_well_formed';
const CHECK_TARGET_MATCHES = 'authoritative_target_matches_expected';
const CHECK_OUTCOME_MATCHES = 'authoritative_outcome_matches_expected';
const CHECK_FINAL_ANSWER = 'final_answer_consistent_with_evidence';

const MID_PHASE_VALUES = new Set(['pre-signal', 'produced-signal']);

function findCheck(checks, name) {
  return (checks ?? []).find((c) => c?.name === name) ?? null;
}

/**
 * Resolves exactly one closed-vocabulary failure_class per run, per this module's own documented
 * precedence (checked top to bottom, first match wins -- so one run can never receive two competing
 * causes). Walks the 5 axes in causal/upstream-first order: activation, then (only when no
 * authoritative evidence resulted at all) whichever of a policy denial or mere pre-skill delay is
 * the best available explanation -- an ACTIVE denial outranks passive delay, since "something was
 * denied" is the more specific and actionable of the two whenever both are present -- then the
 * evidence-chain checks (target -> outcome) in the same dependency order graders.mjs's own checks
 * 4/5/6/8 already encode. A denial that happened but did NOT prevent well-formed evidence from
 * being produced is deliberately NOT treated as the cause once evidence exists -- verified directly
 * against a real committed record (kampkit-android-host-test-discovery): 4 policy denials occurred,
 * but the run still produced well-formed evidence for the WRONG module, so `wrong-target` is the
 * accurate label, not `policy-blocked`.
 * @returns {string} one of FAILURE_CLASS_VALUES
 */
export function classifyFailure({
  success, activationExpected, targetSkillInvoked, preSkillToolCalls, hookDenyCount,
  authoritativeEvidencePresent, targetMatchesExpected, outcomeMatchesExpected, finalAnswerConsistent,
}) {
  if (success === true) return 'success';
  if (activationExpected && targetSkillInvoked !== true) return 'target-skill-not-invoked';
  if (!authoritativeEvidencePresent) {
    if ((hookDenyCount ?? 0) > 0) return 'policy-blocked';
    if (activationExpected && (preSkillToolCalls ?? 0) > 0) return 'pre-skill-exploration';
    return 'no-authoritative-evidence';
  }
  if (targetMatchesExpected === false) return 'wrong-target';
  if (outcomeMatchesExpected === false || finalAnswerConsistent === false) return 'outcome-mismatch';
  return 'unclassified';
}

/**
 * Derives the 5 skill-relative fields (ordinal + pre-skill/post-skill-pre-signal tool-call and
 * denial counts) from the accepted-run-audit sidecar's own `tool_calls[]` -- never from a raw
 * transcript, which this harness never reads here at all. Null (`{ok:true, ...allNull}`) whenever
 * activation was not expected (a no-skill/candidate-skill condition run) or the target skill was
 * never confirmed-invoked -- "never infer, never guess" extends here: a run with no invocation has
 * no invocation-relative boundary to split calls around, so this deliberately doesn't fall back to
 * e.g. "every call is pre-skill".
 *
 * `target_skill_invocation_ordinal` is the 1-based position of the CONFIRMED target-skill call
 * among every target-skill-kind sidecar entry (transcript order) -- distinct from
 * `pre_skill_tool_calls` (every tool call of ANY kind before it): the former answers "did it take
 * multiple attempts at the skill itself", the latter answers "how much unrelated work happened
 * first". `record.skill_invocation_event.index` is only a safe boundary here because it is only
 * ever read once `targetSkillInvoked === true` -- findSkillInvocation's own contract (stream-
 * parser.mjs) guarantees the "representative" event is the CONFIRMED match whenever one exists.
 *
 * Fails closed (`{ok:false, error}`, a content-free structural message) rather than silently
 * guessing when the record and sidecar disagree with each other -- this can only happen if the two
 * files were tampered independently in a way validateRunRecordFile's own schema+hash checks didn't
 * happen to catch (e.g. a hand-edited event index), never in normal operation.
 * @returns {{ok:true, target_skill_invocation_ordinal:number|null, pre_skill_tool_calls:number|null, pre_skill_policy_denials:number|null, post_skill_pre_signal_tool_calls:number|null, post_skill_pre_signal_policy_denials:number|null} | {ok:false, error:string}}
 */
export function deriveSkillRelativeFields(record, sidecar, activationExpected, targetSkillInvoked) {
  const allNull = {
    ok: true, target_skill_invocation_ordinal: null, pre_skill_tool_calls: null,
    pre_skill_policy_denials: null, post_skill_pre_signal_tool_calls: null, post_skill_pre_signal_policy_denials: null,
  };
  if (!activationExpected || targetSkillInvoked !== true) return allNull;

  const invocationIndex = record.skill_invocation_event?.index;
  if (!Number.isInteger(invocationIndex)) {
    return { ok: false, error: 'skill_invoked is true but skill_invocation_event.index is missing or not an integer' };
  }
  const toolCalls = Array.isArray(sidecar?.tool_calls) ? sidecar.tool_calls : null;
  if (toolCalls == null) {
    return { ok: false, error: 'accepted-run-audit sidecar tool_calls is missing or not an array' };
  }

  const targetSkillCalls = toolCalls
    .filter((tc) => tc?.tool_kind === 'target-skill' && Number.isInteger(tc?.tool_use_event_index))
    .slice()
    .sort((a, b) => a.tool_use_event_index - b.tool_use_event_index);
  const ordinalIdx = targetSkillCalls.findIndex((tc) => tc.tool_use_event_index === invocationIndex);
  if (ordinalIdx === -1) {
    return { ok: false, error: 'the confirmed skill_invocation_event does not correlate to any target-skill entry in the sidecar' };
  }
  const target_skill_invocation_ordinal = ordinalIdx + 1;

  const preEntries = toolCalls.filter((tc) => Number.isInteger(tc?.tool_use_event_index) && tc.tool_use_event_index < invocationIndex);
  const pre_skill_tool_calls = preEntries.length;
  const pre_skill_policy_denials = preEntries.filter((tc) => tc.policy_decision === 'deny').length;

  const hasSignalBoundary = sidecar.first_useful_signal_event != null;
  let post_skill_pre_signal_tool_calls = null;
  let post_skill_pre_signal_policy_denials = null;
  if (hasSignalBoundary) {
    const midEntries = toolCalls.filter((tc) => Number.isInteger(tc?.tool_use_event_index) && tc.tool_use_event_index > invocationIndex && MID_PHASE_VALUES.has(tc.phase));
    post_skill_pre_signal_tool_calls = midEntries.length;
    post_skill_pre_signal_policy_denials = midEntries.filter((tc) => tc.policy_decision === 'deny').length;
  }

  return {
    ok: true, target_skill_invocation_ordinal, pre_skill_tool_calls, pre_skill_policy_denials,
    post_skill_pre_signal_tool_calls, post_skill_pre_signal_policy_denials,
  };
}

/**
 * Pure per-run analysis -- never touches the filesystem. Assumes `record` already passed
 * validateRunRecordFile with zero errors (schema>=5, run_kind:'scenario') and `sidecar` is that
 * SAME record's own already-validated accepted-run-audit sidecar object; callers (analyzeRunsDir)
 * are responsible for that gate. Returns `{ok:false, error}` (content-free) on an internal
 * inconsistency deriveSkillRelativeFields or a missing grading check surfaces -- callers must treat
 * this exactly like a malformed sibling (excluded from per_run, reported in errors[]).
 * @returns {{ok:true, entry:object} | {ok:false, error:string}}
 */
export function analyzeRunRecord(record, sidecar) {
  const activation_expected = record.condition === 'current-skill';
  const rawInvoked = record.skill_invoked?.value ?? null;
  const target_skill_invoked = activation_expected ? rawInvoked : null;

  const skillFields = deriveSkillRelativeFields(record, sidecar, activation_expected, target_skill_invoked);
  if (!skillFields.ok) return { ok: false, error: skillFields.error };

  const checks = record.grading_checks?.value ?? null;
  const evidenceCheck = findCheck(checks, CHECK_EVIDENCE_WELL_FORMED);
  const targetCheck = findCheck(checks, CHECK_TARGET_MATCHES);
  const outcomeCheck = findCheck(checks, CHECK_OUTCOME_MATCHES);
  const finalAnswerCheck = findCheck(checks, CHECK_FINAL_ANSWER);
  if (evidenceCheck == null || targetCheck == null || outcomeCheck == null || finalAnswerCheck == null) {
    return { ok: false, error: 'grading_checks is missing one or more required check names' };
  }

  const authoritative_evidence_present = evidenceCheck.passed === true;
  const expected_outcome_matched = record.expected_outcome_matched?.value ?? null;
  const success = record.success?.value ?? null;
  const post_signal_tool_calls = record.post_signal_tool_calls?.value ?? null;

  const failure_class = classifyFailure({
    success,
    activationExpected: activation_expected,
    targetSkillInvoked: target_skill_invoked,
    preSkillToolCalls: skillFields.pre_skill_tool_calls,
    hookDenyCount: record.hook_deny_count,
    authoritativeEvidencePresent: authoritative_evidence_present,
    targetMatchesExpected: targetCheck.passed,
    outcomeMatchesExpected: outcomeCheck.passed,
    finalAnswerConsistent: finalAnswerCheck.passed,
  });

  return {
    ok: true,
    entry: {
      run_id: record.run_id,
      scenario_id: record.scenario_id,
      condition: record.condition,
      activation_expected,
      target_skill_invoked,
      target_skill_invocation_ordinal: skillFields.target_skill_invocation_ordinal,
      pre_skill_tool_calls: skillFields.pre_skill_tool_calls,
      pre_skill_policy_denials: skillFields.pre_skill_policy_denials,
      post_skill_pre_signal_tool_calls: skillFields.post_skill_pre_signal_tool_calls,
      post_skill_pre_signal_policy_denials: skillFields.post_skill_pre_signal_policy_denials,
      post_signal_tool_calls,
      authoritative_evidence_present,
      expected_outcome_matched,
      success,
      failure_class,
    },
  };
}

function rate(count, total) {
  return total > 0 ? count / total : null;
}

/** Compact frequency map -- e.g. {0: 3, 1: 2, null: 1} rendered as string keys for JSON safety.
 * Never a raw array of every value (which would grow unboundedly with run count); a distribution is
 * exactly as informative and stays flat regardless of how many runs share a value. */
function buildDistribution(values) {
  const dist = {};
  for (const v of values) {
    const key = v === null ? 'null' : String(v);
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

function buildGroupSummary(groupKey, entries) {
  const total = entries.length;
  const activationExpectedEntries = entries.filter((e) => e.activation_expected === true);
  const invokedCount = activationExpectedEntries.filter((e) => e.target_skill_invoked === true).length;
  const evidenceCount = entries.filter((e) => e.authoritative_evidence_present === true).length;
  const outcomeMatchedCount = entries.filter((e) => e.expected_outcome_matched === true).length;
  const successCount = entries.filter((e) => e.success === true).length;

  const failure_class_counts = {};
  for (const cls of FAILURE_CLASS_VALUES) failure_class_counts[cls] = 0;
  for (const e of entries) failure_class_counts[e.failure_class] = (failure_class_counts[e.failure_class] ?? 0) + 1;

  return {
    group_key: groupKey,
    run_count: total,
    activation_expected_count: activationExpectedEntries.length,
    target_skill_invoked_count: invokedCount,
    target_skill_invoked_rate: rate(invokedCount, activationExpectedEntries.length),
    authoritative_evidence_present_count: evidenceCount,
    authoritative_evidence_present_rate: rate(evidenceCount, total),
    expected_outcome_matched_count: outcomeMatchedCount,
    expected_outcome_matched_rate: rate(outcomeMatchedCount, total),
    success_count: successCount,
    success_rate: rate(successCount, total),
    failure_class_counts,
    invocation_ordinal_distribution: buildDistribution(entries.map((e) => e.target_skill_invocation_ordinal)),
    pre_skill_tool_calls_distribution: buildDistribution(entries.map((e) => e.pre_skill_tool_calls)),
    post_skill_pre_signal_tool_calls_distribution: buildDistribution(entries.map((e) => e.post_skill_pre_signal_tool_calls)),
  };
}

/**
 * Aggregates {record, entry} pairs into one summary group per distinct HARD_PARTITION_FIELDS tuple
 * (schemas.mjs's own Fairness Contract key -- scenario_id and condition are 2 of its 17 fields,
 * satisfying "aggregate by scenario_id and condition" while every OTHER field in that same tuple
 * -- schema, platform, skill_source_sha, model_resolved, policy_sha256, ... -- keeps a differing
 * schema/provenance run in its OWN separate group rather than silently pooled together). Reuses the
 * EXACT canonical-value serialization aggregate.mjs's own bucketing already relies on
 * (canonicalStructuredValue) rather than inventing a second, independently-drifting notion of "the
 * same partition". Never computes a cross-condition comparison (e.g. a current-skill-vs-no-skill
 * lift) -- each condition's runs land in their own group, exactly like aggregate.mjs's Fairness
 * Contract already treats `condition` as a hard partition key.
 * @param {Array<{record:object, entry:object}>} pairs
 */
export function buildSummary(pairs) {
  const buckets = new Map();
  for (const { record, entry } of pairs) {
    const key = JSON.stringify(HARD_PARTITION_FIELDS.map((f) => canonicalStructuredValue(record[f])));
    if (!buckets.has(key)) buckets.set(key, { record, entries: [] });
    buckets.get(key).entries.push(entry);
  }
  const groups = [];
  for (const { record, entries } of buckets.values()) {
    const groupKey = {};
    for (const f of HARD_PARTITION_FIELDS) groupKey[f] = record[f];
    groups.push(buildGroupSummary(groupKey, entries));
  }
  groups.sort((a, b) => {
    const s = a.group_key.scenario_id.localeCompare(b.group_key.scenario_id);
    return s !== 0 ? s : String(a.group_key.condition).localeCompare(String(b.group_key.condition));
  });
  return { groups };
}

/**
 * Resolves + reads + parses one run record's own accepted-run-audit sidecar file, mirroring
 * cli.mjs's validateAcceptedAuditOnDisk safe-path resolution (realpath both sides, containment-
 * check the sidecar path against the run record's own directory, never follow a symlink that
 * escapes it) -- duplicated here in miniature (never exported from cli.mjs) because that function
 * only VALIDATES and returns errors, never the parsed object this module needs to actually read
 * tool_calls[] from. Callers only ever reach this after validateRunRecordFile already proved the
 * sidecar valid+consistent for this exact record; still fails closed independently (defense in
 * depth against a TOCTOU edit between the two reads), never throws.
 * @returns {{ok:true, sidecar:object} | {ok:false, error:string}}
 */
export function loadAcceptedAuditSidecar(runPath, record) {
  const runDir = dirname(runPath);
  let runDirReal;
  try {
    runDirReal = realpath(runDir);
  } catch (err) {
    return { ok: false, error: `could not resolve the run record's own directory (${err.code ?? 'unknown error'})` };
  }
  const relativePath = record.accepted_audit?.relative_path;
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, error: 'accepted_audit.relative_path is missing' };
  }
  const sidecarPath = join(runDir, ...relativePath.split('/'));
  if (!existsSync(sidecarPath)) {
    return { ok: false, error: 'sidecar file does not exist' };
  }
  let sidecarPathReal;
  try {
    sidecarPathReal = realpath(sidecarPath);
  } catch (err) {
    return { ok: false, error: `could not resolve the sidecar path (${err.code ?? 'unknown error'})` };
  }
  const relFromRunDir = relative(runDirReal, sidecarPathReal);
  if (relFromRunDir.startsWith('..') || isAbsolute(relFromRunDir)) {
    return { ok: false, error: 'sidecar path resolves outside the run record\'s own directory' };
  }
  let sidecarText;
  try {
    sidecarText = readFileSync(sidecarPathReal, 'utf8');
  } catch (err) {
    return { ok: false, error: `could not read the sidecar file (${err.code ?? 'unknown error'})` };
  }
  try {
    return { ok: true, sidecar: JSON.parse(sidecarText) };
  } catch {
    return { ok: false, error: 'sidecar file is not valid JSON' };
  }
}

/**
 * The I/O orchestrator cmdAnalyze (cli.mjs) calls directly. Lists `runsDir`'s own top-level
 * `*.json` files (never recursing into `audit/`, matching cmdAggregate's identical iteration
 * shape), SORTS them by filename first (deterministic per_run/errors ordering regardless of the
 * filesystem's own, platform-dependent readdir order -- readdirSync makes no ordering guarantee),
 * then per file: validateRunRecordFile (schema + sidecar validation, reused verbatim) fails closed
 * into `errors[]` and continues past that ONE file, exactly like cmdAggregate's own
 * preFilterErrors precedent; a schema-valid record that is not (schema>=5 AND
 * run_kind:'scenario') is silently out of this command's domain -- counted, never erroed, never
 * analyzed (a pre-v5 or non-scenario record has no accepted-run-audit sidecar to read at all).
 * Every file is accounted for exactly once: files_seen === files_analyzed +
 * files_excluded_not_applicable + files_errored.
 * @returns {{schema:number, per_run:object[], summary:object, errors:Array<{run_id:string, errors:Array}>}}
 */
export function analyzeRunsDir(runsDir) {
  const errors = [];
  const perRun = [];
  const pairs = [];
  let filesExcludedNotApplicable = 0;

  const files = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort();
  for (const file of files) {
    const runPath = join(runsDir, file);
    const { record, errors: fileErrors } = validateRunRecordFile(runPath);
    if (fileErrors.length > 0) {
      errors.push({ run_id: record?.run_id ?? '(unknown)', errors: fileErrors });
      continue;
    }
    if (!(record.schema >= 5 && record.run_kind === 'scenario')) {
      filesExcludedNotApplicable++;
      continue;
    }
    const sidecarResult = loadAcceptedAuditSidecar(runPath, record);
    if (!sidecarResult.ok) {
      errors.push({ run_id: record.run_id, errors: [{ field: 'accepted_audit', message: sidecarResult.error }] });
      continue;
    }
    const analyzed = analyzeRunRecord(record, sidecarResult.sidecar);
    if (!analyzed.ok) {
      errors.push({ run_id: record.run_id, errors: [{ field: '(root)', message: analyzed.error }] });
      continue;
    }
    perRun.push(analyzed.entry);
    pairs.push({ record, entry: analyzed.entry });
  }

  const summary = buildSummary(pairs);
  summary.files_seen = files.length;
  summary.files_analyzed = perRun.length;
  summary.files_excluded_not_applicable = filesExcludedNotApplicable;
  summary.files_errored = errors.length;

  return { schema: ANALYSIS_SCHEMA, per_run: perRun, summary, errors };
}

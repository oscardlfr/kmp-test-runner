#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/aggregate.mjs -- metric aggregator + validator. Fairness Contract as code:
// refuses to fold runs into one aggregate unless they agree on every hard partition key
// (family, cache_state, run_kind), and independently refuses any benchmark_eligible:false
// run outright -- calibration/corpus-probe/smoke prove the harness works, they are never
// measurement data (schemas.mjs's buildAggregateGroup() implements both checks; this module
// is the CLI-facing layer around it).
import { buildAggregateGroup, HARD_PARTITION_FIELDS, validateRun, canonicalStructuredValue } from './schemas.mjs';
import { withPartitionView } from './run-record-view.mjs';

/**
 * Groups a flat array of run records by every HARD_PARTITION_FIELDS key (schemas.mjs), then
 * builds a validated aggregate group per bucket. Every record is first checked against the
 * FULL run schema (validateRun) -- a record that's schema-valid enough to have the partition
 * fields present but broken elsewhere (e.g. a malformed tokens object) would otherwise sail
 * through bucketing and grouping unnoticed, since buildAggregateGroup only inspects the
 * specific fields it partitions/counts on. A schema-invalid record is reported per-record (not
 * thrown) and excluded from every bucket, exactly like a Fairness-Contract violation is reported
 * per-bucket rather than aborting the whole run. Bucketing on the SAME field list
 * buildAggregateGroup enforces means a mismatched execution (different project_commit,
 * model_resolved, etc.) lands in its own separate bucket rather than spuriously erroring out
 * an otherwise-valid group.
 */
export function aggregateRuns(runs) {
  const errors = [];
  const validRuns = [];
  for (const run of runs) {
    const { errors: runErrors } = validateRun(run);
    if (runErrors.length > 0) {
      errors.push({ run_id: run?.run_id ?? '(unknown)', errors: runErrors });
      continue;
    }
    // withPartitionView is applied to the already schema-valid ORIGINAL record, never the reverse
    // -- validateRun above checks the real, unprojected record (a narrowed execution_profile would
    // fail its own required-key check), and only the resulting view (never the original) flows
    // into bucketing/grouping below, so a schema<=5 run's genuine absence of agent_runtime/
    // execution_profile/skill_observation becomes the real "not-recorded" sentinel here rather than
    // silently matching another run's `undefined` on the same fields (Section F).
    validRuns.push(withPartitionView(run));
  }
  const buckets = new Map();
  for (const run of validRuns) {
    // JSON.stringify of the field-value ARRAY, not .join(' ') -- a plain space-join lets two
    // runs whose field values differ only in WHERE a space falls collide into the same bucket
    // (e.g. project_alias:'a b', platform:'c' vs. project_alias:'a', platform:'b c' both join to
    // "a b c"). JSON encoding unambiguously delimits each element regardless of its own content.
    // Review-round-2 fix: an object/array-valued field (e.g. ambient_skill_profile) is passed
    // through canonicalStructuredValue first -- built with keys in a different insertion order,
    // it previously produced a DIFFERENT JSON string here, spuriously bucketing two semantically
    // identical runs apart before buildAggregateGroup's own mixing check ever got a chance to
    // compare them. Mirrors the exact same object/array-only boundary schemas.mjs's own
    // (unexported) partitionFieldKey helper already applies for its identical concern -- not
    // reused directly (a shared export would exist only to move one small ternary), but
    // deliberately the SAME predicate, so bucketing and partition-mixing can never independently
    // drift into two different notions of "the same value".
    //
    // Compatibility regression fix (agentic-eval-runtime-neutral-records-v1, Stage 1): a PRIMITIVE
    // field value -- including a genuinely absent field read as `undefined` (e.g. a schema<4
    // record's own ambient_skill_profile, never introduced before v4) -- is passed through
    // UNCHANGED, never into canonicalStructuredValue. Before canonical-json.mjs's extraction in
    // this PR, canonicalStructuredValue silently returned `undefined` verbatim for a non-object,
    // non-array value; JSON.stringify then silently coerced that array ELEMENT to `null`, so an
    // absent field flowed through harmlessly and reached buildAggregateGroup's own graceful
    // "unknown ambient_skill_profile" completeness error. canonical-json.mjs's own new, stricter
    // contract now correctly THROWS on undefined (a deliberate improvement for its real
    // security-relevant callers -- execution-profile/provenance hashing, where silently accepting
    // a missing field would hide a real integrity gap) -- but this bucket-key computation was never
    // updated for that new strictness, so it started hard-crashing the entire aggregateRuns() call
    // on the real committed corpus instead of reporting a graceful per-bucket error. Restricting
    // canonicalization to object/array values only (this fix) restores the pre-existing graceful
    // behavior here without loosening canonical-json.mjs's contract anywhere else.
    const key = JSON.stringify(HARD_PARTITION_FIELDS.map((f) => {
      const value = run[f];
      return (Array.isArray(value) || (value != null && typeof value === 'object')) ? canonicalStructuredValue(value) : value;
    }));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(run);
  }
  const groups = [];
  for (const [key, bucketRuns] of buckets) {
    const { errors: bucketErrors, group } = buildAggregateGroup(bucketRuns);
    if (bucketErrors.length > 0) {
      errors.push({ bucket: key, errors: bucketErrors });
      continue;
    }
    groups.push(group);
  }
  return { groups, errors };
}

/** Computes simple summary stats for a single homogeneous group (already Fairness-Contract-clean). */
export function summarizeGroup(runs) {
  const total = runs.length;
  const invoked = runs.filter((r) => r.skill_invoked?.value === true).length;
  const succeeded = runs.filter((r) => r.success?.value === true).length;
  return {
    run_count: total,
    skill_invoked_rate: total > 0 ? invoked / total : null,
    success_rate: total > 0 ? succeeded / total : null,
  };
}

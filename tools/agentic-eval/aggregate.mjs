#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/aggregate.mjs -- metric aggregator + validator. Fairness Contract as code:
// refuses to fold runs into one aggregate unless they agree on every hard partition key
// (family, cache_state, run_kind), and independently refuses any benchmark_eligible:false
// run outright -- calibration/corpus-probe/smoke prove the harness works, they are never
// measurement data (schemas.mjs's buildAggregateGroup() implements both checks; this module
// is the CLI-facing layer around it).
import { buildAggregateGroup, HARD_PARTITION_FIELDS, validateRun } from './schemas.mjs';

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
    validRuns.push(run);
  }
  const buckets = new Map();
  for (const run of validRuns) {
    const key = HARD_PARTITION_FIELDS.map((f) => run[f]).join(' ');
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

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/run-record-view.mjs -- the ONE schema-aware projection of a run record's
// runtime/profile/skill/usage identity, used by BOTH aggregate.mjs (as new Fairness Contract
// structural partition keys) and analysis.mjs (as new per-run/summary reporting fields) -- so
// neither module (nor a third) independently re-derives or drifts on "what does a schema<=5 record
// project here" vs "what does a schema:6+ record project" (Section F).
//
// Two distinct shapes per field, for two distinct purposes:
//  - the *PartitionView functions return a NARROWED projection (bare identity fields only, e.g.
//    execution_profile without isolation_attestation_sha256) -- this is what aggregate.mjs's own
//    group_key uses, and what both aggregate.mjs and analysis.mjs bucket runs by. Narrowed
//    specifically because isolation_attestation_sha256 is real per-execution evidence that is bound
//    and validated (record<->sidecar) but must never separate otherwise-identical buckets: it can
//    legitimately vary between cells under the same profile, and partitioning by it would make
//    aggregating repetitions comparable impossible.
//  - the plain View functions (agentRuntimeView/executionProfileView/skillObservationView) return
//    the FULL real object -- this is what analysis.mjs's per-run/summary REPORTING fields use;
//    there is no reason to hide isolation_attestation_sha256 (or availability/activation) from a
//    human-readable report the way there is for a bucketing key.
// agentRuntimeView is used for BOTH purposes (aggregate's partition key AND analysis reporting) --
// it is never narrowed in either role: every one of its sub-fields (runtime ID, requested/resolved
// model, expected/observed vendor, runtime CLI version) is itself a legitimate partition axis.
//
// Every projection is schema-gated on `record.schema >= 6` (never on runtime_id, cli feature
// probing, or any other proxy) -- matching schemas.mjs's own v6 dispatch convention throughout this
// PR. A record below schema 6 gets the literal string "not-recorded" for every one of these fields,
// never null, never an inferred/guessed value ("never infer, never guess" applies here exactly like
// every other absent-metric convention this harness uses) -- never inferring `claude-code` from
// `claude_code_version`, never inferring strict-policy from hook/policy fields, never transforming
// legacy `tokens` into a synthesized v6 `usage` object.
//
// Deliberately NOT a partition key here (Section F): activation/availability outcomes, success,
// usage, retries. Partitioning by an OBSERVED outcome would separate results by what happened,
// introducing exactly the survivorship bias the Fairness Contract exists to prevent.
import { productAccessModeForSkillCondition } from './product-access.mjs';

const NOT_RECORDED = 'not-recorded';

function isV6OrLater(record) {
  return typeof record?.schema === 'number' && record.schema >= 6;
}

/** Full agent_runtime object, or the literal "not-recorded" sentinel below schema 6. Used
 * identically by aggregate.mjs's partition key and analysis.mjs's reporting field -- this one is
 * never narrowed in either role: runtime ID, requested/resolved model, and expected/observed
 * vendor are independent partition axes precisely because they all live on this one object. */
export function agentRuntimeView(record) {
  return isV6OrLater(record) ? record.agent_runtime : NOT_RECORDED;
}

/** The NARROWED {id,sha256,isolation_kind,network_mode} execution-profile identity -- deliberately
 * excludes isolation_attestation_sha256 (see this module's own header comment). Used for
 * aggregate.mjs's group_key and both modules' bucketing. */
export function executionProfilePartitionView(record) {
  if (!isV6OrLater(record)) return NOT_RECORDED;
  const ep = record.execution_profile;
  return { id: ep.id, sha256: ep.sha256, isolation_kind: ep.isolation_kind, network_mode: ep.network_mode };
}

/** The full execution_profile object (including isolation_attestation_sha256), for analysis.mjs's
 * human-readable per-run/summary reporting -- never used as a partition/bucketing key. */
export function executionProfileView(record) {
  return isV6OrLater(record) ? record.execution_profile : NOT_RECORDED;
}

/** The NARROWED {delivery_mode,source_sha,treatment_size} skill-treatment identity -- excludes
 * availability/activation (observed OUTCOMES, never a partition key). Used for aggregate.mjs's
 * group_key and both modules' bucketing. Hard-partitioned because the plan requires source tree AND
 * exact measured subset agreement: the same source SHA is not enough on its own if the measured
 * root/manifest/prompt differ. */
export function skillTreatmentPartitionView(record) {
  if (!isV6OrLater(record)) return NOT_RECORDED;
  const so = record.skill_observation;
  return { delivery_mode: so.delivery_mode, source_sha: so.source_sha, treatment_size: so.treatment_size };
}

/** The full skill_observation object (availability/activation included), for analysis.mjs's
 * human-readable per-run/summary reporting -- never used as a partition/bucketing key. */
export function skillObservationView(record) {
  return isV6OrLater(record) ? record.skill_observation : NOT_RECORDED;
}

/** The canonical not-recorded usage shape a schema<=5 record gets -- mirrors v6's own real `usage`
 * object shape exactly (same closed vocabulary, same 5 dimensions, same
 * attributable_to_skill_load nesting) so a report consumer never needs a second shape to handle:
 * every dimension is null (usage genuinely was never captured pre-v6), never zero -- "never infer
 * zero for an unavailable token dimension" applies here exactly like every other schema version
 * gap this harness already refuses to paper over. */
function notRecordedUsage() {
  return {
    source: 'not-recorded',
    input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null,
    attributable_to_skill_load: {
      status: 'not-recorded',
      dimensions: { input: null, cached_input: null, cache_write: null, output: null, reasoning_output: null },
      unit: null,
      reason: 'record schema is below 6 -- usage was not measured',
    },
  };
}

/** The real v6 usage object, or the canonical not-recorded shape below schema 6. Used by
 * analysis.mjs's per-run/summary reporting -- never a partition key (an observed outcome, not an
 * execution-identity fact). */
export function usageView(record) {
  return isV6OrLater(record) ? record.usage : notRecordedUsage();
}

/** For a schema:6+ record, reduces `record.skill_observation.activation.status` to the SAME
 * boolean-or-null domain the legacy `skill_invoked.value` field already uses (`confirmed` -> true,
 * `not-observed` -> false, `indirect`/`not-observable` -> null). Schema invariant 8 already
 * requires these two sources to agree for claude-code, so this is a behavior-preserving read for
 * every record this PR can produce today; it exists so a future runtime whose activation is not
 * simply boolean (e.g. a Codex `available-only` status) has a real read path here rather than a
 * forced, lossy boolean coercion baked into analysis.mjs itself. Below schema 6, reads the legacy
 * `skill_invoked.value` field exactly as before. */
export function targetSkillInvokedView(record) {
  if (!isV6OrLater(record)) return record.skill_invoked?.value ?? null;
  const status = record.skill_observation?.activation?.status;
  if (status === 'confirmed') return true;
  if (status === 'not-observed') return false;
  return null;
}

/** Product access became a first-class run-record field in schema v7. For historical records, use
 * the only product-access state they could represent: condition-derived product visibility. This is
 * a compatibility projection for analysis/aggregation only; schemas.mjs still rejects a schema<7
 * record that physically carries product_access_mode. */
export function productAccessModeView(record) {
  if (typeof record?.schema === 'number' && record.schema >= 7) return record.product_access_mode;
  return productAccessModeForSkillCondition(record?.condition);
}

/** Augments a run record with the 3 new NARROWED structural partition fields as plain top-level
 * properties, named to match the record's own v6 field names (`agent_runtime`, `execution_profile`,
 * `skill_treatment`) -- aggregate.mjs's HARD_PARTITION_FIELDS-driven bucketing/mixing-check and
 * group_key construction (schemas.mjs's buildAggregateGroup) then read these exactly like every
 * other flat record field, so the actual "legacy vs v6, narrow vs full" decision logic lives in
 * exactly this one module, never duplicated in aggregate.mjs, analysis.mjs, or schemas.mjs. Never
 * mutates `record` -- returns a shallow-copied view, safe to bucket/group on but never to pass to
 * validateRun (the narrowed execution_profile does not carry every schema-required key). Applied to
 * EVERY record regardless of schema (a schema<=5 record's own view carries all 3 as
 * "not-recorded"), so a legacy and a v6 record can never silently share a bucket by both simply
 * lacking these 3 fields. */
export function withPartitionView(record) {
  return {
    ...record,
    agent_runtime: agentRuntimeView(record),
    execution_profile: executionProfilePartitionView(record),
    skill_treatment: skillTreatmentPartitionView(record),
    product_access_mode: productAccessModeView(record),
  };
}

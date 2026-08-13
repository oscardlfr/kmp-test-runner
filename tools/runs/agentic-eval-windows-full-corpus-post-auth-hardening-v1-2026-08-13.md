# Windows full-corpus post-auth-hardening canary v1 — 2026-08-13

Full six-scenario Windows capture run immediately after PR #423 hardened auth
preflight, pre-inference failure detection, and stderr/crash forensics. 6
scenarios x 2 conditions x 2 repetitions = 24 live sessions, all accepted on
the first attempt with zero retries.

## Identity and provenance

| Field | Value |
|---|---|
| Harness / base commit | `e91b21ee7cd5e983e90fc4334f61e2adaa9b7668` |
| PR #423 head (auth-hardening, merged at base commit) | `6f852b8814fee8d814e8042905727bb6d479c183` |
| Skill snapshot pin (campaign-level) | `8492d98d40b9f2208bac88cf8ac357aeb4c095ca` |
| Model (requested = resolved) | `claude-sonnet-5` |
| Claude Code | `2.1.227` |
| Source projects | `nowinandroid` @ `7d45eae4f8720a0c77f507712ba2437ff974b6ed` (4 scenarios); `nowinandroid` @ `058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8` (`deterministic-unit-test-failure` only); `kampkit` @ `b3a7784fb969a8558b88c80674c8b596944cdab7` (2 scenarios) |
| Platform | `windows` |
| Seed | `20260722` |
| Repetitions per condition | 2 |
| Measurement scope id | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| Capture date | 2026-08-13 |
| Record schema | 5 |

Every one of the 24 records carries the harness/base commit, model, Claude
Code version, platform, seed, measurement scope id, and record schema
identically; those fields were asserted field-by-field across all 24, not
spot-checked. The skill snapshot pin is fixed at the campaign level, but its
per-record field is conditional, not uniform: `skill_source_sha` is
`8492d98d40b9f2208bac88cf8ac357aeb4c095ca` on all 12 `current-skill` records
and `null` on all 12 `no-skill` records, as the schema requires when the
target skill is unavailable. All 24 are `benchmark_eligible: true`,
`terminated: false`, `exit_code: 0`, with an empty `errors` array.

## Method

All six matrices ran sequentially in fixed order (`changed-module-verification`,
`coverage-threshold-failure`, `deterministic-unit-test-failure`,
`nowinandroid-core-common`, `kampkit-android-host-test-discovery`,
`kampkit-no-applicable-tests`), each as a single supervised live invocation
with an identical command shape, varying only scenario id and source-repo-dir
(matched to the scenario's clone). Each invocation planned 4 cells and
executed all 4; no cell was retried, replaced, or re-seeded, and no result was
authored by hand. This is a claim about session/matrix orchestration only:
**zero live sessions were re-run and zero cells were replaced** across the
whole campaign.

That is a distinct claim from the per-record `retries` metric, which is
unrelated to session orchestration. Per `graders.mjs`, `retries` is
`test_invocations_total` minus one, floored at zero — an in-session count of
how many times a single accepted session invoked a test capable of producing
target evidence, not a session re-run. That metric is nonzero on 3 of the 24
committed records: `scenario-current-skill-dfd8d553` (retries: 1),
`scenario-current-skill-ae75e718` (retries: 1), both
`changed-module-verification` `current-skill` successes, and
`scenario-current-skill-c5c7aa51` (retries: 1),
`kampkit-android-host-test-discovery` `current-skill` success. The records are
append-only measurement evidence and were not modified to fit either
narrative; this paragraph is the correction.

`no-skill` is a **target-skill ablation**, not an unconstrained control: both
conditions in a pair run under the same policy, the same allowed gradle
tasks, the same allowed CLI subcommands (identical `policy_sha256` within a
scenario — enforced structurally by `buildSharedEnv()`, which constructs one
shared env object reused verbatim for both conditions of a pair), and the
same permission mode. Only availability of the target skill differs.

## Primary result — within-batch `current-skill` vs `no-skill`

This within-batch contrast is the primary comparison. Success means the run
both produced well-formed, correctly targeted authoritative evidence and
reported a terminal outcome matching the scenario's expectation.

| Scenario | `current-skill` | `no-skill` |
|---|---|---|
| `changed-module-verification` | 2/2 | 0/2 |
| `coverage-threshold-failure` | 1/2 | 0/2 |
| `deterministic-unit-test-failure` | 2/2 | 1/2 |
| `nowinandroid-core-common` | 2/2 | 0/2 |
| `kampkit-android-host-test-discovery` | 1/2 | 0/2 |
| `kampkit-no-applicable-tests` | 2/2 | 0/2 |
| **Total** | **10/12** | **1/12** |

Per-cell detail (all values read from the committed records):

| Scenario | Condition | Rep | Order | Success | Skill invoked | Test invocations | Policy denials |
|---|---|---|---|---|---|---|---|
| `changed-module-verification` | no-skill | 1 | 0 | false | false | 5 | 22 |
| `changed-module-verification` | current-skill | 1 | 1 | true | true | 2 | 11 |
| `changed-module-verification` | current-skill | 0 | 2 | true | true | 2 | 9 |
| `changed-module-verification` | no-skill | 0 | 3 | false | false | 0 | 7 |
| `coverage-threshold-failure` | no-skill | 1 | 0 | false | false | 0 | 10 |
| `coverage-threshold-failure` | current-skill | 1 | 1 | false | true | 1 | 5 |
| `coverage-threshold-failure` | current-skill | 0 | 2 | true | true | 1 | 2 |
| `coverage-threshold-failure` | no-skill | 0 | 3 | false | false | 0 | 12 |
| `deterministic-unit-test-failure` | no-skill | 1 | 0 | true | false | 1 | 7 |
| `deterministic-unit-test-failure` | current-skill | 1 | 1 | true | true | 1 | 1 |
| `deterministic-unit-test-failure` | current-skill | 0 | 2 | true | true | 1 | 0 |
| `deterministic-unit-test-failure` | no-skill | 0 | 3 | false | false | 0 | 8 |
| `nowinandroid-core-common` | no-skill | 1 | 0 | false | false | 0 | 7 |
| `nowinandroid-core-common` | current-skill | 1 | 1 | true | true | 1 | 2 |
| `nowinandroid-core-common` | current-skill | 0 | 2 | true | true | 1 | 1 |
| `nowinandroid-core-common` | no-skill | 0 | 3 | false | false | 0 | 10 |
| `kampkit-android-host-test-discovery` | no-skill | 1 | 0 | false | false | 0 | 9 |
| `kampkit-android-host-test-discovery` | current-skill | 1 | 1 | false | true | 1 | 0 |
| `kampkit-android-host-test-discovery` | current-skill | 0 | 2 | true | true | 2 | 4 |
| `kampkit-android-host-test-discovery` | no-skill | 0 | 3 | false | false | 0 | 9 |
| `kampkit-no-applicable-tests` | no-skill | 1 | 0 | false | false | 0 | 12 |
| `kampkit-no-applicable-tests` | current-skill | 1 | 1 | true | true | 1 | 6 |
| `kampkit-no-applicable-tests` | current-skill | 0 | 2 | true | true | 1 | 6 |
| `kampkit-no-applicable-tests` | no-skill | 0 | 3 | false | false | 0 | 10 |

## How the two arms failed differently

11 of 12 `no-skill` cells failed identically: `bash_tool_use_present` was
false, meaning no policy-**allowed** command was ever attempted. That is not
the same as no attempt at all — every `no-skill` cell made policy-**denied**
attempts (7–22 per cell; see table above). With no eligible invocation, the
authoritative-evidence and final-answer checks had nothing to evaluate. 5 of
12 `no-skill` cells recorded `foreign_skill_summary.confirmed = 1` (a
confirmed invocation of a non-target skill); `rejected` is 0 across all 24
records.

The 1 `no-skill` exception (`scenario-no-skill-4d544cb4`,
`deterministic-unit-test-failure`, rep 1) succeeded without the target skill:
it made 1 eligible test invocation and produced correct terminal evidence
through direct exploration alone. This is a legitimate ablation outcome, not
a harness anomaly — `no-skill` establishes whether the skill is *necessary*,
not that the task is unsolvable without it.

The `current-skill` arm was not friction-free either (0–11 denials per cell),
and 2 of 12 cells missed:

- `scenario-current-skill-88f37070` (`coverage-threshold-failure`, rep 1)
  invoked the skill, ran 1 test invocation, and produced well-formed,
  correctly-targeted terminal evidence — it failed at exactly one check,
  `authoritative_outcome_matches_expected`. The evidence was simply not the
  expected outcome, a substantively different failure mode from a
  policy-denied non-invocation.
- `scenario-current-skill-9337f6a9` (`kampkit-android-host-test-discovery`,
  rep 1) invoked the skill with zero policy denials, but failed 3 checks:
  `authoritative_target_matches_expected`,
  `authoritative_outcome_matches_expected`, and
  `final_answer_consistent_with_evidence` — a wrong-target miss, not just a
  wrong-outcome one. This matches a previously-observed failure shape for
  this same scenario (a `current-skill` `wrong-target` record already exists
  in the pre-campaign corpus at an older Claude Code version); recorded here
  as a repeat observation, not a new pattern.

Wall clock totals: matrix 1 = 782.0 s, matrix 2 = 543.8 s, matrix 3 = 483.8 s,
matrix 4 = 379.0 s, matrix 5 = 316.9 s, matrix 6 = 339.2 s; campaign total
2,844.8 s (~47.4 min) across all 24 sessions, sequential.

## Reconciliation

Computed offline and deterministically from the committed records and
sidecars (`aggregate`/`analyze` against an isolated copy of just the 24 new
files for "new-only", and against the full evidence directory for "full").

| Check | Expected | Observed |
|---|---|---|
| new-only aggregate groups | 12 | 12 |
| new-only aggregate errors | 0 | 0 |
| new-only aggregate `run_count` per group | 2 (x12) | 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2 |
| new-only analyze seen / analyzed | 24 / 24 | 24 / 24 |
| new-only analyze excluded / groups / errors | 0 / 12 / 0 | 0 / 12 / 0 |
| full aggregate groups | 50 | 50 |
| full aggregate errors | 4 historical | 4 historical |
| full analyze seen | 108 | 108 |
| full analyze analyzed | 92 | 92 |
| full analyze excluded | 16 | 16 |
| full analyze groups | 46 | 46 |
| full analyze errors | 0 | 0 |

The 4 full-aggregate errors are unchanged from the pre-campaign baseline: the
same schema-era `ambient_skill_profile` errors on the two historical
`kampkit` scenarios. This capture introduced no new aggregate error.

Evidence corpus moved 84 → 108 records and 68 → 92 accepted-audit sidecars.
Each record's `accepted_audit.sha256` matches its sidecar file's actual
SHA-256 (24/24, confirmed via `validate --run` on every new record
individually — 0 errors, 0 warnings on all 24). Each run's local raw
transcript is present (24/24); raw transcripts remain gitignored and
uncommitted, verified by presence and size only, never read or quoted. Final
tracked `tools/runs/**` count after this PR's commit: 200 + 24 records + 24
sidecars + 1 report = **249**.

## Historical context — directional only

Two prior Windows captures used this same 6-scenario corpus (full or a
2-scenario subset) at different pins/toolchain versions. Numbers below are
re-read from each capture's own committed report, not from recollection.

| Scenario | v3 (2026-08-11, pin `9814ada...` homogeneous, CC `2.1.225`) current-skill | v1 canary (2026-08-12, pin `8492d98...`, CC `2.1.227`, 2 scenarios only) current-skill | This batch current-skill |
|---|---|---|---|
| `changed-module-verification` | 0/2 | 2/2 | 2/2 |
| `coverage-threshold-failure` | 1/2 | 1/2 | 1/2 |
| `deterministic-unit-test-failure` | 2/2 | — | 2/2 |
| `nowinandroid-core-common` | 2/2 | — | 2/2 |
| `kampkit-android-host-test-discovery` | 2/2 | — | 1/2 |
| `kampkit-no-applicable-tests` | 2/2 | — | 2/2 |
| **Total (6-scenario batches)** | **9/12** | n/a (2-scenario only) | **10/12** |

`no-skill` totals: v3 1/12, this batch 1/12 (identical count, not necessarily
the same passing cell).

These numbers are included **only as directional context and are not a
controlled comparison against this batch.** Between this batch and v3,
multiple things changed simultaneously: the skill snapshot pin, the Claude
Code version, the harness/base commit, and the capture date. Agent runs are
also nondeterministic at fixed seed: the seed fixes cell ordering, not model
sampling. No part of any difference between captures can be attributed to the
skill or to PR #423's auth hardening on this evidence alone. A later macOS
capture on this same corpus, when it exists, must be treated the same way —
platform is a confound, not an isolated variable, across any
Windows/macOS comparison.

## Limitations

- **n = 2 per condition per scenario.** No causal, statistical-significance,
  reliability, or generalization claim is made or supported. The counts above
  are descriptive of these 24 runs and nothing more.
- Six scenarios, the full corpus as currently defined — not a claim of
  coverage beyond what these six scenarios test.
- Single platform (`windows`), single model, single harness/pin/toolchain
  combination, one commit per source project.
- `benchmark_eligible` reflects protocol and integrity completeness, not
  answer correctness; `success` and the grading checks carry the outcome.
- No conclusion here depends on raw transcript or stderr text. Raw
  transcripts and stderr were used only as fixed-size/hash integrity
  artifacts, never read, parsed, or quoted.

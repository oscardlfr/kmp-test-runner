# macOS full-corpus post-Darwin-auth canary v2 — 2026-08-16

Full six-scenario macOS capture run after PR #429 corrected the Darwin auth
preflight to preserve `USER` alongside `HOME` (the v1 macOS canary closed at
4/24 on the `HOME`-only gap; PR #423 fixed `HOME`, PR #429 fixed the remaining
`USER` requirement). 6 scenarios x 2 conditions x 2 repetitions = 24 live
sessions, all accepted on the first attempt with **zero session/matrix
re-executions and zero cell replacements**. That orchestration claim is
distinct from the in-session `retries` grading metric (defined in Method
below), which is nonzero on 1 of the 24 records.

## Identity and provenance

| Field | Value |
|---|---|
| Harness / base commit | `29a17810f4711b7b8884e10ffb28a8584d53bf15` |
| PR #429 head (`USER`-preservation fix, squashed at base commit) | `079af29f6b92194164735fb540683f561b98b7e9` |
| Skill snapshot pin (campaign-level) | `8492d98d40b9f2208bac88cf8ac357aeb4c095ca` |
| Model (requested = resolved) | `claude-sonnet-5` |
| Claude Code | `2.1.227` (native `darwin-arm64`) |
| Source projects | `nowinandroid` @ `7d45eae4f8720a0c77f507712ba2437ff974b6ed` (4 scenarios); `nowinandroid` @ `058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8` (`deterministic-unit-test-failure` only); `kampkit` @ `b3a7784fb969a8558b88c80674c8b596944cdab7` (2 scenarios) |
| Platform | `macos` (Apple Silicon, Rosetta absent) |
| Seed | `20260722` |
| Repetitions per condition | 2 |
| Measurement scope id | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| Capture date | 2026-08-16 |
| Record schema | 5 |

Every one of the 24 records carries the harness/base commit, model, Claude
Code version, platform, seed, measurement scope id, and record schema
identically; those fields were asserted field-by-field across all 24 during
per-matrix and final reconciliation, not spot-checked. The skill snapshot pin
is fixed at the campaign level, but its per-record field is conditional:
`skill_source_sha` is `8492d98d40b9f2208bac88cf8ac357aeb4c095ca` on all 12
`current-skill` records and `null` on all 12 `no-skill` records. All 24 are
`benchmark_eligible: true`, `terminated: false`, `exit_code: 0`, with an empty
`errors` array on every record.

## Method

All six matrices ran sequentially in fixed order (`changed-module-verification`,
`coverage-threshold-failure`, `deterministic-unit-test-failure`,
`nowinandroid-core-common`, `kampkit-android-host-test-discovery`,
`kampkit-no-applicable-tests`), each as a single supervised live invocation
with an identical command shape, varying only scenario id and source-repo-dir
(matched to the scenario's clone). Each invocation planned 4 cells and
executed all 4; no cell was retried, replaced, or re-seeded, and no result was
authored by hand: **zero live sessions were re-run and zero cells were
replaced** across the whole campaign.

That is a distinct claim from the per-record `retries` metric (in-session,
unrelated to session orchestration): `max(0, test_invocations_total - 1)`.
Nonzero on exactly 1 of the 24 committed records —
`scenario-no-skill-0acceecd` (`nowinandroid-core-common`, `no-skill`, rep 1,
`retries: 2`, 3 test invocations) — itself a **failure**: it reached terminal
evidence (`terminal_authoritative_evidence_present: true`) but that evidence
was not well-formed (`terminal_authoritative_evidence_well_formed: false`),
so it lands in the same `policy-denial-observed-without-terminal-evidence`
failure class as the cleaner denial-only failures below, despite being a
substantively different, more eligible-but-unproductive attempt (21 policy
denials, 24 tool calls, 285.5s — the longest cell in the campaign).

`no-skill` is a **target-skill ablation**, not an unconstrained control: both
conditions in a pair run under the same policy, the same allowed gradle
tasks, the same allowed CLI subcommands (identical `policy_sha256` within a
scenario), and the same permission mode. Only availability of the target
skill differs.

**Execution provenance note.** Matrices 1–2 were orchestrated by a forked
coordinator agent, with every structural claim (hashes, `validate --run`,
dispatch accounting, journal/worktree state) independently re-verified by the
coordinating session directly against the committed files rather than taken
on the subagent's report. Before matrix 3, that subagent's final message
contained content the harness itself flagged as instruction-shaped
(`harness-envelope-tag`), including a fabricated, HTML-escaped
`<task-notification>` fragment and two specific claims about the coordination
history that were directly contradicted by the coordinating session's own
verbatim record. The subagent's evaluation *data* for matrices 1–2 was not
found to be compromised — every checkable structural fact matched
independently — but the subagent itself was no longer treated as a reliable
channel. Matrices 3–6 were executed directly by the coordinating session with
no subagent intermediary, using the same helper scripts (verified sane by
inspection before reuse) and the same per-matrix checklist throughout.

## Primary result — within-batch `current-skill` vs `no-skill`

This within-batch contrast is the primary comparison. Success means the run
both produced well-formed, correctly targeted authoritative evidence and
reported a terminal outcome matching the scenario's expectation.

| Scenario | `current-skill` | `no-skill` |
|---|---|---|
| `changed-module-verification` | 2/2 | 0/2 |
| `coverage-threshold-failure` | 0/2 | 0/2 |
| `deterministic-unit-test-failure` | 2/2 | 1/2 |
| `nowinandroid-core-common` | 2/2 | 0/2 |
| `kampkit-android-host-test-discovery` | 2/2 | 0/2 |
| `kampkit-no-applicable-tests` | 2/2 | 0/2 |
| **Total** | **10/12** | **1/12** |

Per-cell detail (all values read directly from the committed records):

| Scenario | Condition | Rep | Order | Success | Skill invoked | Test invocations | Denials/hook calls | Wall (s) |
|---|---|---|---|---|---|---|---|---|
| `changed-module-verification` | no-skill | 1 | 0 | false | false | 0 | 11/11 | 76.1 |
| `changed-module-verification` | current-skill | 1 | 1 | true | true | 1 | 2/3 | 119.2 |
| `changed-module-verification` | current-skill | 0 | 2 | true | true | 1 | 1/2 | 110.1 |
| `changed-module-verification` | no-skill | 0 | 3 | false | false | 0 | 10/10 | 43.2 |
| `coverage-threshold-failure` | no-skill | 1 | 0 | false | false | 0 | 5/5 | 17.6 |
| `coverage-threshold-failure` | current-skill | 1 | 1 | false | true | 1 | 2/4 | 161.2 |
| `coverage-threshold-failure` | current-skill | 0 | 2 | false | true | 1 | 5/7 | 168.5 |
| `coverage-threshold-failure` | no-skill | 0 | 3 | false | false | 0 | 7/7 | 33.8 |
| `deterministic-unit-test-failure` | no-skill | 1 | 0 | false | false | 0 | 7/7 | 26.7 |
| `deterministic-unit-test-failure` | current-skill | 1 | 1 | true | true | 1 | 0/2 | 108.6 |
| `deterministic-unit-test-failure` | current-skill | 0 | 2 | true | true | 1 | 0/2 | 104.7 |
| `deterministic-unit-test-failure` | no-skill | 0 | 3 | true | false | 1 | 5/6 | 104.8 |
| `nowinandroid-core-common` | no-skill | 1 | 0 | false | false | 3 | 21/24 | 285.5 |
| `nowinandroid-core-common` | current-skill | 1 | 1 | true | true | 1 | 2/4 | 112.1 |
| `nowinandroid-core-common` | current-skill | 0 | 2 | true | true | 1 | 1/3 | 110.4 |
| `nowinandroid-core-common` | no-skill | 0 | 3 | false | false | 0 | 5/5 | 18.7 |
| `kampkit-android-host-test-discovery` | no-skill | 1 | 0 | false | false | 0 | 10/10 | 37.2 |
| `kampkit-android-host-test-discovery` | current-skill | 1 | 1 | true | true | 1 | 0/2 | 137.0 |
| `kampkit-android-host-test-discovery` | current-skill | 0 | 2 | true | true | 1 | 0/2 | 132.4 |
| `kampkit-android-host-test-discovery` | no-skill | 0 | 3 | false | false | 0 | 8/8 | 38.4 |
| `kampkit-no-applicable-tests` | no-skill | 1 | 0 | false | false | 0 | 7/7 | 24.3 |
| `kampkit-no-applicable-tests` | current-skill | 1 | 1 | true | true | 1 | 4/6 | 97.5 |
| `kampkit-no-applicable-tests` | current-skill | 0 | 2 | true | true | 1 | 6/8 | 85.6 |
| `kampkit-no-applicable-tests` | no-skill | 0 | 3 | false | false | 0 | 5/5 | 22.0 |

## How the two arms failed differently

Of the 12 `no-skill` cells, 1 succeeded and 11 failed — not one uniform
shape. **10 of the 11** failed with `bash_tool_use_present: false` (no
policy-allowed command ever attempted, despite 5–11 policy-denied attempts
each). **The 11th, `scenario-no-skill-0acceecd`** (`nowinandroid-core-common`,
rep 1) is a distinct shape: 3 test invocations, 21 denials, 24 tool calls, and
terminal evidence present but not well-formed — an eligible-but-unproductive
attempt, not a non-attempt, and the longest-running cell in the batch. The 1
`no-skill` success (`scenario-no-skill-211432c2`,
`deterministic-unit-test-failure`, rep 0) succeeded without the target skill:
1 eligible test invocation against 5 denials, correct terminal evidence
through direct exploration alone — a legitimate ablation outcome, not a
harness anomaly.

The `current-skill` arm missed 2 of 12, both in `coverage-threshold-failure`,
each a different failure shape:

- `scenario-current-skill-184242a4` (rep 0): skill invoked, 1 test invocation,
  well-formed and correctly-targeted terminal evidence — but
  `authoritative_outcome_matches_expected: false` and
  `final_answer_consistent_with_evidence: false`. A wrong-outcome miss.
- `scenario-current-skill-de6faa60` (rep 1): skill invoked, 1 test
  invocation, well-formed evidence, `authoritative_outcome_matches_expected:
  true` — but `final_answer_consistent_with_evidence: false`. The run
  measured the right thing and got the right outcome; the final structured
  answer did not match it. Per the known grader-precision limitation recorded
  in the prior Windows report (`final_answer_consistent_with_evidence`
  compares the answer against the scenario's expected value, not this run's
  own observed evidence), this is a real, distinct failure class from the
  rep-0 miss, not the same defect twice.

No pre-dispatch block occurred on any of the 24 records
(`pre_dispatch_blocked_total: 0` on every sidecar's summary, confirmed
individually, not inferred from the aggregate). Per the runbook, this is a
live-coverage limitation of this batch, not evidence the matcher doesn't
work — mitigated but not replaced by the harness's own focused E2E fixture
for that code path.

Wall clock totals: matrix 1 = 348.6 s, matrix 2 = 381.1 s, matrix 3 = 344.8 s,
matrix 4 = 526.7 s, matrix 5 = 345.0 s, matrix 6 = 229.4 s; campaign total
2,175.6 s (~36.3 min) across all 24 sessions, sequential.

## Reconciliation

Computed deterministically from the committed records and sidecars
(`aggregate`/`analyze` against an isolated copy of just the 24 new files for
"new-only", and against the full evidence directory for "full").

| Check | Expected | Observed |
|---|---|---|
| new-only aggregate groups | 12 | 12 |
| new-only aggregate errors | 0 | 0 |
| new-only aggregate `run_count` per group | 2 (x12) | 2 (x12) |
| new-only analyze seen / analyzed | 24 / 24 | 24 / 24 |
| new-only analyze excluded / groups / errors | 0 / 12 / 0 | 0 / 12 / 0 |
| full aggregate groups | 74 | 74 |
| full aggregate errors | 4 historical | 4 historical |
| full analyze seen | 156 | 156 |
| full analyze analyzed | 140 | 140 |
| full analyze excluded | 16 | 16 |
| full analyze groups | 70 | 70 |
| full analyze errors | 0 | 0 |
| final sidecars (schema 1 / schema 2) | 140 (92 / 48) | 140 (92 / 48) |

The 4 full-aggregate errors are unchanged from the pre-campaign baseline: the
same schema-era `ambient_skill_profile` errors on two historical `kampkit`
scenarios at an older Claude Code version (`2.1.217`) on `windows`. This
capture introduced no new aggregate error.

Evidence corpus moved 298 → 347 tracked `tools/runs/**` files (298 baseline +
24 records + 24 sidecars + 1 report). Each record's `accepted_audit.sha256`
matches its sidecar file's actual SHA-256 (24/24, confirmed via `validate
--run` on every new record individually — 0 errors, 0 warnings on all 24).
Each run's local raw transcript is present (24/24); raw transcripts remain
gitignored and uncommitted, verified by presence and count only, never read
or quoted. Journal was empty/removed after every matrix's verified success;
both source clones (`NowInAndroid`, `KaMPKit`) ended the campaign clean with
exactly one worktree each.

## Historical context — directional only

Three prior captures used this same 6-scenario corpus (full or a 2-scenario
subset) at different pins/toolchain versions/platforms. Numbers below are
re-read from each capture's own committed report, not from recollection.

| Scenario | v3 (2026-08-11, pin `9814ada...`, CC `2.1.225`, windows) | v1 canary (2026-08-12, pin `8492d98...`, CC `2.1.227`, macos, 2 scenarios only) | Windows batch (2026-08-13, pin `8492d98...`, CC `2.1.227`) | This macOS batch |
|---|---|---|---|---|
| `changed-module-verification` | 0/2 | 2/2 | 2/2 | 2/2 |
| `coverage-threshold-failure` | 1/2 | 1/2 | 1/2 | 0/2 |
| `deterministic-unit-test-failure` | 2/2 | — | 2/2 | 2/2 |
| `nowinandroid-core-common` | 2/2 | — | 2/2 | 2/2 |
| `kampkit-android-host-test-discovery` | 2/2 | — | 1/2 | 2/2 |
| `kampkit-no-applicable-tests` | 2/2 | — | 2/2 | 2/2 |
| **Total (6-scenario batches)** | **9/12** | n/a | **10/12** | **10/12** |

`no-skill` totals: v3 1/12, Windows batch 1/12, this batch 1/12 (identical
count across all three full batches, not necessarily the same passing
scenario each time — this batch's success was `deterministic-unit-test-failure`;
the Windows batch's was also `deterministic-unit-test-failure`, but a
different repetition and a different underlying attempt).

These numbers are included **only as directional context and are not a
controlled comparison against this batch.** Between this batch and the
Windows batch, multiple things changed simultaneously: platform, host,
capture date, and PR #425/#426/#429 landed on `develop` between the two
captures, changing harness semantics prospectively. Agent runs are also
nondeterministic at fixed seed: the seed fixes cell ordering, not model
sampling. This batch's one `coverage-threshold-failure` current-skill miss
where the Windows batch had one hit, and one `kampkit-android-host-test-discovery`
current-skill hit where the Windows batch had one miss, are weak directional
observations, not evidence of an OS effect, a regression, or variance beyond
n=2 noise. No part of any difference between captures is attributed to
platform, the skill, or any specific PR on this evidence alone.

## Limitations

- **n = 2 per condition per scenario.** No causal, statistical-significance,
  reliability, or generalization claim is made or supported. The counts above
  are descriptive of these 24 runs and nothing more.
- Six scenarios, the full corpus as currently defined — not a claim of
  coverage beyond what these six scenarios test.
- Single platform (`macos`, Apple Silicon), single model, single
  harness/pin/toolchain combination, one commit per source project.
- `benchmark_eligible` reflects protocol and integrity completeness, not
  answer correctness; `success` and the grading checks carry the outcome.
- No conclusion here depends on raw transcript or stderr text. Raw
  transcripts were used only as fixed-size/count integrity artifacts, never
  read, parsed, or quoted.
- Zero pre-dispatch blocks occurred in this batch (see "How the two arms
  failed differently"); this batch cannot demonstrate that code path live,
  only that it did not spuriously fire.
- `final_answer_consistent_with_evidence` compares the final answer against
  the scenario's *expected* value, not against this run's own observed
  evidence (documented grader-precision limitation, not a data error —
  see the Windows batch's report for the source-verified detail). This
  affects the reading of `scenario-current-skill-de6faa60` above but changes
  nothing about its `success: false` classification or any reconciliation
  number in this report.
- Matrices 1–2 were orchestrated through a subagent whose process-reporting
  became unreliable partway through the campaign (see Method); this is
  disclosed for evidence-provenance completeness. It was not found to affect
  any structural or substantive claim in this report, all of which are
  independently re-derived from the committed records/sidecars directly,
  not from that subagent's narrative.

# Windows post-remediation canary v1 — 2026-08-12

Focused two-scenario Windows capture covering exactly the two routing contracts
remediated by the skill-snapshot pin change. 2 scenarios x 2 conditions x 2
repetitions = 8 live sessions, all accepted.

## Identity and provenance

| Field | Value |
|---|---|
| Harness / base commit | `dc62a72ce8b151878767eeea3a7866772f9d7de9` |
| Skill snapshot pin | `8492d98d40b9f2208bac88cf8ac357aeb4c095ca` |
| Model (requested = resolved) | `claude-sonnet-5` |
| Claude Code | `2.1.227` |
| Source project | `nowinandroid` @ `7d45eae4f8720a0c77f507712ba2437ff974b6ed` |
| Platform | `windows` |
| Seed | `20260722` |
| Repetitions per condition | 2 |
| Measurement scope id | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| Capture date | 2026-08-12 |
| Record schema | 5 |

Every one of the 8 records carries these values identically; the fields were
asserted field-by-field rather than spot-checked. All 8 are
`benchmark_eligible: true`, `terminated: false`, `exit_code: 0`, with an empty
`errors` array and a passing `no_transcript_structural_issues` grading check.

## Method

Both matrices ran sequentially in fixed order with an identical command shape,
varying only the scenario id. Each invocation planned 4 cells and executed all 4;
no cell was retried, replaced, or re-seeded, and no result was authored by hand.

`no-skill` is a **target-skill ablation**, not an unconstrained control: both
conditions run under the same policy, the same allowed gradle tasks, the same
allowed CLI subcommands (identical `policy_sha256` within a scenario), and the
same permission mode. Only availability of the target skill differs.

## Primary result — within-batch `current-skill` vs `no-skill`

This within-batch contrast is the primary comparison. Success means the run both
produced well-formed, correctly targeted authoritative evidence and reported a
terminal outcome matching the scenario's expectation.

| Scenario | `current-skill` | `no-skill` |
|---|---|---|
| `changed-module-verification` | 2/2 | 0/2 |
| `coverage-threshold-failure` | 1/2 | 0/2 |
| **Total** | **3/4** | **0/4** |

Per-cell detail (all values read from the committed records):

| Scenario | Condition | Rep | Order | Success | Skill invoked | Test invocations |
|---|---|---|---|---|---|---|
| `changed-module-verification` | no-skill | 1 | 0 | false | false | 0 |
| `changed-module-verification` | current-skill | 1 | 1 | true | true | 2 |
| `changed-module-verification` | current-skill | 0 | 2 | true | true | 2 |
| `changed-module-verification` | no-skill | 0 | 3 | false | false | 0 |
| `coverage-threshold-failure` | no-skill | 1 | 0 | false | false | 0 |
| `coverage-threshold-failure` | current-skill | 1 | 1 | false | true | 1 |
| `coverage-threshold-failure` | current-skill | 0 | 2 | true | true | 1 |
| `coverage-threshold-failure` | no-skill | 0 | 3 | false | false | 0 |

### How the two arms failed differently

The two arms did not fail in the same way, and the distinction matters more than
the headline counts.

All 4 `no-skill` cells failed identically and early: `bash_tool_use_present` was
false, meaning **no policy-allowed command was ever attempted**. With no attempt,
the three authoritative-evidence checks and the final-answer check had nothing to
evaluate. These runs did not attempt the task and get it wrong; they did not
reach the point of producing target evidence at all. Median wall clock across the
4 `no-skill` cells is well under a minute (35.1s, 39.4s, 40.7s, 72.6s).

The single `current-skill` cell that failed
(`coverage-threshold-failure`, rep 1) failed at exactly one check:
`authoritative_outcome_matches_expected`. It invoked the skill, ran a test
invocation, and produced well-formed, correctly-targeted terminal evidence — the
evidence was simply not the expected outcome. That is a substantively different
failure mode from "never attempted", and it is the only near-miss in the batch.

3 of 4 `no-skill` cells recorded `foreign_skill_summary.confirmed = 1`, i.e. a
confirmed invocation of a non-target skill. `rejected` is 0 across all 8 records.

Wall clock totals: matrix 1 = 428,395 ms, matrix 2 = 543,386 ms.

## Reconciliation

Computed offline and deterministically from the committed records and sidecars.

| Check | Expected | Observed |
|---|---|---|
| new-only aggregate groups | 4 | 4 |
| new-only aggregate errors | 0 | 0 |
| new-only aggregate `run_count` per group | 2 | 2, 2, 2, 2 |
| new-only analyze seen / analyzed | 8 / 8 | 8 / 8 |
| new-only analyze excluded / groups / errors | 0 / 4 / 0 | 0 / 4 / 0 |
| full aggregate groups | 38 | 38 |
| full aggregate errors | 4 historical | 4 historical |
| full analyze seen | 84 | 84 |
| full analyze analyzed | 68 | 68 |
| full analyze excluded | 16 | 16 |
| full analyze groups | 34 | 34 |
| full analyze errors | 0 | 0 |

The 4 full-aggregate errors are unchanged from the pre-campaign baseline: the
same schema-era `ambient_skill_profile` errors on the two historical `kampkit`
scenarios. This capture introduced no new aggregate error.

Evidence corpus moved 76 -> 84 records and 60 -> 68 accepted-audit sidecars.
Each record's `accepted_audit.sha256` matches its sidecar file's actual SHA-256
(8/8). Each run's local raw transcript is present with a byte size exactly equal
to that record's `stream_json_bytes` (8/8); raw transcripts remain gitignored and
uncommitted, and were verified by size and hash only.

## Historical context — directional only

The prior Windows full-corpus capture (v3) recorded `changed-module-verification`
at 0/2 and `coverage-threshold-failure` at 1/2 for the equivalent arm. Those
numbers are included **only as directional context and are not a controlled
comparison against this batch.** At least three things changed simultaneously
between the two captures:

- skill snapshot pin moved to `8492d98...` (v3 used a different pin);
- Claude Code moved to `2.1.227` (v3 ran `2.1.225`);
- the harness/base commit differs, as does the capture date.

Agent runs are also nondeterministic at fixed seed: the seed fixes cell ordering,
not model sampling. No part of the change between v3 and this batch can be
attributed to the skill on this evidence.

## Limitations

- **n = 2 per condition per scenario.** No causal, statistical-significance,
  reliability, or generalization claim is made or supported. The counts above are
  descriptive of these 8 runs and nothing more.
- Two scenarios only, chosen because they cover the two remediated routing
  contracts. Not a corpus-wide result.
- Single platform (`windows`), single model, single source project at one commit.
- `benchmark_eligible` reflects protocol and integrity completeness, not answer
  correctness; success and the grading checks carry the outcome.
- No conclusion here depends on raw transcript text. Raw transcripts were used
  only as fixed-size integrity artifacts, never read or quoted.

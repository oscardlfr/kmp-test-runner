# Windows full-corpus canary after pre-dispatch accounting v1 — 2026-08-15

Evidence-only capture. No harness, skill, pin, policy, grader, corpus, or schema
change accompanies it.

## Purpose

Validate that the pre-dispatch accounting corrections merged in PR #426 —
canonical per-`tool_use_id` dispatch classification, fail-closed recognition of
the one demonstrated pre-dispatch block form, `hookAccountingOk`,
`captureIncomplete`, accepted-audit sidecar schema 2, `policy_decisions_missing`,
and sidecar/record schema correspondence — broke no matrix, and that all six
matrices complete homogeneously on Windows.

PR #427 (test-only) preceded this campaign: it made the committed-corpus guard
version-aware, without which the 24 schema-2 sidecars below could not have been
committed at all.

## Fixed identity

| Field | Value |
|---|---|
| Harness/base SHA | `d1d0b6c1c7e1495efe59926ada064495a99a7a89` |
| PR #427 audited head | `6f7a53c4ecc01b139a92e458a0592c8ad40f3fe9` |
| PR #426 squash | `0eec5cc1dac438bd604611338d71ffc900d375c4` |
| Skill snapshot pin | `8492d98d40b9f2208bac88cf8ac357aeb4c095ca` |
| Model | `claude-sonnet-5` |
| Claude Code | `2.1.227`, Windows distribution |
| Seed | `20260722` |
| Repeats | `2` |
| Conditions | `no-skill`, `current-skill` |
| Scope id | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| Live sessions | 24 of 24 authorized |

`no-skill` is a **target-skill ablation under the same policy**: the same hook,
the same allowlist, the same corpus, the same model. Only the target skill's
availability differs. `current-skill` records carry the pin above;
`no-skill` records carry `skill_source_sha: null`. Verified: 12/12 and 12/12.

## Session accounting

- 6 matrices × 4 cells = **24 live sessions**, exactly the authorized ceiling.
- **Zero** session, cell, or matrix re-executions, replacements, or retries.
- Zero changes to seed, repeats, order, model, or Claude Code version mid-run.
- Every matrix ran sequentially; at most one live process existed at any time.

**Do not conflate two different quantities.** The zero above is *campaign-level*:
no session was ever re-run. It is unrelated to the grader's in-session
`retries = max(0, test_invocations_total - 1)` metric, which counts repeated test
invocations *inside* a single session and is a behavioural observation, not a
harness failure. In this batch that in-session metric sums to **1** for
current-skill and **6** for no-skill.

## Results

### "6/6 matrices accepted" is a structural statement, not a behavioural one

All six matrices were **accepted**: every cell passed the harness's structural
integrity gates — hook accounting, transcript structure, provenance, sidecar
construction and cross-validation — so all 24 records were promoted. That is
what acceptance means and it is the harness property this campaign set out to
test.

It is **not** a claim that the agent succeeded in 24 of 24 tasks. Behavioural
outcomes are separate and lower: **current-skill 8/12, no-skill 1/12**. A cell
can be structurally accepted and still fail its grading checks; 15 of the 24
cells did exactly that.

### By condition (n = 12 cells each)

| Metric | current-skill | no-skill |
|---|---|---|
| `success` | 8/12 | 1/12 |
| `expected_outcome_matched` | 8/12 | 2/12 |
| all 8 grading checks passed | 8/12 | 1/12 |
| target skill invoked | 12/12 | 0/12 |
| in-session retries (sum) | 1 | 6 |
| `pre_dispatch_blocked_total` | 0 | 0 |
| `policy_decisions_missing` | 0 | 0 |

`success` and `expected_outcome_matched` differ by one cell: one no-skill cell
matched the expected outcome without passing the full check set.

### By scenario (successes out of 2 repeats)

| Scenario | current-skill | no-skill |
|---|---|---|
| `changed-module-verification` | 1/2 | 0/2 |
| `coverage-threshold-failure` | 0/2 | 0/2 |
| `deterministic-unit-test-failure` | 2/2 | 1/2 |
| `kampkit-android-host-test-discovery` | 1/2 | 0/2 |
| `kampkit-no-applicable-tests` | 2/2 | 0/2 |
| `nowinandroid-core-common` | 2/2 | 0/2 |

### Per cell

| Scenario | Cond | Rep | success | outcome | checks | first signal (ms) | wall (ms) | testInv | retries | denies |
|---|---|---|---|---|---|---|---|---|---|---|
| changed-module-verification | current-skill | 0 | true | true | 8/8 | 184070 | 187009 | 2 | 1 | 9 |
| changed-module-verification | current-skill | 1 | false | false | 4/8 | — | 224056 | 1 | 0 | 15 |
| changed-module-verification | no-skill | 0 | false | false | 3/8 | — | 64651 | 0 | 0 | 11 |
| changed-module-verification | no-skill | 1 | false | false | 4/8 | — | 334412 | 5 | 4 | 22 |
| coverage-threshold-failure | current-skill | 0 | false | false | 6/8 | — | 219464 | 1 | 0 | 2 |
| coverage-threshold-failure | current-skill | 1 | false | false | 6/8 | — | 215814 | 1 | 0 | 2 |
| coverage-threshold-failure | no-skill | 0 | false | false | 3/8 | — | 40798 | 0 | 0 | 8 |
| coverage-threshold-failure | no-skill | 1 | false | false | 3/8 | — | 56389 | 0 | 0 | 12 |
| deterministic-unit-test-failure | current-skill | 0 | true | true | 8/8 | 137913 | 142901 | 1 | 0 | 0 |
| deterministic-unit-test-failure | current-skill | 1 | true | true | 8/8 | 140890 | 147492 | 1 | 0 | 0 |
| deterministic-unit-test-failure | no-skill | 0 | true | true | 8/8 | 136406 | 140239 | 1 | 0 | 7 |
| deterministic-unit-test-failure | no-skill | 1 | false | false | 3/8 | — | 20628 | 0 | 0 | 5 |
| kampkit-android-host-test-discovery | current-skill | 0 | false | false | 6/8 | — | 68884 | 1 | 0 | 0 |
| kampkit-android-host-test-discovery | current-skill | 1 | true | true | 8/8 | 133915 | 140020 | 1 | 0 | 0 |
| kampkit-android-host-test-discovery | no-skill | 0 | false | false | 3/8 | — | 35587 | 0 | 0 | 9 |
| kampkit-android-host-test-discovery | no-skill | 1 | false | false | 3/8 | — | 39052 | 0 | 0 | 7 |
| kampkit-no-applicable-tests | current-skill | 0 | true | true | 8/8 | 95831 | 99801 | 1 | 0 | 7 |
| kampkit-no-applicable-tests | current-skill | 1 | true | true | 8/8 | 91462 | 95536 | 1 | 0 | 4 |
| kampkit-no-applicable-tests | no-skill | 0 | false | false | 3/8 | — | 52721 | 0 | 0 | 11 |
| kampkit-no-applicable-tests | no-skill | 1 | false | false | 3/8 | — | 34978 | 0 | 0 | 8 |
| nowinandroid-core-common | current-skill | 0 | true | true | 8/8 | 148536 | 151577 | 1 | 0 | 1 |
| nowinandroid-core-common | current-skill | 1 | true | true | 8/8 | 152148 | 155251 | 1 | 0 | 2 |
| nowinandroid-core-common | no-skill | 0 | false | false | 3/8 | — | 48434 | 0 | 0 | 10 |
| nowinandroid-core-common | no-skill | 1 | false | true | 7/8 | 152121 | 335614 | 3 | 2 | 25 |

A policy **deny** is the hook working as intended and is recorded as such
(`hook_deny_count`, `policy_decision: "deny"`, `dispatch_status:
"hook_evaluated"`). It is not an error and is categorically distinct from a
pre-dispatch block.

### The four failed current-skill cells

Read verbatim from the committed records' own `grading_checks`. These are the
failing check names and their recorded details — **no cause is attributed**, no
skill defect is claimed, and no regression is inferred. Establishing why any of
these happened requires evidence this report does not contain.

| Run id | Scenario | Rep | Checks | Failing checks (as recorded) |
|---|---|---|---|---|
| `scenario-current-skill-d9d1a5fe` | `changed-module-verification` | 1 | 4/8 | terminal attempt produced content that did not parse as valid evidence; target and outcome therefore had no well-formed evidence to check; final answer contains no `KMP_EVAL_RESULT` block |
| `scenario-current-skill-29d93e1c` | `coverage-threshold-failure` | 0 | 6/8 | terminal attempt outcome does not match expected; `KMP_EVAL_RESULT` block does not match the facts observed in the terminal attempt's own evidence |
| `scenario-current-skill-151c2029` | `coverage-threshold-failure` | 1 | 6/8 | same two checks, same recorded details as the cell above |
| `scenario-current-skill-4e6425f2` | `kampkit-android-host-test-discovery` | 0 | 6/8 | terminal attempt targeted the wrong module; outcome therefore had no well-formed, correctly-targeted evidence to check |

Two structural notes, both readable directly from the check sets:

- For `d9d1a5fe`, `29d93e1c` and `151c2029`, evidence was produced and reached
  the grader; for `d9d1a5fe` it did not parse, for the other two it parsed but
  the outcome disagreed with the scenario's expectation.
- For `4e6425f2`, `final_answer_consistent_with_evidence` **passed** while the
  target check failed — the agent's final answer was consistent with the
  evidence it actually produced, which happened to target the wrong module.
  That is PR #425's semantics working as designed: the check binds the final
  answer to terminal evidence, not to `scenario.expected`.

## Dispatch accounting — the point of this campaign

Structural counts, taken from the schema-2 sidecars' own fields only. No raw
transcript or stderr was read to produce any number in this report.

| Condition | Cells | `pre_dispatch_blocked_total` | `policy_decisions_missing` | `dispatch_status: unaccounted` |
|---|---|---|---|---|
| current-skill | 12 | 0 | 0 | 0 |
| no-skill | 12 | 0 | 0 | 0 |
| **All** | **24** | **0** | **0** | **0** |

Per scenario, `pre_dispatch_blocked_total` is 0 for all 4 cells of all 6
scenarios.

**What this campaign validated, and what it did not.**

Validated: the ordinary dispatch-accounting path over 24 real Windows sessions.
Every Bash attempt in every cell was classified, with zero unaccounted calls and
zero spurious missing decisions — the regression the incident made a live risk.

**Not validated: the pre-dispatch block matcher itself.** Zero occurrences means
`isRecognizedPreDispatchBlock` was never exercised against a real Claude Code
pre-dispatch block in this campaign. **This is a live-coverage limitation of the
canary**, and it should be recorded as one. The focused end-to-end fixture at
this base (`tests/fixtures/fake-claude-run-pre-dispatch-blocked`, driven by
`agentic-eval-run-command.test.js`) mitigates it, but a fixture is not a
substitute for a live observation: it exercises the matcher against a recorded
shape, not against whatever the product actually emits next.

## Reconciliation

All figures are deterministic output of `aggregate` / `analyze` over the
committed records and sidecars.

| | Baseline (pre-campaign) | New only | Full (post-campaign) |
|---|---|---|---|
| tracked `tools/runs/**` | 249 | +49 | **298** |
| scenario records | 108 | +24 | **132** |
| accepted-audit sidecars | 92 | +24 | **116** |
| aggregate groups | 50 | 12 | **62** |
| aggregate errors | 4 (`ambient_skill_profile`) | 0 | 4 (same 4) |
| analyze files_seen | 108 | 24 | **132** |
| analyze files_analyzed | 92 | 24 | **116** |
| analyze excluded-not-applicable | 16 | 0 | **16** |
| analyze benchmark-ineligible | 0 | 0 | **0** |
| analyze groups | 46 | 12 | **58** |
| analyze errors | 0 | 0 | **0** |

New-only aggregate reports `run_count: 2` for every one of its 12 groups.

The 16 excluded-not-applicable records are exactly the 8 schema-3 plus 8
schema-4 pre-v5 records; they are outside `analyze`'s domain and are not errors.
The 4 aggregate errors are the same 4 historical `ambient_skill_profile` entries
present before this campaign; none is new.

Sidecar schema distribution after this campaign: **92 schema 1** (historical,
frozen) plus **24 schema 2** (this batch). Every record's
`accepted_audit.schema` equals its own sidecar's schema, and every
`validate --run` returned 0 errors and 0 warnings across all 24.

## Comparability and limits

- **n = 2 per cell.** No causal, significance, reliability, or generalization
  claim is made or supported. The tables are descriptive counts.

### Directional context — a signal to analyse, not a conclusion

Windows 6-scenario `current-skill` totals, each read from its own campaign's
committed report:

| Campaign | Date | Claude Code | Pin | current-skill | no-skill |
|---|---|---|---|---|---|
| full-corpus canary v3 | 2026-08-11 | `2.1.225` | `9814ada…` | 9/12 | 1/12 |
| Windows post-auth-hardening v1 | 2026-08-13 | `2.1.227` | `8492d98…` | 10/12 | 1/12 |
| **this campaign** | 2026-08-15 | `2.1.227` | `8492d98…` | **8/12** | **1/12** |

Note the v3 row also differs in pin and Claude Code version, so only the last
two rows share a skill snapshot and a toolchain at all.

**This is a weak directional observation, but it does not establish a
behavioural regression.** Three things limit what can be read from it:

1. **n = 2 per cell does not characterise variability.** A 10→8 move is two
   cells, and this design produces no estimate of run-to-run spread. That means
   the difference cannot be shown to exceed normal variation — it does not mean
   it has been shown to be normal variation.
2. **The success totals are not directly comparable.** PR #425 rebound
   `final_answer_consistent_with_evidence` to terminal evidence and PR #426
   reworked dispatch accounting, both **prospectively**; earlier batches were
   graded under the older semantics and were not re-graded. The three totals are
   therefore not measured on one instrument, so differencing them measures the
   instrument change as well as any behavioural change.
3. **The non-monotonic shape (9 → 10 → 8) settles nothing.** It is not proof of
   variance, and it does not rule out a real regression in the most recent
   transition. A genuine change occurring between 08-13 and 08-15 would produce
   this same shape.

No claim is made here about which explanation is more likely; the data do not
support ranking them.

Recorded because it is worth a deliberate look **before** the macOS canary, not
because it supports a conclusion now. Investigating it causally would need more
repeats while holding **all** of the following fixed: harness and grader
version, skill pin, Claude Code version, platform, corpus and source commits,
and the execution protocol. Fixing the grader alone would not be sufficient —
each of the others is an uncontrolled difference in the table above or a
plausible source of one. This campaign was not designed to provide that.
- **No macOS comparison of any kind is made here** — not directional, not
  illustrative. The committed baseline contains **108 Windows records and zero
  macOS records**, so there is nothing to compare against. A valid macOS canary
  will run later under its own authorization and its own runbook.
- **Two prior incidents are excluded and never pooled:**
  (a) `agentic-full-corpus-windows-post-final-answer-binding-v1`, closed at 3
  spent sessions after a Claude-Code pre-dispatch tool block aborted matrix 1 —
  the very defect PR #426 addressed; and (b) the prior macOS campaign, which
  ended as an authentication failure and is incident evidence, not benchmark
  evidence.
- **Harness differences against historical records.** This batch's sidecars are
  schema 2; the 92 historical ones are schema 1. PR #425 (final-answer evidence
  binding) and PR #426 (dispatch accounting) changed grading and accounting
  semantics **prospectively**; historical records were not rewritten. Any
  cross-campaign comparison must account for that, and for differing harness
  base, date, and source state.
- No number in this report derives from raw transcript or stderr text.

## Provenance

- Worktree: `C:\kmp-eval\agentic-full-corpus-windows-post-pre-dispatch-accounting-v1`
- Source clones: fresh, non-shallow, single-worktree, clean throughout; origin
  verified against each scenario's own `project_url`, and each scenario's
  `project_commit` proven resolvable before its matrix ran.
- NowInAndroid `7d45eae4f8720a0c77f507712ba2437ff974b6ed` (scenarios 1, 2, 4),
  `058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8` (scenario 3);
  KaMPKit `b3a7784fb969a8558b88c80674c8b596944cdab7` (scenarios 5, 6).
- Raw transcripts (24) are retained locally and gitignored; they are not part of
  this commit.
- No incident diagnostic, rejection diagnostic, cleanup warning, or residual
  journal was produced by any of the six matrices.

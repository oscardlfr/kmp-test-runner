# Windows coverage-threshold canary, post-budget-invariant — 2026-08-16

Focused single-scenario Windows capture measuring whether the skill snapshot
containing the coverage-budget command invariant preserves an explicit 15-line
coverage budget through the terminal `parallel` command. 1 scenario x 2
conditions x 4 repetitions = 8 live sessions, all accepted.

This is a focused replication, not a reliability or significance study. See
"Claim boundary" below before quoting any number from this document.

## Identity and provenance

| Field | Value |
|---|---|
| Harness / base commit | `32364d4026a2cbce853a53a10ab2498fe4457a28` |
| Skill snapshot pin (campaign-level) | `0bb958d464ccd4b2f463aa10a4101d726e2154c4` |
| Scenario | `coverage-threshold-failure` |
| Model (requested = resolved) | `claude-sonnet-5` |
| Claude Code | `2.1.227` |
| Windows distribution | Windows 11 Pro, 23H2, build 22631.6199, x64 |
| Source project | `nowinandroid` @ `7d45eae4f8720a0c77f507712ba2437ff974b6ed` |
| Platform | `windows` |
| Seed | `20260722` |
| Repetitions per condition | 4 |
| Measurement scope id | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| `kmp_test` CLI | `0.14.0` @ `32364d4026a2cbce853a53a10ab2498fe4457a28` |
| Policy sha256 | `44400952001e67181080ff71d5c01f8660293fc2c972a9b581f3bd5ffc802dfa` |
| Daemon policy | `disabled-via-gradle-user-home-properties` |
| Env allowlist profile | `narrow` |
| Cache state | `cold` |
| Capture date | 2026-08-16 |
| Record schema | 5 |

All 8 records carry the harness/base commit, model, Claude Code version, source
project commit, platform, seed, measurement scope id, policy hash and record
schema identically; each field was asserted across all 8 records rather than
spot-checked. `skill_source_sha` is conditional as the schema requires: the pin
`0bb958d464ccd4b2f463aa10a4101d726e2154c4` on all 4 `current-skill` records and
`null` on all 4 `no-skill` records. All 8 are `benchmark_eligible: true`,
`terminated: false`, `exit_code: 0`, with an empty `errors` array.

The Claude Code binary was an isolated, pinned toolchain resolved through the
harness's own environment construction, not an ambient installation; the
resolved executable and its reported version (`2.1.227 (Claude Code)`) were
both verified through the production spawn path before the matrix ran.

## Method

One matrix invocation, executed exactly once. The pre-registered dry-run planned
8 cells and the live run executed all 8. No cell was retried, replaced or
re-seeded, no matrix was re-run, and no result was authored by hand.

Execution order was fixed by the seed and interleaved conditions:

| order_index | repetition_index | condition |
|---|---|---|
| 0 | 1 | `no-skill` |
| 1 | 1 | `current-skill` |
| 2 | 2 | `current-skill` |
| 3 | 2 | `no-skill` |
| 4 | 3 | `no-skill` |
| 5 | 3 | `current-skill` |
| 6 | 0 | `current-skill` |
| 7 | 0 | `no-skill` |

## Session accounting, at every layer

Stated separately per layer, because these are different quantities and
collapsing them into the single word "retries" has previously produced wrong
counts:

| Layer | Count |
|---|---|
| Authorized live-session ceiling | 8 |
| Matrix process executions | 1 |
| Matrix re-executions | 0 |
| Planned cells (dry-run) | 8 |
| Executed cells | 8 |
| Cells replaced or re-seeded | 0 |
| Cell respawns | 0 (the harness has no automatic respawn mechanism) |
| Live sessions consumed | 8 of 8 |
| Records / sidecars / raw transcripts written | 8 / 8 / 8 |
| Per-record `retries.value` | 0 on every one of the 8 |

The per-record `retries` metric is an in-session count of test invocations
beyond the first, unrelated to session orchestration. Both layers are zero here,
but they are reported separately because they measure different things.

## Structural acceptance

Structural acceptance is reported independently of whether any agent answered
correctly. A cell can be structurally accepted while carrying `success: false`.

| Check | Result |
|---|---|
| New records / sidecars / local raw transcripts | 8 / 8 / 8 |
| Records validating with zero errors and zero warnings | 8 / 8 |
| `benchmark_eligible: true` | 8 / 8 |
| `terminated: false` | 8 / 8 |
| Empty record `errors` array | 8 / 8 |
| Accepted-audit hash matches physical sidecar | 8 / 8 |
| Rejection tier created | none |
| Incident tier created | none |
| Durable journal after acceptance | empty |
| Source clone after the run | clean, exactly one registered worktree |

Corpus state after capture: 164 records and 148 accepted-audit sidecars.
`aggregate` reports 76 groups with the same 4 pre-existing historical
`ambient_skill_profile` errors carried by older records; `analyze` reports 164
seen, 148 analyzed, 16 excluded, 72 groups, 0 errors. Restricted to the 8 new
records in isolation, `aggregate` reports 2 groups and 0 errors with
`run_count: 4` in each, and `analyze` reports 8 seen, 8 analyzed, 0 excluded,
2 groups, 0 errors.

## Behavioral result

Reported separately from structural acceptance above.

| Condition | `success: true` | Cells passing all 8 grading checks |
|---|---|---|
| `current-skill` | 4 / 4 | 4 / 4 |
| `no-skill` | 0 / 4 | 0 / 4 |

### Per-cell grading checks

All four `current-skill` cells (order_index 1, 2, 5, 6) passed all 8 checks:
`no_transcript_structural_issues`, `bash_tool_use_present`,
`tool_result_correlated`, `authoritative_evidence_well_formed`,
`authoritative_target_matches_expected`,
`authoritative_outcome_matches_expected`, `no_provider_contradiction`,
`final_answer_consistent_with_evidence`.

All four `no-skill` cells (order_index 0, 3, 4, 7) passed 3 of 8 —
`no_transcript_structural_issues`, `tool_result_correlated` and
`no_provider_contradiction` — and failed the same 5 in every cell. The recorded
details are identical across all four cells for the first four of those checks,
quoted literally here:

| Failing check | Recorded detail (all 4 cells) |
|---|---|
| `bash_tool_use_present` | no policy-allowed command was ever attempted |
| `authoritative_evidence_well_formed` | no attempt capable of producing target evidence was ever made |
| `authoritative_target_matches_expected` | no well-formed terminal evidence to check |
| `authoritative_outcome_matches_expected` | no well-formed, correctly-targeted terminal evidence to check |

The fifth check failed in all four cells too, but **not for the same recorded
reason**, so it is reported per cell rather than collapsed:

| Cell | `final_answer_consistent_with_evidence` recorded detail |
|---|---|
| `no-skill-115425bb` | final answer contains no `KMP_EVAL_RESULT` block |
| `no-skill-17db32ac` | final answer contains no `KMP_EVAL_RESULT` block |
| `no-skill-ced1c9f8` | final answer contains no `KMP_EVAL_RESULT` block |
| `no-skill-3f2e929a` | no well-formed, canonicalizable observed result from the terminal attempt to compare the `KMP_EVAL_RESULT` block against |

The `3f2e929a` detail records the absence of a canonicalizable observed terminal
result to compare against. It says nothing about whether that cell's final answer
did or did not contain a `KMP_EVAL_RESULT` block, and no such inference is drawn
here.

The `no-skill` comparator is a within-batch ablation. It is not a requirement
that those cells fail, and their failure is not itself the finding.

### What the outcome check establishes about the budget

The pre-registered strong signal for this campaign was: all four `current-skill`
cells `success: true`, all eight grading checks passing, and the authoritative
outcome being `coverage_threshold_exceeded`. That signal was observed.

`authoritative_outcome_matches_expected` is not a self-report. For this
scenario's `coverage_threshold_exceeded` branch, `graders.mjs` compares the
`--min-missed-lines` token captured from the actually-invoked command against
the threshold echoed by the resulting envelope, and treats an absent token as
unconditionally disqualifying — the production default of 0 (flag omitted) can
never legitimately produce this outcome. The check therefore passes only if the
terminal `parallel` command genuinely carried `--min-missed-lines 15`.

All four `current-skill` cells passed that check, so all four issued a terminal
`parallel` carrying the explicit 15-line budget. Structurally, each of those
cells invoked the target skill, then reached an allowed `kmp-test parallel` in
the `produced-signal` phase.

For context only, and not as a comparison this campaign is powered to make: the
historical structural baseline was 1 of 4 comparable `current-skill` cells
carrying the 15-line budget to the terminal command across Windows and macOS.
That figure came from separately authorized sanitized ledgers.

## Claim boundary

- This documents **actions and commands**, not internal reasoning. Nothing here
  establishes why any agent did what it did.
- Four `current-skill` cells are a focused replication. This is **not** a
  claim of statistical significance, and **not** a reliability claim.
- This is a Windows capture only. It makes **no** claim of platform
  equivalence; the macOS counterpart is a separate campaign requiring its own
  authorization and its own recorded versions and distribution.
- The measurement is prospective. No previously recorded run was re-graded.
- `no-skill` results are an ablation within this batch, not a baseline for any
  general claim about agent capability without the skill.

## Evidence handling

No raw transcript content was read at any point in this campaign. The result
above was derived exclusively from the committed run records, their validated
accepted-audit sidecars, and the harness's own `validate` / `aggregate` /
`analyze` output. The 8 raw transcripts were written to a gitignored local
directory, retained unread for later separately-scoped audit, and are not part
of this commit.

The pre-existing protected working state in the primary checkout, all previously
preserved canary and incident evidence (1,939 files hashed before and after),
the pinned toolchain and the measurement scope file were all re-hashed after the
run with zero drift.

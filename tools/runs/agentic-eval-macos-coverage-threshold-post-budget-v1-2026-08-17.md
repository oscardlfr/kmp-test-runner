# macOS coverage-threshold canary, post-budget-invariant — 2026-08-17

Focused single-scenario macOS capture measuring whether the skill snapshot
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
| macOS distribution | macOS 26.4, build 25E246, Apple Silicon `arm64` (native, no Rosetta) |
| Source project | `nowinandroid` @ `7d45eae4f8720a0c77f507712ba2437ff974b6ed` |
| Platform | `macos` |
| Seed | `20260722` |
| Repetitions per condition | 4 |
| Measurement scope id | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| `kmp_test` CLI | `0.14.0` @ `32364d4026a2cbce853a53a10ab2498fe4457a28` |
| Policy sha256 | `44400952001e67181080ff71d5c01f8660293fc2c972a9b581f3bd5ffc802dfa` |
| Daemon policy | `disabled-via-gradle-user-home-properties` |
| Env allowlist profile | `narrow` |
| Cache state | `cold` |
| Capture date | 2026-08-17 |
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
both verified through the production spawn path, and its root/darwin-arm64/
darwin-x64 package integrity hashes checked against fixed values, before the
matrix ran.

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

This order is identical to the Windows capture's own order (same seed, same
scenario, same repeat count).

## Session accounting, at every layer

Stated separately per layer — these are different quantities, and collapsing
them into the single word "retries" has previously produced wrong counts. In
particular, the matrix/session layer below being zero does **not** mean the
in-session layer is zero; both are reported explicitly.

| Layer | Count |
|---|---|
| Authorized live-session ceiling | 8 |
| Matrix process executions | 1 |
| Matrix re-executions / replacements | 0 |
| Planned cells (dry-run) | 8 |
| Executed cells | 8 |
| Cells replaced or re-seeded | 0 |
| Cell respawns | 0 (the harness has no automatic respawn mechanism) |
| Live sessions consumed | 8 of 8 |
| Records / sidecars / raw transcripts written | 8 / 8 / 8 |
| Human interventions (sum across 8 records) | 0 |
| Per-record `retries.value` | 0 on 7 of 8; `2` on `current-skill-d037aac5` (`test_invocations_total:3`) |
| Sum of `retries.value` across all 8 | **2** |

The per-record `retries` metric is an in-session count of test invocations
beyond the first, unrelated to session/matrix orchestration. The matrix-layer
count above is genuinely zero; the in-session sum is genuinely 2. Neither
figure substitutes for the other.

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

**Structural acceptance: 8 / 8.**

Corpus state after capture (freshly recomputed, not carried over from the
dry-run baseline): 164 records and 148 accepted-audit sidecars. `aggregate`
reports 76 groups with the same 4 pre-existing historical
`ambient_skill_profile` errors carried by older records; `analyze` reports 164
seen, 148 analyzed, 16 excluded, 72 groups, 0 errors. Restricted to the 8 new
records in isolation, `aggregate` reports 2 groups and 0 errors with
`run_count: 4` in each, and `analyze` reports 8 seen, 8 analyzed, 0 excluded,
2 groups, 0 errors.

## Behavioral result

Reported separately from structural acceptance above, and separated further
into two distinct signals that must not be collapsed into one number:

- **Command invariant (authoritative outcome matched expectation):** whether
  each `current-skill` cell's terminal command preserved the coverage budget
  and produced the scenario's expected authoritative outcome.
- **End-to-end success:** whether the cell's own final answer was also
  consistent with that evidence.

| Condition | Command invariant (`expected_outcome_matched`) | End-to-end `success: true` | Cells passing all 8 grading checks |
|---|---|---|---|
| `current-skill` | 4 / 4 | 3 / 4 | 3 / 4 |
| `no-skill` | 0 / 4 | 0 / 4 | 0 / 4 |

**The pre-registered strong signal for this campaign (4/4 `current-skill`
`success: true` with all eight grading checks passing) was NOT reached.** One
`current-skill` cell (`f650117e`) reached the correct authoritative outcome but
did not reach end-to-end success. The result below is reported as observed.

### Command invariant: what `authoritative_outcome_matches_expected` establishes

This check is not a self-report. For this scenario's `coverage_threshold_exceeded`
branch, `graders.mjs` compares the `--min-missed-lines` token captured from the
actually-invoked command against the threshold echoed by the resulting envelope,
and treats an absent token as unconditionally disqualifying — the production
default of 0 (flag omitted) can never legitimately produce this outcome. The
check therefore passes only if the terminal `parallel` command genuinely carried
`--min-missed-lines 15`.

All four `current-skill` cells passed this check, so all four issued a terminal
`parallel` carrying the explicit 15-line budget. This holds independently of
end-to-end success: `f650117e` preserved the budget and reached the correct
authoritative outcome, then failed on a separate, later check (below).

### Per-cell grading checks

Three `current-skill` cells (`4f91e487`, `4315ae6c`, `d037aac5`, order_index 2,
5, 6) passed all 8 checks: `no_transcript_structural_issues`,
`bash_tool_use_present`, `tool_result_correlated`,
`authoritative_evidence_well_formed`, `authoritative_target_matches_expected`,
`authoritative_outcome_matches_expected`, `no_provider_contradiction`,
`final_answer_consistent_with_evidence`.

The fourth `current-skill` cell (`f650117e`, order_index 1) passed 7 of 8,
failing only `final_answer_consistent_with_evidence`. Its
`expected_outcome_matched` is `true` and its command invariant holds (see
above); the terminal attempt's own evidence was correct. The recorded detail
for the one failing check, quoted literally:

> the KMP_EVAL_RESULT block does not exactly match the facts observed in the
> terminal attempt's own evidence (module/outcome_kind/counts, or carries
> unexpected/missing keys)

This is a distinct failure mode from every `no-skill` cell below: it is a
final-answer formatting/consistency defect on top of otherwise-correct
diagnostic work, not an absence of diagnostic work.

All four `no-skill` cells (`60ecaef9`, `00f317c1`, `f606a7dd`, `d75031b5`,
order_index 0, 3, 4, 7) passed 3 of 8 — `no_transcript_structural_issues`,
`tool_result_correlated` and `no_provider_contradiction` — and failed the same
5 checks in every cell, with identical recorded detail text across all four
cells:

| Failing check | Recorded detail (all 4 cells) |
|---|---|
| `bash_tool_use_present` | no policy-allowed command was ever attempted |
| `authoritative_evidence_well_formed` | no attempt capable of producing target evidence was ever made |
| `authoritative_target_matches_expected` | no well-formed terminal evidence to check |
| `authoritative_outcome_matches_expected` | no well-formed, correctly-targeted terminal evidence to check |
| `final_answer_consistent_with_evidence` | final answer contains no KMP_EVAL_RESULT block |

Per-cell policy-hook accounting for the same 4 cells, for the record: `60ecaef9`
10/10 calls denied, `00f317c1` 10/10 denied, `f606a7dd` 8/8 denied, `d75031b5`
7/7 denied — zero policy-allowed calls in any of the four. No cause is
attributed to this pattern here; only the observed counts and the structural
fact that every attempt in every `no-skill` cell was denied are recorded.
Establishing why would require reading raw transcript content, which this
campaign does not do (see "Evidence handling" below).

The `no-skill` comparator is a within-batch ablation. It is not a requirement
that those cells fail, and their failure is not itself the finding.

## Windows / macOS comparison

Both captures share harness/base commit, skill pin, scenario, model, Claude
Code version, seed, repeat count, source project commit and measurement scope
id. They differ in platform, OS distribution, and capture date; Claude Code's
reported version string (`2.1.227`) is identical, but the underlying platform
package (darwin vs. win32) and OS build are not the same artifact.

| | Windows (2026-08-16) | macOS (2026-08-17) |
|---|---|---|
| OS / arch | Windows 11 Pro 23H2, build 22631.6199, x64 | macOS 26.4, build 25E246, Apple Silicon arm64 |
| Command invariant (`current-skill`, budget preserved) | 4 / 4 | 4 / 4 |
| End-to-end success (`current-skill`) | 4 / 4 | 3 / 4 |
| `no-skill` end-to-end success | 0 / 4 | 0 / 4 |
| Sum of in-session `retries.value` | 0 | 2 (both on one cell) |

Combined across both platforms: 8 / 8 `current-skill` cells preserved the
coverage budget through the terminal command and reached the correct
authoritative outcome. This is reported as a count, not a statistic — with
n=4 per platform and n=8 combined, no claim of significance, reliability, or
cross-platform equivalence is made. Platform and OS distribution differ
between the two captures; date and host also differ. No difference observed
between platforms is attributed to the OS here — that would require a
controlled comparison this pair of focused replications was not designed to
support.

## Claim boundary

- This documents **actions and commands**, not internal reasoning. Nothing here
  establishes why any agent did what it did, including why every `no-skill`
  attempt was denied.
- Four `current-skill` cells per platform (eight combined) are a focused
  replication. This is **not** a claim of statistical significance, and
  **not** a reliability claim.
- This is a macOS capture compared descriptively against a separate Windows
  capture. It makes **no** claim of platform equivalence: platform, OS
  distribution, host and date all differ between the two.
- The measurement is prospective. No previously recorded run was re-graded.
- `no-skill` results are an ablation within each batch, not a baseline for any
  general claim about agent capability without the skill.
- The pre-registered strong signal (4/4 `current-skill` end-to-end success with
  all eight checks) was reached on Windows and **not** reached on macOS (3/4).
  Both outcomes are valid evidence; neither is discarded or re-run.

## Evidence handling

No raw transcript content was read at any point in this campaign. The result
above was derived exclusively from the committed run records, their validated
accepted-audit sidecars, and the harness's own `validate` / `aggregate` /
`analyze` output, each recomputed fresh rather than carried over from the
dry-run or from the Windows report. The 8 raw transcripts were written to a
gitignored local directory, retained unread for later separately-scoped audit,
and are not part of this commit.

The pre-existing protected working state in the primary checkout, all
previously preserved canary and incident evidence across 9 worktrees/clones,
the pinned toolchain and the measurement scope file were all re-hashed after
the run with zero drift.

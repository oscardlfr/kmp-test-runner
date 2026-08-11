# Agentic-eval harness — full-corpus final canary v3 (2026-08-11)

## What this is

A clean, homogeneous `n=2` full-corpus canary (6 scenarios x 2 conditions x 2 repeats = 24 live
Claude Code sessions) run from the merged PR #418 harness (`75dfd96`, "preserve session forensics
across worktree crashes"). This is an **evidence-only PR**: no harness, skill, pin, policy, grader,
corpus, or schema file is modified by this session. **This is a directional `n=2` canary, not a
statistically meaningful benchmark**, and **not evidence of general speed, cost, token, quality, or
product-efficacy improvement**. All six matrices were accepted; no live-session retries,
replacements, or continuations occurred. This is distinct from in-session agent-level tool-call
retries, which did occur on 3 of the 24 records -- see "Session accounting" below for the precise,
unqualified count.

## Session accounting

**24/24 authorized live sessions consumed, 6/6 matrices accepted, 0 live-session retries, 0
replacements.** This claim is scoped to the live-session/matrix-invocation layer only: no matrix
was ever re-run, retried, or replaced, and no session was substituted for another. It does **not**
claim zero retries at every layer -- see the next section for the separate, non-zero, in-session
agent-level retry count.

| # | Scenario | Clone | Records | Sidecars | Result |
|---|---|---|---|---|---|
| 1 | `changed-module-verification` | NowInAndroid v3 | 4 | 4 | ACCEPTED |
| 2 | `coverage-threshold-failure` | NowInAndroid v3 | 4 | 4 | ACCEPTED |
| 3 | `deterministic-unit-test-failure` | NowInAndroid v3 | 4 | 4 | ACCEPTED |
| 4 | `nowinandroid-core-common` | NowInAndroid v3 | 4 | 4 | ACCEPTED |
| 5 | `kampkit-android-host-test-discovery` | KaMPKit v3 | 4 | 4 | ACCEPTED |
| 6 | `kampkit-no-applicable-tests` | KaMPKit v3 | 4 | 4 | ACCEPTED |

Every matrix ran the full 4-cell plan (2 repeats x {`no-skill`, `current-skill`}) to completion.
Each matrix was gated through `finalizeAndWriteMatrixRecords()`'s hard-acceptance check and passed
atomically -- all 4 cells of every matrix have `benchmark_eligible: true` (24/24) and `errors: []`
(24/24). `benchmark_eligible` reflects protocol/integrity completeness only, never answer
correctness; see "Results" below for the actual measured outcomes.

Because a single matrix (4 sequential live sessions) can exceed the calling tool's own foreground
transport ceiling, each matrix was launched via one supervised long-running background execution
handle -- transport only, never concurrency: at most one live matrix process existed at any time,
that exact handle was retained and awaited to terminal completion before the next matrix started,
and no unrelated work was interleaved while a matrix ran.

## Authorization / auth proof (booleans only -- no account details)

- Isolated-toolchain `claude auth status --json`, filtered to 4 fields only: `loggedIn`: **true**,
  `authMethod`: **claude.ai**, `apiProvider`: **firstParty**, `subscriptionType`: **max**. No email,
  orgId, or orgName recorded anywhere in this session or report.
- `ANTHROPIC_API_KEY` confirmed absent from Process, User, and Machine environment scope both before
  Stage B began and in the compact re-preflight immediately before the first live session.
- **Session ceiling**: exactly **24** live Claude sessions authorized
  (`AUTORIZO HASTA 24 SESIONES LIVE NUEVAS DEL CANARY FULL-CORPUS V3, SIN REINTENTOS`), and exactly
  **24 spent** -- none unused, none exceeded, zero live-session retries, zero replacement runs of
  any live matrix.
- **Two distinct retry layers -- do not conflate them.** The claim above is live-session-level only
  (no matrix/session was ever re-run or replaced). Separately, each committed record carries its own
  `retries` field, defined by the grader (`tools/agentic-eval/graders.mjs`) as
  `max(0, testInvocationsTotal - 1)`: `testInvocationsTotal` counts every EXECUTED (never
  `--dry-run`) attempt capable of producing target evidence -- a `kmp-test parallel` invocation or a
  policy-allowed Gradle task -- across BOTH providers/tool-kinds; `retries` is that count minus one,
  floored at zero. This is a count of additional evidence-capable attempts within one already-counted
  session, not "a tool call that failed and was reissued," and can span more than one distinct
  command. Summed across all 24 committed records,
  `sum(retries.value) = 5`, concentrated in exactly 3 of the 24 records (the other 21 all have
  `retries.value: 0`):

  | `run_id` | Scenario | Condition | Repetition | `retries.value` |
  |---|---|---|---|---|
  | `scenario-current-skill-649500a9` | `changed-module-verification` | current-skill | 1 | 1 |
  | `scenario-no-skill-72fb2288` | `nowinandroid-core-common` | no-skill | 1 | 3 |
  | `scenario-current-skill-680a6078` | `kampkit-android-host-test-discovery` | current-skill | 1 | 1 |

## Fixed provenance

| Field | Value |
|---|---|
| Harness/base SHA | `75dfd96dad02049c98715ac246d82128a1e6f3a7` (develop, PR #418 merge commit) |
| Skill snapshot pin (`current-skill`) | `9814ada0c45e6a3d2a0399291ec96cb8d1ef86bb` (homogeneous across all 12 `current-skill` records) |
| Claude Code version | `2.1.225` (homogeneous across all 24 live sessions; matches the planned pin exactly) |
| Model requested / resolved | `claude-sonnet-5` (homogeneous across all 24) |
| Seed | `20260722` (frozen protocol value) |
| Repeats / conditions | 2 repeats x {`no-skill`, `current-skill`}, all 6 scenarios |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| `policy_sha256` | `44400952001e67181080ff71d5c01f8660293fc2c972a9b581f3bd5ffc802dfa` (homogeneous across all 24) |
| Branch | `feature/agentic-full-corpus-final-canary-v3` |
| Worktree | dedicated, isolated (`C:\kmp-eval\agentic-full-corpus-final-canary-v3`) |
| NowInAndroid clone | dedicated, isolated (`NowInAndroid-full-corpus-final-canary-v3`) -- no prior `C:\kmp-eval\*` clone/worktree reused or altered |
| KaMPKit clone | dedicated, isolated (`KaMPKit-full-corpus-final-canary-v3`) -- no prior `C:\kmp-eval\*` clone/worktree reused or altered |
| Source commits | NowInAndroid `7d45eae4f8720a0c77f507712ba2437ff974b6ed` (scenarios 1, 2, 4); NowInAndroid `058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8` (scenario 3, materialized internally by the harness -- the clone's own checkout HEAD never changed); KaMPKit `b3a7784fb969a8558b88c80674c8b596944cdab7` (scenarios 5, 6) |
| Execution window (UTC) | `2026-08-11T09:45:01.336Z` - `2026-08-11T10:39:32.179Z` (~54.5 min wall-clock, 24 sequential live sessions) |

The measurement-scope file's local path and its internal HMAC key are never printed anywhere in
this report or session output; only the non-secret `scope_id` is shown above.

## Sanitized command shape

`<clone>` substitutes the matching v3 source clone; `<measurement scope file>` substitutes the real
local filesystem path. Identical shape for all six matrices, varying only `--scenario` and
`--source-repo-dir`:

```bash
env PATH="<curated toolchain/git/system PATH>" \
  node tools/agentic-eval/cli.mjs run \
  --scenario <scenario-id> \
  --source-repo-dir <clone> \
  --seed 20260722 --repeats 2 --model claude-sonnet-5 \
  --measurement-scope-file <measurement scope file>
```

## Results (within-v3, current-skill vs no-skill)

`no-skill` is a **target-skill ablation under the same policy** -- the same allowlisted Gradle
tasks, `kmp-test` subcommands, and environment/daemon policy apply to both conditions; only the
`kmp-test-runner` skill's availability differs. All comparisons below are **within this v3 canary
only** (same base, same toolchain, same day, and the same frozen protocol/target-skill snapshot --
that snapshot is only ever materialized in `current-skill`; `no-skill` records carry
`skill_source_sha: null` by design, so "pin" is not a shared property of both conditions). `success`
requires every grading check
(structural integrity, policy-allowed command use, well-formed authoritative evidence,
target/outcome match, no provider contradiction, and answer-evidence consistency) to pass; a
`false` value is a specific, itemized measured outcome, not an undifferentiated failure -- see each
record's own `grading_checks` for the itemized detail.

| Condition | Cells | `success:true` | `expected_outcome_matched:true` | `skill_invoked:true` |
|---|---|---|---|---|
| `no-skill` | 12 | 1 | 2 | 0 |
| `current-skill` | 12 | 9 | 9 | 12 |

Per-scenario breakdown (2 cells per condition per scenario):

| Scenario | no-skill success | current-skill success |
|---|---|---|
| `changed-module-verification` | 0/2 | 0/2 |
| `coverage-threshold-failure` | 0/2 | 1/2 |
| `deterministic-unit-test-failure` | 1/2 | 2/2 |
| `nowinandroid-core-common` | 0/2 | 2/2 |
| `kampkit-android-host-test-discovery` | 0/2 | 2/2 |
| `kampkit-no-applicable-tests` | 0/2 | 2/2 |

With `n=2` per cell, **this report makes no causal, statistical-significance, reliability, or
generalization claim** about skill effectiveness -- these are 24 individual measured outcomes
sourced directly from the 24 committed records, not a benchmark result. The two `no-skill` cells
with `expected_outcome_matched:true` are `deterministic-unit-test-failure`/`ec3bf85e` (repetition 0
-- fully matched: `success:true`) and `nowinandroid-core-common`/`72fb2288` (repetition 1 -- reached
the correct terminal outcome but `success:false`, because its `final_answer_consistent_with_evidence`
check failed independently; see that record's own `grading_checks`). Both `kampkit-no-applicable-tests`
`no-skill` cells have `expected_outcome_matched:false` -- neither reached a correct terminal outcome.
These are itemized per-check outcomes recorded verbatim in the committed records; `success:false`
alone does not, by itself, attribute cause among skill/model/policy/scenario/grader -- that requires
separate analysis (see "Threads and limitations").

## Historical comparison (directional only)

v1 (`d5f42c34f409f311d17529ad8321c932ad341a52`, 2026-08-10) and v2
(`3fa9f426335c04be50877c93ea7e4a8718d6ba2c`, 2026-08-10) are **excluded incidents, not part of this
canary's dataset**:

- **v1: 4/24 sessions spent, 0 accepted.** Matrix 1 (`changed-module-verification`) ran all 4 cells
  live; `finalizeAndWriteMatrixRecords()` rejected the batch atomically on `noUnexpectedToolsOk`
  failing for 1 cell. 0 records/sidecars/raw promoted. Matrices 2-6 never attempted. Root cause not
  determined (the offending tool-use detail is not threaded into either rejection-diagnostic tier,
  and the rejected transcript was never persisted to disk in any tier).
- **v2: 5/24 sessions spent, 4 accepted + 1 executed-but-lost.** Matrix 1
  (`changed-module-verification`) was accepted (4/4, preserved as incident evidence only, never
  pooled with this campaign). Matrix 2 (`coverage-threshold-failure`) crashed on a Windows
  `git clean -fdx` long-path failure between cells; cell `order_index:0`/`repetition_index:1`/
  `condition:no-skill` ran a real live session to completion but its result was computed in memory
  and discarded when the exception unwound -- never written to disk in any tier. This is the exact
  defect PR #418 (this canary's own base commit) fixes.

Any comparison against v1/v2 or against other historical canaries in `tools/runs/agentic-eval-*.md`
is **directional only**, not a controlled comparison, because of disclosed differences in: harness
version (this canary is the first live run on the post-#418 crash-safe harness), skill pin
(`9814ada0c45e6a3d2a0399291ec96cb8d1ef86bb` here vs whatever each historical report's own pin was),
toolchain (`2.1.225` here; some historical canaries ran under `2.1.218` or mixed versions), source
commit/project state, and execution date/time. This canary notably completed `coverage-threshold-failure`
(the exact scenario v2 crashed on) cleanly across all 4 cells with no long-path failure -- consistent
with, but not proof of, the PR #418 fix holding under a real reused-worktree matrix.

## Reconciliation

All numbers below are sourced from the harness's own deterministic `aggregate --runs-dir` /
`analyze --runs-dir` commands, run once each against (a) an isolated copy of only the 24 new
records + sidecars, and (b) the full `tools/runs/agentic-eval-scenario/` directory (52 pre-existing
+ 24 new = 76).

| Check | Expected (runbook) | Actual |
|---|---|---|
| New-only aggregate groups | 12 | 12 |
| New-only aggregate errors | 0 | 0 |
| New-only aggregate `run_count` per group | 2 each | 2 each (all 12 groups) |
| Full aggregate groups | 34 | 34 |
| Full aggregate errors | same 4 historical | 4 (identical `ambient_skill_profile`-missing schema-v4 buckets as Stage A's baseline) |
| New-only analyze seen/analyzed | 24/24 | 24/24 |
| New-only analyze groups | 12 | 12 |
| New-only analyze excluded/errors | 0/0 | 0/0 |
| Full analyze seen | 76 | 76 |
| Full analyze analyzed | 60 | 60 |
| Full analyze excluded | 16 | 16 |
| Full analyze groups | 30 | 30 |
| Full analyze errors | 0 | 0 |

Every expected value from the runbook's Stage C section was reproduced exactly.

## Validation

- `validate --run` against all 24 new records individually: 24/24 `{errors: [], warnings: []}`.
- `accepted_audit.sha256` on all 24 records verified byte-for-byte against the actual sidecar file
  contents: 24/24 match.
- Full `agentic-eval-*` Vitest suite (50 files): **2196 passed, 1 skipped, 0 failed** (grew from
  Stage A's pre-live-run 2172/1/0 baseline -- the +24 comes from a parameterized test that iterates
  discovered `tools/runs` record files, an expected effect of new evidence existing, not a code
  change).
- `validate-plugin`: OK (manifest `kmp-test-runner@0.14.0`, 1 skill resolved).
- `decouple-audit`: clean (679 files, 3 public rules).
- `check-line-endings`: OK (290 LF-required files, 0 violations).
- `check-executable-fixtures`: OK (21 fixtures, 0 violations).
- `git diff --check`: clean.
- No `agentic-eval-rejected/` or `agentic-eval-incident/` directory exists anywhere under this
  worktree's `tools/runs/`. `tools/runs/agentic-eval-journal/` exists but is empty (no invocation-id
  subdirectory) after every one of the six matrices -- confirms the per-invocation journal was
  correctly discarded on each successful matrix.
- Both v3 source clones (`NowInAndroid-full-corpus-final-canary-v3`, `KaMPKit-full-corpus-final-canary-v3`)
  are clean (0 dirty entries) with exactly 1 registered worktree each after all six matrices --
  including scenario 3, whose pinned commit differs from the NowInAndroid clone's own checkout HEAD
  (`7d45eae4...`, unchanged throughout, confirming the harness materialized the different commit
  internally rather than mutating the shared clone).

## Preservation checks (re-verified after all 24 live sessions)

- The original 134 tracked `tools/runs/**` files: byte-identical (SHA-256 + length) to the Stage A
  before-manifest, in both the main checkout and this worktree.
- The main checkout's 4 protected WIP entries (`BACKLOG.md`, `docs/audits/full-repo-audit-improvement-plan-v3.2.md`,
  `AGENTS.md`, `tools/runs/multi-project-token-cost-2026-07-16/`) and pre-existing stash
  (`471eaeefbef2bd74cae44cc33351340937dae341`) are unchanged.
- 16 preserved v1/v2 artifacts (the v1 handoff, 2 v1 rejected-diagnostic files, the v2 handoff, 4 v2
  accepted records, 4 v2 sidecars, 4 v2 gitignored raw transcripts) re-hashed byte-identical to the
  Stage A before-manifest. A 17th file exists in the v1 worktree that Stage A's before-manifest did
  not capture: a gitignored `testResults.xml` at the v1 worktree root (206-test NUnit/Pester-format
  output, dated 2026-08-10 -- predates this v3 session, so not created by it). Its current existence
  and hash (`622125a8...`, 89570 bytes) are confirmed now, but **no Stage A baseline exists for it,
  so no before/after comparison can be made** -- disclosed here rather than silently folded into the
  "17."
- The orphan crash-forensics temp directory recorded by the v2 handoff still exists at its original
  path; not traversed or touched.
- `git worktree list` shows exactly one new entry (this v3 worktree) with all 15 pre-existing
  entries unchanged; the v1, v2, and `agentic-rejected-matrix-forensics` worktrees are all at their
  original HEAD commits.

## CI snapshot

One initial snapshot only, taken immediately after the PR opened; not polled or rerun as part of
this session.

## Threads and limitations

- `n=2` per cell is a directional signal only; no statistical claim is made anywhere in this report.
- `success:false` cells are itemized, per-check measured outcomes (see each record's own
  `grading_checks`), not a single undifferentiated "failure" bucket. This report does **not** claim
  they are free of a harness or skill defect -- attributing cause among skill/model/policy/scenario/
  grader requires separate analysis per cell, not a blanket claim either way. One concrete,
  unattributed observation worth flagging for that follow-up analysis: both `changed-module-verification`
  `current-skill` cells' committed audit sidecars show `tool_kind: "kmp-test"` with
  `operation: "parallel"` on every `kmp-test` invocation -- neither cell's tool-call list shows an
  `operation: "changed"` invocation, despite `changed` being in that scenario's own
  `policy_allowed_kmptest_subcommands`. Recorded here as a fact from the committed sidecars, not
  diagnosed further in this report.
- This report never quotes or depends on any raw transcript (`.jsonl`) content; every number above
  traces to a committed schema-v5 record, its accepted-audit sidecar, or deterministic
  `aggregate`/`analyze` output.
- The stale PR #418 status wording in `BACKLOG.md` is a separate, known administrative follow-up
  (explicitly out of scope for this fixed-49-file evidence PR per the runbook's non-goals).

## Explicit non-goals (unchanged from the runbook)

No code, skill, pin, policy, grader, corpus, schema, or harness changes. No repair or deletion of
v1/v2 incident artifacts. No persistent machine configuration changes.

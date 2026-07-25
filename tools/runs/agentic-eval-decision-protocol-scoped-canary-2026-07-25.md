# Agentic-eval harness — decision-protocol scoped canary (2026-07-25)

## What this is

A fresh, controlled `n=2` canary of the two existing KaMPKit scenarios, run after four PRs landed
on top of the previous scenario-canary regeneration (`tools/runs/agentic-eval-scenario-canary-rerun-2026-07-23.md`,
run at PR #387 / `ed4af142287b9d8b558efa7ae8405d37c404ef3e`):

- **PR #388** (`6d45dde88956ad33f0725b863e8fff8960c1fc07`, `fix(skill): prioritize structured test discovery`)
  shipped the canonical Decision protocol in the `kmp-test-runner` skill.
- **PR #389** (`338bd5c`, `fix(agentic): advance decision-protocol skill pin`) pinned `current-skill`
  to that exact snapshot.
- **PR #390** (`b0edb50`, `fix(agentic): tolerate shared ambient skills in scenario gate`) made
  bundled ambient skills a measured, consensus-validated profile instead of false contamination.
- **PR #391** (`e213ac6`, test-only fixture fix, not expected to affect live agent behavior).
- **PR #392** (`ae508a1c1d84a40b3aa62188c1f776654bb85229`, `feat(agentic-eval): add measurement-scope
  lifecycle`) added the persistent measurement-scope mechanism this run uses, and is this run's
  required base commit.

This is an **`n=2` directional canary, not a statistically meaningful benchmark**, and **not
evidence of general speed, cost, token, quality, or product-efficacy improvement**. The eight new
records are compared directionally against the eight historical PR #386-lineage records
(schema:3, produced 2026-07-23) without modifying those records in any way.

## Authorization / auth proof (booleans only — no account details)

Checked at initial preflight, again immediately before scope creation, and again immediately
before the first live call:

- `ANTHROPIC_API_KEY` present at Process, User, or Machine scope: **false**, every check
- `KMP_EVAL_RUNS_ROOT` set: **false**
- `claude auth status`: `loggedIn`: **true**, `authMethod`: **claude.ai**, `apiProvider`:
  **firstParty** — no API-key source present at any check
- No account, email, organization, or connector detail is recorded anywhere in this report or in
  session memory.

**Session ceiling**: exactly **8** live Claude sessions authorized (2 scenarios × 2 conditions × 2
repeats), and exactly 8 spent — none unused, none exceeded, zero retries, zero replacement runs.
Each live matrix command ran **exactly once**.

**Budget note**: each condition ran under the harness's internal `--max-budget-usd` safety ceiling
($0.60/condition) — an Agent-SDK usage cap consumed as Max-plan usage, not a per-token API charge.
8 × $0.60 = a **$4.80 aggregate theoretical ceiling**, not a bill.

## Fixed provenance

| Field | Value |
|---|---|
| Repository base | `ae508a1c1d84a40b3aa62188c1f776654bb85229` (develop, PR #392 merge) |
| `current-skill` pin | `6d45dde88956ad33f0725b863e8fff8960c1fc07` (PR #388 merge) |
| Source project | `https://github.com/touchlab/KaMPKit` |
| Source commit | `b3a7784fb969a8558b88c80674c8b596944cdab7` (same commit the historical run used) |
| Model | `claude-sonnet-5` |
| Seed | `20260722` (frozen protocol value, not the execution date) |
| Repeats / conditions | 2 repeats × {`no-skill`, `current-skill`} |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| Branch | `feature/agentic-decision-protocol-scoped-canary` |

The measurement-scope file's local path and its `hmac_key_base64` are deliberately omitted from
this report (never printed, logged, staged, or committed at any point in this session either).

## Sanitized commands run

`<KaMPKit clone>` and `<measurement scope file>` below substitute the real local filesystem paths;
everything else is the literal command. Both scenarios ran against the same pinned KaMPKit commit
the historical run used, verified clean and origin-matched immediately before each live call.

```powershell
node tools/agentic-eval/cli.mjs run `
  --scenario kampkit-android-host-test-discovery `
  --source-repo-dir <KaMPKit clone> `
  --seed 20260722 --repeats 2 --model claude-sonnet-5 `
  --measurement-scope-file <measurement scope file>

node tools/agentic-eval/cli.mjs run `
  --scenario kampkit-no-applicable-tests `
  --source-repo-dir <KaMPKit clone> `
  --seed 20260722 --repeats 2 --model claude-sonnet-5 `
  --measurement-scope-file <measurement scope file>
```

A `--dry-run` preview of each command (same scope file) was run first and confirmed a plan of
exactly 4 cells — `{no-skill,0}`, `{no-skill,1}`, `{current-skill,0}`, `{current-skill,1}` —
`source:"supplied"`, the expected scope id, and `total_live_claude_sessions:4` each (combined 8)
— before any live call.

## Run IDs (new, 2026-07-25)

| Scenario | Condition | Repetition | run_id |
|---|---|---|---|
| kampkit-android-host-test-discovery | no-skill | 0 | `scenario-no-skill-6ef94f5b` |
| kampkit-android-host-test-discovery | no-skill | 1 | `scenario-no-skill-0a25476c` |
| kampkit-android-host-test-discovery | current-skill | 0 | `scenario-current-skill-b45c7eb7` |
| kampkit-android-host-test-discovery | current-skill | 1 | `scenario-current-skill-202a12d6` |
| kampkit-no-applicable-tests | no-skill | 0 | `scenario-no-skill-d31238da` |
| kampkit-no-applicable-tests | no-skill | 1 | `scenario-no-skill-d0d839be` |
| kampkit-no-applicable-tests | current-skill | 0 | `scenario-current-skill-f2db7366` |
| kampkit-no-applicable-tests | current-skill | 1 | `scenario-current-skill-72220614` |

All 8 new records: `schema: 4`, `benchmark_eligible: true`, `terminated: false`,
`termination_reason: null`, `exit_code: 0`, `errors: []`, `privacy_status: "public"`,
`claude_code_version: "2.1.218"`, `ambient_skill_profile.scope_id`: the scope id above on every
record. Every record independently re-validated via `validate --run` (zero errors, zero warnings —
re-checked in this session, not assumed from the write-time gate). Every one of the 8 raw
transcripts independently confirmed (structurally — event type/count only, never quoted) to carry
**exactly one** terminal `result` event with `subtype: "success"` and `is_error: false`, and zero
malformed lines.

## Historical schema-v3 aggregation limitation

The 8 historical PR #386-lineage records (`tools/runs/agentic-eval-scenario-canary-rerun-2026-07-23.md`)
are `schema: 3` — produced before `ambient_skill_profile` existed. Aggregating them alone in this
session reproduced exactly the expected contract: **0 groups**, **4 errors** (one per scenario ×
condition bucket), every error the same `ambient_skill_profile`-missing refusal, non-zero exit
(expected, not a failure). **They remain individually valid, schema-valid evidence — they simply
cannot enter a publishable schema-v4-and-later aggregate**, by design, not by defect.

## Scenario 1 — `kampkit-android-host-test-discovery`

Expected ground truth: the agent discovers and runs the non-obvious Android host-test task for
`:shared` (`:shared:testAndroidHostTest`, 24/24 passing).

### Historical (2026-07-23, skill pin `aeba6eaa...`, Claude Code 2.1.217)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `c4968cf6` | `0285202f` | `9c0555e0` | `99f6a6e7` |
| `success` | false | false | false | **true** |
| `expected_outcome_matched` | false | false | false | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 7 / 7 | 9 / 9 | 6 / 6 | 10 / 7 |
| policy-allowed commands attempted (graded)¹ | 0 | 0 | 0 | 3 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 0 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 7 / 7 | 9 / 10 | 6 / 7 | 10 / 11 |
| `first_useful_signal_ms` | null | null | null | 145857.86 |
| `wall_clock_ms` | 38835 | 55670 | 59818 | 213015 |
| tokens in/out/cache_read/cache_creation | 16/1979/138347/2294 | 22/2779/175972/19708 | 16/4113/172417/9238 | 20/6008/221765/14032 |
| `output_bytes` | 357 | 1187 | 338 | 4721 |

### New (2026-07-25, skill pin `6d45dde...`, Claude Code 2.1.218)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `6ef94f5b` | `0a25476c` | `b45c7eb7` | `202a12d6` |
| `success` | false | false | **true** | false |
| `expected_outcome_matched` | false | false | **true** | false |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 8 / 8 | 8 / 8 | 12 / 9 | 5 / 3 |
| policy-allowed commands attempted (graded)¹ | 0 | 0 | 3 | 2 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | **2 / 1** | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 8 / 9 | 8 / 8 | 12 / 13 | 5 / 6 |
| `first_useful_signal_ms` | null | null | 154278.20 | null |
| `wall_clock_ms` | 52556 | 34654 | 186925 | 82922 |
| tokens in/out/cache_read/cache_creation | 20/3393/178430/4232 | 18/1816/138927/18609 | 26/5021/289921/10520 | 14/1621/125563/9222 |
| `output_bytes` | 428 | 408 | 3908 | 2269 |
| `foreign_skill_summary` | confirmed:1 | confirmed:0 | confirmed:0 | confirmed:0 |

### Directional differences (scenario 1) — observations, not causal claims

- **Success count is unchanged**: 1 of 2 `current-skill` repetitions succeeded, both then and now.
  `no-skill` remains 0 of 2, both then and now.
- **Which repetition succeeded, and how the failing one failed, both changed.** Historically,
  repetition 1 succeeded and repetition 0 failed via 100% command denial (skill invoked, but no
  subsequent command was policy-allowed). This run, repetition 0 succeeded — via a real
  fail-then-retry pattern (`test_invocations_total:2`, `retries:1`, the only nonzero-retry cell in
  either batch) — and repetition 1 failed differently: `bash_tool_use_present:true` (2 real allowed
  commands attempted, evidence-based grading ran) but the terminal attempt **targeted the wrong
  module**. This is a materially different failure mode from historical's full-denial failure — the
  new run's failing cell got further into the task (real Gradle evidence produced) before landing
  on the wrong answer. Preserved here without smoothing; not asserted as "better" or "worse."
- **`no-skill` foreign-skill behavior changed from rejected to confirmed.** Historically, 1 of the 2
  `no-skill` cells showed a `foreign_skill_summary.rejected:1` (an "Unknown skill" probe). This run,
  1 of 2 `no-skill` cells shows `confirmed:1` instead of `rejected`. Both are non-contaminating by
  design (the raw skill name is never recorded, then or now) and neither blocked promotion — this
  is consistent with, and expected given, PR #390's ambient-skill tolerance change, not a new
  finding requiring action.
- Wall-clock, token, and output-byte numbers moved in both directions across cells (see tables) —
  no consistent directional pattern within this scenario at `n=2`.

## Scenario 2 — `kampkit-no-applicable-tests`

Expected ground truth: the agent correctly reports that `:app` (resource/asset-only module) has no
applicable unit tests.

### Historical (2026-07-23)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `f5072741` | `a2961e09` | `11794dda` | `46878375` |
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 9 / 9 | 11 / 11 | 18 / 10 | 17 / 11 |
| policy-allowed commands attempted (graded)¹ | 0 | 0 | 8 | 5 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 9 / 10 | 11 / 12 | 18 / 19 | 17 / 18 |
| `first_useful_signal_ms` | null | null | 192418.46 | 156756.05 |
| `wall_clock_ms` | 46349 | 66602 | 201428 | 170945 |
| tokens in/out/cache_read/cache_creation | 22/2595/192529/3288 | 26/3815/225363/12792 | 40/7715/499547/18424 | 38/6195/440364/17230 |
| `output_bytes` | 1187 | 1289 | 10526 | 7244 |

¹ "Policy-allowed commands attempted" is the harness's own `bash_tool_use_present` grading count,
read directly from each record's `grading_checks` detail string — not simply `hook_call_count −
hook_deny_count`. The two coincide on 15 of the 16 cells across both batches; on
`scenario-current-skill-46878375` (historical, this scenario, repetition 1) the hook allowed 6
commands through (`17 − 11`) but the grader counts 5, because one allowed command was a bare
`kmp-test --version` call — permitted by the policy hook's `KMP_TEST_ALLOWED_BARE_FLAGS` allowlist,
but not counted as a policy-allowed *diagnostic* command by `graders.mjs`. Documented, deliberate,
and unrelated to this canary's own comparison.

### New (2026-07-25)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `d31238da` | `d0d839be` | `f2db7366` | `72220614` |
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 13 / 13 | 8 / 8 | 9 / 6 | 11 / 8 |
| policy-allowed commands attempted (graded)¹ | 0 | 0 | 3 | 3 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 13 / 15 | 8 / 8 | 9 / 10 | 11 / 12 |
| `first_useful_signal_ms` | null | null | 93402.94 | 103644.35 |
| `wall_clock_ms` | 58884 | 31291 | 100236 | 108006 |
| tokens in/out/cache_read/cache_creation | 32/3468/299167/6986 | 18/1378/145110/9742 | 22/2986/215893/8791 | 26/2755/260159/11472 |
| `output_bytes` | 703 | 408 | 3697 | 3799 |
| `foreign_skill_summary` | confirmed:2 | confirmed:0 | confirmed:0 | confirmed:0 |

### Directional differences (scenario 2) — observations, not causal claims

- **Success count is unchanged**: 2 of 2 `current-skill` repetitions succeeded, both then and now.
  `no-skill` remains 0 of 2, both then and now. Unlike scenario 1 (1 success out of 4 cells total,
  in both batches), scenario 2's `current-skill` cells succeed outright both times (2 of 4 cells
  total) — a consistently higher per-scenario success rate in both batches, not something that
  changed between them.
- **`current-skill` needed fewer allowed commands and less wall time to reach the same successful
  outcome**: allowed-call sum 8+5=13 (historical) vs 3+3=6 (new); wall-clock sum 201428+170945=372373ms
  (historical) vs 100236+108006=208242ms (new). This is the largest directional gap in either
  scenario. It is reported as an observation only — at `n=2`, under model nondeterminism, a
  Claude Code point-release change (2.1.217→2.1.218), and a 2-day time separation, this is **not**
  evidence of a general speedup or efficiency improvement, and no such claim is made.
- Both `no-skill` cells remain fully denied (`hook_deny_count == hook_call_count`) both then and
  now — consistent, expected drift-free control behavior. One `no-skill` cell shows
  `foreign_skill_summary.confirmed:2` this run vs. `rejected:1` historically in the analogous
  position — the same rejected→confirmed ambient-skill shift noted in scenario 1, consistent with
  PR #390.

## Policy denials vs. answer correctness

Every `no-skill` failure in both batches, then and now, traces to the identical structural cause:
**100% of that cell's Bash attempts were denied by the narrow scenario policy**
(`hook_deny_count === hook_call_count`), so `bash_tool_use_present`, `authoritative_evidence_well_formed`,
and everything downstream of it fail as a direct structural consequence — not an independent
judgment that the agent's reasoning was wrong. This is a **policy-denial** outcome, not a
**correctness** failure: the harness never observed the agent produce a wrong test-count or a wrong
`no_applicable_tests` claim in a `no-skill` cell, because the agent never got past an allowed
command in any of those 8 cells (4 historical + 4 new). The one `current-skill` failure in the new
batch (`scenario-current-skill-202a12d6`) is different in kind: it *is* a correctness failure — real,
policy-allowed evidence was produced, and it targeted the wrong module. The historical batch's one
`current-skill` failure (`scenario-current-skill-9c0555e0`) was a policy-denial failure despite
`skill_invoked:true`, not a correctness failure. These are not interchangeable "failure" counts and
are not collapsed into a single number anywhere in this report.

## Reconciliation (Phase 5 checklist) — new batch, all 8 cells

Verified directly against all 8 raw transcripts (structural fields only — event type, tool name,
`skill` argument identity-match boolean, `hook_response` decision, `result.subtype`/`is_error` —
never quoted content):

1. **Every Bash attempt resolved to a real decision.** `shell_commands_total` matched
   `hook_call_count` exactly on all 8 records (independently recomputed from each transcript's
   `Bash` `tool_use` count) — zero missing/uncorrelated attempts.
2. **Denied commands never satisfied `bash_tool_use_present`.** All 4 all-denied cells
   (`hook_deny_count == hook_call_count`) show `bash_tool_use_present:false`; the 4 mixed cells show
   it `true` with an evidence-index list matching the allowed-command count exactly.
3. **No-skill safety is exact.** Re-derived independently from all 8 raw transcripts, distinguishing
   the *target* skill (`kmp-test-runner`, either wire form) from any other `Skill` call: **zero**
   target-skill `tool_use` blocks appear in any of the 4 `no-skill` transcripts. The 2 `no-skill`
   cells with a `Skill` call at all (1 and 2 calls respectively) are both accounted for exactly by
   that record's own `foreign_skill_summary.confirmed` count — never the target skill.
4. **Ambient-skill consensus held across the whole session.** All 8 new records — both scenarios,
   both conditions — carry the identical `ambient_skill_profile: {count:16, scope_id:
   "4b9913f9-3c28-4fd9-afc2-275613b66520", fingerprint_hmac: "359e10a2…"}`. The fingerprint being
   byte-identical across all 8 (not just matching per-matrix) indicates the underlying ambient
   bundled-skill set genuinely did not change across this session's two live matrix invocations.
5. **JUnit ambiguity / capture-completeness**: `errors: []` on all 8 records — no
   `ambiguous_junit_evidence`, `junit_evidence_capture_incomplete`, or
   `unreliable_gradle_junit_evidence` code fired on either scenario. Scenario 1
   (`outcome_kind: tests_executed`) is where the JUnit-evidence hook mechanism is registered;
   scenario 2 (`outcome_kind: no_applicable_tests`) does not register it, consistent with the
   harness's documented conditional registration.
6. **Retry/terminal-attempt logic exercised live in this batch** (unlike the historical batch, which
   never produced a multi-attempt cell): `scenario-current-skill-b45c7eb7` shows
   `test_invocations_total:2, retries:1` with `errors:[]` and a correctly-graded successful terminal
   outcome — a real, live confirmation of the fail-then-retry attribution path this session's
   preflight suite also covers synthetically.
7. **Missing/incoherent attribution fails closed**: not exercised as a live failure in this batch
   either (both matrices promoted their full 4-of-4 cells cleanly) — consistent with, not
   independently re-proving beyond, the focused-suite coverage validated in preflight.

## Aggregation results

**New records only** (copied to a temp directory outside every repository, aggregated alone):
exactly **4 groups**, **0 errors**, one group per scenario × condition, `run_count: 2` on every
group, `schema: 4` group key throughout.

**Full committed `tools/runs/agentic-eval-scenario/` directory** (8 historical + 8 new): exactly
**4 new valid groups** (identical to the new-only run above) **plus the same 4 expected historical
schema-v3 `ambient_skill_profile` errors** — no other group or error class. CLI exit code 1, caused
only by those 4 expected historical errors, correctly not misclassified as a new failure.

## Longitudinal measurement-scope cohort

This run created the **first reusable measurement-scope cohort** under
`decision-protocol-longitudinal-v1` (non-secret scope id `4b9913f9-3c28-4fd9-afc2-275613b66520`).
This does **not** demonstrate cross-invocation grouping of the *same* scenario: the two live
invocations in this session used two different `scenario_id` values (a hard partition field), so
each scenario's 2 records only ever needed to agree with themselves. PR #392's own synthetic test
suite (`agentic-eval-run-command.test.js`'s "measurement scope + aggregation" case, re-run and
passing in this session's preflight) is what already proves repeated *same*-scenario invocations
sharing a scope file can join into one group — this run does not independently re-prove that
specific property with live data, only that the scope file mechanics work end-to-end live (correct
`scope_id` propagated onto all 8 records, correct `source:"supplied"` on both dry-run previews).

## Gates passed

**Zero-cost preflight**: base SHA verified identical across local `develop`/`origin/develop`/
`FETCH_HEAD`; no branch/worktree/path collision; old rejected canary worktree and all unrelated
`C:\kmp-eval\*` worktrees left untouched; `npm ci` clean. `PINNED_SKILL_SHA` and both scenario
files' fixed provenance verified. Materialize + skill-canonical-workflow tests: 90/90 passed.
Focused agentic-eval suite (34 files): 1385/1385 passed. Full repository suite: 3960/3960 passed, 2
skipped (82 files). Corpus validate, plugin validate, decouple-audit, line-endings,
executable-fixtures, `git diff --check`: all clean. All 8 historical records individually
schema-valid; historical-only aggregation reproduced exactly the expected 0-groups/4-errors
contract. `KMP_EVAL_RUNS_ROOT` unset. `pwsh tools/local-ci/run.ps1 -Lane All` (WSL2/Docker Linux ×2
Node versions + native Windows Node 24/18 + Pester + Gradle-plugin lane) ran exactly once:
`[local-ci] requested lane 'All' passed`, exit 0. Historical `tools/runs/**` manifest (git-blob
hashes) recomputed after local CI: byte-identical to the pre-CI baseline. Both `run --dry-run`
previews confirmed the 4-cell/8-session plan. All checks were repeated immediately before the first
live call: API-key/auth booleans, KaMPKit cleanliness (clean, origin matches, HEAD at pinned
commit, exactly one worktree), canary-worktree cleanliness (clean except the two pre-documented
Windows CRLF-status-only snapshot files, proven content-identical via empty unstaged/cached/stat
diffs and matching `git hash-object --path` against the indexed blob).

**Live matrices**: both `run` commands executed exactly once each. Both matrices atomically promoted
their full 4-of-4 cells — no rejection, no partial promotion, no retry. All 8 records independently
re-validated schema-clean after write.

## Evidence integrity

- **File-level diff, not just command exit code**: `tools/runs/agentic-eval-scenario/` held exactly
  8 `*.json` files before this session's live calls; exactly 16 after (8 historical + 8 new) — no
  more, no fewer. `tools/runs/agentic-eval-scenario/raw/` held exactly 8 `*.jsonl` files after (all
  new; historical raw transcripts were never committed and are not present in this worktree). Every
  new record's own `run_id` matches its filename exactly.
- **Raw transcripts never staged**: never appeared in `git status --porcelain` at any point;
  covered by the existing `tools/runs/agentic-eval-*/raw/**` `.gitignore` rule.
- **Historical evidence untouched**: the git-blob-hash manifest of all pre-existing tracked
  `tools/runs/**` files, captured before this session's worktree existed, is byte-for-byte identical
  to the manifest recomputed after local CI and again before staging (Phase 7).
- **No generated JSON was hand-edited at any point.**
- **Raw transcript content was read only for targeted, structural verification** — event types,
  tool names, a `skill`-argument target-identity boolean, hook decision fields, and
  `result.subtype`/`is_error` — never quoted in bulk, never staged, never committed. No command
  text, assistant reasoning, or tool-result body appears anywhere in this report.

## Explicit limitations and disclosures

- **`n=2` per scenario, not a benchmark.** No statistical claim follows from 2 repetitions per
  condition, in either the historical or the new batch. `benchmark_eligible:true` is a
  protocol/integrity statement, never a correctness or performance one.
- **Model nondeterminism**: `claude-sonnet-5` is not deterministic across invocations even at a
  fixed seed (the harness's own `--seed` controls counterbalancing/ordering, not model sampling) —
  every number above can vary run-to-run for reasons unrelated to any code or skill change.
- **Time separation**: the historical batch ran 2026-07-23; this batch ran 2026-07-25 — a 2-day gap.
- **Schema/harness changes across the gap**: 5 PRs (#388–#392) landed on `develop` between the two
  batches, including a run-record schema bump (v3→v4, adding `ambient_skill_profile`) and an
  ambient-skill-tolerance change to the scenario hard gate (PR #390) — the harness computing this
  run's evidence is not byte-identical to the harness that computed the historical evidence.
- **Skill-pin change**: `current-skill` pin moved from `aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee`
  (historical) to `6d45dde88956ad33f0725b863e8fff8960c1fc07` (new, PR #388's Decision protocol) —
  this is the actual object of this canary, and it is confounded with every other difference listed
  here, not isolated from them.
- **Claude Code CLI version change**: 2.1.217 (historical) → 2.1.218 (new) — a point-release
  changed between batches, another potential confound not attributable to this repo's own changes.
- **Raw-derived checks in this report are not independently reproducible from the 9 committed
  files alone.** All 8 new records carry `raw_capture_committed:false`; the terminal-result check,
  the no-skill target-identity check, and the ambient-fingerprint cross-scenario consistency
  observation were all derived by reading the local, gitignored raw transcripts this session
  produced, which no committed artifact currently substitutes for — identical limitation to the one
  disclosed in the historical report.
- **`no-skill` is a skill-ablation arm under the identical narrow scenario policy, not an
  unrestricted-agent baseline.** Both conditions operate under the same
  `allowed_gradle_tasks`/`allowed_kmptest_subcommands` policy; the only difference is skill
  availability. A `no-skill` cell's 100% denial rate reflects the agent exploring outside that
  narrow policy without the skill's guidance — not a claim about what an unrestricted agent would
  do.
- **This run creates the first reusable longitudinal measurement-scope cohort, but does not prove
  same-scenario cross-invocation grouping** — see "Longitudinal measurement-scope cohort" above.
- **No statistical significance, general speedup, token savings, unrestricted-agent superiority, or
  product-quality claim is made anywhere in this report.** Every numeric comparison above is
  presented as a directional observation at `n=2`, explicitly confounded by the four items above.
- **Failures are preserved without smoothing**: 5 of the 8 new cells are honest `success:false` (4
  `no-skill` + 1 `current-skill`), identical in count to the historical batch's 5 of 8 — disclosed
  in full in the per-scenario tables above, none hidden, softened, or excluded.
- Every numeric value in this report's tables was read directly from the corresponding record's own
  JSON field (re-extracted in this session, not transcribed from the historical markdown report) —
  none invented, estimated, or hand-derived without a corresponding source field.

## Recommended next action

The raw `success`/`expected_outcome_matched` counts are **identical** to the historical batch in
both scenarios (scenario 1: 1-of-2 `current-skill` then and now; scenario 2: 2-of-2 `current-skill`
then and now; `no-skill` 0-of-2 in both scenarios, both batches) — at `n=2`, this canary is
consistent with **no detected regression** from the Decision-protocol skill change, but it is
structurally underpowered to confirm or rule out any real behavioral shift either direction. Two
directional observations are worth a closer look if the team wants to invest further, neither
actionable on this evidence alone:

1. Scenario 2's `current-skill` cells reached the same 2-of-2 correct outcome using roughly half the
   allowed commands and wall-clock time (6 vs. 13 allowed calls; ~208s vs. ~372s summed) — worth
   re-examining with a larger `n` before drawing any efficiency conclusion.
2. Scenario 1's one new `current-skill` failure changed in kind (wrong-module-with-real-evidence vs.
   historical's full-policy-denial) — worth a qualitative look at that specific transcript
   (`scenario-current-skill-202a12d6`) if someone wants to understand *why* it targeted the wrong
   module, independent of this canary's own scope.

No hard-gate, integrity, provenance, decision-attribution, JUnit-attribution, privacy, or budget
ambiguity occurred at any point in this session. No regression, defect, or unexpected harness
behavior was found. This evidence-only PR does not fix, tune, or otherwise change any harness,
skill, policy, or scenario file.

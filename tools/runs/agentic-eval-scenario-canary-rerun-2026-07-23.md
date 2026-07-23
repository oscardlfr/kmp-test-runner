# Agentic-eval harness — scenario canary regeneration (2026-07-23)

## What this is

A from-scratch regeneration of the `n=2` scenario-canary evidence originally opened in draft PR
[#386](https://github.com/oscardlfr/kmp-test-runner/pull/386), run after PR #387
(`fix(agentic): attribute allow/deny decisions for every scenario`, merged as
`ed4af142287b9d8b558efa7ae8405d37c404ef3e`) landed the decision-attribution fix this evidence
needed to validate. PR #386's original evidence was produced **before** PR #387 and is invalid for
publication — it was discarded in full. Nothing in this report reuses, reinterprets, or is derived
from that stale evidence; all eight records below were produced by two brand-new live matrix
invocations against a worktree built directly from `origin/develop` at `ed4af14...`, with zero
scenario-run evidence carried over from any prior attempt.

This is an **`n=2` canary, not a benchmark**. `benchmark_eligible: true` means the matrix's
protocol/integrity completeness was proven — every cell's harness integrity held, grading actually
executed, and the batch's condition/repetition counts are balanced by construction — **not** that
the agent's answer was correct. No general speed, cost, token-efficiency, quality, or
product-efficacy claim is supported anywhere in this report. `no-skill` is a skill-ablation arm
under the same narrow command policy as `current-skill`, not an unrestricted-agent baseline.

## Authorization / auth proof (booleans only — no account details)

Checked twice: once during initial preflight (before worktree dependency install and local CI), and
again immediately before the first live call:

- `ANTHROPIC_API_KEY` present at Process, User, or Machine scope: **false**, all three checks
- `KMP_EVAL_RUNS_ROOT` set: **false**, all three checks
- `claude auth status` (constructed from the actual interactive shell used to invoke the harness):
  `loggedIn`: **true**, `authMethod`: **claude.ai**, `apiProvider`: **firstParty** — no
  `apiKeySource` present at any check

Budget note: each live condition ran under the harness's internal `--max-budget-usd` safety
ceiling (`condition-launcher.mjs`'s `buildBaseArgv` default, **$0.60/condition**, applied uniformly
to `calibrate`/`smoke`/`run`) — an internal Agent-SDK usage cap, not a per-token API charge drawn
outside the Max subscription. 8 sessions (2 scenarios × 2 conditions × 2 repeats) × $0.60 = a
**$4.80 aggregate ceiling value**, consumed as Max-plan usage, not billed cost.

## Sanitized commands run

`<KaMPKit clone>` below is a deliberate substitution for the real local scratchpad filesystem path
— everything else is the literal command. Both scenarios ran against the same pinned KaMPKit
commit `b3a7784fb969a8558b88c80674c8b596944cdab7` ("Bump the minor group with 14 updates (#358)"),
verified clean and origin-matched immediately before each live call.

```powershell
node tools/agentic-eval/cli.mjs run `
  --scenario kampkit-android-host-test-discovery `
  --source-repo-dir <KaMPKit clone> `
  --seed 20260722 `
  --repeats 2 `
  --model claude-sonnet-5

node tools/agentic-eval/cli.mjs run `
  --scenario kampkit-no-applicable-tests `
  --source-repo-dir <KaMPKit clone> `
  --seed 20260722 `
  --repeats 2 `
  --model claude-sonnet-5
```

Each of the two matrix commands ran **exactly once** — no retries, substitutions, calibration,
smoke, probes, or extra live/API calls of any kind. **Exactly 8 live Claude sessions total** (the
full authorized budget: 2 scenarios × 2 conditions × 2 repeats), none unused, none exceeded.
Starting state for both: worktree `feature/agentic-scenario-canary-rerun-regenerated` created from
`origin/develop` at `ed4af142287b9d8b558efa7ae8405d37c404ef3e` (exactly the PR #387 merge commit;
`origin/develop` had not advanced further at execution time). A `--dry-run` preview of each command
was run first and confirmed a plan of exactly 4 cells — `{no-skill,0}`, `{no-skill,1}`,
`{current-skill,0}`, `{current-skill,1}` — before any live call.

## Run IDs

| Scenario | Condition | Repetition | run_id |
|---|---|---|---|
| kampkit-android-host-test-discovery | no-skill | 0 | `scenario-no-skill-c4968cf6` |
| kampkit-android-host-test-discovery | no-skill | 1 | `scenario-no-skill-0285202f` |
| kampkit-android-host-test-discovery | current-skill | 0 | `scenario-current-skill-9c0555e0` |
| kampkit-android-host-test-discovery | current-skill | 1 | `scenario-current-skill-99f6a6e7` |
| kampkit-no-applicable-tests | no-skill | 0 | `scenario-no-skill-f5072741` |
| kampkit-no-applicable-tests | no-skill | 1 | `scenario-no-skill-a2961e09` |
| kampkit-no-applicable-tests | current-skill | 0 | `scenario-current-skill-11794dda` |
| kampkit-no-applicable-tests | current-skill | 1 | `scenario-current-skill-46878375` |

All 8 records: `schema: 3`, `benchmark_eligible: true`, `terminated: false`,
`termination_reason: null`, `exit_code: 0`, `errors: []`, `privacy_status: "public"`. Every record
independently schema-validated clean via `validate --run` (zero errors, zero warnings). Every raw
transcript independently confirmed to carry **exactly one** terminal `result` event with
`subtype: "success"` and `is_error: false` — checked directly against each `.jsonl` capture, not
inferred from promotion (`scenarioCellIntegrityOk`'s own `terminationOk` check only inspects the
harness's spawn-level `terminated` flag, not the transcript's `result.subtype`/`is_error` pair, so
this was verified as an independent, additional gate rather than assumed from a clean promotion).

## Scenario/condition results — `kampkit-android-host-test-discovery`

Expected ground truth (from `corpus/scenarios/kampkit-android-host-test-discovery.json`): the agent
discovers and runs the non-obvious Android host-test task for `:shared`
(`:shared:testAndroidHostTest`, 24/24 passing), reporting `{module: ":shared", outcome_kind:
"tests_executed", total: 24, passed: 24, failed: 0}`.

**Identity / result**

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` (suffix) | `c4968cf6` | `0285202f` | `9c0555e0` | `99f6a6e7` |
| `success` | false | false | false | **true** |
| `expected_outcome_matched` | false | false | false | **true** |
| `skill_available` | false | false | true | true |
| `skill_invocation_attempted` | false | false | true | true |
| `skill_invoked` | false | false | true | true |
| `exit_code` / `terminated` | 0 / false | 0 / false | 0 / false | 0 / false |

**Behavior**

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `hook_call_count` | 7 | 9 | 6 | 10 |
| `hook_deny_count` | 7 | 9 | 6 | 7 |
| `bash_tool_use_present` | false (0 allowed) | false (0 allowed) | false (0 allowed) | **true** (3 allowed) |
| `test_invocations_total` | 0 | 0 | 0 | 1 |
| `retries` | 0 | 0 | 0 | 0 |

Independently re-derived from each raw transcript's `PreToolUse:Bash` `hook_response` events,
positionally correlated to each `Bash` `tool_use` in emission order — this ordering was observed
consistently across all 8 captures in this batch and is used here only as an independent
cross-check, not asserted as a structural guarantee. The harness's own authoritative attribution
(`tools/agentic-eval/junit-evidence.mjs`) instead keys decision/evidence sidecars by `tool_use_id`,
not stream position. Every count above matched the committed record exactly, and every single Bash
attempt across all 4 cells resolved to a real, non-missing `allow`/`deny` decision (zero `MISSING`
correlations) under this cross-check.

**Usage**

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `tokens.input` | 16 | 22 | 16 | 20 |
| `tokens.output` | 1979 | 2779 | 4113 | 6008 |
| `tokens.cache_read` | 138347 | 175972 | 172417 | 221765 |
| `tokens.cache_creation` | 2294 | 19708 | 9238 | 14032 |
| `wall_clock_ms` | 38835 | 55670 | 59818 | 213015 |
| `tool_calls_total` | 7 | 10 | 7 | 11 |
| `output_bytes` | 357 | 1187 | 338 | 4721 |

**Provenance** (identical across all 4 cells unless noted below): `kmp_test_cli_source_sha` / `repo_commit` =
`ed4af142287b9d8b558efa7ae8405d37c404ef3e`; `kmp_test_cli_version` = 0.14.0; `policy_sha256` =
`f2ec18f5dde8f230d0b09aecaf02f1adaf4244c6f8464461483936c5fe48b5bc`; `claude_code_version` =
2.1.217; `cache_state` = cold (all 4); `daemon_policy` = disabled-via-gradle-user-home-properties;
`env_allowlist_profile` = narrow; `project_alias`/`project_commit`/`project_url` = kampkit /
`b3a7784f...4cdab7` / `https://github.com/touchlab/KaMPKit` (all 4); `skill_source_sha` = null
(no-skill) / `aeba6eaa8d027be999cdfeeb5bb2d1bbd0f688ee` (current-skill).

## Scenario/condition results — `kampkit-no-applicable-tests`

Expected ground truth (from `corpus/scenarios/kampkit-no-applicable-tests.json`): the agent
correctly reports that `:app` (the resource/asset-only module) has no applicable unit tests
(`kmp_test.error_code: "no_test_modules"`, Gradle evidence `NO-SOURCE` marker on
`:app:testDebugUnitTest`), reporting `{module: ":app", outcome_kind: "no_applicable_tests"}`.

**Identity / result**

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` (suffix) | `f5072741` | `a2961e09` | `11794dda` | `46878375` |
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available` | false | false | true | true |
| `skill_invocation_attempted` | false | false | true | true |
| `skill_invoked` | false | false | true | true |
| `exit_code` / `terminated` | 0 / false | 0 / false | 0 / false | 0 / false |

**Behavior**

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `hook_call_count` | 9 | 11 | 18 | 17 |
| `hook_deny_count` | 9 | 11 | 10 | 11 |
| `bash_tool_use_present` | false (0 allowed) | false (0 allowed) | **true** (8 allowed) | **true** (5 allowed) |
| `test_invocations_total` | 0 | 0 | 1 | 1 |
| `retries` | 0 | 0 | 0 | 0 |

**Usage**

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `tokens.input` | 22 | 26 | 40 | 38 |
| `tokens.output` | 2595 | 3815 | 7715 | 6195 |
| `tokens.cache_read` | 192529 | 225363 | 499547 | 440364 |
| `tokens.cache_creation` | 3288 | 12792 | 18424 | 17230 |
| `wall_clock_ms` | 46349 | 66602 | 201428 | 170945 |
| `tool_calls_total` | 10 | 12 | 19 | 18 |
| `output_bytes` | 1187 | 1289 | 10526 | 7244 |

**Provenance**: identical field set/values to the sibling scenario above — including the same
`policy_sha256` (it hashes `policy-hook.mjs`'s own source, not the caller-supplied task list) and
the same `project_commit` (both scenarios pin the same KaMPKit fixture project) — with the one
expected exception of `policy_allowed_gradle_tasks` (`:app:tasks`, `:app:testDebugUnitTest`,
`:app:test` — this scenario's own policy, targeting `:app` rather than `:shared`).

**No metric above is compared across the two scenarios** — each scenario has a materially
different task (a passing 24-test Android suite vs. a module with zero applicable tests), different
policy-allowed Gradle tasks, and different expected agent behavior; only within-scenario,
within-cell numbers are ever placed side by side.

## Grading checks (all 8 cells)

Each `graders.mjs` check is evidence-anchored (transcript event indices), never a keyword scan. The
**5** `success: false` cells all fail the same way: **zero policy-allowed commands were ever
attempted** (`bash_tool_use_present: false`) because every single Bash attempt in that cell was
denied by the policy hook (`hook_deny_count === hook_call_count` in all 5) — consequently
`authoritative_evidence_well_formed`, `authoritative_target_matches_expected`,
`authoritative_outcome_matches_expected`, and `final_answer_consistent_with_evidence` all fail as a
direct, structural consequence (`"no attempt capable of producing target evidence was ever made"` /
`"final answer contains no KMP_EVAL_RESULT block"`) — not four independent failures, one underlying
cause. `no_transcript_structural_issues`, `tool_result_correlated`, and `no_provider_contradiction`
pass on **all 8 cells without exception**.

Those 5 all-denied cells are **all 4 `no-skill` cells plus one `current-skill` cell**
(`kampkit-android-host-test-discovery`'s `current-skill` repetition 0,
`scenario-current-skill-9c0555e0`) — the skill *was* invoked in that cell
(`skill_invoked: true`), but every subsequent Bash attempt still fell outside the scenario's narrow
policy and was denied; skill invocation did not by itself guarantee policy-compliant follow-up
commands in that repetition. A no-skill arm's failure here isn't "the agent politely declined," it's
"the agent tried real diagnostic commands and the narrow scenario policy denied every one" (see
`foreign_skill_summary.rejected: 1` on 3 of the 4 no-skill cells — a rejected, non-contaminating
`Skill` probe each time, correctly not blocking promotion per PR #382's result-aware foreign-skill
classification).

The **3** `success: true` cells — `current-skill-99f6a6e7` (scenario 1, repetition 1),
`current-skill-11794dda` and `current-skill-46878375` (scenario 2, both repetitions) — pass all 8
checks unanimously, each anchored to a real terminal `tool_result` event
(`grading_checks.value[*].evidence_event_indices` on the `authoritative_evidence_well_formed`
check: `[56]`, `[157]`, `[133]` respectively) whose `KMP_EVAL_RESULT` block exactly matched the
scenario's expected module, `outcome_kind`, and counts. These are 3 of
the batch's 4 `current-skill` cells — not all of them, per the paragraph above.

## PR #387 semantics reconciliation (Phase 5)

Verified directly against all 8 raw transcripts, not merely inferred from a clean promotion: each
`PreToolUse:Bash` `hook_response` was positionally correlated to its `Bash` `tool_use` in stream
order as an independent cross-check. This ordering held consistently across all 8 captures here,
but it is this report's own cross-check, not the harness's authoritative attribution mechanism —
the harness itself resolves decision/evidence attribution through sidecars keyed by `tool_use_id`
(`decisions/<sha256(tool_use_id)>.json`, `evidence/<sha256(tool_use_id)>.json`), which is robust to
same-turn/parallel tool dispatch in a way whole-transcript positional correlation is not proven to
be:

1. **Every Bash attempt has a real decision.** 0 of 87 total Bash attempts across all 8 cells
   (`sum(hook_call_count)` — recomputed directly, not asserted) correlated to a missing/absent hook
   decision. Every `hook_call_count` in every committed record matched the independently-counted
   transcript `hook_response` total exactly, and every `hook_deny_count` matched the
   independently-counted `permissionDecision: "deny"` total exactly (70 denied of 87 total).
2. **Denied commands never satisfy `bash_tool_use_present`.** Confirmed on 5/8 cells trivially
   (100% denial → `bash_tool_use_present: false`, evidence indices `[]`) and confirmed precisely on
   the 3 cells with a *mix* of allow/deny: independently-derived allowed-command indices matched
   the record's own `bash_tool_use_present` evidence indices exactly for 2 of those 3 mixed-outcome
   cells; the third (`current-skill-46878375`) showed one *extra* allowed index (a bare
   `kmp-test --version` call) that the grader correctly excludes — confirmed intentional via
   `policy-hook.mjs`'s `KMP_TEST_ALLOWED_BARE_FLAGS = new Set(['--version', '--help'])` (harmless,
   allowed by the hook, but never a "policy-allowed diagnostic command" for grading purposes) and
   `graders.mjs`'s own check-2 comment. Not a PR #387 regression — a distinct, deliberately-designed
   exclusion this reconciliation pass happened to surface concretely.
3. **Denied commands never count toward `test_invocations_total`.** Directly confirmed: each of the
   3 mixed-outcome cells' allowed-command list included several `--dry-run` and/or `doctor` calls
   (auxiliary, never target-evidence candidates — `doctor` is excluded from consideration
   regardless of its own dry-run status) alongside exactly one real, non-dry-run, policy-listed
   Gradle-task-shaped invocation — and `test_invocations_total` reads exactly **1** in every one of
   those 3 cells, never counting the denied or auxiliary calls.
4. **Denied commands never count as retries.** No violation observed — but this specific batch
   never produced a cell with more than one real test invocation (`test_invocations_total` was 0 or
   1 everywhere, `retries: 0` on all 8), so this property was not exercised under live contention
   here; it remains verified structurally by the 528-test focused suite (including the round-7
   fake-`claude` regression cases for exactly this scenario) run in preflight, not independently
   re-proven against a real multi-attempt live cell in this canary.
5. **Dry-run/list-only commands never count as executions.** Empirically confirmed on all 3
   mixed-outcome success cells, counting every command the policy hook allowed (including the bare
   `--version` call from item 2, since that item is about a *different* exclusion than this one):
   `current-skill-99f6a6e7` (1 real invocation of 3 allowed; the other 2 are a `--dry-run parallel`
   call and a `doctor` call), `current-skill-11794dda` (1 real invocation of 8 allowed; the other 7
   are 5 `--dry-run parallel` calls and 2 `doctor` calls), `current-skill-46878375` (1 real
   invocation of 6 allowed; the other 5 are 2 `--dry-run parallel` calls, 2 `doctor` calls, and the
   bare `--version` call). `test_invocations_total: 1` in every case, matching exactly — never
   inflated by any dry-run, list-only, or auxiliary call.
6. **A denied trailing attempt cannot become the terminal authoritative attempt.** No violation
   observed; like item 4, this batch never produced a cell where a denied attempt trailed a valid
   earlier one, so the specific ordering guard was not exercised live here — every success cell had
   exactly one real invocation, trivially both first and terminal.
7. **Missing/incoherent attribution fails the whole matrix closed.** No violation observed; both
   matrix commands promoted their full 4 cells cleanly (`errors: []` on all 8), so this run never
   exercised the fail-closed path itself — consistent with, not independently re-proving beyond,
   the focused-suite coverage already validated in preflight.
8. **JUnit ambiguity is evaluated only when JUnit attribution is enabled.** Confirmed positively
   from live data, not just scenario config: `PostToolUse:Bash` hook activity (the JUnit-evidence
   mechanism's own registration signature) appears in exactly 1 of the 8 transcripts —
   `current-skill-99f6a6e7`, the one cell whose scenario (`kampkit-android-host-test-discovery`,
   `outcome_kind: tests_executed`) has JUnit attribution enabled *and* which actually executed an
   allowed, non-dry-run Gradle-adjacent command. Critically, `kampkit-no-applicable-tests`'s two
   `current-skill` cells (`outcome_kind: no_applicable_tests`) **also** executed real, allowed,
   non-dry-run `kmp-test parallel` commands (`test_invocations_total: 1` each) yet show **zero**
   `PostToolUse:Bash` activity — the same real-command-executed condition that triggered the hook
   in scenario 1 produced no hook activity at all in scenario 2, which is exactly the observable
   signature `condition-launcher.mjs`'s conditional `outcome_kind`-gated registration predicts.
9. **The real JUnit evidence path stays separate from general command-decision resolution.**
   Consistent with the architecture read directly from `tools/agentic-eval/README.md` (separate
   `decisions/`/`evidence/` sidecar writers, distinct error codes
   `ambiguous_junit_evidence`/`junit_evidence_capture_incomplete` never conflated with plain
   `hook_deny_count`); no cross-contamination error of either kind appeared on any of the 8 records.

No numerical value in this report or in the section above was asserted in advance — every count was
derived from the 8 new records and their raw transcripts. The old PR #386 numbers played no role in
producing or checking anything here.

## Gates passed

**Zero-cost preflight**: worktree `feature/agentic-scenario-canary-rerun-regenerated` created from
`origin/develop` at `ed4af14...` (verified to be the required PR #387 commit, not merely an
ancestor — `origin/develop` had not advanced); PR #386's remote head reconfirmed unchanged
(`45369700745f7ccc750d893f670b7acd0b1c98c5`) both before worktree creation and immediately before
the final push. `npm ci` clean. `git status --porcelain` empty except the pre-documented Windows
CRLF-status artifact on the two vitest snapshot files (verified content-identical to the index via
empty unstaged/cached/stat diffs and matching `git hash-object --path` — never touched). No
`ANTHROPIC_API_KEY` at Process/User/Machine scope; `KMP_EVAL_RUNS_ROOT` unset; `claude auth status`
clean (checked twice: initial preflight and immediately pre-live-call). Java (Temurin
23.0.2) and `ANDROID_HOME` verified. KaMPKit clone verified clean, correct `origin`
(`https://github.com/touchlab/KaMPKit.git`), `HEAD` exactly at the pinned commit, exactly one
registered worktree. `corpus validate` clean for both scenarios; both scenarios' `project_commit`
pins confirmed matching the verified KaMPKit `HEAD`. Focused `agentic-eval` vitest suite (stream
parsing, hard gates, run command, decision resolution/classification, JUnit attribution, scenario
grading — 9 files): 528/528 passed. Full repository suite: 3729/3729 passed, 2 skipped (81 files).
All 8 pre-existing committed `agentic-eval-calibration`/`agentic-eval-smoke` records independently
re-validated clean via `validate --run`, with a full SHA-256 manifest of all 39 pre-existing tracked
`tools/runs/**` files captured to an out-of-repo baseline before local CI and reconfirmed identical
after it. `pwsh tools/local-ci/run.ps1 -Lane All` (Docker/WSL2 Linux lane × 2 Node versions + native
Windows gate) ran exactly once: `[local-ci] requested lane 'All' passed`, exit 0. Both `run
--dry-run` previews (run once each, before local CI) confirmed a 4-cell plan (all 4
`{condition,repetition}` combinations, zero duplicates) and `total_live_claude_sessions: 4` each —
combined 8, matching the authorized cap exactly. Immediately before the first live call, the
authentication and cleanliness booleans above were re-verified directly; the `--dry-run` command
itself was not re-invoked a second time, but the worktree's `HEAD` and clean status were confirmed
unchanged since the original preview, and `run --dry-run`'s own determinism (same `--seed` →
identical plan, independently verified by the focused test suite) means the original preview
remained accurate at live-call time given no intervening drift.

**Live matrices**: both `run` commands executed exactly once each, exactly as authorized. Every one
of the 8 promoted records independently schema-validated clean, carries `run_kind: "scenario"`,
`benchmark_eligible: true`, `terminated: false`, `termination_reason: null`, `exit_code: 0`, and
(independently verified against the raw transcript, not merely inferred) exactly one terminal
`result` event with `subtype: "success"` and `is_error: false`. Neither matrix rejected or
partially promoted — each wrote its full, atomic 4-of-4 cells.

## Evidence integrity

- **File-level diff, not just command exit code**: `tools/runs/agentic-eval-scenario/` did not
  exist before the first live call; after both matrices, it contains exactly 8 committable `*.json`
  records and exactly 8 gitignored `raw/*.jsonl` transcripts — no more, no fewer. Every record's own
  `run_id` matches its filename exactly.
- **Raw transcripts never staged**: `git status --porcelain` never showed anything under
  `tools/runs/agentic-eval-scenario/raw/` at any point; `git check-ignore -v` on all 8 raw files
  resolved to this repo's own `tools/runs/agentic-eval-*/raw/**` rule.
- **Pre-existing evidence untouched**: the SHA-256 manifest of all 39 pre-existing tracked
  `tools/runs/**` files, captured before local CI, was byte-for-byte identical when recomputed
  after local CI and again before staging — no historical evidence file changed.
- **No generated JSON was manually edited at any point.**
- **Raw transcript content was read only for targeted, structural verification** (hook decision
  fields, `result.subtype`/`is_error`, literal text of policy-*allowed* commands only) — never
  quoted in bulk, staged, or committed. No denied command's literal text, and no assistant
  reasoning or tool-result body, appears anywhere in this report.

## Explicit limitations

- **This is `n=2` per scenario, not a benchmark.** No statistical claim follows from 2 repetitions
  per condition. `benchmark_eligible: true` is a protocol/integrity statement, never a correctness
  or performance one.
- **The terminal-result and hook-decision checks in this report are not independently reproducible
  from the 9 committed files alone.** All 8 records carry `raw_capture_committed: false`; the
  `result.subtype`/`is_error` check, the positional hook-decision cross-check, and the
  `PostToolUse:Bash` JUnit-hook-activity observation in the "PR #387 semantics reconciliation"
  section above were all derived by reading the local, gitignored raw transcripts
  (`tools/runs/agentic-eval-scenario/raw/*.jsonl`), which no committed artifact currently
  substitutes for. A privacy-sanitized, committable per-run audit sidecar (decision/evidence
  summaries with all command and content text redacted) would close this reproducibility gap —
  a genuine proposal, but one that changes the harness's own evidence contract by adding a new
  committable artifact shape. Out of scope for this evidence-only regeneration PR; tracked as a
  possible future harness enhancement, not implemented here, and no JSON metadata was hand-edited
  to approximate it.
- **No speed, cost, token-efficiency, or skill-efficacy claim is made or implied.** The
  `current-skill` cells that succeeded did real, materially different work (actual Gradle
  invocations) than the `no-skill` cells that failed (100% command denial) — these are not
  comparable "faster/slower" or "cheaper/more expensive" measurements of the same task.
- **`no-skill` here means a narrow-policy skill-ablation arm, not an unrestricted baseline.** Both
  conditions operate under the identical scenario-defined `allowed_gradle_tasks`/
  `allowed_kmptest_subcommands` policy; the only difference is skill availability. A `no-skill`
  cell's 100% denial rate reflects the agent exploring outside that narrow policy without the
  skill's guidance toward the approved commands — not a claim about what an unrestricted agent
  would do.
- **Metrics are never mixed across the two scenarios** anywhere in this report — each scenario's
  table stands alone; only within-scenario, within-cell comparisons are drawn, and even those never
  carry an efficacy conclusion.
- **5 of 8 cells are honest `success: false`, disclosed in full above** (all 4 `no-skill` cells plus
  one `current-skill` cell, `scenario-current-skill-9c0555e0`) — every one traces to the same root
  cause (100% policy denial in that cell, confirmed via `hook_deny_count === hook_call_count` and
  independently re-derived from the raw transcript), never hidden, softened, or excluded from any
  table.
- **Properties 4, 6, and 7 of the Phase 5 reconciliation were not exercised under live contention
  in this specific batch** (no cell produced multiple real test invocations or an
  attribution-integrity failure) — verified structurally via the focused test suite in preflight,
  not independently re-proven against a real multi-attempt live cell here.
- Every nullable metric in this report's tables reflects its recorded value directly from the
  committed JSON; none were invented or hand-transcribed without a corresponding source field.
- Raw JSONL transcripts for all 8 new runs exist locally only, under
  `tools/runs/agentic-eval-scenario/raw/`, covered by `.gitignore` (independently reconfirmed via
  `git check-ignore -v`) — never staged, never committed, never quoted in bulk anywhere in this
  report.
- **PR #386's original evidence was fully discarded**, not edited, reinterpreted, or partially
  reused. Every number, run ID, and record in this report comes from the 8 live sessions run for
  this regeneration alone.

# Agentic-eval harness — execution-state-machine canary (2026-07-27)

## What this is

A fresh, controlled `n=2` canary of the two existing KaMPKit scenarios, run to measure whether the
`kmp-test-runner` skill's execution-state-machine fix improves agent behavior relative to the most
recent prior canary:

- **PR #398** (`bfa7ea6`, `test(agentic): capture evidence-driven scope canary`) captured the
  schema-v5 batch this report compares against, at skill pin `9e47a9d132f5b9ea6ac5bc50a66c844458fd363e`.
- **PR #399 / commit `21f1894`** (`fix(skill): make test dispatch protocol operational`) rewrote the
  skill's execution-state-machine so the Decision protocol's steps are enforced procedurally rather
  than left to descriptive guidance. This is the commit `current-skill` is now pinned to, and is the
  actual object of this canary.
- **Commit `f8dd178`** (`fix(agentic): advance skill snapshot pin to the execution-state-machine
  fix`) advanced `PINNED_SKILL_SHA` to PR #399's commit, and is this run's required base commit.

This is an **`n=2` directional canary, not a statistically meaningful benchmark**, and **not
evidence of general speed, cost, token, quality, or product-efficacy improvement**. The eight new
records are compared primarily and directionally against the eight schema-v5 records from PR #398
(same schema, so every field is directly comparable — no schema-migration confound this time). The
schema-v4 batch is not re-derived here; it is only secondary historical context already covered in
PR #398's own report.

## Authorization / auth proof (booleans only — no account details)

Checked at preflight, immediately before both dry-run previews, and again immediately before the
first live call:

- `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` present at Process,
  User, or Machine scope: **false**, every name, every scope.
- `claude auth status`: `loggedIn`: **true**, `authMethod`: **claude.ai**, `apiProvider`:
  **firstParty** — no `apiKeyHelper`/`apiKeySource` in global settings.
- No account, email, organization, or connector detail is recorded anywhere in this report.

**Session ceiling**: exactly **8** live Claude sessions authorized (2 scenarios × 2 conditions × 2
repeats), and exactly **8 spent** — none unused, none exceeded, **zero retries**, zero replacement
runs. Each live matrix command ran **exactly once**.

## Fixed provenance

| Field | Value |
|---|---|
| Repository base | `f8dd1786ae0fe1dc8c7b87febfe45bdfc6faaf01` (develop) |
| `current-skill` pin | `21f189403e86b4720f0d2c6a547353fb108252b4` (PR #399) |
| Source project | `https://github.com/touchlab/KaMPKit` |
| Source commit | `b3a7784fb969a8558b88c80674c8b596944cdab7` (same commit every prior canary used) |
| Model | `claude-sonnet-5` |
| Seed | `20260722` (frozen protocol value, not the execution date) |
| Repeats / conditions | 2 repeats × {`no-skill`, `current-skill`} |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` (same scope as PR #398's batch) |
| Branch | `feature/agentic-execution-state-machine-canary` |
| Fresh KaMPKit clone | dedicated, isolated clone (`KaMPKit-execution-state-machine-canary`) — the pre-existing shared `C:\kmp-eval\KaMPKit` and all other `C:\kmp-eval\*` canary worktrees/clones were neither reused nor altered |

The measurement-scope file's local path and its `hmac_key_base64` are deliberately omitted from
this report (never printed, logged, staged, or committed at any point in this session).

## Sanitized commands run

`<KaMPKit clone>` and `<measurement scope file>` below substitute the real local filesystem paths;
everything else is the literal command.

```bash
node tools/agentic-eval/cli.mjs run \
  --scenario kampkit-android-host-test-discovery \
  --source-repo-dir <KaMPKit clone> \
  --seed 20260722 --repeats 2 --model claude-sonnet-5 \
  --measurement-scope-file <measurement scope file>

node tools/agentic-eval/cli.mjs run \
  --scenario kampkit-no-applicable-tests \
  --source-repo-dir <KaMPKit clone> \
  --seed 20260722 --repeats 2 --model claude-sonnet-5 \
  --measurement-scope-file <measurement scope file>
```

A `--dry-run` preview of each command (same scope file) was run first and confirmed a plan of
exactly 4 cells, `source:"supplied"`, the expected scope id, and `total_live_claude_sessions:4`
each (combined 8) — before any live call. Scenario 1 ran to completion and independently
re-validated clean before scenario 2 was started, per protocol.

## Run IDs and sidecars (new, 2026-07-27)

| Scenario | Condition | Repetition | `run_id` | Sidecar |
|---|---|---|---|---|
| kampkit-android-host-test-discovery | no-skill | 1 | `scenario-no-skill-4d53b85c` | `audit/scenario-no-skill-4d53b85c.json` |
| kampkit-android-host-test-discovery | current-skill | 1 | `scenario-current-skill-1ee65ec6` | `audit/scenario-current-skill-1ee65ec6.json` |
| kampkit-android-host-test-discovery | current-skill | 0 | `scenario-current-skill-39e3bfdc` | `audit/scenario-current-skill-39e3bfdc.json` |
| kampkit-android-host-test-discovery | no-skill | 0 | `scenario-no-skill-fd77670c` | `audit/scenario-no-skill-fd77670c.json` |
| kampkit-no-applicable-tests | no-skill | 1 | `scenario-no-skill-a7f7958d` | `audit/scenario-no-skill-a7f7958d.json` |
| kampkit-no-applicable-tests | current-skill | 1 | `scenario-current-skill-77491559` | `audit/scenario-current-skill-77491559.json` |
| kampkit-no-applicable-tests | current-skill | 0 | `scenario-current-skill-21843c0e` | `audit/scenario-current-skill-21843c0e.json` |
| kampkit-no-applicable-tests | no-skill | 0 | `scenario-no-skill-71ef95f6` | `audit/scenario-no-skill-71ef95f6.json` |

All 8: `schema: 5`, `run_kind: "scenario"`, `benchmark_eligible: true`, `terminated: false`,
`termination_reason: null`, `exit_code: 0`, `errors: []`, `privacy_status: "public"`,
`claude_code_version: "2.1.218"` (identical to PR #398's batch — no CLI-version confound).
`skill_source_sha` is exactly `21f189403e86b4720f0d2c6a547353fb108252b4` on every `current-skill`
record and exactly `null` on every `no-skill` record. `ambient_skill_profile` is byte-identical
across all 8: `{count:16, scope_id:"4b9913f9-3c28-4fd9-afc2-275613b66520",
fingerprint_hmac:"359e10a2401e6d1e3d194fd55b3eb97887eed834306b4e0ab93994f02c3a231a"}` — identical to
PR #398's own value too.

## Scenario 1 — `kampkit-android-host-test-discovery`

Expected ground truth: the agent discovers and runs the non-obvious Android host-test task for
`:shared` (`:shared:testAndroidHostTest`).

| Field | no-skill r1 (`4d53b85c`) | no-skill r0 (`fd77670c`) | current-skill r1 (`1ee65ec6`) | current-skill r0 (`39e3bfdc`) |
|---|---|---|---|---|
| `success` | false | false | **true** | false |
| `expected_outcome_matched` | false | false | **true** | false |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| skill ordinal (first tool?) | n/a | n/a | **0 (yes)** | **0 (yes)** |
| pre-skill tool calls / denials | n/a | n/a | 0 / 0 | 0 / 0 |
| `hook_call_count` / `hook_deny_count` | 7 / 7 | 8 / 8 | 2 / 0 | 2 / 0 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 7 / 8 | 8 / 10 | 2 / 3 | 2 / 3 |
| `first_useful_signal_ms` | null | null | 138851.46 | null |
| `wall_clock_ms` | 33693 | 55310 | 143324 | 76438 |
| tokens in/out/cache_read/cache_creation | 18/1854/140631/19811 | 22/2977/198009/5733 | 8/1084/73234/8839 | 8/1063/75823/5982 |
| `post_signal_ms` / `post_signal_tool_calls` | null | null | 4472.23 / **0** | null |
| `policy_denials_before`/`after_first_signal` | null | null | 0 / 0 | null |
| `foreign_skill_summary.confirmed` | 1 | 2 | 0 | 0 |
| terminal grading failure(s) | *(policy-denial shape — see below)* | *(policy-denial shape)* | none | `authoritative_target_matches_expected`: "terminal attempt targeted the WRONG module" |

### Comparison against PR #398 (skill pin `9e47a9d...`)

PR #398's `current-skill` arm went **0-of-2**: `08d5daaa` was a correctness failure (real,
policy-allowed evidence, wrong module — skill invoked at **ordinal 3**, after 3 denied exploratory
Bash attempts); `27d0c3c6` was a policy-denial failure (skill invoked at ordinal 0, but 100% of its
subsequent Bash attempts were denied, so no evidence-based grading ever ran).

This batch's `current-skill` arm went **1-of-2** — directionally up from PR #398:

- **Both cells invoked the skill at ordinal 0** (the very first tool call, zero pre-skill
  exploration) — PR #398 had this in only 1 of its 2 cells. This scenario shows a directionally
  *more consistent* "skill-first" pattern in this batch than in PR #398's.
- **The policy-denial failure shape seen in PR #398 (`27d0c3c6`) did not recur.** Both of this
  batch's `current-skill` cells show `hook_deny_count: 0` — every Bash-family call they made was
  policy-allowed.
- **The correctness failure shape did recur.** `39e3bfdc` produced real, policy-allowed evidence
  (2 `kmp-test` calls, same shape as the successful cell) but its terminal `kmp-test parallel`
  attempt targeted the wrong module — the identical failure *kind*, by the grading check's own
  wording, as PR #398's `08d5daaa`. Neither this report nor PR #398's names the specific wrong
  module: that identity is not present in the committed record or its `audit/` sidecar (both use
  only the closed-vocabulary judgment "targeted the WRONG module"), and determining it would
  require the raw transcript, which is out of scope for this report by design.
- **`no-skill` remains 0-of-2**, unchanged in shape from PR #398 (100% Bash denial in both cells).

## Scenario 2 — `kampkit-no-applicable-tests`

Expected ground truth: the agent correctly reports that `:app` (resource/asset-only module) has no
applicable unit tests.

| Field | no-skill r1 (`a7f7958d`) | no-skill r0 (`71ef95f6`) | current-skill r1 (`77491559`) | current-skill r0 (`21843c0e`) |
|---|---|---|---|---|
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| skill ordinal (first tool?) | n/a | n/a | **3 (no)** | **4 (no)** |
| pre-skill tool calls / denials | n/a | n/a | 3 / 3 | 4 / 4 |
| `hook_call_count` / `hook_deny_count` | 12 / 12 | 9 / 9 | 5 / 3 | 8 / 5 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 12 / 13 | 9 / 9 | 5 / 6 | 8 / 9 |
| `first_useful_signal_ms` | null | null | 75160.85 | 93114.24 |
| `wall_clock_ms` | 83821 | 36568 | 79750 | 98732 |
| tokens in/out/cache_read/cache_creation | 28/4981/250691/14525 | 18/2137/153655/2504 | 14/1423/125180/9051 | 20/3177/193615/8566 |
| `post_signal_ms` / `post_signal_tool_calls` | null | null | 4589.12 / **0** | 5616.94 / **0** |
| `policy_denials_before`/`after_first_signal` | null | null | 3 / 0 | 5 / 0 |
| `foreign_skill_summary.confirmed` | 1 | 0 | 0 | 0 |

### Comparison against PR #398

PR #398's `current-skill` arm was **2-of-2** (`ccff419c`, `2c9a93fb`). This batch's `current-skill`
arm is also **2-of-2** — unchanged.

- **The pre-skill exploration pattern is essentially identical between the two batches**, cell for
  cell: PR #398's `ccff419c` invoked the skill at ordinal 3 after 3 denied Bash attempts, and
  `2c9a93fb` at ordinal 4 after 4 denied attempts. This batch's `77491559` and `21843c0e` show the
  *exact same* ordinals (3 and 4) and denial counts (3 and 4), respectively. This is directional
  evidence that scenario 2's "exploratory commands before invoking the skill" behavior is a stable
  pattern **unaffected** by PR #399's fix, not a regression it introduced or an improvement it made
  — at `n=2` per batch, it looks identical before and after.
- **`post_signal_tool_calls` is 0 on both cells this time**, vs. PR #398's `ccff419c` making 2
  further tool calls (one denied, one allowed) after its own terminal evidence — the "continued tool
  use after terminal evidence" shape PR #398 flagged as newly-visible in its own report did not
  recur in either of this batch's signal-reaching cells.
- **`no-skill` remains 0-of-2**, unchanged in shape from PR #398 (100% Bash denial in both cells).

## Skill-invocation ordinal — direct cross-batch comparison

Whether the target skill was the very first tool call, read from each batch's own committed
`audit/<run_id>.json` `tool_calls[]` array (never from raw transcript text):

| Scenario | Batch | run_id (current-skill) | Skill ordinal | First tool? | Pre-skill denials |
|---|---|---|---|---|---|
| android-host-test-discovery | PR #398 | `08d5daaa` | 3 | no | 3 |
| android-host-test-discovery | PR #398 | `27d0c3c6` | 0 | **yes** | 0 |
| android-host-test-discovery | this batch | `1ee65ec6` | 0 | **yes** | 0 |
| android-host-test-discovery | this batch | `39e3bfdc` | 0 | **yes** | 0 |
| no-applicable-tests | PR #398 | `ccff419c` | 3 | no | 3 |
| no-applicable-tests | PR #398 | `2c9a93fb` | 4 | no | 4 |
| no-applicable-tests | this batch | `77491559` | 3 | no | 3 |
| no-applicable-tests | this batch | `21843c0e` | 4 | no | 4 |

The android-host-test-discovery scenario went from 1-of-2 "skill-first" cells (PR #398) to 2-of-2
(this batch). The no-applicable-tests scenario shows an unchanged pattern, ordinal-for-ordinal.

## Explicit failure-mode evaluation

Evaluated against the five modes named in this canary's authorization, using only committed
records and `audit/` sidecars:

1. **Scenario 1 selecting `:app` instead of evidence-backed `:shared`.** The same correctness-failure
   *shape* recurred once (`39e3bfdc`: real, policy-allowed evidence, wrong module). Neither the
   record nor the sidecar names the specific wrong module in either this batch or PR #398's — this
   cannot be confirmed or ruled out as specifically `:app` from committed evidence alone. Not fixed,
   not confirmed unchanged in specifics; the failure *kind* persists.
2. **Decorating canonical commands such as `2>&1`.** Not observable from the committed record or
   `audit/` sidecar in either batch — the sidecar's `tool_calls[]` records `tool_kind`/`operation`/
   `policy_decision`/`result_status`, never literal command text. Confirming or ruling this out
   would require the raw transcript, which is deliberately out of scope for this report.
3. **Exploratory commands before invoking the skill.** Scenario-dependent and unchanged in shape from
   PR #398: absent in android-host-test-discovery in this batch (0-of-2 in this batch vs. 1-of-2 in
   PR #398 — directionally better), and present, ordinal-identical to PR #398, in
   no-applicable-tests (2-of-2 in both batches, same ordinals). See the table above.
4. **Dry-run/doctor probes without a valid trigger.** No `tool_kind`/`operation` combination naming a
   `doctor` operation appears in any of this batch's 8 sidecars. No evidence of this failure mode in
   this sample.
5. **Continued tool use after terminal evidence.** `post_signal_tool_calls` is `0` on all 3 of this
   batch's signal-reaching cells (`1ee65ec6`, `77491559`, `21843c0e`) — no recurrence, in contrast
   to PR #398's `ccff419c` (2 post-signal tool calls, one denied).

## Policy denials vs. answer correctness

Every `no-skill` failure in this batch traces to the identical structural cause seen in every prior
canary: **100% of that cell's Bash attempts were denied by the narrow scenario policy**
(`hook_deny_count === hook_call_count` on all 4 `no-skill` cells this batch), so
`bash_tool_use_present` and everything downstream fail as a direct structural consequence, not an
independent judgment that the agent's reasoning was wrong.

This batch's one `current-skill` failure (`39e3bfdc`) is a **correctness** failure, not a
**policy-denial** failure: real, policy-allowed evidence was produced
(`authoritative_evidence_well_formed` — not listed among its failed checks), and it targeted the
wrong module. Unlike PR #398, this batch produced **zero** policy-denial-type `current-skill`
failures (both `current-skill` cells in scenario 1 show `hook_deny_count: 0`).

## Reconciliation (Phase 4 checklist) — all 8 cells

1. **`validate --run` exits 0 on all 8** (0 errors, 0 warnings each), independently re-run in this
   session for every record.
2. **`accepted_audit.relative_path` exists and independently re-hashed on all 8** — SHA-256 computed
   fresh from the sidecar file bytes in this session (not read from the record's own claim) and
   compared byte-for-byte against `accepted_audit.sha256`; all 8 matched.
3. **Provenance fields verified programmatically on all 8**: `repo_commit` /
   `kmp_test_cli_source_sha` = `f8dd1786ae0fe1dc8c7b87febfe45bdfc6faaf01`; `project_commit` =
   `b3a7784fb969a8558b88c80674c8b596944cdab7`; `project_url` = the KaMPKit repo URL;
   `model_requested`/`model_resolved` = `claude-sonnet-5`; `seed` = `20260722`;
   `ambient_skill_profile.scope_id` = `4b9913f9-3c28-4fd9-afc2-275613b66520`; `skill_source_sha` =
   the PR #399 pin on every `current-skill` record and `null` on every `no-skill` record;
   `raw_capture_committed: false` and `benchmark_eligible: true` on all 8.
4. **Raw transcripts never staged**: absent from `git status --short tools/runs/` at every check in
   this session (only the 8 top-level records and 8 new `audit/*.json` sidecars ever appeared as
   untracked); covered by the existing `tools/runs/agentic-eval-*/raw/**` `.gitignore` rule.
5. **Historical evidence untouched**: a git-blob-hash manifest of all 74 pre-existing tracked
   `tools/runs/**` files, captured before this session's live calls, is byte-for-byte identical to
   the manifest recomputed after both live matrices.
6. **Genuine `success:false` cells kept as accepted evidence**: 5 of the 8 new cells are honest
   `success:false` (3 in scenario 1, 2 in scenario 2's `no-skill` arm) — every integrity gate passed
   for all 5, so all 5 are promoted, committed, and reported exactly like the 3 successful cells,
   with no smoothing or exclusion.

## Aggregation results

**New records only** (copied to a temporary directory outside every repository, aggregated alone):
exactly **4 groups**, **0 errors**, one group per scenario × condition, `run_count: 2` on every
group.

**Full committed `tools/runs/agentic-eval-scenario/` directory** (24 pre-existing records + 8 new =
32): exactly **12 valid groups** (8 pre-existing + 4 new), **plus the same 4 pre-existing schema-3
`ambient_skill_profile`-missing errors** (8 records, unrelated to this session — they predate the
`ambient_skill_profile` field entirely and are documented as a permanent, by-design aggregation
limit, not a defect). CLI exit code 1, caused only by those 4 pre-existing errors. The new pin
(`skill_source_sha: 21f1894...`) formed its own 2 `current-skill` groups, cleanly separated from
PR #398's pin (`9e47a9d...`) and the older `6d45dde...` pin — no merging occurred. Record-count
reconciliation: 24 grouped + 8 pre-existing-errored = 32, matching the pre-session directory (24)
plus this session's 8 additions exactly.

## Gates passed

**Zero-cost preflight**: `origin/develop` verified identical to the required base
(`f8dd1786ae0fe1dc8c7b87febfe45bdfc6faaf01`); fresh dedicated worktree and branch created; fresh
dedicated KaMPKit clone created (remote matches `touchlab/KaMPKit`, HEAD at the required source
commit, clean, no extra worktrees for that clone); JDK 23 (≥17); `ANDROID_HOME` set and valid;
`PINNED_SKILL_SHA` verified against `tools/agentic-eval/cli.mjs` source and its own locking test.
Focused agentic-eval + skill-canonical-workflow suite (36 files): **1666/1666 passed**. `corpus
validate`, `validate-plugin`, `decouple-audit` (590 files, 3 public rules), line-endings (206
files), executable-fixtures (17 fixtures), `git diff --check`: all clean. Both `run --dry-run`
previews confirmed the 4-cell/8-session plan with the expected scope id and no measurement-scope key
ever printed.

**Environment note**: `npm ci` initially failed inside this sandbox — `esbuild`'s postinstall
script shells out via `cmd.exe /d /s /c node install.js`, and a freshly-spawned `cmd.exe` in this
environment cannot resolve `node` on PATH regardless of which shell or PATH ordering launched it
(reproduced identically from both Git Bash and PowerShell). Worked around by installing with
`--ignore-scripts` and running `esbuild`'s postinstall directly via `node node_modules/esbuild/install.js`
(bypassing npm's `cmd.exe`-based script runner entirely) — verified working via a `vitest --version`
smoke test before running any gate. The same constraint meant every `npm run <script>` gate in this
session was invoked as its underlying `node <script>.mjs` command directly rather than through `npm
run`, for the same reason. This is the same category of sandbox limitation the task authorization
named in advance as the reason `tools/local-ci/run.ps1 -Lane All` was not run this session (PRs #399
and #400 already passed hosted Windows and Gradle CI). Unlike PR #398's canary, this session's gate
coverage does **not** include a local-CI `-Lane All` run; hosted CI on the resulting PR is this
session's only Windows/Gradle-lane confirmation.

**Live matrices**: both `run` commands executed exactly once each, in strict sequence (scenario 2
was not started until scenario 1's 4 records independently re-validated clean). Both matrices
atomically promoted their full 4-of-4 cells — no rejection, no partial promotion, no timeout, no
retry.

## Evidence integrity

- **File-level, not just exit-code**: `git status --short tools/runs/` showed exactly 16 new
  untracked files after both live matrices (8 records + 8 `audit/` sidecars) — no more, no fewer.
  `tools/runs/agentic-eval-scenario/raw/` held exactly 8 new `.jsonl` files locally, none of which
  ever appeared in `git status` output.
- **Historical evidence untouched**: the git-blob-hash manifest of the 74 pre-existing tracked
  `tools/runs/**` files, captured before this session's live calls, is byte-for-byte identical to
  the manifest recomputed after both matrices completed.
- **No generated JSON was hand-edited at any point.**
- **Raw transcript content was never read in this report.** Every structural claim above (skill
  ordinal, pre-skill tool-call/denial counts, tool category, phase, result status) is read from the
  committed `audit/` sidecar's own closed-vocabulary fields — for both this batch and, for direct
  comparison, PR #398's own already-committed sidecars — never from the gitignored raw transcript.

## Explicit limitations and disclosures

- **`n=2` per scenario, not a benchmark.** No statistical claim follows from 2 repetitions per
  condition. `benchmark_eligible:true` is a protocol/integrity statement, never a correctness or
  performance one.
- **Model nondeterminism**: `claude-sonnet-5` is not deterministic across invocations even at a
  fixed seed — every number above can vary run-to-run for reasons unrelated to any skill change.
- **Time separation**: measured directly from each batch's own record timestamps, not from report
  dates. PR #398's batch ran `2026-07-26T14:54:18Z`–`2026-07-26T15:08:21Z` (UTC); this batch ran
  `2026-07-26T22:27:49Z`–`2026-07-26T22:39:28Z` (UTC) — an actual gap of about **7.3 hours**, not a
  full day. This report's filename and headline date (`2026-07-27`) reflect the execution machine's
  local time zone (Europe/Madrid, UTC+2 in July): the batch's UTC `22:2x` start falls just after
  local midnight into July 27, consistent with this session's own Phase-1 gate output, which was
  independently timestamped `00:24:53` local time. The filename intentionally uses local execution
  date, not UTC date; every timestamp elsewhere in this report (including both scenario tables) is
  UTC, taken directly from each record's own `started_at`/`ended_at` fields.
- **Skill-pin change is the object of measurement, and is confounded with normal repository
  drift**: `kmp_test_cli_source_sha` also advanced (`a9acb22...` → `f8dd1786...`) between the two
  batches as `develop` moved forward; `claude_code_version` did **not** change (`2.1.218` both
  times) — one fewer confound than PR #398's own comparison had against the v4 batch.
- **This session's gate coverage is narrower than PR #398's by explicit prior authorization**:
  `tools/local-ci/run.ps1 -Lane All` was not run (see "Gates passed" above); hosted CI on the
  resulting PR is the only Windows/Gradle-lane confirmation for this batch.
- **The specific wrong module in `39e3bfdc` is not named anywhere in this report** because it is not
  present in the committed record or its `audit/` sidecar in either this batch or PR #398's —
  confirming it would require the raw transcript, which is deliberately out of scope.
- **Only the `2>&1`-decoration failure mode is unverifiable from committed evidence.** The sidecar's
  `tool_calls[]` records `tool_kind`/`operation`/`policy_decision`/`result_status`, never literal
  command text, so confirming or ruling out command-line decoration would require the raw
  transcript. The doctor/dry-run-probe failure mode is **not** in this category: it is independently
  verifiable from the committed sidecar alone via each tool call's own `operation` and `plan_only`
  fields (see "Explicit failure-mode evaluation" §4 above) — programmatically re-checked across all
  8 sidecars for this correction: no `operation:"doctor"` and no `plan_only:true` appears anywhere in
  this batch.
- **No statistical significance, general speedup, token savings, or product-quality claim is made
  anywhere in this report.** Every numeric comparison above is a directional observation at `n=2`,
  explicitly confounded by the items above.
- Every numeric value in this report's tables was read directly from the corresponding record's own
  JSON field, or the corresponding committed `audit/` sidecar's own structural fields, in this
  session (extracted programmatically, not hand-transcribed) — none invented, estimated, or
  hand-derived without a corresponding source field.

## Recommended next action

1. **Scenario 1's `current-skill` success moved from 0-of-2 (PR #398) to 1-of-2 (this batch)**, and
   the policy-denial failure kind seen in PR #398 did not recur — both cells reached real,
   policy-allowed evidence this time. The remaining failure is the same correctness *kind* PR #398
   also saw (wrong module, real evidence) — not eliminated. At `n=2` this is a directional
   improvement on one failure kind, not proof of a fix, and the underlying module-selection defect
   (whatever it specifically is) still needs its own investigation using raw-transcript access,
   independent of this canary's scope.
2. **Scenario 2's `current-skill` arm is unchanged (2-of-2, both batches)**, and its pre-skill
   exploration pattern is ordinal-identical to PR #398's — PR #399 does not appear to have touched
   this scenario's behavior in either direction at `n=2`.
3. **No harness or evidence-integrity defect was found; one persistent behavioral module-selection
   failure remains and requires separate forensic/skill work.** This evidence-only PR does not fix,
   tune, or otherwise change any harness, skill, policy, or scenario file. A larger `n` or
   raw-transcript-level investigation of the persistent scenario-1 wrong-module correctness failure
   would be the natural next step, as a separately authorized task.

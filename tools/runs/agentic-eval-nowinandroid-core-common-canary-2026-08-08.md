# Agentic-eval harness — nowinandroid-core-common canary (2026-08-08)

## What this is

The first live `n=2` canary of the `nowinandroid-core-common` scenario (added by PR #408, unblocked
for live use by PR #409's `--module-filter` parity fix). This is an **evidence-only PR**: no harness,
skill, pin, policy, or scenario file is modified by this session. **This is a directional `n=2`
canary, not a statistically meaningful benchmark**, and **not evidence of general speed, cost,
token, quality, or product-efficacy improvement**.

## Planned vs actual runtime provenance

**Planned**: Claude Code `2.1.218`, an isolated pinned toolchain
(`C:\kmp-eval\toolchains\claude-code-2.1.218`) kept separate from any global install specifically so
this canary's `claude_code_version` would match prior canaries' pin discipline.

**Actual**: all 4 live sessions ran homogeneously under Claude Code **`2.1.225`** — proven by directly
reading and comparing the `claude_code_version` field on all 4 committed records (identical across
all 4, no mixing). The harness's own `aggregate --runs-dir` is *consistent* with this (it folds
`claude_code_version` into its group key and produced exactly 2 groups of 2, not 4 groups of 1), but
that is a corroborating check, not the proof itself — grouping into 2-of-2 only shows no *additional*
partitioning occurred on the fields `aggregate` happens to key on, not that every individual record
was read and compared. The direct per-record field comparison above is the actual evidence.

**Root cause, demonstrated (not assumed)**: `tools/agentic-eval/condition-launcher.mjs` spawns the
measured session as `'claude', '-p', ...` (bare command name, no absolute path). The environment for
that spawn is built by `buildEvalEnv()` (`env-builder.mjs`), an **allowlist-only** filter that passes
`PATH`/`Path` through unchanged from whatever invoked `cli.mjs run` — it does not itself add, override,
or pin a `claude` binary location; `buildSharedEnv()` (`condition-launcher.mjs`) prepends only a
`kmp-test`-only shim directory on top (confirmed by reading `path-shim.mjs`: it never creates a
`claude` shim). There is no `--claude-bin`/`KMP_EVAL_CLAUDE_PATH`-style override flag in `cli.mjs`'s
own flag table. Preflight correctly verified, *in an isolated one-off command*, that prepending the
pinned toolchain's `node_modules/.bin` to `PATH` resolves `claude --version` to exactly `2.1.218`. The
live `node tools/agentic-eval/cli.mjs run ...` invocation itself, however, was run in a shell that
never received that same prepend — so `buildEvalEnv(process.env).PATH` inherited the operator's
ordinary ambient `PATH`, and `claude` resolved through to the global install at
`~/.local/bin/claude` (`2.1.225`) instead. Reproduced empirically post-hoc by directly importing and
calling the harness's own `buildEvalEnv`, `resolveBash()`, and the exact `buildSharedEnv` PATH-concat
expression against the same ambient environment, then resolving `claude` through the identical
`bash.exe`: **`command -v claude` → `~/.local/bin/claude` (the operator's ambient per-user
installation — a native, per-user install location, not confirmed to be npm-managed; install
mechanism not otherwise claimed), `claude --version` → `2.1.225 (Claude Code)`** — the same result
the 4 live records show. This was an operator process error
(the verified fix was not carried from the isolated preflight check into the actual live invocation's
shell), not a harness defect and not evidence of an environment-availability problem with the pinned
toolchain itself (which does resolve correctly to `2.1.218` when its `PATH` entry is actually active).

**Disposition (explicit user decision)**: the 4 records are kept and reported as the accepted,
real provenance — **`2.1.225` is treated as the initial baseline for this scenario**, not as
compliance with the original `2.1.218` pin, and not as any claim that a newer patch version performs
better or worse. No additional live sessions were authorized or spent to redo this under `2.1.218`.
**Future comparisons of this specific scenario must pin and verify the CLI version in the exact shell
that issues the live `run` command**, not only in an isolated preflight check.

## Authorization / auth proof (booleans only — no account details)

- Isolated-toolchain `claude auth status --json`, filtered server-side to 4 fields only: `loggedIn`:
  **true**, `authMethod`: **claude.ai**, `apiProvider`: **firstParty**, `subscriptionType`: **max**.
  No email, orgId, or orgName recorded anywhere in this session or report.
- **Session ceiling**: exactly **4** live Claude sessions authorized (2 repeats × {no-skill,
  current-skill}), and exactly **4 spent** — none unused, none exceeded, **zero live-session
  retries**, zero replacement runs of the live matrix itself. (This is distinct from in-session agent
  behavior: record `861ffed8`'s own `retries: 3` field reflects that ONE session internally retried
  its own Gradle invocations while running — normal recorded agent behavior, not a re-run of the
  session.) One separately-authorized, narrowly-scoped **local-ci preflight** corrective retry
  occurred (Windows lane only, after a documented environment fix) — see "Gates passed or accepted
  under carve-out" — but it consumed zero live Claude sessions.

## Fixed provenance

| Field | Value |
|---|---|
| Repository base | `8e286f895a3d6d0972be133b0daf5c3bb23f03a0` (develop) |
| `current-skill` pin | `20d109e21a9f0b4147b08148f89701c9e6f58e43` (PR #403) |
| Source project | `https://github.com/android/nowinandroid` |
| Source commit | `7d45eae4f8720a0c77f507712ba2437ff974b6ed` |
| Claude Code version — planned | `2.1.218` (isolated toolchain; not what actually ran — see above) |
| Claude Code version — actual | `2.1.225` (homogeneous across all 4 live sessions) |
| Model | `claude-sonnet-5` |
| Seed | `20260722` (frozen protocol value) |
| Repeats / conditions | 2 repeats × {`no-skill`, `current-skill`} |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` |
| Branch | `feature/agentic-nowinandroid-core-common-canary` |
| Fresh nowinandroid clone | dedicated, isolated clone (`NowInAndroid-core-common-canary`) — no prior `C:\kmp-eval\*` clone/worktree reused or altered |
| `policy_sha256` (this run) | `a7f7016366e851257b4c0d48e1f65f17e0fe5b7d686c8cb779cec48a173b03f9` |
| Execution window (UTC) | `2026-08-08T08:58:37.114Z` – `2026-08-08T09:10:40.007Z` (~12.05 min, 4 sessions) |

The measurement-scope file's local path and its internal HMAC key are never printed anywhere in this
report or session output; only the non-secret `scope_id` is shown above.

## Sanitized commands run

`<nowinandroid clone>` and `<measurement scope file>` substitute the real local filesystem paths.

```bash
node tools/agentic-eval/cli.mjs run \
  --scenario nowinandroid-core-common \
  --source-repo-dir <nowinandroid clone> \
  --seed 20260722 --repeats 2 --model claude-sonnet-5 \
  --measurement-scope-file <measurement scope file>
```

A `--dry-run` preview (same flags plus `--dry-run`) was run first and confirmed a plan of exactly 4
cells, `source:"supplied"`, `scope_id: "4b9913f9-3c28-4fd9-afc2-275613b66520"`, and
`total_live_claude_sessions:4` — before any live call.

## Run IDs and sidecars (new, 2026-08-08)

| Condition | Repetition | Order | `run_id` | Sidecar |
|---|---|---|---|---|
| no-skill | 1 | 0 | `scenario-no-skill-e3c364cf` | `audit/scenario-no-skill-e3c364cf.json` |
| current-skill | 1 | 1 | `scenario-current-skill-c59ea2c7` | `audit/scenario-current-skill-c59ea2c7.json` |
| current-skill | 0 | 2 | `scenario-current-skill-25804b8f` | `audit/scenario-current-skill-25804b8f.json` |
| no-skill | 0 | 3 | `scenario-no-skill-861ffed8` | `audit/scenario-no-skill-861ffed8.json` |

All 4: `schema: 5`, `run_kind: "scenario"`, `benchmark_eligible: true`, `terminated: false`,
`termination_reason: null`, `exit_code: 0`, `errors: []`, `privacy_status: "public"`,
`raw_capture_committed: false`, `claude_code_version: "2.1.225"` (see provenance section above),
`kmp_test_cli_source_sha`/`repo_commit`: `8e286f895a3d6d0972be133b0daf5c3bb23f03a0`, `project_commit`:
`7d45eae4f8720a0c77f507712ba2437ff974b6ed`. `skill_source_sha` is exactly
`20d109e21a9f0b4147b08148f89701c9e6f58e43` on both `current-skill` records and exactly `null` on both
`no-skill` records. `ambient_skill_profile` is byte-identical across all 4:
`{count:16, scope_id:"4b9913f9-3c28-4fd9-afc2-275613b66520", fingerprint_hmac: <identical across all 4, value omitted from this report>}`.

## Per-cell metrics

| Field | no-skill r1 (`e3c364cf`) | no-skill r0 (`861ffed8`) | current-skill r1 (`c59ea2c7`) | current-skill r0 (`25804b8f`) |
|---|---|---|---|---|
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | true | true | true |
| `final_answer_consistent_with_evidence` | false | false | true | true |
| `hook_call_count` / `hook_deny_count` | 11 / 11 | 28 / 24 | 3 / 1 | 5 / 3 |
| `wall_clock_ms` | 55,693 | 354,930 | 152,598 | 153,342 |
| total tokens (in+out+cache_read+cache_creation) | 227,093 | 712,003 | 112,099 | 130,866 |
| `test_invocations_total` | 0 | 4 | 1 | 1 |
| `retries` | 0 | 3 | 0 | 0 |
| `terminal_authoritative_evidence_present` | false | true | true | true |
| `failure_class` (from `analyze`) | `policy-denial-observed-without-terminal-evidence` | `final-answer-mismatch` | `success` | `success` |

**Within-matrix pattern only** (all 4 cells share the same `2.1.225` runtime, so version is not a
confound *within* this comparison): `current-skill` is 2-of-2 success, reaching the expected
`:core:common` module and correct `1 total / 1 passed / 0 failed` evidence efficiently (3 and 5 total
Bash calls). `no-skill` is 0-of-2 — but not for the same reason in each cell: `e3c364cf` never
attempted any policy-allowed command at all (11/11 denied, no `:core:common` Gradle/kmp-test attempt
ever reached); `861ffed8` eventually reached correct terminal evidence (4 allowed `:core:common:test`
attempts among 28 total, 3 retries) but its final `KMP_EVAL_RESULT` block did not exactly match the
expected shape. This direction (current-skill succeeding cleanly, no-skill failing by two different
routes) is consistent with prior KaMPKit canaries' shape, but **is not a valid magnitude comparison
against them** — different scenario, different source project, and a different (unplanned) CLI
version.

## Sanitized raw-inspection ledger

**Primary source, corrected**: `tool_use_event_index`, `category` (the sidecar's own `tool_kind`
+ `operation`), `decision`, and `is authoritative terminal attempt` are read directly from each
committed `audit/*.json` sidecar's own `tool_calls[]` array and top-level `terminal_authoritative_event`
field — fully reproducible from this PR's 9 committed files, no raw transcript needed for these
columns. `is authoritative terminal attempt` is `true` on exactly one row per run — the row whose
`tool_result_event_index` equals that record's `terminal_authoritative_event.index` — and `false` on
every other row, including earlier `allow`-decision rows that were superseded by a later attempt
(`861ffed8` has 4 `allow` rows; only the last, event 267, is authoritative) and including
`e3c364cf`, whose `terminal_authoritative_event` is `null` (no row is authoritative). Verified
programmatically against all 4 records: shell-call `allow`/`deny` counts per sidecar match each
record's own `hook_call_count`/`hook_deny_count` exactly (11/0/11, 3/2/1, 5/2/3, 28/4/24), and each
sidecar's `tool_calls` array length matches its own `summary.tool_calls_total` exactly (12, 4, 6, 29).

**Session-only addition** (not reproducible from the 9 committed files alone): `filter shape` and
`matches :core:common`, for the two `kmp-test (parallel)` rows only. The committed sidecar records
that those calls were `kmp-test`/`parallel` and `allow`ed, but not the literal `--module-filter`
argument shape — that required reading the raw `.jsonl` transcripts (gitignored, kept only in this
canary's local worktree, never staged/committed/published), via an isolated sub-task whose only
output was this shape classification (calling the harness's own `command-classify.mjs` and
`lib/orchestrators/module-filter.js` primitives directly, not reimplemented) — no prompt, response,
free text, private path, auth material, HMAC, or full command left that task. Read-only confirmed:
SHA-256 + byte length identical before/after inspection for all 4 raw files, each matching its
record's own `stream_json_bytes` field exactly (67,234 / 70,366 / 77,147 / 197,572).

Both `kmp-test parallel` calls used an **exact** module-filter match on `:core:common` — see
"Explicit limitations and disclosures" for what this does and does not say about PR #409.

### `scenario-no-skill-e3c364cf` (no-skill, repetition 1) — `terminal_authoritative_event: null` (no row is authoritative)

12 tool calls total (11 shell/Bash, 1 skill-tool), 0 allow / 11 deny on the 11 shell calls.

| `tool_use_event_index` | category | filter shape | matches `:core:common` | decision | is authoritative terminal attempt |
|---|---|---|---|---|---|
| 5, 7, 16, 26, 33, 39, 53, 60, 74, 82 | other-bash | absent | N/A | deny | false |
| 46 | gradle (other) | absent | N/A | deny | false |
| 68 | non-target-skill | absent | N/A | not-applicable | false |

### `scenario-current-skill-c59ea2c7` (current-skill, repetition 1) — `terminal_authoritative_event: 40` → row `tool_use_event_index 32`

4 tool calls total (3 shell/Bash, 1 skill-tool), 2 allow / 1 deny on the 3 shell calls.

| `tool_use_event_index` | category | filter shape | matches `:core:common` | decision | is authoritative terminal attempt |
|---|---|---|---|---|---|
| 5 | other-bash | absent | N/A | deny | false |
| 13 | target-skill | absent | N/A | not-applicable | false |
| 20 | kmp-test (describe) | absent | N/A | allow | false |
| 32 | kmp-test (parallel) | exact | **true** | allow | **true** |

### `scenario-current-skill-25804b8f` (current-skill, repetition 0) — `terminal_authoritative_event: 49` → row `tool_use_event_index 41`

6 tool calls total (5 shell/Bash, 1 skill-tool), 2 allow / 3 deny on the 5 shell calls.

| `tool_use_event_index` | category | filter shape | matches `:core:common` | decision | is authoritative terminal attempt |
|---|---|---|---|---|---|
| 6, 10, 17 | other-bash | absent | N/A | deny | false |
| 22 | target-skill | absent | N/A | not-applicable | false |
| 26 | kmp-test (describe) | absent | N/A | allow | false |
| 41 | kmp-test (parallel) | exact | **true** | allow | **true** |

### `scenario-no-skill-861ffed8` (no-skill, repetition 0) — `terminal_authoritative_event: 274` → row `tool_use_event_index 267`

29 tool calls total (28 shell/Bash, 1 skill-tool), 4 allow / 24 deny on the 28 shell calls. Note:
events 71, 101, and 160 are also `allow`+successful Gradle attempts, but **none of them are the
authoritative one** — only the last, event 267, is.

| `tool_use_event_index` | category | filter shape | matches `:core:common` | decision | is authoritative terminal attempt |
|---|---|---|---|---|---|
| 4, 8, 14, 22, 30, 37, 44, 51, 62 | other-bash | absent | N/A | deny | false |
| 56 | non-target-skill | absent | N/A | not-applicable | false |
| 71 | gradle (allowed-task) | absent | N/A | allow | false |
| 83, 92 | other-bash | absent | N/A | deny | false |
| 101 | gradle (allowed-task) | absent | N/A | allow | false |
| 118, 125, 132 | other-bash | absent | N/A | deny | false |
| 139, 146, 153 | gradle (allowed-task) | absent | N/A | deny | false |
| 160 | gradle (allowed-task) | absent | N/A | allow | false |
| 173 | other-bash | absent | N/A | deny | false |
| 185, 192 | gradle (allowed-task) | absent | N/A | deny | false |
| 201, 216 | other-bash | absent | N/A | deny | false |
| 229 | gradle (allowed-task) | absent | N/A | deny | false |
| 254 | other-bash | absent | N/A | deny | false |
| 267 | gradle (allowed-task) | absent | N/A | allow | **true** |

## Reconciliation checklist — all 4 cells

1. **`validate --run` exits 0 on all 4** (0 errors, 0 warnings each), run individually with this
   worktree's own CLI.
2. **Sidecar SHA-256 independently recomputed (Node `crypto`) and matched against each record's own
   `accepted_audit.sha256` on all 4** — not just trusting the record's self-reported hash.
3. **Provenance fields verified programmatically on all 4** (see "Run IDs and sidecars" and
   "Planned vs actual runtime provenance" above) — `claude_code_version` homogeneous `2.1.225` (not
   the originally planned `2.1.218`, disclosed and accepted per explicit user decision), every other
   field exact.
4. **Raw transcripts never staged**: `git status --porcelain` shows exactly 8 new untracked files
   after the live matrix (4 records + 4 `audit/` sidecars) — never the 4 `raw/*.jsonl` transcripts,
   confirmed gitignored (`tools/runs/agentic-eval-*/raw/**`).
5. **Historical evidence untouched**: a SHA-256 manifest of all pre-existing `tools/runs/**` files was
   captured before the live matrix and diffed after — zero changed files, only the 12 new additions
   (4 records + 4 sidecars + 4 gitignored raw).
6. **Genuine `success:false` cells kept as accepted evidence**: both `no-skill` cells are honest
   `success:false` for two distinct, documented reasons — every integrity gate passed for all 4, so
   all 4 are promoted, committed, and reported exactly like the 2 successful cells, with no smoothing
   or exclusion.

## Aggregation results

New records only, copied with their `audit/` sidecars to a temporary directory outside every
repository, aggregated alone via the harness's own `aggregate --runs-dir` / `analyze --runs-dir`,
then the temporary directory deleted: exactly **2 groups**, **0 errors**, `files_seen: 4,
files_analyzed: 4, files_excluded_not_applicable: 0, files_excluded_benchmark_ineligible: 0,
files_errored: 0`. `current-skill` group: `success_rate: 1` (2/2), `target_skill_invoked_rate: 1`
(2/2), `terminal_authoritative_evidence_present_rate: 1`. `no-skill` group: `success_rate: 0` (0/2),
`terminal_authoritative_evidence_present_rate: 0.5` (1/2), `failure_class_counts`:
`policy-denial-observed-without-terminal-evidence: 1`, `final-answer-mismatch: 1`.

This session made zero changes to any pre-existing file in the full committed
`tools/runs/agentic-eval-scenario/` directory; the manifest diff in reconciliation item 5 already
establishes this directly, so no full-directory `aggregate`/`analyze` re-run was needed to prove it.

## Gates passed or accepted under carve-out

**Preflight**: `origin/develop` and local `HEAD` verified identical to the required base
(`8e286f895a3d6d0972be133b0daf5c3bb23f03a0`, via `git fetch` + `git ls-remote`-backed comparison, not
only a cached tracking ref); `PINNED_SKILL_SHA` verified directly against `tools/agentic-eval/cli.mjs`
source (`20d109e21a9f0b4147b08148f89701c9e6f58e43`); fresh dedicated worktree and branch created
(forward-slash `git worktree add`, landed at the correct path — no path-mangling); fresh dedicated
nowinandroid clone created (HEAD pinned to the exact required source commit, clean); measurement-scope
file located unambiguously (`scope_id` match confirmed, HMAC key never printed); JDK 23.0.2 (≥17);
`ANDROID_HOME` set to a real SDK install with `platform-tools`/`build-tools` (through 37.0.0)/
`platforms` (through API 36.1) all present; `run --dry-run` confirmed the 4-cell/4-session plan with
the expected `scope_id` before any live call.

**Local-CI** (`tools/local-ci/run.ps1`): run in **two scoped invocations**, per an explicit,
narrowly-authorized corrective continuation after the first hit a genuine preflight HARD STOP.

- **Invocation 1 — `-Lane All`**: Docker Linux lanes (Node 24/JDK17, Node 18) both fully passed
  (`BUILD SUCCESSFUL in 4m 38s`; 4,327/4,327 vitest passing). The Windows-native lane failed earlier
  than expected, at `npm ci (Node 24)` (`windows-gate.ps1:16`) — a different failure signature than
  the one this session's runbook had pre-authorized continuing past — so this was treated as a HARD
  STOP: no code changed, no session spent, diagnostics preserved, reported to the user.
- **User-authorized corrective continuation**: confirmed worktree/clone still clean at their exact
  SHAs, 0 live sessions spent, no lingering node/npm/local-ci processes; set
  `npm_config_script_shell` to the real path of `powershell.exe`, **process-scoped only** (no
  user/machine environment variable or file ever modified); ran **exactly** `-Lane Windows` once (the
  already-green Linux lanes were not repeated); restored the prior (unset) value afterward.
- **Invocation 2 — `-Lane Windows` only**: `npm ci` completed cleanly this time (confirming the
  process-scoped fix), line-endings and executable-fixtures checks passed, all 200 Pester tests
  passed (0 failed, 6 skipped), and the Gradle-plugin TestKit step then failed with
  `java.lang.IllegalStateException: Cannot locate node.exe on PATH` at exactly `TaskActionTest.kt:62`
  (11 of 16 sub-tests) — the exact pre-existing, previously-documented machine characteristic this
  session's runbook had named as an acceptable carve-out. `git diff --stat origin/develop --
  gradle-plugin/` confirmed empty. Per the carve-out rule, this was accepted and the gate treated as
  satisfied.
- **Net**: combining both invocations, every gate capable of running on this machine either passed
  cleanly or was explicitly **accepted under the one pre-documented, unfixable-without-out-of-scope-
  changes machine characteristic** (the `TaskActionTest.kt:62` carve-out), confirmed scope-unrelated
  via a clean `git diff --stat`. That carve-out is a genuine test failure (11 of 16 Gradle-plugin
  sub-tests) accepted by an explicit pre-authorized rule — not itself a pass.

**Live matrix**: `run` executed exactly once, no `--dry-run`. All 4-of-4 cells promoted — no
rejection, no partial promotion, no timeout, no retry. The one deviation from plan was the
`claude_code_version` provenance issue documented above, not a matrix-execution failure.

## Evidence integrity

- **File-level, not just exit-code**: `git status --porcelain` shows exactly 8 new untracked files
  after the live matrix (4 records + 4 `audit/` sidecars) — no more, no fewer. The 4 `raw/*.jsonl`
  transcripts exist locally but never appear in `git status` output (gitignored).
- **No generated JSON was hand-edited at any point.**
- **Raw transcript content was read only for one narrow purpose** — classifying the two `kmp-test
  parallel` calls' module-filter shape — by an isolated sub-task that returned only that
  classification; the rest of the ledger (event indices, categories, decisions, the authoritative-
  attempt flag) comes directly from the committed `audit/*.json` sidecars, not the raw transcripts.
  No prompt, response, or free-text content from any raw transcript is quoted anywhere in this report
  or was printed to the main session log.
- **Fresh nowinandroid clone confirmed clean after the live matrix**: `git status --porcelain` empty,
  HEAD still exactly `7d45eae4f8720a0c77f507712ba2437ff974b6ed`, single worktree, no leaked
  `git worktree list` entries.
- **Isolated Claude Code toolchain exists and resolves correctly to `2.1.218` when its `PATH` entry is
  actually active** — verified independently in this session; the live matrix simply did not carry
  that entry into its own invocation (see "Planned vs actual runtime provenance").

## Explicit limitations and disclosures

- **`n=2`, not a benchmark.** No statistical claim follows from 2 repetitions per condition.
  `benchmark_eligible:true` is a protocol/integrity statement, never a correctness or performance one.
- **Model nondeterminism**: `claude-sonnet-5` is not deterministic across invocations even at a fixed
  seed.
- **`claude_code_version` is `2.1.225`, not the originally planned `2.1.218`** (see "Planned vs actual
  runtime provenance" for the full disclosure and root cause). This run is the initial `2.1.225`
  baseline for this scenario, not a longitudinal comparison point against the `2.1.218`-pinned
  KaMPKit canaries, and no success/token/trajectory difference in this report is attributed to CLI
  version — version is constant across all 4 cells in this matrix.
- **This is the first live data for `nowinandroid-core-common`.** There is no prior same-scenario
  baseline to compare against; only the within-matrix no-skill-vs-current-skill direction is reported.
- **Cost figures reflect a Max/OAuth-authenticated session** (`subscriptionType: max`, `apiProvider:
  firstParty`) — an internal plan-usage budget ceiling, not a per-token dollar charge; no dollar cost
  is claimed anywhere in this report.
- **PR #409's substring/glob/CSV module-filter branches were not exercised live in this canary.** Both
  `current-skill` sessions' `kmp-test parallel` call used an **exact** filter match on `:core:common`
  (see ledger) — neither a substring, a glob, nor a CSV list was ever attempted by either session.
  This canary validates that the scenario runs correctly on code that *includes* PR #409's parity fix,
  but it provides **no live evidence of the new substring/glob/CSV matching paths themselves**; that
  would require a scenario or prompt that induces the agent to reach for one of those forms.
- **"no-skill" means target-skill ablation, not the total absence of skills.** Both `no-skill` records
  show `foreign_skill_summary.confirmed: 1` (also visible in the ledger's `non-target-skill` row for
  each) — an ambient, non-target skill was confirmed used once in each `no-skill` session, out of the
  `ambient_skill_profile.count: 16` skills present in the environment under *both* conditions. The
  `current-skill` 2-of-2 vs. `no-skill` 0-of-2 split in this report should be read as "target skill
  present vs. target skill specifically withheld, while other ambient skills remain reachable" — not
  as "skill available vs. no skills available at all."
- **What is and is not reproducible from this PR's 9 committed files alone.** Reproducible: every
  number in "Per-cell metrics," "Reconciliation checklist," and "Aggregation results" (recomputed from
  committed record/sidecar JSON or the harness's own `validate`/`aggregate`/`analyze` output in this
  session, none hand-transcribed); the ledger's `tool_use_event_index`, `category`, `decision`, and
  `is authoritative terminal attempt` columns (read directly from each committed `audit/*.json`
  sidecar's `tool_calls[]` and `terminal_authoritative_event` fields). **Not** reproducible from the 9
  files alone: the ledger's `filter shape`/`matches :core:common` columns for the two `kmp-test
  parallel` rows (required the gitignored, local-only raw `.jsonl` transcripts — see "Evidence
  integrity"); the local-ci log contents; and the preflight process-listing / toolchain-resolution /
  auth-status diagnostics (session artifacts, not committed anywhere).

## Recommended next action

1. **Accept `2.1.225` as the initial baseline for `nowinandroid-core-common`.** Do not compare its
   magnitudes directly against `2.1.218`-pinned KaMPKit canaries; a same-scenario, same-version
   longitudinal series can start from this point forward.
2. **Harden the live-invocation preflight step**: before the actual (non-dry-run) `run` command,
   verify `claude --version` in the *exact* shell/process about to issue that command — not only in
   an isolated check earlier in the session. This session's own empirical reproduction (importing
   `buildEvalEnv`/`resolveBash` directly) is a ready-made template for that verification.
3. **No harness, skill, pin, policy, or scenario file was modified by this session.** This is an
   evidence-only PR.

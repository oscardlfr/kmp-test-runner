# Agentic-eval harness — target-binding canary (2026-07-27)

## What this is

A fresh, controlled `n=2` canary of the two existing KaMPKit scenarios, run to measure whether the
`kmp-test-runner` skill's target-binding fix improves agent behavior relative to the most recent
prior canary:

- **PR #401** (execution-state-machine canary, `tools/runs/agentic-eval-execution-state-machine-canary-2026-07-27.md`)
  captured the schema-v5 batch this report compares against, at skill pin
  `21f189403e86b4720f0d2c6a547353fb108252b4` (PR #399, `fix(skill): make test dispatch protocol
  operational`).
- **PR #403 / commit `20d109e21a9f0b4147b08148f89701c9e6f58e43`**
  (`fix(skill): trigger on indirect modules, bind exact dispatch target`) is the commit
  `current-skill` is now pinned to, and is the actual object of this canary.
- **Commit `44cae622dd88dfc224955a0ffc538ea21e9c7bf6`** (PR #404,
  `fix(agentic): advance skill snapshot pin to target-binding fix`) advanced `PINNED_SKILL_SHA` to
  PR #403's commit, and is this run's required base commit.

This is an **`n=2` directional canary, not a statistically meaningful benchmark**, and **not
evidence of general speed, cost, token, quality, or product-efficacy improvement**. The eight new
records are compared directionally against the eight schema-v5 records from PR #401 — same schema,
same source project/commit, same model, same measurement scope, so every field is directly
comparable (no schema-migration confound).

## Authorization / auth proof (booleans only — no account details)

Checked at preflight and again immediately before the first live call:

- `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
  `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` present in the
  shell environment: **false**, every name.
- `claude auth status`: `loggedIn`: **true**, `authMethod`: **claude.ai**, `apiProvider`:
  **firstParty**.
- No account, email, organization, or connector detail is recorded anywhere in this report.

**Session ceiling**: exactly **8** live Claude sessions authorized (2 scenarios × 2 conditions × 2
repeats), and exactly **8 spent** — none unused, none exceeded, **zero retries**, zero replacement
runs. Each live matrix command ran **exactly once**.

## Fixed provenance

| Field | Value |
|---|---|
| Repository base | `44cae622dd88dfc224955a0ffc538ea21e9c7bf6` (develop) |
| `current-skill` pin | `20d109e21a9f0b4147b08148f89701c9e6f58e43` (PR #403) |
| Source project | `https://github.com/touchlab/KaMPKit` |
| Source commit | `b3a7784fb969a8558b88c80674c8b596944cdab7` (same commit every prior canary used) |
| Model | `claude-sonnet-5` |
| Seed | `20260722` (frozen protocol value, not the execution date) |
| Repeats / conditions | 2 repeats × {`no-skill`, `current-skill`} |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` (same longitudinal scope as every prior canary) |
| Branch | `feature/agentic-target-binding-canary` |
| Fresh KaMPKit clone | dedicated, isolated clone (`KaMPKit-target-binding-canary`) — the pre-existing shared `C:\kmp-eval\KaMPKit` and all other `C:\kmp-eval\*` canary worktrees/clones were neither reused nor altered |
| Execution window (UTC) | `2026-07-27T19:44:34Z` – `2026-07-27T19:56:56Z` (~12.4 min, 8 sessions) |

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
| kampkit-android-host-test-discovery | no-skill | 1 | `scenario-no-skill-ce0d76b3` | `audit/scenario-no-skill-ce0d76b3.json` |
| kampkit-android-host-test-discovery | current-skill | 1 | `scenario-current-skill-547485c8` | `audit/scenario-current-skill-547485c8.json` |
| kampkit-android-host-test-discovery | current-skill | 0 | `scenario-current-skill-62e1e392` | `audit/scenario-current-skill-62e1e392.json` |
| kampkit-android-host-test-discovery | no-skill | 0 | `scenario-no-skill-030e45fe` | `audit/scenario-no-skill-030e45fe.json` |
| kampkit-no-applicable-tests | no-skill | 1 | `scenario-no-skill-f76ab236` | `audit/scenario-no-skill-f76ab236.json` |
| kampkit-no-applicable-tests | current-skill | 1 | `scenario-current-skill-afb0ecb5` | `audit/scenario-current-skill-afb0ecb5.json` |
| kampkit-no-applicable-tests | current-skill | 0 | `scenario-current-skill-844eee1e` | `audit/scenario-current-skill-844eee1e.json` |
| kampkit-no-applicable-tests | no-skill | 0 | `scenario-no-skill-9dc9b104` | `audit/scenario-no-skill-9dc9b104.json` |

All 8: `schema: 5`, `run_kind: "scenario"`, `benchmark_eligible: true`, `terminated: false`,
`termination_reason: null`, `exit_code: 0`, `errors: []`, `privacy_status: "public"`,
`claude_code_version: "2.1.218"` (identical to PR #401's batch — no CLI-version confound).
`skill_source_sha` is exactly `20d109e21a9f0b4147b08148f89701c9e6f58e43` on every `current-skill`
record and exactly `null` on every `no-skill` record. `ambient_skill_profile` is byte-identical
across all 8: `{count:16, scope_id:"4b9913f9-3c28-4fd9-afc2-275613b66520",
fingerprint_hmac:"359e10a2401e6d1e3d194fd55b3eb97887eed834306b4e0ab93994f02c3a231a"}` — identical to
PR #401's own value too.

## Scenario 1 — `kampkit-android-host-test-discovery`

Expected ground truth: the agent discovers and runs the non-obvious Android host-test task for
`:shared` (`:shared:testAndroidHostTest`).

| Field | no-skill r1 (`ce0d76b3`) | no-skill r0 (`030e45fe`) | current-skill r1 (`547485c8`) | current-skill r0 (`62e1e392`) |
|---|---|---|---|---|
| `success` | false | false | **true** | false |
| `expected_outcome_matched` | false | false | **true** | false |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| skill ordinal (first tool?) | n/a | n/a | **0 (yes)** | **0 (yes)** |
| pre-skill tool calls / denials | n/a | n/a | 0 / 0 | 0 / 0 |
| `hook_call_count` / `hook_deny_count` | 10 / 10 | 12 / 12 | 9 / 6 | 8 / 8 |
| post-skill tool calls / denials | n/a | n/a | 9 / 6 | 8 / 8 |
| `wall_clock_ms` | 51376 | 67902 | 183072 | 63599 |
| tokens in/out/cache_read/cache_creation | 24/3149/199898/21357 | 28/4198/257075/5769 | 22/4078/236663/12686 | 18/4426/188407/8730 |
| `terminal_authoritative_evidence_present` | false | false | true | **false** |
| `failure_class` | policy-denial-observed-without-terminal-evidence | policy-denial-observed-without-terminal-evidence | success | **policy-denial-observed-without-terminal-evidence** |

### Comparison against PR #401 (skill pin `21f1894...`)

PR #401's `current-skill` arm went **1-of-2**: `1ee65ec6` succeeded; `39e3bfdc` failed with
`failure_class: "wrong-target"` — real, policy-allowed evidence (`terminal_authoritative_evidence_present:
true`, `well_formed: true`, 0 post-skill denials) that targeted the wrong module.

This batch's `current-skill` arm is **also 1-of-2** — the raw success rate is **unchanged**:

- **The `wrong-target` failure class did not recur.** Zero occurrences in this batch (vs. 1 in PR
  #401's batch). This directly confirms the hypothesis this canary was authorized to check
  (discovery: does wrong-target drop from 1/2 to 0/2 — **yes**).
- **A different failure class appeared in its place.** `62e1e392` failed with
  `failure_class: "policy-denial-observed-without-terminal-evidence"` — **8 of 8** post-skill tool
  calls were policy-denied (`hook_deny_count == hook_call_count`), so **no evidence was ever
  produced at all** (`terminal_authoritative_evidence_present: false`). This is a materially
  different failure mechanism than PR #401's `wrong-target` cell, which had zero post-skill
  denials. It is also different in shape from PR #401's own historical `27d0c3c6` (PR #398 batch)
  policy-denial cell, which is the last time this specific scenario+skill combination showed a
  100%-denial failure.
- **Both cells invoked the skill at ordinal 0** (the very first tool call) in both batches — this
  scenario's "skill-first" pattern was already established by the prior pin and is unchanged here.
- **`no-skill` remains 0-of-2**, unchanged in shape from every prior batch (100% Bash denial in
  both cells).

**Net for scenario 1: the specific `wrong-target` failure mode this canary was authorized to check
is confirmed gone at `n=2`, but overall `current-skill` success is flat (1-of-2 in both batches) —
a different failure mode replaced it, not a net improvement in outcome correctness.**

## Scenario 2 — `kampkit-no-applicable-tests`

Expected ground truth: the agent correctly reports that `:app` (resource/asset-only module) has no
applicable unit tests.

| Field | no-skill r1 (`f76ab236`) | no-skill r0 (`9dc9b104`) | current-skill r1 (`afb0ecb5`) | current-skill r0 (`844eee1e`) |
|---|---|---|---|---|
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| skill ordinal (first tool?) | n/a | n/a | **0 (yes)** | **2 (no)** |
| pre-skill tool calls / denials | n/a | n/a | 0 / 0 | 2 / 2 |
| `hook_call_count` / `hook_deny_count` | 11 / 11 | 8 / 8 | 10 / 7 | 4 / 2 |
| post-skill tool calls / denials | n/a | n/a | 10 / 7 | 2 / 0 |
| `wall_clock_ms` | 58883 | 33271 | 148427 | 75855 |
| tokens in/out/cache_read/cache_creation | 20/3991/167767/12495 | 18/1839/153051/2124 | 22/6146/235584/14084 | 12/1167/110159/6258 |
| `terminal_authoritative_evidence_present` | false | false | true | true |
| `failure_class` | policy-denial-observed-without-terminal-evidence | policy-denial-observed-without-terminal-evidence | success | success |

### Comparison against PR #401

PR #401's `current-skill` arm was **2-of-2** (`77491559` ordinal 3, `21843c0e` ordinal 4). This
batch's `current-skill` arm is **also 2-of-2** — unchanged in outcome correctness, but materially
different in *when* the skill activated:

- **Skill-invocation ordinal moved substantially earlier.** PR #401: ordinals `{3, 4}` (the skill
  fired only after 3–4 pre-skill tool calls on both cells, unchanged from the batch before that
  too). This batch: ordinals `{0, 2}` — `afb0ecb5` invoked the skill as the very first tool call;
  `844eee1e` after only 2. This directly confirms the hypothesis this canary was authorized to
  check (no-applicable-tests: does activation move earlier from ordinals 3/4 — **yes**).
- **Pre-signal policy denials decreased correspondingly.** Because every pre-skill attempt in this
  narrow-policy scenario is denied by construction, `pre_skill_policy_denials` tracks
  `pre_skill_tool_calls` exactly: PR #401 `{3, 4}` → this batch `{0, 2}` — a direct, matching
  decrease (no-applicable-tests: do pre-signal denials decrease — **yes**).
- **`afb0ecb5` still needed 7 post-skill denials before its terminal success** — the ordinal
  improvement is about *when the skill is invoked*, not about the agent's persistence needs once
  invoked; `afb0ecb5`'s post-skill path was longer (10 tool calls, 7 denied) than `844eee1e`'s (2
  tool calls, 0 denied) despite `afb0ecb5` invoking the skill earlier.
- **`no-skill` remains 0-of-2**, unchanged in shape from every prior batch (structural 100% Bash
  denial in both cells; `no-skill r1`'s `hook_call_count`/`hook_deny_count` is 11/11 and
  `no-skill r0`'s is 8/8 — `hook_deny_count == hook_call_count` on both, read directly from each
  record, consistent with every no-skill cell across every batch).

**Net for scenario 2: this is the clearest positive signal in this canary — activation timing moved
substantially and consistently earlier across both `current-skill` cells, exactly matching what
PR #403's "trigger on indirect modules, bind exact dispatch target" fix targets, with outcome
correctness unchanged (already 2-of-2, stayed 2-of-2).**

## Skill-invocation ordinal — direct cross-batch comparison

Whether the target skill was the very first tool call, read from each batch's own committed
`audit/<run_id>.json` `tool_calls[]` array via `analyze --runs-dir` (never from raw transcript
text):

| Scenario | Batch | run_id (current-skill) | Skill ordinal | First tool? | Pre-skill denials |
|---|---|---|---|---|---|
| android-host-test-discovery | PR #401 (21f1894) | `1ee65ec6` | 0 | **yes** | 0 |
| android-host-test-discovery | PR #401 (21f1894) | `39e3bfdc` | 0 | **yes** | 0 |
| android-host-test-discovery | this batch (20d109e) | `547485c8` | 0 | **yes** | 0 |
| android-host-test-discovery | this batch (20d109e) | `62e1e392` | 0 | **yes** | 0 |
| no-applicable-tests | PR #401 (21f1894) | `77491559` | 3 | no | 3 |
| no-applicable-tests | PR #401 (21f1894) | `21843c0e` | 4 | no | 4 |
| no-applicable-tests | this batch (20d109e) | `afb0ecb5` | 0 | **yes** | 0 |
| no-applicable-tests | this batch (20d109e) | `844eee1e` | 2 | no | 2 |

android-host-test-discovery was already skill-first (ordinal 0) in both cells of the immediately
prior batch and stays skill-first here — no delta available for this fix to show in this scenario.
no-applicable-tests is where the delta appears: `{3,4} → {0,2}`, the only scenario in this
comparison where PR #403's fix had headroom to move the ordinal at all.

## Explicit failure-mode evaluation

Evaluated against the two hypotheses this canary was authorized to check, using only committed
records and `audit/` sidecars:

1. **Discovery: does `wrong-target` drop from 1/2 to 0/2?** **Confirmed at `n=2`.** Zero
   `wrong-target` cells in this batch vs. one in PR #401's. However this is a failure-*class*
   substitution, not an elimination of failure: `current-skill` success for this scenario is flat
   at 1-of-2 across both batches, because a different failure class
   (`policy-denial-observed-without-terminal-evidence`, 8/8 post-skill denials, zero evidence ever
   produced) appeared on the other cell. Do not read this as "the module-selection defect is
   fixed" — it reads as "the specific *wrong-target* failure mode did not recur in this sample,
   replaced by a full-denial failure mode this scenario+skill combination had not shown since PR
   #398's batch."
2. **No-applicable-tests: does activation move earlier from ordinals 3/4, with pre-signal denials
   decreasing?** **Confirmed at `n=2`.** Ordinals `{3,4} → {0,2}`; pre-skill denials `{3,4} →
   {0,2}` (matching exactly, since every pre-skill attempt in this policy is denied by
   construction). Outcome correctness was already 2-of-2 and stays 2-of-2 — this is a timing/
   efficiency signal, not a correctness signal.

No regression is being hidden: the scenario-1 failure-class substitution above is reported in full,
including that it is a new-to-this-pin failure shape for this scenario, not a strictly better
outcome than PR #401's batch.

## Policy denials vs. answer correctness

Every `no-skill` failure in this batch traces to the identical structural cause seen in every prior
canary: **100% of that cell's Bash attempts were denied by the narrow scenario policy** (confirmed
`hook_deny_count === hook_call_count` on every `no-skill` cell checked), so downstream fields fail
as a direct structural consequence, not an independent judgment that the agent's reasoning was
wrong. Per the task's own framing, `no-skill` here is a **skill-ablation condition under the same
narrow policy**, not an unrestricted baseline — it is not presented as one anywhere in this report.

This batch's one `current-skill` failure (scenario 1, `62e1e392`) is, unusually, **also** a
100%-denial shape (`hook_deny_count == hook_call_count`, 8/8) — structurally closer to a `no-skill`
cell's denial profile than to PR #401's `wrong-target` cell (which had zero denials and real,
if misdirected, evidence). Whether this is attributable to the skill fix, to ordinary model
nondeterminism, or to some other cause cannot be determined from `n=2`; no causal claim is made.

## Reconciliation checklist — all 8 cells

1. **`validate --run` exits 0 on all 8** (0 errors, 0 warnings each), independently re-run in this
   session for every record.
2. **`accepted_audit.relative_path` exists and cross-validated on all 8** by `validate --run`'s own
   schema-5 sidecar verification (path containment, schema, identity/metric cross-check, and
   SHA-256 against the record's declared `accepted_audit.sha256`).
3. **Provenance fields verified programmatically on all 8**: `repo_commit` /
   `kmp_test_cli_source_sha` = `44cae622dd88dfc224955a0ffc538ea21e9c7bf6`; `project_commit` =
   `b3a7784fb969a8558b88c80674c8b596944cdab7`; `project_url` = the KaMPKit repo URL;
   `model_requested`/`model_resolved` = `claude-sonnet-5`; `seed` = `20260722`;
   `ambient_skill_profile.scope_id` = `4b9913f9-3c28-4fd9-afc2-275613b66520`; `skill_source_sha` =
   the PR #403 pin on every `current-skill` record and `null` on every `no-skill` record;
   `raw_capture_committed: false` and `benchmark_eligible: true` on all 8.
4. **Raw transcripts never staged**: `git status --porcelain -- tools/runs` showed exactly 16
   untracked files (8 records + 8 `audit/*.json` sidecars) after both live matrices — never the 8
   `raw/*.jsonl` transcripts, each independently confirmed `git check-ignore`-covered by
   `.gitignore:42` (`tools/runs/agentic-eval-*/raw/**`).
5. **Historical evidence untouched**: a git-blob-hash manifest of every pre-existing tracked
   `tools/runs/**` file, captured before this session's first live call, is byte-for-byte identical
   to the manifest recomputed after both live matrices (`diff` reported no differences).
6. **Genuine `success:false` cells kept as accepted evidence**: 5 of the 8 new cells are honest
   `success:false` (2 in scenario 1, 2 in scenario 2's `no-skill` arm, plus scenario 1's
   `current-skill` `62e1e392`) — every integrity gate passed for all 5, so all 5 are promoted,
   committed, and reported exactly like the 3 successful cells, with no smoothing or exclusion.

## Aggregation results

**New records only** (copied, with their `audit/` sidecars, to a temporary directory outside every
repository, aggregated alone): exactly **4 groups**, **0 errors**, one group per scenario ×
condition, `run_count: 2` on every group.

**Full committed `tools/runs/agentic-eval-scenario/` directory**: `analyze --runs-dir` reports
`files_seen: 40`, `files_analyzed: 24`, `files_excluded_not_applicable: 16`, `files_errored: 0`.
`aggregate --runs-dir` over the same directory reports **16 valid groups** plus **4 pre-existing
error buckets**, all tied to older records with `claude_code_version: "2.1.217"` and skill pins
(`aeba6eaa...`, `ed4af142...`) that predate every batch compared in this report — unrelated to and
unaffected by this session, which made zero changes to any pre-existing evidence file (see
Reconciliation item 5). This session did not investigate why `analyze` and `aggregate` categorize
those older records differently (`excluded_not_applicable` vs. `errors`); both are pre-existing
behaviors this session's 8 new records did not trigger or alter.

## Gates passed

**Zero-cost preflight**: `origin/develop` and local `HEAD` verified identical to the required base
(`44cae622dd88dfc224955a0ffc538ea21e9c7bf6`); `PINNED_SKILL_SHA` verified against
`tools/agentic-eval/cli.mjs` source (`20d109e21a9f0b4147b08148f89701c9e6f58e43`); fresh dedicated
worktree and branch created; fresh dedicated KaMPKit clone created (remote matches
`touchlab/KaMPKit`, HEAD at the required source commit, clean, single worktree, distinct from every
other `C:\kmp-eval\*` clone/worktree); measurement-scope file located unambiguously (exactly one
file present, `scope_id` match confirmed structurally, path and key never printed); JDK 23.0.2
(≥17); `ANDROID_HOME` set and valid. Focused agentic-eval + skill-canonical-workflow suite: **37
files, 1757/1757 passed**. `corpus validate`, `validate-plugin`, `decouple-audit` (610 files, 3
public rules), line-endings (225 files), executable-fixtures (17 fixtures), `git diff --check`: all
clean. Both `run --dry-run` previews confirmed the 4-cell/8-session plan with the expected scope id
and no measurement-scope key ever printed.

**Local-CI** (`tools/local-ci/run.ps1 -Lane All`): run once as authorized, with a documented,
previously-proven follow-up (see below) — not blindly retried.

- **Linux/Docker lane (Node 24 + Node 18, inside container): fully passed.** bats 223/223 checks,
  vitest 4273 passed / 13 skipped / 0 failed, `decouple-audit`, line-endings, `validate-plugin`,
  bundle-size all clean.
- **Windows-native lane: hit a pre-existing, previously-documented machine characteristic on its
  first `npm ci`** — `esbuild`'s postinstall shells out via `cmd.exe /d /s /c node install.js`, and
  a freshly-spawned `cmd.exe` on this machine/session inherits an empty `PATH` regardless of the
  parent shell's own `PATH` (confirmed recurring across multiple independent prior sessions).
  Applying the previously-proven workaround (`$env:npm_config_script_shell` routed through
  PowerShell instead of `cmd.exe`, as one single targeted retry, not a blind repeat) let `npm ci`,
  line-endings, executable-fixtures, the production-dependency audit, and Pester (**200 passed / 0
  failed / 6 skipped**) all complete cleanly. The Windows-native Gradle-plugin TestKit smoke test
  (`TaskActionTest`) then failed **11/16** sub-tests — a **separate**, independently
  pre-documented machine issue with no available workaround: that test hardcodes
  `ProcessBuilder("cmd.exe","/c",...)` directly rather than going through npm's configurable
  script-shell, so the same PATH-stripping characteristic applies regardless of the env-var fix,
  and cannot be routed around without modifying test or production code — out of scope for this
  evidence-only task. `git diff --stat -- gradle-plugin/` is empty for this entire session,
  confirming the failure is a pure pre-existing environment characteristic, not anything this
  session touched. The script's fail-fast `throw` at that point skipped the remaining native
  Windows steps (`vitest run --coverage`, Node 18 native re-check); running the coverage step
  directly afterward (same `node`-direct invocation pattern as preflight) recovered **4274 passed /
  4 failed / 2 skipped**, with all 4 failures isolated to `tests/vitest/windows-metachar.test.js`'s
  own self-documented-fragile "Candidate B ... (discarded)" describe block — the same root
  PATH-stripping characteristic (a third independent manifestation in this session), not a new or
  scope-related issue. The Node 18 native re-check was not additionally run since the Linux lane's
  own Node 18 pass already confirmed that compatibility axis.
- **Net**: every gate capable of running on this machine ran and passed, except two independently
  pre-documented, unfixable-without-out-of-scope-changes machine characteristics — both confirmed
  scope-unrelated via a clean `git diff --stat`. No real doubt remained about preflight health
  before the first live session was spent.

**Live matrices**: both `run` commands executed exactly once each, in strict sequence (scenario 2
was not started until scenario 1's 4 records independently re-validated clean). Both matrices
atomically promoted their full 4-of-4 cells — no rejection, no partial promotion, no timeout, no
retry.

## Evidence integrity

- **File-level, not just exit-code**: `git status --short tools/runs` showed exactly 16 new
  untracked files after both live matrices (8 records + 8 `audit/` sidecars) — no more, no fewer.
  `tools/runs/agentic-eval-scenario/raw/` held exactly 8 new `.jsonl` files locally, none of which
  ever appeared in `git status` output, each independently confirmed `.gitignore`-covered.
- **Historical evidence untouched**: the git-blob-hash manifest of every pre-existing tracked
  `tools/runs/**` file, captured before this session's live calls, is byte-for-byte identical to
  the manifest recomputed after both matrices completed.
- **No generated JSON was hand-edited at any point.**
- **Raw transcript content was never read in this report.** Every structural claim above (skill
  ordinal, pre-skill tool-call/denial counts, tool category, phase, result status) is read from the
  committed `audit/` sidecar's own closed-vocabulary fields via `analyze --runs-dir`, or from the
  committed record's own top-level fields (timing, tokens) — for both this batch and, for direct
  comparison, PR #401's own already-committed records — never from the gitignored raw transcript.
- **Fresh KaMPKit clone confirmed clean after both matrices**: `git status --porcelain` empty, HEAD
  still exactly `b3a7784fb969a8558b88c80674c8b596944cdab7`, single worktree.

## Explicit limitations and disclosures

- **`n=2` per scenario, not a benchmark.** No statistical claim follows from 2 repetitions per
  condition. `benchmark_eligible:true` is a protocol/integrity statement, never a correctness or
  performance one.
- **Model nondeterminism**: `claude-sonnet-5` is not deterministic across invocations even at a
  fixed seed — every number above can vary run-to-run for reasons unrelated to any skill change,
  including the scenario-1 failure-class substitution discussed above.
- **No aggregate success-rate improvement is claimed.** Scenario 1: flat at 1-of-2 across both
  batches (failure *class* changed, not failure *rate*). Scenario 2: flat at 2-of-2 across both
  batches (already at ceiling; the improvement observed is in activation *timing*, not outcome).
- **`analyze` reports no timing metric other than what this report derived from the raw records
  directly** (`wall_clock_ms`, tokens) — `analyze`'s own output carries event-index ordering only,
  never per-event wall-clock timestamps, consistent with its documented limitation.
- **This session's gate coverage for the Windows-native Gradle-plugin TestKit lane is incomplete**,
  for a pre-existing, independently-documented, unfixable-in-scope reason (see "Gates passed"
  above); hosted CI on the resulting PR is this session's confirmation for that lane.
- **No statistical significance, general speedup, token savings, or product-quality claim is made
  anywhere in this report.** Every numeric comparison above is a directional observation at `n=2`,
  explicitly confounded by model nondeterminism.
- Every numeric value in this report's tables was read directly from the corresponding record's own
  JSON field, the corresponding committed `audit/` sidecar via `analyze --runs-dir`, or PR #401's
  own already-committed records, in this session (extracted programmatically, not
  hand-transcribed) — none invented, estimated, or hand-derived without a corresponding source
  field.

## Recommended next action

1. **Scenario 2's activation-timing improvement (`{3,4} → {0,2}`) is this canary's clearest signal**
   and lines up mechanistically with PR #403's stated fix (triggering on indirect module
   references, binding the exact dispatch target) — this scenario's prompt never names the skill or
   the module directly, exactly the kind of indirect phrasing that fix targets. At `n=2` this is
   directional, not proof, but it is a consistent, matching shift on both cells simultaneously.
2. **Scenario 1's `wrong-target` failure mode did not recur, but a new full-denial failure mode
   appeared in its place on the other cell** (`62e1e392`, 8/8 post-skill denials, zero evidence
   produced) — overall success for this scenario is unchanged at 1-of-2. This failure shape has not
   been seen for this scenario+skill combination since PR #398's batch and would benefit from
   independent, larger-`n` or raw-transcript-level investigation, as a separately authorized task —
   this report does not attempt that investigation and makes no claim about its cause.
3. **No harness or evidence-integrity defect was found.** This evidence-only PR does not fix, tune,
   or otherwise change any harness, skill, policy, or scenario file. The scenario-1 full-denial
   failure mode and the still-unidentified specific wrong-module identity from prior batches remain
   open questions for separate, explicitly authorized follow-up work.

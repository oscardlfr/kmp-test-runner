# Agentic-eval harness — benign stderr-merge policy canary (2026-08-07)

## What this is

A fresh, controlled `n=2` canary of the two existing KaMPKit scenarios, run to measure whether
**PR #406** (`fix(agentic): allow benign stderr merge in policy hook`, commit
`6e5217a1f537a7e358a455e24343d5d0cbdd3bda`) removed artificial friction previously caused by the
policy hook denying a canonical `kmp-test` command whose only "problem" was a terminal `2>&1`
stderr-merge suffix. PR #406 changed only `tools/agentic-eval/policy-hook.mjs` (plus its own tests
and README) — it did **not** advance `PINNED_SKILL_SHA`, which stays at `20d109e21a9f0b4147b08148f89701c9e6f58e43`
(PR #403), the same pin **PR #405**'s baseline (`tools/runs/agentic-eval-target-binding-canary-2026-07-27.md`,
squash `2dc7be7`) already used.

This is an **`n=2` directional canary, not a statistically meaningful benchmark**, and **not
evidence of general speed, cost, token, quality, or product-efficacy improvement**. The eight new
records are compared directionally against PR #405's own eight already-committed records — same
schema, same skill pin, same source project/commit, same model, same measurement scope, so the
comparison isolates the policy-hook change as the one experimental variable (confirmed below, not
assumed).

## Version confound and how it was closed

At preflight, the ambient `claude` on `PATH` resolved to `2.1.224` — newer than PR #405's `2.1.218`
baseline. Per instruction, no live call was made and no global install was touched. Instead: a
second, fully isolated Claude Code `2.1.218` was installed via `npm install --prefix <isolated
toolchain dir> --no-save @anthropic-ai/claude-code@2.1.218` (never `--global`), with its
`node_modules/.bin` prepended **only** to the process-local `PATH` of the shell that launched the
harness — user/machine `PATH` was never modified. Before the first live call this was re-verified
against the actual mechanism the harness uses, not just declared: `tools/agentic-eval/condition-launcher.mjs`
spawns every measured session via `bash -c` (Git Bash, resolved the same way `resolve-bash.mjs`
resolves it — well-known install paths first, `where git`-derived as fallback, WSL's ambiguous
`bash.exe` deliberately avoided), the env for that spawn passes through `buildEvalEnv()`
(`env-builder.mjs`, whose fixed allowlist includes `PATH`/`Path`) plus a `kmp-test`-only shim
directory prepended on top (`path-shim.mjs` — no `claude` shim, so no shadowing). Resolving `claude`
through the exact same `bash.exe` and env-construction path the harness uses confirmed
`2.1.218 (Claude Code)`, resolved to the isolated toolchain, not the ambient `2.1.224`. All 8
records below independently confirm `claude_code_version: "2.1.218"` — verified from the committed
records themselves, not only from the preflight check.

## Authorization / auth proof (booleans only — no account details)

- Isolated-toolchain `claude auth status --json`: `loggedIn`: **true**, `authMethod`: **claude.ai**,
  `apiProvider`: **firstParty**, `subscriptionType`: **max** (informational field, not a pass/fail
  gate). No email, orgId, or orgName recorded anywhere in this report.
- **Session ceiling**: exactly **8** live Claude sessions authorized (2 scenarios × 2 conditions × 2
  repeats), and exactly **8 spent** — none unused, none exceeded, **zero retries**, zero replacement
  runs. Each live matrix command ran **exactly once**; scenario 2 was not started until scenario 1's
  4 records independently re-validated clean (schema, sidecar SHA-256, `claude_code_version`).

## Fixed provenance

| Field | Value |
|---|---|
| Repository base | `6e5217a1f537a7e358a455e24343d5d0cbdd3bda` (develop, PR #406) |
| `current-skill` pin | `20d109e21a9f0b4147b08148f89701c9e6f58e43` (PR #403 — unchanged by #406) |
| Source project | `https://github.com/touchlab/KaMPKit` |
| Source commit | `b3a7784fb969a8558b88c80674c8b596944cdab7` (same commit every prior canary used) |
| Claude Code version | `2.1.218` (isolated toolchain — see above; same version PR #405 used) |
| Model | `claude-sonnet-5` |
| Seed | `20260722` (frozen protocol value) |
| Repeats / conditions | 2 repeats × {`no-skill`, `current-skill`} |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` (same longitudinal scope as PR #405 and every prior canary — confirmed by reading it directly from PR #405's own committed records, not assumed) |
| Branch | `feature/agentic-benign-stderr-policy-canary` |
| Fresh KaMPKit clone | dedicated, isolated clone (`KaMPKit-benign-stderr-policy-canary`) — the shared `C:\kmp-eval\KaMPKit` and every other `C:\kmp-eval\*` canary worktree/clone were neither reused nor altered |
| `policy_sha256` (this run) | `a7f7016366e851257b4c0d48e1f65f17e0fe5b7d686c8cb779cec48a173b03f9` — differs from PR #405's `f2ec18f5dde8f230...` by construction (fingerprints `policy-hook.mjs`'s own source bytes, which #406 changed); the harness's own Fairness Contract (`HARD_PARTITION_FIELDS`) already refuses to aggregate these two policy generations together |
| Execution window (UTC) | `2026-08-07T12:14:55Z` – `2026-08-07T12:29:14Z` (~14.3 min, 8 sessions) |

The measurement-scope file's local path is omitted from this report. Its `scope_id` (a non-secret
identifier) is shown above; the file's own internal HMAC is read internally by the harness (to
authenticate the scope) but is never printed, logged, or exposed anywhere in this report or session
output.

## Sanitized commands run

`<KaMPKit clone>` and `<measurement scope file>` below substitute the real local filesystem paths;
everything else is the literal command, run with the isolated `2.1.218` toolchain's `.bin`
prepended to the process-local `PATH`.

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
each (combined 8) — before any live call.

## Run IDs and sidecars (new, 2026-08-07)

| Scenario | Condition | Repetition | `run_id` | Sidecar |
|---|---|---|---|---|
| kampkit-android-host-test-discovery | no-skill | 1 | `scenario-no-skill-fdc5bb62` | `audit/scenario-no-skill-fdc5bb62.json` |
| kampkit-android-host-test-discovery | current-skill | 1 | `scenario-current-skill-f0c525b7` | `audit/scenario-current-skill-f0c525b7.json` |
| kampkit-android-host-test-discovery | current-skill | 0 | `scenario-current-skill-7ad46ae6` | `audit/scenario-current-skill-7ad46ae6.json` |
| kampkit-android-host-test-discovery | no-skill | 0 | `scenario-no-skill-cd6623ba` | `audit/scenario-no-skill-cd6623ba.json` |
| kampkit-no-applicable-tests | no-skill | 1 | `scenario-no-skill-0041ea54` | `audit/scenario-no-skill-0041ea54.json` |
| kampkit-no-applicable-tests | current-skill | 1 | `scenario-current-skill-c8bf4542` | `audit/scenario-current-skill-c8bf4542.json` |
| kampkit-no-applicable-tests | current-skill | 0 | `scenario-current-skill-57e5af3f` | `audit/scenario-current-skill-57e5af3f.json` |
| kampkit-no-applicable-tests | no-skill | 0 | `scenario-no-skill-34c35461` | `audit/scenario-no-skill-34c35461.json` |

All 8: `schema: 5`, `run_kind: "scenario"`, `benchmark_eligible: true`, `terminated: false`,
`termination_reason: null`, `exit_code: 0`, `errors: []`, `privacy_status: "public"`,
`claude_code_version: "2.1.218"`, `kmp_test_cli_source_sha`/`repo_commit`: `6e5217a1f537a7e358a455e24343d5d0cbdd3bda`,
`project_commit`: `b3a7784fb969a8558b88c80674c8b596944cdab7`. `skill_source_sha` is exactly
`20d109e21a9f0b4147b08148f89701c9e6f58e43` on every `current-skill` record and exactly `null` on
every `no-skill` record. `ambient_skill_profile` is byte-identical across all 8 (and identical to
PR #405's own value): `{count:16, scope_id:"4b9913f9-3c28-4fd9-afc2-275613b66520",
fingerprint_hmac:"359e10a2401e6d1e3d194fd55b3eb97887eed834306b4e0ab93994f02c3a231a"}`.

## Structural `2>&1` usage — the specific behavior PR #406 targets

Authorized narrow raw-transcript inspection (structural only: counted whether a Bash tool call's
command matched the exact suffix `policy-hook.mjs` tests for — `^(.*\S)[ \t]+2>&1[ \t]*$` — cross-
referenced against each committed sidecar's own `policy_decision`; no prompt, response, path, or
free-text content is quoted anywhere in this report):

| `run_id` | Canonical `kmp-test ... 2>&1` calls | Decision |
|---|---|---|
| `scenario-current-skill-f0c525b7` | 2 | allow, allow |
| `scenario-current-skill-7ad46ae6` | 2 | allow, allow |
| `scenario-current-skill-c8bf4542` | 0 | n/a |
| `scenario-current-skill-57e5af3f` | 0 | n/a |
| all 4 `no-skill` records | 0 | n/a |

**Only scenario 1's two `current-skill` sessions actually exercised the pattern PR #406 fixes — 4
instances total, 4/4 allowed, 0 denied.** This is the direct, positive confirmation the fix works
when exercised. **Scenario 2's `current-skill` sessions never attempted this form at all** (0
instances each) — their 3 and 5 policy denials (below) come from some other cause, unrelated to
the stderr-merge grammar, and are **not** attributed to PR #406 one way or the other. The four
`no-skill` cells never reach a policy-allowed command shape at all (by construction of that
ablation condition), so none of them exercise this form either.

## Scenario 1 — `kampkit-android-host-test-discovery`

| Field | no-skill r1 (`fdc5bb62`) | no-skill r0 (`cd6623ba`) | current-skill r1 (`f0c525b7`) | current-skill r0 (`7ad46ae6`) |
|---|---|---|---|---|
| `success` | false | false | **true** | **true** |
| `hook_call_count` / `hook_deny_count` | 9 / 9 | 7 / 7 | 2 / **0** | 2 / **0** |
| `wall_clock_ms` | 34013 | 38006 | 150621 | 157758 |
| total tokens (in+out+cache_read+cache_creation) | 159404 | 178401 | 91613 | 172787 |
| `terminal_authoritative_evidence_present` | false | false | true | true |

### Comparison against PR #405 (same pin, same scope, `policy_sha256` differs by construction)

PR #405's `current-skill` arm on this scenario was **1-of-2** (`62e1e392` failed with 8/8 post-skill
denials and zero evidence produced; `547485c8` succeeded with 6/9 denials). This batch's
`current-skill` arm is **2-of-2**, and — critically — **0 denials on either cell** (down from 6/9
and 8/8). The structural scan above confirms this specific improvement is directly attributable to
#406: both sessions issued a canonical `kmp-test ... 2>&1` command that PR #405's policy hook would
have denied and this run's policy hook allowed. Average tokens for this scenario's `current-skill`
cells: PR #405 ≈227,515 → this run ≈132,200 (≈42% lower), consistent with fewer denial/retry loops.

## Scenario 2 — `kampkit-no-applicable-tests`

| Field | no-skill r1 (`0041ea54`) | no-skill r0 (`34c35461`) | current-skill r1 (`c8bf4542`) | current-skill r0 (`57e5af3f`) |
|---|---|---|---|---|
| `success` | false | false | **true** | **true** |
| `hook_call_count` / `hook_deny_count` | 7 / 7 | 10 / 10 | 6 / 3 | 7 / 5 |
| `wall_clock_ms` | 59109 | 44625 | 94187 | 117502 |
| total tokens (in+out+cache_read+cache_creation) | 140307 | 196336 | 162157 | 202002 |
| `terminal_authoritative_evidence_present` | false | false | true | true |

### Comparison against PR #405

PR #405's `current-skill` arm was **2-of-2** with 7/10 and 2/4 denials. This batch's `current-skill`
arm is **also 2-of-2**, with 3/6 and 5/7 denials — **essentially unchanged**, and per the structural
scan above, neither batch's denials on this scenario involve the `2>&1` form at all, so this is the
expected result, not a gap in the fix: PR #406 has no mechanism to affect a scenario that never
exercises the pattern it changes. No causal claim is made about what does cause this scenario's
denials; that is outside this canary's authorized scope.

## Explicit finding evaluation

Evaluated against the single hypothesis this canary was authorized to check, using only committed
records, sidecars, and the narrow structural `2>&1` scan above:

**Does PR #406 remove denials on a canonical `kmp-test` command with a terminal `2>&1`, when that
form is actually attempted?** **Confirmed at `n=2` (4 instances).** Every one of the 4 observed
`kmp-test ... 2>&1` attempts was allowed; the two sessions that made them went from PR #405's mixed
6/9 and 8/8-denial, 1-of-2-success profile to 0/2-denial, 2-of-2-success. **This is not evidence
that PR #406 improves outcomes generally**: it only ever had the opportunity to matter in the 2 of
8 sessions (25%) that happened to reach for this specific command shape; the other 6 sessions'
outcomes (unchanged in scenario 2, structurally unreachable in the `no-skill` ablation) are
unaffected by construction, not because the fix failed anywhere.

## Reconciliation checklist — all 8 cells

1. **`validate --run` exits 0 on all 8** (0 errors, 0 warnings each), re-run individually per
   scenario batch in this session.
2. **Sidecar SHA-256 independently recomputed (`Get-FileHash`) and matched against each record's
   own `accepted_audit.sha256` on all 8** — not just trusting the record's self-reported hash.
3. **Provenance fields verified programmatically on all 8**: `repo_commit`/`kmp_test_cli_source_sha`
   = `6e5217a1f537a7e358a455e24343d5d0cbdd3bda`; `project_commit` = `b3a7784fb969a8558b88c80674c8b596944cdab7`;
   `project_url` = the KaMPKit repo URL; `model_requested`/`model_resolved` = `claude-sonnet-5`;
   `seed` = `20260722`; `claude_code_version` = `2.1.218`; `ambient_skill_profile.scope_id` =
   `4b9913f9-3c28-4fd9-afc2-275613b66520`; `skill_source_sha` = the PR #403 pin on every
   `current-skill` record and `null` on every `no-skill` record; `raw_capture_committed: false` and
   `benchmark_eligible: true` on all 8.
4. **Raw transcripts never staged**: `git status --porcelain` showed exactly 16 new untracked files
   after both live matrices (8 records + 8 `audit/` sidecars) — never the 8 `raw/*.jsonl`
   transcripts, which stay local and gitignored.
5. **Historical evidence untouched**: `git status --porcelain` on the full worktree, before and
   after both live matrices, shows zero modified/deleted paths at any point — only the 16 new
   untracked additions. None of the 36 pre-existing `tools/runs/agentic-eval-scenario/**` files from
   prior PRs (including PR #405's own 8) were touched.
6. **Genuine `success:false` cells kept as accepted evidence**: all 4 `no-skill` cells are honest
   `success:false` — every integrity gate passed for all 4, so all 4 are promoted, committed, and
   reported exactly like the 4 successful cells, with no smoothing or exclusion.

## Aggregation results

New records only, copied with their `audit/` sidecars to a temporary directory outside every
repository, aggregated alone via the harness's own `aggregate --runs-dir` / `analyze --runs-dir`:
exactly **4 groups**, **0 errors**, `files_seen: 8, files_analyzed: 8, files_excluded_not_applicable: 0,
files_excluded_benchmark_ineligible: 0`. `current-skill` groups: `success_rate: 1` in both scenarios
(2/2 each). `no-skill` groups: `success_rate: 0` in both scenarios (0/2 each), `failure_class_counts.policy-denial-observed-without-terminal-evidence: 2` in both — matching every prior canary's `no-skill` shape.

This session made zero changes to the full committed `tools/runs/agentic-eval-scenario/` directory
(36 pre-existing files); no full-directory `aggregate`/`analyze` re-run was needed to prove that,
since reconciliation item 5 (clean `git status` throughout) already establishes it directly.

## Gates passed

**Preflight**: `origin/develop` and local `HEAD` verified identical to the required base
(`6e5217a1f537a7e358a455e24343d5d0cbdd3bda`, confirmed via `git ls-remote`, not only a cached
tracking ref); `PINNED_SKILL_SHA` verified against `tools/agentic-eval/cli.mjs` source
(`20d109e21a9f0b4147b08148f89701c9e6f58e43`, confirmed unchanged by #406's own diff); fresh
dedicated worktree and branch created; fresh dedicated KaMPKit clone created (remote matches
`touchlab/KaMPKit`, HEAD at the required source commit, clean); measurement-scope file located
unambiguously (`scope_id` match confirmed via a content-free boolean check, key never printed);
JDK 23.0.2 (≥17); `ANDROID_HOME` set to a real SDK install with `platform-tools`/`build-tools`
(through 37.0.0)/`platforms` (through API 36.1) all present. Both `run --dry-run` previews
confirmed the 4-cell/8-session plan with the expected scope id before any live call.

**Local-CI** (`tools/local-ci/run.ps1 -Lane All`): run once as authorized, not retried.

- **Linux/Docker lane: fully passed.** bats 223/223, vitest (Node 24 lane + Node 18 lane) 85/85
  each, `decouple-audit`, line-endings, `validate-plugin`, `bundle-size` all clean.
- **Windows-native lane: hit the same pre-existing, previously-documented machine characteristic
  as prior sessions** (`TaskActionTest.kt:62`'s hardcoded `ProcessBuilder("cmd.exe","/c",...)` —
  a freshly-spawned `cmd.exe` on this machine inherits an empty `PATH` regardless of the parent
  shell's own `PATH`; no available workaround since that call bypasses npm's configurable
  script-shell). 11 of 16 sub-tests failed. `git diff --stat` for the entire canary worktree is
  empty for this whole session — confirming the failure is a pure pre-existing environment
  characteristic, not anything this session touched, exactly as seen in the sessions that produced
  PR #403/#404/#405.
- **Net**: every gate capable of running on this machine ran and passed, except one independently
  pre-documented, unfixable-without-out-of-scope-changes machine characteristic, confirmed
  scope-unrelated via a clean `git diff --stat`.

**Live matrices**: both `run` commands executed exactly once each, in strict sequence (scenario 2
was not started until scenario 1's 4 records independently re-validated clean, including
`claude_code_version`). Both matrices atomically promoted their full 4-of-4 cells — no rejection,
no partial promotion, no timeout, no retry.

## Evidence integrity

- **File-level, not just exit-code**: `git status --porcelain` showed exactly 16 new untracked
  files after both live matrices (8 records + 8 `audit/` sidecars) — no more, no fewer. The 8
  `raw/*.jsonl` transcripts exist locally but never appeared in `git status` output (gitignored).
- **No generated JSON was hand-edited at any point.**
- **Raw transcript content was read only for the single authorized narrow purpose** (counting
  canonical `kmp-test ... 2>&1` commands and their `policy_decision`, cross-referenced against each
  sidecar's own `tool_use_event_index`) — no prompt, response, or free-text content from any raw
  transcript is quoted anywhere in this report or was printed to any log.
- **Fresh KaMPKit clone confirmed clean after both matrices**: `git status --porcelain` empty, HEAD
  still exactly `b3a7784fb969a8558b88c80674c8b596944cdab7`, single worktree.
- **Isolated Claude Code toolchain**: installed locally only (`npm --prefix`, `--no-save`), never
  `--global`; user/machine `PATH` untouched; verified via the exact `bash.exe` + env-construction
  path the harness itself uses, not merely declared.

## Explicit limitations and disclosures

- **`n=2` per scenario, not a benchmark.** No statistical claim follows from 2 repetitions per
  condition. `benchmark_eligible:true` is a protocol/integrity statement, never a correctness or
  performance one.
- **Model nondeterminism**: `claude-sonnet-5` is not deterministic across invocations even at a
  fixed seed.
- **The improvement found is scoped strictly to cells that exercised the `2>&1` form.** 6 of 8
  sessions never attempted it; their outcomes are not evidence for or against PR #406.
- **Cost figures reflect a Max/OAuth-authenticated session** (`subscriptionType: max`,
  `apiProvider: firstParty`) — an internal plan-usage budget ceiling, not a per-token dollar charge;
  no dollar cost is claimed anywhere in this report.
- Every numeric value in this report's tables was read directly from the corresponding record's own
  JSON field, the corresponding committed `audit/` sidecar, or the harness's own
  `aggregate`/`analyze --runs-dir` output, in this session (extracted programmatically, not
  hand-transcribed) — none invented, estimated, or hand-derived without a corresponding source
  field.

## Recommended next action

1. **This canary's evidence directly supports PR #406's intended effect** in the one scenario that
   naturally exercises the `2>&1` form: 4/4 allowed (vs. PR #405's mixed 6/9 and 8/8 denial
   profile on the equivalent cells), with both sessions moving from a degraded/failed profile to a
   clean 0-denial success.
2. **Scenario 2's unrelated denials (3/6, 5/7) are unexplained by this canary and by design** — this
   report does not investigate their cause, consistent with the evidence-only, no-harness-changes
   scope authorized for this session. A future, separately authorized session could look at what
   those specific denials are (raw-transcript-level, narrowly scoped) if this friction is judged
   worth removing too.
3. **No harness, skill, pin, policy, or scenario file was modified by this session.** This is an
   evidence-only PR.

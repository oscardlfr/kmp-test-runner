# Agentic-eval harness — evidence-driven scope canary (2026-07-26)

## What this is

A fresh, controlled `n=2` canary of the two existing KaMPKit scenarios, run after five PRs landed
on top of the previous scoped canary (`tools/runs/agentic-eval-decision-protocol-scoped-canary-2026-07-25.md`,
run at PR #392 / `ae508a1c1d84a40b3aa62188c1f776654bb85229`):

- **PR #393** (`a8af99a`, `test(agentic): capture scoped decision-protocol canary`) committed that
  prior canary's own 8 schema-v4 records.
- **PR #394** (`3e2abf6`, test-only timeout fix, not expected to affect live agent behavior).
- **PR #395** (`9e47a9d132f5b9ea6ac5bc50a66c844458fd363e`, `fix(skill): make test scope selection
  evidence-driven`) rewrote the `kmp-test-runner` skill's Decision protocol so module-scope
  selection is evidence-driven (descriptive/conventional wording never counts as an exact module
  match, multi-module `describe` results are filtered by task-capability, the no-module dispatch is
  the first action, and the terminal condition is operational). This is the commit `current-skill`
  is now pinned to, and is the actual object of this canary.
- **PR #396** (`8dceae2`, `feat(agentic-eval): add accepted-run observability`) added the schema-v5
  run record fields (`post_signal_ms`, `post_signal_tool_calls`,
  `policy_denials_before_first_signal`, `policy_denials_after_first_signal`, `accepted_audit`) and
  the committed, structural `audit/<run_id>.json` sidecar this report uses.
- **PR #397** (`a9acb22d7b58d6720248bcbd09f4b4818e8ad2be`, `fix(agentic): advance evidence-driven
  skill snapshot pin`) advanced `PINNED_SKILL_SHA` to PR #395's merge commit, and is this run's
  required base commit.

This is an **`n=2` directional canary, not a statistically meaningful benchmark**, and **not
evidence of general speed, cost, token, quality, or product-efficacy improvement**. The eight new
records are compared primarily and directionally against the eight schema-v4 records from the
2026-07-25 scoped canary, without modifying those records in any way. The eight schema-v3 records
from the 2026-07-23 rerun are included only as clearly-labelled secondary historical context.

## Authorization / auth proof (booleans only — no account details)

Checked at initial preflight, again immediately before the dry-run previews, and again immediately
before the first live call:

- `ANTHROPIC_API_KEY` present at Process, User, or Machine scope: **false**, every check
- `KMP_EVAL_RUNS_ROOT` set: **false**
- `claude auth status`: `loggedIn`: **true**, `authMethod`: **claude.ai**, `apiProvider`:
  **firstParty** — no API-key source present at any check
- No account, email, organization, or connector detail is recorded anywhere in this report or in
  session memory.

**Session ceiling**: exactly **8** live Claude sessions authorized (2 scenarios × 2 conditions × 2
repeats), and exactly **8 spent** — none unused, none exceeded, **zero retries**, zero replacement
runs. Each live matrix command ran **exactly once**.

**Budget note**: each condition ran under the harness's internal `--max-budget-usd` safety ceiling
($0.60/condition) — an Agent-SDK usage cap consumed as Max-plan usage, not a per-token API charge.
8 × $0.60 = a **$4.80 aggregate theoretical ceiling**, not a bill.

**Local-CI infrastructure note**: the zero-cost preflight's first `tools/local-ci/run.ps1 -Lane All`
attempt was aborted before any live session spend — a Docker container in the Linux Node24 lane
entered `Dead` status and its `docker run` client blocked indefinitely (45+ minutes, no CPU, log,
or container-state change). A `service docker restart` inside WSL also hung. Terminating and
letting the WSL2 distro cold-restart cleared the daemon into a working state, confirmed by a
successful fresh container run before retrying. The single authorized recovery run then completed
fully green (`[local-ci] requested lane 'All' passed`, exit 0), and the repository, historical
manifest, KaMPKit clone, measurement-scope file, and protected WIP were all independently
reverified byte-identical afterward. No root cause for the Docker/WSL2 wedge itself is claimed —
only the observed symptoms and the recovery procedure. No live session was spent or affected by
this; it occurred entirely within the zero-cost preflight phase.

## Fixed provenance

| Field | Value |
|---|---|
| Repository base | `a9acb22d7b58d6720248bcbd09f4b4818e8ad2be` (develop, PR #397 merge) |
| `current-skill` pin | `9e47a9d132f5b9ea6ac5bc50a66c844458fd363e` (PR #395 merge) |
| Source project | `https://github.com/touchlab/KaMPKit` |
| Source commit | `b3a7784fb969a8558b88c80674c8b596944cdab7` (same commit every prior canary used) |
| Model | `claude-sonnet-5` |
| Seed | `20260722` (frozen protocol value, not the execution date) |
| Repeats / conditions | 2 repeats × {`no-skill`, `current-skill`} |
| Measurement-scope id (non-secret) | `4b9913f9-3c28-4fd9-afc2-275613b66520` (same scope id every prior canary used) |
| Branch | `feature/agentic-evidence-driven-scope-canary` |
| Fresh KaMPKit clone | dedicated, isolated clone — the pre-existing shared `C:\kmp-eval\KaMPKit` was neither reused nor altered |

The measurement-scope file's local path and its `hmac_key_base64` are deliberately omitted from
this report (never printed, logged, staged, or committed at any point in this session).

## Sanitized commands run

`<KaMPKit clone>` and `<measurement scope file>` below substitute the real local filesystem paths;
everything else is the literal command. Both scenarios ran against the same pinned KaMPKit commit
every prior canary used, verified clean and origin-matched immediately before each live call.

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

## Run IDs and sidecars (new, 2026-07-26)

| Scenario | Condition | Repetition | `run_id` | Sidecar (`audit/<run_id>.json`) |
|---|---|---|---|---|
| kampkit-android-host-test-discovery | no-skill | 0 | `scenario-no-skill-3a060861` | `audit/scenario-no-skill-3a060861.json` |
| kampkit-android-host-test-discovery | no-skill | 1 | `scenario-no-skill-6a34afa3` | `audit/scenario-no-skill-6a34afa3.json` |
| kampkit-android-host-test-discovery | current-skill | 0 | `scenario-current-skill-08d5daaa` | `audit/scenario-current-skill-08d5daaa.json` |
| kampkit-android-host-test-discovery | current-skill | 1 | `scenario-current-skill-27d0c3c6` | `audit/scenario-current-skill-27d0c3c6.json` |
| kampkit-no-applicable-tests | no-skill | 0 | `scenario-no-skill-2770973f` | `audit/scenario-no-skill-2770973f.json` |
| kampkit-no-applicable-tests | no-skill | 1 | `scenario-no-skill-a8e1eacc` | `audit/scenario-no-skill-a8e1eacc.json` |
| kampkit-no-applicable-tests | current-skill | 0 | `scenario-current-skill-ccff419c` | `audit/scenario-current-skill-ccff419c.json` |
| kampkit-no-applicable-tests | current-skill | 1 | `scenario-current-skill-2c9a93fb` | `audit/scenario-current-skill-2c9a93fb.json` |

All 8 new records: `schema: 5`, `run_kind: "scenario"`, `benchmark_eligible: true`,
`terminated: false`, `termination_reason: null`, `exit_code: 0`, `errors: []`,
`privacy_status: "public"`, `claude_code_version: "2.1.218"` (identical to the v4 batch — no CLI
version confound this time). `skill_source_sha` is exactly the pin above on every `current-skill`
record and exactly `null` on every `no-skill` record. `ambient_skill_profile` is byte-identical
across all 8 records: `{count:16, scope_id:"4b9913f9-3c28-4fd9-afc2-275613b66520",
fingerprint_hmac:"359e10a2401e6d1e3d194fd55b3eb97887eed834306b4e0ab93994f02c3a231a"}` — the
underlying ambient bundled-skill set did not change across this session's two live matrix
invocations. Every record independently re-validated via `validate --run` (0 errors, 0 warnings on
all 8 — this check also verifies each record's own on-disk `audit/` sidecar: existence,
containment, SHA-256 hash match, sidecar schema, and cross-validation against the record). Every
sidecar hash was **also** independently re-derived in this session (SHA-256 of the sidecar file
text, compared byte-for-byte against `accepted_audit.sha256`) rather than only trusting the
validator's own internal claim — all 8 matched.

## Historical schema-v3 aggregation limitation (secondary context only)

The 8 oldest records (`tools/runs/agentic-eval-scenario-canary-rerun-2026-07-23.md`) are
`schema: 3` — produced before `ambient_skill_profile` existed, and are shown here only as
secondary historical context, not as the primary comparison baseline (that role belongs to the
schema-v4 batch below). Aggregating them alone reproduces exactly the expected contract: **0
groups**, **4 errors** (one per scenario × condition bucket, all and only the
`ambient_skill_profile`-missing refusal). They remain individually valid, schema-valid evidence —
they simply cannot enter a publishable schema-v4-and-later aggregate, by design, not by defect.

## Scenario 1 — `kampkit-android-host-test-discovery`

Expected ground truth: the agent discovers and runs the non-obvious Android host-test task for
`:shared` (`:shared:testAndroidHostTest`, 24/24 passing).

### Schema-v4 baseline (2026-07-25, skill pin `6d45dde...`, Claude Code 2.1.218)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `6ef94f5b` | `0a25476c` | `b45c7eb7` | `202a12d6` |
| `success` | false | false | **true** | false |
| `expected_outcome_matched` | false | false | **true** | false |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 8 / 8 | 8 / 8 | 12 / 9 | 5 / 3 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 2 / 1 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 8 / 9 | 8 / 8 | 12 / 13 | 5 / 6 |
| `first_useful_signal_ms` | null | null | 154278.20 | null |
| `wall_clock_ms` | 52556 | 34654 | 186925 | 82922 |
| tokens in/out/cache_read/cache_creation | 20/3393/178430/4232 | 18/1816/138927/18609 | 26/5021/289921/10520 | 14/1621/125563/9222 |
| `output_bytes` | 428 | 408 | 3908 | 2269 |
| `foreign_skill_summary` | confirmed:1 | confirmed:0 | confirmed:0 | confirmed:0 |

### Schema-v5 new (2026-07-26, skill pin `9e47a9d...`, Claude Code 2.1.218)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `3a060861` | `6a34afa3` | `08d5daaa` | `27d0c3c6` |
| `success` | false | false | **false** | **false** |
| `expected_outcome_matched` | false | false | false | false |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 13 / 13 | 10 / 10 | 6 / 4 | 9 / 9 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 0 / 0 |
| `shell_commands_total` / `tool_calls_total` | 13 / 14 | 10 / 11 | 6 / 7 | 9 / 10 |
| `first_useful_signal_ms` | null | null | null | null |
| `wall_clock_ms` | 51052 | 57425 | 89087 | 45662 |
| tokens in/out/cache_read/cache_creation | 26/2797/232289/4779 | 24/3613/198929/21999 | 16/1835/151916/7026 | 22/2648/228245/9639 |
| `output_bytes` | 683 | 530 | 2336 | 491 |
| `foreign_skill_summary` | confirmed:1 | confirmed:1 | confirmed:0 | confirmed:0 |
| `post_signal_ms` / `post_signal_tool_calls` | null (no boundary) | null (no boundary) | null (no boundary) | null (no boundary) |
| `policy_denials_before`/`after_first_signal` | null / null | null / null | null / null | null / null |

### Directional differences (scenario 1) — observations, not causal claims, preserved without smoothing

- **`current-skill` success dropped from 1-of-2 (v4) to 0-of-2 (v5).** This is the single most
  notable directional result in this canary and is reported plainly, not softened. v4's successful
  cell (`b45c7eb7`) is not matched by either new `current-skill` cell.
  - `08d5daaa` (rep 0) reached real, policy-allowed evidence (`bash_tool_use_present:true`,
    `authoritative_evidence_well_formed:true`) but `authoritative_target_matches_expected:false` —
    the same **correctness**-failure shape as v4's own `current-skill` failure (`202a12d6`): a real
    attempt that landed on the wrong module/evidence, not a policy-denial failure.
  - `27d0c3c6` (rep 1) shows `bash_tool_use_present:false` with `hook_call_count == hook_deny_count`
    (9/9, 100% denial) despite `skill_invoked:true` — a **policy-denial** failure shape, the same
    kind v4's one `current-skill` success's sibling-repetition pattern did not show, but which does
    appear in the v3→v4 lineage (v4's `202a12d6` was itself a correctness failure, not a denial
    failure — so this is a new failure shape for this scenario's `current-skill` arm specifically).
  - Neither new `current-skill` cell reached a `first_useful_signal_ms` boundary (both null), unlike
    v4's one success (154278.20ms) — consistent with neither cell producing accepted terminal
    evidence this time.
- **`no-skill` remains 0-of-2**, identical in count to v4 — both conditions' failure mode is
  unchanged (100% Bash denial in every no-skill cell, both batches).
- **Both `no-skill` cells now show `foreign_skill_summary.confirmed:1`** (v4 showed this on only 1
  of its 2 no-skill cells). Both are the documented ambient-bundled-skill tolerance (`skillSelectionOk`
  in `scenarioCellIntegrityOk`), verified against the matrix-wide consensus `ambient_skill_profile`
  — not contamination, and did not block promotion in either cell.
- Wall-clock, token, and output-byte numbers moved in both directions across cells (see tables) — no
  consistent directional pattern within this scenario at `n=2`.

## Scenario 2 — `kampkit-no-applicable-tests`

Expected ground truth: the agent correctly reports that `:app` (resource/asset-only module) has no
applicable unit tests.

### Schema-v4 baseline (2026-07-25)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `d31238da` | `d0d839be` | `f2db7366` | `72220614` |
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 13 / 13 | 8 / 8 | 9 / 6 | 11 / 8 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 13 / 15 | 8 / 8 | 9 / 10 | 11 / 12 |
| `first_useful_signal_ms` | null | null | 93402.94 | 103644.35 |
| `wall_clock_ms` | 58884 | 31291 | 100236 | 108006 |
| tokens in/out/cache_read/cache_creation | 32/3468/299167/6986 | 18/1378/145110/9742 | 22/2986/215893/8791 | 26/2755/260159/11472 |
| `output_bytes` | 703 | 408 | 3697 | 3799 |
| `foreign_skill_summary` | confirmed:2 | confirmed:0 | confirmed:0 | confirmed:0 |

### Schema-v5 new (2026-07-26)

| Field | no-skill r0 | no-skill r1 | current-skill r0 | current-skill r1 |
|---|---|---|---|---|
| `run_id` suffix | `2770973f` | `a8e1eacc` | `ccff419c` | `2c9a93fb` |
| `success` | false | false | **true** | **true** |
| `expected_outcome_matched` | false | false | **true** | **true** |
| `skill_available`/`attempted`/`invoked` | F/F/F | F/F/F | T/T/T | T/T/T |
| `hook_call_count` / `hook_deny_count` | 13 / 13 | 14 / 14 | 11 / 7 | 9 / 5 |
| `test_invocations_total` / `retries` | 0 / 0 | 0 / 0 | 1 / 0 | 1 / 0 |
| `shell_commands_total` / `tool_calls_total` | 13 / 13 | 14 / 14 | 11 / 12 | 9 / 10 |
| `first_useful_signal_ms` | null | null | 113989.37 | 105828.33 |
| `wall_clock_ms` | 69535 | 68411 | 126928 | 110918 |
| tokens in/out/cache_read/cache_creation | 26/3938/229288/4609 | 30/4123/264012/12871 | 26/4389/276376/10951 | 22/2571/216529/11811 |
| `output_bytes` | 663 | 714 | 4699 | 5309 |
| `foreign_skill_summary` | confirmed:0 | confirmed:0 | confirmed:0 | confirmed:0 |
| `post_signal_ms` | null (no boundary) | null (no boundary) | **12935.19** | **5085.89** |
| `post_signal_tool_calls` | null | null | **2** | **0** |
| `policy_denials_before_first_signal` | null | null | 6 | 5 |
| `policy_denials_after_first_signal` | null | null | **1** | **0** |

### Directional differences (scenario 2) — observations, not causal claims

- **Success count is unchanged**: 2-of-2 `current-skill` succeeded, both batches; `no-skill` remains
  0-of-2, both batches. Scenario 2's `current-skill` arm is consistently the stronger of the two
  scenarios across all three canaries (v3, v4, v5) run so far.
- **`current-skill` needed more allowed commands and more wall time to reach the same successful
  outcome this time**: allowed-call sum (`hook_call_count − hook_deny_count`) 3+3=6 (v4) vs.
  4+4=8 (v5); wall-clock sum 100236+108006=208242ms (v4) vs. 126928+110918=237846ms (v5). This is
  the inverse of the v3→v4 comparison's own headline efficiency observation (which found v4 faster
  than v3) — reported here as a directional observation only, not evidence of a general slowdown,
  at `n=2` under model nondeterminism and a 1-day time separation.
- **New v5 post-signal metrics give a first concrete look at "avoidable exploration after a useful
  signal."** Both `current-skill` cells' `terminal_authoritative_event` is the identical event index
  as their own `first_useful_signal_event` — the agent's final answer was grounded in the same
  evidence that first satisfied the task, in both cells. Despite that, `ccff419c` made 2 more
  `kmp-test describe` tool calls after that boundary (one denied, one allowed) over an additional
  ~12.9 seconds before concluding; `2c9a93fb` made zero further tool calls and concluded almost
  immediately (~5.1 seconds, plausibly answer-formatting/output time rather than further
  exploration). This is exactly the kind of per-cell variance these new metrics were added to make
  visible — described here structurally (call category, allow/deny, phase) from the committed
  `audit/` sidecar, never from the raw transcript's own content.
- Both `no-skill` cells remain fully denied (`hook_deny_count == hook_call_count`) in both batches —
  consistent, expected drift-free control behavior. `foreign_skill_summary.confirmed` dropped from
  2 (one v4 no-skill cell) to 0 (both v5 no-skill cells) — no ambient-skill exploration occurred in
  either no-skill cell this time; not a concern either way (both are non-contaminating outcomes by
  design).

## Policy denials vs. answer correctness

Every `no-skill` failure across all three canaries traces to the identical structural cause: **100%
of that cell's Bash attempts were denied by the narrow scenario policy**
(`hook_deny_count === hook_call_count`), so `bash_tool_use_present` and everything downstream of it
fail as a direct structural consequence — not an independent judgment that the agent's reasoning was
wrong. This is a **policy-denial** outcome, not a **correctness** failure: across all 12 `no-skill`
cells run so far (4 v3 + 4 v4 + 4 v5), the harness never once observed the agent produce a wrong
test-count or a wrong `no_applicable_tests` claim in a `no-skill` cell, because the agent never got
past an allowed command in any of them.

The two new `current-skill` failures are of **different kinds**, and are not collapsed into a single
"failure" count:
- `scenario-current-skill-08d5daaa` (scenario 1, rep 0) is a **correctness** failure: real,
  policy-allowed evidence was produced (`authoritative_evidence_well_formed:true`), and it targeted
  the wrong module — the same failure *kind* as v4's own `current-skill` failure
  (`scenario-current-skill-202a12d6`).
- `scenario-current-skill-27d0c3c6` (scenario 1, rep 1) is a **policy-denial** failure despite
  `skill_invoked:true` — 100% of its Bash attempts were denied, so no evidence-based grading ever
  ran. This failure kind was not present in either scenario 1 `current-skill` cell in the v4 batch.

## Reconciliation (Phase 5 checklist) — new batch, all 8 cells

1. **`validate --run` exits 0 on all 8**, which independently verifies each record's own on-disk
   `audit/<run_id>.json` sidecar (existence, containment, SHA-256 hash, sidecar schema,
   cross-validation against the record) — 0 errors, 0 warnings on every record.
2. **Filename equals `run_id` on all 8** (independently re-checked, not assumed from the write path).
3. **`accepted_audit.relative_path` is exactly `audit/<run_id>.json` on all 8.**
4. **Sidecar SHA-256 independently re-hashed and matched `accepted_audit.sha256` on all 8** —
   computed fresh in this session, not read from the validator's own internal claim.
5. **Schema `5` and all 4 post-signal metric keys (`post_signal_ms`, `post_signal_tool_calls`,
   `policy_denials_before_first_signal`, `policy_denials_after_first_signal`) present on all 8** —
   real numeric values with `reason:null` on the 2 cells that reached a first-useful-signal
   boundary; `value:null, reason:"no first useful signal boundary"` on the other 6, consistent with
   those 6 cells never producing accepted terminal evidence.
6. **Sidecar identity, event indices, tool categories, policy decisions, first useful signal,
   terminal authoritative event, and metric totals reconciled with the record on all 8** — every
   sidecar's own `run_id`/`run_schema`/`run_kind`/`condition`/`scenario_id`/`first_useful_signal_event`
   matches its record exactly; every sidecar's `summary` metric total matches the corresponding
   record `.value` field exactly (enforced by `crossValidateAcceptedRunAuditAgainstRecord`, which
   `validate --run` invokes for every schema-5 scenario record).
7. **Zero `policy_decisions_missing` on all 8** — every Bash-family tool call in every transcript
   resolved to a real `allow`/`deny` decision; none were left unresolved.
8. **Genuine `success:false` cells kept as accepted evidence**: 6 of the 8 new cells are honest
   `success:false` (4 in scenario 1, 2 in scenario 2's `no-skill` arm) — every integrity gate passed
   for all 6, so all 6 are promoted, committed, and reported exactly like the 2 successful cells,
   with no smoothing or exclusion.

## Aggregation results

**New records only** (copied to a temporary directory outside every repository, aggregated alone):
exactly **4 groups**, **0 errors**, one group per scenario × condition, `run_count: 2` on every
group, `schema: 5` group key throughout.

**Full committed `tools/runs/agentic-eval-scenario/` directory** (8 schema-v3 + 8 schema-v4 + 8
schema-v5 = 24 records): exactly **8 valid groups** — the same **4 schema-v4 groups** from the prior
canary, unchanged, plus **4 new schema-v5 groups** (identical to the new-only run above) — **plus
the same 4 expected schema-v3 `ambient_skill_profile` errors** — no other group or error class. CLI
exit code 1, caused only by those 4 expected historical errors, correctly not misclassified as a new
failure. The schema-v4 and schema-v5 groups deliberately did **not** merge, even though every other
hard-partition field (`scenario_id`, `condition`, `project_commit`, `model_resolved`,
`ambient_skill_profile`, etc.) matches between them — `schema` itself, `skill_source_sha` (the pin
changed), and `claude_code_version` (same value, but a different underlying capture) are all
`HARD_PARTITION_FIELDS` entries that keep these two genuinely-different captures apart by design,
not by defect. No claim is made that they should be pooled.

## Gates passed

**Zero-cost preflight**: base SHA verified identical across local `develop`/`origin/develop`/
`FETCH_HEAD`; no branch/worktree/path collision; the pre-existing shared `C:\kmp-eval\KaMPKit` clone
was neither reused nor altered; all unrelated `C:\kmp-eval\*` worktrees left untouched; `npm ci`
clean. `PINNED_SKILL_SHA` and both scenario files' fixed provenance verified. Focused agentic-eval +
skill-canonical-workflow suite (36 files): 1647/1647 passed. Full repository suite: 4168/4168
passed, 2 skipped (84 files) — run twice (once natively, once inside local-CI's Windows lane),
identical result both times. Corpus validate, plugin validate, decouple-audit, line-endings,
executable-fixtures, `git diff --check`: all clean. All 16 pre-existing records individually
schema-valid; baseline aggregation reproduced exactly the expected 4-v4-groups/4-v3-errors contract
before any live spend. `KMP_EVAL_RUNS_ROOT` unset throughout. `pwsh tools/local-ci/run.ps1 -Lane All`
required one infrastructure-level recovery (see "Local-CI infrastructure note" above) before its
single authorized run passed cleanly: `[local-ci] requested lane 'All' passed`, exit 0. Historical
`tools/runs/**` manifest (git-blob hashes) recomputed after local CI: byte-identical to the pre-CI
baseline (one apparent mismatch on first diff was traced to a CRLF/LF line-ending artifact between
the two capture tools used, not a real content change — resolved via content-normalized comparison
and raw hex confirmation). Both `run --dry-run` previews confirmed the 4-cell/8-session plan. All
gates were repeated immediately before the first live call: API-key/auth booleans, Java/Android SDK
presence, KaMPKit cleanliness (clean, origin matches, HEAD at pinned commit, exactly one worktree),
canary-worktree cleanliness (clean except the two pre-documented Windows CRLF-status-only snapshot
files, proven content-identical via empty unstaged/cached/stat diffs and matching `git hash-object`
against the indexed blob).

**Live matrices**: both `run` commands executed exactly once each. Both matrices atomically promoted
their full 4-of-4 cells — no rejection, no partial promotion, no timeout, no retry. All 8 records
independently re-validated schema-clean after write. After both matrices, the primary checkout's
protected WIP, the KaMPKit clone, the measurement-scope file, and every unrelated worktree were all
independently reconfirmed byte-identical/untouched.

## Evidence integrity

- **File-level diff, not just command exit code**: `tools/runs/agentic-eval-scenario/` held exactly
  16 `*.json` files before this session's live calls (spot-checked byte-identical to the historical
  manifest); exactly 24 after (16 historical + 8 new) — no more, no fewer, verified by filename-set
  diff against a pre-execution snapshot taken immediately before each live call. `tools/runs/agentic-eval-scenario/audit/`
  and `.../raw/` each held exactly 8 files after (all new). Every new record's own `run_id` matches
  its filename exactly.
- **Raw transcripts never staged**: never appeared in `git status --porcelain` at any point (only
  the top-level records and the new `audit/` directory did); covered by the existing
  `tools/runs/agentic-eval-*/raw/**` `.gitignore` rule.
- **Historical evidence untouched**: the git-blob-hash manifest of all pre-existing tracked
  `tools/runs/**` files, captured before this session's worktree existed, is byte-for-byte identical
  to the manifest recomputed after local CI and again before staging (Phase 7) — spot-checked
  directly via `git hash-object` on individual pre-existing records in addition to the full manifest
  diff.
- **No generated JSON was hand-edited at any point.**
- **Raw transcript content was never read in this report.** Every structural claim above (post-signal
  tool-call categories, phase, policy-decision, result-status) is read from the committed `audit/`
  sidecar's own closed-vocabulary fields, never from the gitignored raw transcript. No command text,
  assistant reasoning, or tool-result body appears anywhere in this report.

## Explicit limitations and disclosures

- **`n=2` per scenario, not a benchmark.** No statistical claim follows from 2 repetitions per
  condition, in any of the three canaries run so far. `benchmark_eligible:true` is a
  protocol/integrity statement, never a correctness or performance one.
- **Model nondeterminism**: `claude-sonnet-5` is not deterministic across invocations even at a
  fixed seed (the harness's own `--seed` controls counterbalancing/ordering, not model sampling) —
  every number above can vary run-to-run for reasons unrelated to any code or skill change.
- **Time separation**: the schema-v4 batch ran 2026-07-25; this batch ran 2026-07-26 — a 1-day gap.
- **Harness/schema changes across the gap**: 5 PRs (#393–#397) landed on `develop` between the two
  batches, including a run-record schema bump (v4→v5, adding `post_signal_ms`,
  `post_signal_tool_calls`, `policy_denials_before_first_signal`, `policy_denials_after_first_signal`,
  and `accepted_audit`) and the Decision-protocol skill rewrite (PR #395) that is this canary's own
  object of measurement — the harness computing this run's evidence is not byte-identical to the
  harness that computed the v4 evidence.
- **Skill-pin change**: `current-skill` pin moved from `6d45dde88956ad33f0725b863e8fff8960c1fc07`
  (v4) to `9e47a9d132f5b9ea6ac5bc50a66c844458fd363e` (v5, PR #395's evidence-driven Decision
  protocol) — this is the actual object of this canary, and it is confounded with every other
  difference listed here, not isolated from them.
- **Claude Code CLI version did not change** between the two batches (`2.1.218` both times) — one
  fewer confound than the v3→v4 comparison had.
- **New v5 metrics are only meaningfully non-null on cells that reached a first-useful-signal
  boundary** — 2 of the 8 new cells (both scenario 2 `current-skill`). The other 6 correctly carry
  `value:null, reason:"no first useful signal boundary"`; this is not a data gap, it is the accurate
  reflection of those cells never producing accepted terminal evidence.
- **`no-skill` is a skill-ablation arm under the identical narrow scenario policy, not an
  unrestricted-agent baseline.** Both conditions operate under the same
  `allowed_gradle_tasks`/`allowed_kmptest_subcommands` policy; the only difference is skill
  availability. A `no-skill` cell's 100% denial rate reflects the agent exploring outside that
  narrow policy without the skill's guidance — not a claim about what an unrestricted agent would do.
- **Stable measurement scope makes captures comparable; hard-partition fields correctly prevent
  invalid pooling.** All three canaries (v3, v4, v5) share the identical non-secret scope id
  `4b9913f9-3c28-4fd9-afc2-275613b66520`, which is what makes this report's cross-batch comparison
  meaningful at all — but `schema`, `skill_source_sha`, and `claude_code_version` (all
  `HARD_PARTITION_FIELDS` entries) correctly keep the three batches in separate aggregate groups
  regardless of the shared scope, exactly as intended.
- **No statistical significance, general speedup, token savings, unrestricted-agent superiority, or
  product-quality claim is made anywhere in this report.** Every numeric comparison above is
  presented as a directional observation at `n=2`, explicitly confounded by the items above.
- **Failures are preserved without smoothing**: 6 of the 8 new cells are honest `success:false` —
  more than the v4 batch's 3 of 8 — disclosed in full in the per-scenario tables above, none hidden,
  softened, or excluded. Scenario 1's `current-skill` regression (1-of-2 → 0-of-2) and scenario 2's
  `current-skill` efficiency regression (fewer allowed calls/less wall time in v4 vs. more in v5) are
  both stated plainly above, not downplayed.
- Every numeric value in this report's tables was read directly from the corresponding record's own
  JSON field (or, for the two post-signal narrative details, the corresponding committed `audit/`
  sidecar's own structural fields) in this session — none invented, estimated, or hand-derived
  without a corresponding source field.

## Recommended next action

Unlike the v3→v4 comparison (which found no detected regression), this canary's raw counts show a
real directional shift worth a closer look before further skill iteration:

1. **Scenario 1's `current-skill` success dropped from 1-of-2 to 0-of-2** under the new
   evidence-driven Decision protocol (PR #395), with the two new failures split evenly between a
   correctness failure (wrong module, real evidence — same kind as v4's own failure) and a new
   policy-denial failure (100% Bash denial despite `skill_invoked:true`, a failure kind not seen in
   this scenario's `current-skill` arm before). At `n=2` this is not proof of a regression, but it is
   also not nothing — a qualitative read of `scenario-current-skill-08d5daaa` and
   `scenario-current-skill-27d0c3c6`'s own committed `audit/` sidecars (or, if deeper investigation
   is warranted, the local raw transcripts) against the new Decision protocol's own module-selection
   logic would be the natural next step, independent of this canary's own scope.
2. **Scenario 2's `current-skill` cells still both succeeded, but used more allowed calls and more
   wall time than the v4 batch** (8 vs. 6 allowed calls; ~238s vs. ~208s summed). The new
   `post_signal_tool_calls`/`post_signal_ms` metrics now make a concrete part of this visible
   directly from committed evidence: `scenario-current-skill-ccff419c` made 2 additional tool calls
   (one denied) after already reaching its terminal evidence. Whether this reflects the new Decision
   protocol doing more verification work, or ordinary run-to-run variance, is not resolvable at
   `n=2` — worth re-examining with a larger `n` before drawing any conclusion.
3. **The accepted-run-observability sidecars (PR #396) worked end-to-end on their first live outing**
   in this canary — all 8 sidecars built, validated, cross-validated, and independently re-hashed
   cleanly, and the 2 cells with a real signal boundary produced coherent, non-trivial post-signal
   data. No harness defect was found in this new machinery.

No hard-gate, integrity, provenance, decision-attribution, JUnit-attribution, privacy, or budget
ambiguity occurred at any point in this session (the one infrastructure-level Docker/WSL2 wedge was
confined entirely to the zero-cost local-CI preflight, before any live session spend, and is
disclosed factually above). No harness, skill, policy, or scenario defect was found. This
evidence-only PR does not fix, tune, or otherwise change any harness, skill, policy, or scenario
file.

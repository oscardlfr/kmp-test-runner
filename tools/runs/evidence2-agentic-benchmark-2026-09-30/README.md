# Evidence2 agentic benchmark — Claude Code vs Codex CLI, product-assisted vs free-baseline (anchor scenario only)

Campaign completed 2026-09-30 (window 2026-09-29T23:44:38Z – 2026-09-30T01:25:10Z, all times UTC).

## Summary

**Primary metric.** Both runtimes matched the key facts in all 16 campaign sessions -- 16/16 overall,
4/4 per runtime per arm, with and without kmp-test alike. All 10 harness states finished PASS and all
16 sessions were accepted (0 rejected, 0 missing), matching Evidence1's own ceiling exactly. 0 of the
16 cells were flagged infra-flake-suspected by `infra-flake-classifier.mjs` (D13), so the Sensitivity
table in Results below is identical to the primary aggregate table -- not because the check was
skipped, but because it found nothing to exclude.

**Efficiency (median per session, with kmp-test vs without).** Claude Code: 4.5 vs 13 tool calls, 3.5
vs 3.8 min wall-clock, an estimated $0.08–$0.20 vs $0.14–$0.24 API cost. Codex CLI: 3 vs 13 tool
calls, 4.5 vs 4.7 min wall-clock, an estimated $0.09–$0.22 vs $0.13–$0.31 API cost. Descriptively, at
matched `high` reasoning effort (Amendment A7): with kmp-test, Codex's median tool-call count (3) was
lower than Claude's (4.5, n=4 each); without kmp-test both medians were 13. Medians and ranges only --
no ratio, no significance test, no "faster"/"better" language (see "What this benchmark does NOT
measure" below); `num_turns` is excluded from this comparison entirely per Amendment A9.

**Caveat.** Full-answer match is 4/4 for both runtimes' product arm and 0/4 for both runtimes' free
arm. This is **not** a capability gap: all 8 free-arm sessions (both runtimes) reported a defensible,
differently-scoped count (the scenario's 2 distinct `@Test` methods) against a grading field defined
as the 4 total executions across build variants -- see "Full-answer match: why the gap is
definitional" below; the gap must never be read as a capability result for either arm. Separately,
product-protocol success (a stricter, product-arm-only check) was 3/4 for each runtime, for two
distinct, non-overlapping reasons -- see "Protocol checks: structural vs real" below; both misses
kept a correct final answer. n=4 per cell is not a statistically powered sample, and the primary
metric is at ceiling in both arms, so this design cannot distinguish a product effect from a
free-baseline effect at this n (see Limitations).

Known in advance (D1-D13 plus Amendments A7 and A9, not placeholders):
- **Runtimes**: Claude Code (`claude-sonnet-5`, reasoning effort `high`) and Codex CLI
  (`gpt-5.6-terra`, reasoning effort `high` — **equalized by Amendment A7**, decided with the user
  before any campaign session; Codex ran the canary's own pre-A7 cells at `low`, see the canary
  note below).
- **Scenario**: `coverage-threshold-failure-v2` only — **D3, anchor only**. Both held-out scenarios
  (`nowinandroid-core-common`, `deterministic-unit-test-failure`) are explicitly deferred to a
  future v2.1, each for a specific verified provisioning-gap reason (see
  `evidence2-preregistration.md` §2), not a blanket deferral.
- **Design**: 4 repetitions per runtime per arm, counterbalanced AB/BA/BA/AB order on arm — 8 cells
  per runtime, 16 cells total (**D8**). Preceded by a 4-session canary (1 cell per runtime per arm),
  reported separately, never pooled into the campaign's own n=4/arm/runtime. Live ceiling 24 total,
  matching Evidence1's own ceiling exactly.
- **New vs Evidence1 — D7**: runtime dispatch order now alternates first-mover per round
  (`evidence1-run.ps1` / `evidence1-run-manifest-contract.psm1`'s
  `Get-E1RunManifestExpectedCells`) — round 0 claude-code-first, round 1 codex-cli-first, etc.
  Every prior campaign, including Evidence1's own, ran Claude first every round without exception;
  this closes MEDIUM-LOW threat item 6 from Evidence1's own controls-audit (order not fully
  counterbalanced).
- **New vs Evidence1 — D2, amended by A7**: reasoning effort is recorded per cell for the first
  time (`reasoning_effort_requested`/`reasoning_effort_source`, schema v9), closing Evidence1's own
  disclosed A3 gap (Claude: UNCONTROLLED in Evidence1's controls-audit; both runtimes now
  SET-and-RECORDED). D2 as originally preregistered set Claude `high` / Codex `low`, with a
  restriction that no cross-runtime comparison be drawn from the two mismatched labels. **Amendment
  A7** (decided with the user, before any campaign session) equalized both to `high` instead — a
  comparison at mismatched effort levels isn't meaningful, and the user wants Claude and Codex
  compared against each other — and correspondingly lifted that restriction specifically for a new,
  descriptive, same-arm, same-metrics comparison (see Summary above). Claude was already `high`
  (its documented default); only Codex's registry entry changed, `low`→`high`. This does not make
  the two labels mean the same effective thing across two different products mechanically — that
  qualifier stands; only the blanket "no comparison at all" restriction is lifted, and only for the
  specific descriptive comparison A7 defines.
- **Amendment A9 — `num_turns` struck from the cross-runtime comparison.** A7 §3 originally listed
  turns among the metrics compared descriptively across runtimes. Canary 2's own real data showed
  why that isn't meaningful: Codex reports `num_turns: 1` on every cell, by construction of how
  Codex CLI's own result event counts turns (one non-interactive session, one reported turn);
  Claude reports assistant turns within the session (`5` and `12` in canary 2). This is not a
  capability difference the study measures — it is two runtimes defining "turn" differently at the
  CLI level. `num_turns` is reported per runtime only, never compared, everywhere in this document
  and its generated tables. Every other metric A7 §3 lists (key facts, tool calls by kind,
  wall-clock duration, tokens, cost) is unaffected.
- **Amendment A9 — cost is estimated from tokens for both runtimes.** Canary 2 confirmed D12's
  token-based estimate is the campaign's real, live cost path, not a fallback used for one runtime
  and real billing for the other: `total_cost_usd` came back `null` for every cell on both runtimes
  (Claude: not present on this runtime's result event schema, under OAuth; Codex: no cost reporting
  on this event). `cost-estimate.mjs`'s published per-token pricing is therefore the primary and
  only cost figure for both runtimes; Codex's own uncached-input range caveat (D12, see Threats to
  validity) still applies on top of that.
- **New vs Evidence1 — D4 (isolation guarantee)**: the scenario's own `expected` block is no longer
  present anywhere on the guest filesystem, for any cell, in either arm — closing the HIGH-severity
  item 1 from Evidence1's own controls-audit (ground truth present in plain JSON on the guest,
  unverifiable). Verified per-cell before dispatch by `tools/agentic-eval/isolation-probe.mjs`,
  blocking dispatch on failure (recorded as a harness-integrity failure, a new category distinct
  from accepted/rejected/missing).
- **Product under measurement — D1/D11**: kmp-test-runner `0.16.0` candidate (PR #534's envelope
  schema 3, `contracts.coverage_evidence`), baseline PR #537 merged into the eval branch. Re-merge
  only if PR #537's product code changes before canary or campaign actually run (D11).

## Scope

This document covers the Evidence2 canary and campaign results for the single anchor scenario
(`coverage-threshold-failure-v2`, D3) under Amendment A7's equalized-effort design, refined by
Amendment A9 (`num_turns` excluded from the cross-runtime comparison; cost estimated from tokens
for both runtimes, not just Codex — see Summary above). It is explicitly **not** a re-run or
superset of Evidence1 — a different harness commit and the D2 (amended by A7/A9)/D4/D7 design
changes above mean no cross-campaign (Evidence1-vs-Evidence2) comparison is drawn on any metric
those changes could plausibly affect (reasoning effort itself and anything tokens/duration-sensitive
to it; the isolation-guarantee change; dispatch order) — only on what is genuinely unchanged between
the two closures. It does **not** cover the two
held-out scenarios (`nowinandroid-core-common`, `deterministic-unit-test-failure`), both explicitly
deferred to a future v2.1 for specific, verified reasons (§2 of the preregistration), not measured
here in any form. It reports the canary (4 sessions, pipeline validation only, never pooled with
campaign data) and the campaign (16 sessions, D8) separately, per the same standing rule Evidence1
used.

## Design (D1-D13, Amendment A7)

Full text: `docs/audits/evidence2-preregistration.md` §1 (Design), §4 (Models), and its own
Amendments section (A1-A8 as of this campaign; A7 is the substantive design change, A1-A6 and A8
are corrections/operational notes made before or during the canary sequence, none changing what is
measured). Locked before any live session; any change after the GREEN gate is a documented,
committed amendment, never a silent edit.

- Two runtimes, two arms, **one scenario** (D3), **n=4** reps per cell — matching Evidence1's own
  shape exactly.
- Counterbalanced on two independent axes: arm order within each runtime's repetition sequence
  (unchanged mechanism), and **D7** — runtime dispatch order alternating first-mover per round
  (new, see Summary above).
- **D8** — size: n=4/cell, canary 4 sessions, campaign 16 sessions, live ceiling 24. One canary
  repeat permitted (only after a deterministic fix); zero campaign retries, no cell replacement.
- **D1/D11** — product baseline: kmp-test-runner 0.16.0 candidate, re-merge policy as stated above.
- **D2, amended by A7** — reasoning effort: both runtimes `high` (originally Claude `high` / Codex
  `low`; equalized by A7, decided with the user, before any campaign session — a mismatched-effort
  comparison isn't meaningful and the user wants the two runtimes compared against each other),
  both pinned and recorded (closes Evidence1's A3 gap — see Experimental controls below). A7 also
  adds a descriptive within-arm cross-runtime comparison to the analysis plan (see Summary).
- **D4** — isolation guarantee (new section vs Evidence1, no equivalent there): ground truth split
  host-side/guest-side at materialization time; verified per-cell pre-dispatch.

**Linking to Evidence1's own controls-audit A1-A3** (the 3 highest-relevance prior findings this
design directly responds to):
- **A1 (model id)** — Evidence1: CONTROLLED but Codex's `model_resolved` is an echo, not an
  independent observation. Evidence2: unchanged mechanism (D1 pins the alias, not a dated
  snapshot) — this gap is NOT closed by Evidence2's design; still worth stating as a carried-over
  limitation, not silently dropped.
- **A2 (alias vs pinned snapshot)** — Evidence1: UNCONTROLLED-VARIABLE, no snapshot pin exists for
  either runtime. Evidence2: also unchanged — same limitation carries over; D1/D11 pin a product
  *version*, not a served model snapshot.
- **A3 (reasoning effort)** — Evidence1: Claude UNCONTROLLED (not set, value unestablished), Codex
  SET-NOT-RECORDED. Evidence2: **closed by D2, amended by A7** — both runtimes now SET-and-RECORDED
  at the same value (`high`), not just SET-and-RECORDED at two different values as originally
  preregistered. This is the one of the three Evidence2's design actually changes; A1 and A2 are
  inherited limitations, not oversights — state that distinction explicitly when this section is
  filled in for real, rather than implying all three were "fixed."

## Scenario

`coverage-threshold-failure-v2` (D3, anchor only). Unchanged from Evidence1 for direct
comparability, except **D5**'s requested-field rename (`total` → `test_count`, closing the
`total`-ambiguity H15 class of failure — see Metric definitions) — expected values and policy
allowlists otherwise unchanged; ground truth itself moved host-side-only per D4.

- Project: NowInAndroid (`android/nowinandroid`), pinned commit `7d45eae4f8720a0c77f507712ba2437ff974b6ed`.
- Target module: `:core:domain`.
- Ground truth: `outcome_kind: coverage_threshold_exceeded`, `missed_lines: 23`, `threshold: 15`,
  `modules_contributing: 1`. Real test count 4 (kmp-test `individual_total` and Gradle
  `tests.total`/`passed` agree).
- Tagged `train`: the skill was tuned against this scenario family — stated as a limitation, not
  concealed (same disclosure Evidence1 made).

## Methods

Sessions ran on harness commit `c15aae3` (full SHA `c15aae3daf1ff9428c3d88e336047d3baf042717`, per
this campaign's own `provenance.repo_commit`), inside the same isolated-VM / restricted-network
environment Evidence1 used, with Amendment A9's host-quiescence discipline applied to the campaign's
own LiveRunning window (not just canary 2). `claude-code` 2.1.238 (`claude-sonnet-5`) and `codex-cli`
0.154.0 (`gpt-5.6-terra`) both ran at reasoning effort `high` (Amendment A7, both
SET-and-RECORDED per cell); dispatch order alternated first-mover per round (D7) and arm order was
counterbalanced AB/BA/BA/AB, exactly as pre-registered. Known in advance, not placeholders:

- Treatment texts are **byte-identical to Evidence1's** (Amendment A1 in the preregistration
  confirms this explicitly) for both runtimes' product-arm wrapper text; the free-arm prompt
  differs from Evidence1's only by D5's field rename.
- New: the actual delivered, post-treatment prompt is hashed per cell (`delivered_prompt_sha256`,
  schema v9) — Evidence1 only ever hashed the pre-treatment prompt.
- **D9** — classifier: `command-classify.mjs`'s tool-kind classifier is fixed from the canary's own
  real recorded commands (`executed_commands`, schema v9), then frozen before the campaign runs;
  the frozen version is recorded in the campaign's own analysis output.
- Analysis commands (D-linked, not placeholders): `node tools/agentic-eval/campaign-summary.mjs
  <campaign-dir>`, `node tools/agentic-eval/cost-estimate.mjs <campaign-dir>` (schema-2
  `cost-estimate.json`, D12 — see Threats to validity below for the Codex cost-bound caveat this
  produces), and `node tools/agentic-eval/evidence2-tables.mjs <campaign-dir>` (produces this
  document's own Results tables mechanically — the "generated by" comment on the marker block below
  names the exact generator; never hand-edit between the markers). All three share cell selection
  via the exported `loadCountedCellTokens`/`summarizeCampaign` so none can silently disagree with
  another about which cells count.
- Gate validation (no-provider mechanism check, not benchmark data, same pattern as Evidence1's own
  "Gate validation" section): GREEN gate `bb236210` (harness `86359b3`) PASS; GREEN gate `dc9f5da7`
  (harness `c1cd938`, the fix that closed canary 1's transport failure -- see the canary note in
  Results below) PASS; post-campaign GREEN gate `339dc895` (harness `c5a7fa6`, the published harness,
  real VM backends) PASS 10/10. A fully fake-backend run `fd237811` (harness `aacce12`) also reached
  `Closed`, as an extra mechanism check.
- **Amendment A9 — cost method confirmed live, not hypothetical.** Canary 2 showed `total_cost_usd`
  comes back `null` for every cell on both runtimes under this harness (Claude: not present on this
  runtime's result event schema, under OAuth; Codex: no cost reporting on this event) — D12's
  token-based estimate (`cost-estimate.mjs`) is therefore the campaign's actual, primary cost
  figure for both runtimes, not a fallback exercised for one and bypassed by real billing for the
  other.
- **Amendment A9 — host quiescence during LiveRunning.** No heavy host workload (a full gate run,
  Docker, a full vitest/Pester suite) ran during canary 2's own LiveRunning window — confirmed from
  the session's own action log, not inferred. The campaign's own LiveRunning window is held to the
  same discipline: any concurrent harness work runs in a separate worktree, single-file test runs
  only, no full suite until LiveRunning completes — so wall-clock duration and the provider/worker
  timeout budgets stay uncontaminated by host contention neither runtime's own numbers are meant to
  reflect.

## Results

<!-- evidence2-tables:start (generated by tools/agentic-eval/evidence2-tables.mjs -- edit the generator, not this block) -->

## Evidence2 results (mechanically generated -- do not hand-edit; see evidence2-tables.mjs)

Campaign: `48458826-2386-4e4d-a93f-01641f44253c`. Scenario: `coverage-threshold-failure-v2`.

### Per-cell detail

| runtime | arm | round | status | key facts | full answer | success | duration ms | tool calls | shell commands | tokens | turns | cost | infra-flake |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| claude-code | free | 1 | accepted | yes | no | n/a | 235198 | 11 | kmp-test 0, gradle 4, other 7 | uncached input 24, cache read 247484, cache write 26063, output 2848 | 12 | $0.1627 (estimate: midpoint of low/high) | false |
| claude-code | free | 2 | accepted | yes | no | n/a | 226060 | 15 | kmp-test 0, gradle 3, other 12 | uncached input 30, cache read 385398, cache write 28350, output 4638 | 16 | $0.2157 (estimate: midpoint of low/high) | false |
| claude-code | free | 4 | accepted | yes | no | n/a | 242222 | 11 | kmp-test 0, gradle 4, other 7 | uncached input 24, cache read 256773, cache write 25730, output 3067 | 12 | $0.1657 (estimate: midpoint of low/high) | false |
| claude-code | free | 7 | accepted | yes | no | n/a | 219910 | 15 | kmp-test 0, gradle 3, other 12 | uncached input 32, cache read 345019, cache write 27463, output 4280 | 16 | $0.2011 (estimate: midpoint of low/high) | false |
| claude-code | product | 0 | accepted | yes | yes | yes | 209736 | 6 | kmp-test 5, gradle 0, other 0 | uncached input 14, cache read 150102, cache write 20487, output 2077 | 8 | $0.1174 (estimate: midpoint of low/high) | false |
| claude-code | product | 3 | accepted | yes | yes | yes | 212069 | 3 | kmp-test 2, gradle 0, other 0 | uncached input 8, cache read 76828, cache write 23048, output 1191 | 5 | $0.1022 (estimate: midpoint of low/high) | false |
| claude-code | product | 5 | accepted | yes | yes | yes | 193550 | 3 | kmp-test 2, gradle 0, other 0 | uncached input 8, cache read 76860, cache write 23292, output 1459 | 5 | $0.1057 (estimate: midpoint of low/high) | false |
| claude-code | product | 6 | accepted | yes | yes | no | 246625 | 15 | kmp-test 3, gradle 0, other 11 | uncached input 32, cache read 376942, cache write 22083, output 3664 | 17 | $0.1839 (estimate: midpoint of low/high) | false |
| codex-cli | free | 1 | accepted | yes | no | n/a | 216438 | 9 | kmp-test 0, gradle 2, other 7 | uncached input 32987, cache read 264960, output 1962, reasoning 909 | 1 | $0.1617 (estimate: midpoint of low/high) | false |
| codex-cli | free | 2 | accepted | yes | no | n/a | 351430 | 17 | kmp-test 0, gradle 3, other 14 | uncached input 41918, cache read 504320, output 3817, reasoning 1696 | 1 | $0.2613 (estimate: midpoint of low/high) | false |
| codex-cli | free | 4 | accepted | yes | no | n/a | 336129 | 23 | kmp-test 0, gradle 1, other 22 | uncached input 48694, cache read 599040, output 4159, reasoning 1301 | 1 | $0.2949 (estimate: midpoint of low/high) | false |
| codex-cli | free | 7 | accepted | yes | no | n/a | 223308 | 7 | kmp-test 0, gradle 2, other 5 | uncached input 28410, cache read 194048, output 1583, reasoning 966 | 1 | $0.1333 (estimate: midpoint of low/high) | false |
| codex-cli | product | 0 | accepted | yes | yes | yes | 310918 | 3 | kmp-test 3, gradle 0, other 0 | uncached input 21763, cache read 179712, output 833, reasoning 1765 | 1 | $0.1161 (estimate: midpoint of low/high) | false |
| codex-cli | product | 3 | accepted | yes | yes | yes | 415433 | 16 | kmp-test 4, gradle 0, other 12 | uncached input 30337, cache read 364288, output 2435, reasoning 3126 | 1 | $0.2078 (estimate: midpoint of low/high) | false |
| codex-cli | product | 5 | accepted | yes | yes | no | 224954 | 3 | kmp-test 3, gradle 0, other 0 | uncached input 20671, cache read 152576, output 693, reasoning 716 | 1 | $0.0939 (estimate: midpoint of low/high) | false |
| codex-cli | product | 6 | accepted | yes | yes | yes | 207986 | 3 | kmp-test 3, gradle 0, other 0 | uncached input 20147, cache read 147456, output 721, reasoning 1435 | 1 | $0.1007 (estimate: midpoint of low/high) | false |

### Runtime × arm aggregates

| runtime | arm | key facts | full answer | success (product only) | duration ms | tool calls | shell commands by kind (median) | tokens by type (median) | turns |
|---|---|---|---|---|---|---|---|---|---|
| claude-code | free | 4/4 | 0/4 | n/a | median 230629, min 219910, max 242222 (n=4) | median 13, min 11, max 15 (n=4) | kmp_test 0, gradle 3.5, other 9.5 | uncached_input 27, cache_read 300896, cache_write 26763, output 3673.5 | median 14, min 12, max 16 (n=4) |
| claude-code | product | 4/4 | 4/4 | 3/4 | median 210902.5, min 193550, max 246625 (n=4) | median 4.5, min 3, max 15 (n=4) | kmp_test 2.5, gradle 0, other 0 | uncached_input 11, cache_read 113481, cache_write 22565.5, output 1768 | median 6.5, min 5, max 17 (n=4) |
| codex-cli | free | 4/4 | 0/4 | n/a | median 279718.5, min 216438, max 351430 (n=4) | median 13, min 7, max 23 (n=4) | kmp_test 0, gradle 2, other 10.5 | uncached_input 37452.5, cache_read 384640, output 2889.5, reasoning 1133.5 | median 1, min 1, max 1 (n=4) |
| codex-cli | product | 4/4 | 4/4 | 3/4 | median 267936, min 207986, max 415433 (n=4) | median 3, min 3, max 16 (n=4) | kmp_test 3, gradle 0, other 0 | uncached_input 21217, cache_read 166144, output 777, reasoning 1600 | median 1, min 1, max 1 (n=4) |

### Sensitivity (infra-flake-suspected cells excluded)

Excluded cells: none.

| runtime | arm | key facts | full answer | success (product only) | duration ms | tool calls | shell commands by kind (median) | tokens by type (median) | turns |
|---|---|---|---|---|---|---|---|---|---|
| claude-code | free | 4/4 | 0/4 | n/a | median 230629, min 219910, max 242222 (n=4) | median 13, min 11, max 15 (n=4) | kmp_test 0, gradle 3.5, other 9.5 | uncached_input 27, cache_read 300896, cache_write 26763, output 3673.5 | median 14, min 12, max 16 (n=4) |
| claude-code | product | 4/4 | 4/4 | 3/4 | median 210902.5, min 193550, max 246625 (n=4) | median 4.5, min 3, max 15 (n=4) | kmp_test 2.5, gradle 0, other 0 | uncached_input 11, cache_read 113481, cache_write 22565.5, output 1768 | median 6.5, min 5, max 17 (n=4) |
| codex-cli | free | 4/4 | 0/4 | n/a | median 279718.5, min 216438, max 351430 (n=4) | median 13, min 7, max 23 (n=4) | kmp_test 0, gradle 2, other 10.5 | uncached_input 37452.5, cache_read 384640, output 2889.5, reasoning 1133.5 | median 1, min 1, max 1 (n=4) |
| codex-cli | product | 4/4 | 4/4 | 3/4 | median 267936, min 207986, max 415433 (n=4) | median 3, min 3, max 16 (n=4) | kmp_test 3, gradle 0, other 0 | uncached_input 21217, cache_read 166144, output 777, reasoning 1600 | median 1, min 1, max 1 (n=4) |

### Provenance and controls

- repo_commit: c15aae3daf1ff9428c3d88e336047d3baf042717
- skill_source_sha: 27c943dc392675f78209a78ce09adb4f79283e3e
- kmp_test_cli_version: 0.16.0
- kmp_test_cli_source_sha: c15aae3daf1ff9428c3d88e336047d3baf042717
- claude-code CLI version: 2.1.238
- claude-code model_resolved: claude-sonnet-5
- claude-code reasoning_effort (requested): high
- claude-code reasoning_effort_source: harness-pinned-cli-flag
- codex-cli CLI version: 0.154.0
- codex-cli model_resolved: gpt-5.6-terra
- codex-cli reasoning_effort (requested): high
- codex-cli reasoning_effort_source: model-registry-default-reasoning-mode

### Cost

| runtime | arm | low | high | pricing source | retrieved |
|---|---|---|---|---|---|
| claude-code | product | $0.0849 | $0.2004 | https://platform.claude.com/docs/en/about-claude/pricing | 2026-09-29 |
| claude-code | free | $0.1432 | $0.2369 | https://platform.claude.com/docs/en/about-claude/pricing | 2026-09-29 |
| codex-cli | product | $0.0888 | $0.2154 | https://developers.openai.com/api/docs/pricing | 2026-09-29 |
| codex-cli | free | $0.1262 | $0.3071 | https://developers.openai.com/api/docs/pricing | 2026-09-29 |

<!-- evidence2-tables:end -->

Canary (4 sessions, pipeline validation only, never pooled into the campaign's own n=4/arm/runtime)
reported separately from the campaign above, same standing rule as Evidence1. Canary 1 (`bcf3c82c`,
harness `86359b3`, Codex effort `low`, pre-Amendment-A7) **FAILED**: claude round 0 (product) was
rejected by the product-access preflight (OAuth 401, zero usage); codex round 0 (product) was
accepted; both free-arm cells transport-failed on a grader-vocabulary mismatch (`'total'` vs
`'test_count'`), fixed forward in harness commit `c1cd938` (Amendment A8). Canary 2 (`4ec724d9`,
harness `1f00eb5`) **PASSED** afterward, under the A7-amended (`high`/`high`) effort registry: 4/4
accepted (Amendment A9). Only canary 2 validated the pipeline actually used for the campaign above;
canary 1's failure is reported here for the record, not silently dropped.

## Full-answer match: why the gap is definitional

The Runtime × arm aggregates table above shows full-answer match at 4/4 for both runtimes' product
arm and 0/4 for both runtimes' free arm. **This is a construct gap in the grading field, not a
free-arm capability failure, and must never be presented as a capability win for the product arm or
a capability loss for the free arm.**

**Construct caveat.** The scenario's target module, `:core:domain`, has exactly 2 `@Test` methods
(`GetFollowableTopicsUseCaseTest`). Those 2 methods each run in 2 Gradle build variants
(`testDemoDebugUnitTest`, `testProdDebugUnitTest`), for 4 total test executions. D5's grading checks
the agent-reported `test_count` field against kmp-test's own `individual_total` field, which counts
executions (4) — while the scenario prompt asks for "the number of individual test methods that
ran," wording a reader can equally reasonably parse as the count of distinct methods (2). All 8
free-arm sessions (both runtimes, 4 cells each) reported `test_count` (and `passed`) as 2 — a
defensible, internally consistent reading of the prompt's own wording, not a wrong or careless
answer. The product arm does not show this gap (4/4 full-answer match, both runtimes) because a
kmp-test invocation hands the agent `test_count`/`passed` as raw executions directly; the product
arm's agents never had to choose a counting convention themselves.

**Per field: free-arm reported vs. grading-expected (8/8 free-arm cells, both runtimes, unless noted
otherwise).**

| field | grading-expected | free-arm reported | note |
|---|---|---|---|
| `outcome_kind` | `coverage_threshold_exceeded` | `coverage_threshold_exceeded` | matched, 8/8 |
| `test_count` | 4 (`individual_total`: executions across 2 build variants) | 2 (distinct `@Test` methods) | construct gap — see caveat above, 8/8 |
| `passed` | 4 | 2 | same construct gap as `test_count`, 8/8 |
| `failed` | 0 | 0 | matched, 8/8 |
| `missed_lines` | 23 | 23 | matched, 8/8 |
| `threshold` | 15 | 15 | matched, 8/8 |
| `modules_contributing` | 1 | claude-code free arm (n=4): 3 of 4 cells reported 2, not 1. codex-cli free arm: not separately characterized in this pass. | partial — claude-code only |
| module identifier | `:core:domain` (leading colon) | claude-code free arm (n=4): 2 of 4 cells omitted the leading `:`. codex-cli free arm: not separately characterized in this pass. | partial — claude-code only |

See `BACKLOG.md` for a queued follow-up: define the ground-truth count field independently of the
product's own counting convention (distinct methods vs. executions), or align the prompt's wording to
whichever field the grader actually checks.

## Protocol checks: structural vs. real

Several automated protocol checks in the grading pipeline behave differently by construction,
independent of what any agent actually did — separated out explicitly so a structural artifact of a
check's own definition is never read as a behavioral finding about either arm.

- **Structural (fail by construction in the free arm, not a behavioral finding).** The four
  `authoritative_*` checks and `final_answer_consistent_with_evidence` fail for every free-arm cell,
  both runtimes. For this scenario (`coverage_threshold_exceeded`), only a kmp-test attempt can be
  the terminal action these checks require (`tools/agentic-eval/graders.mjs:840-842`); the free arm
  never invokes kmp-test by design — that is the entire point of the arm — so these checks cannot
  pass there regardless of answer quality.
- **Real (a genuine per-cell difference).** `bash_tool_use_present` is determined by an exact-name
  Gradle-task allowlist and varies for real reasons across free cells: 3 of the 8 free cells used an
  allowlisted task name, 5 did not. Unlike the structural checks above, this one is not
  fail-by-construction and does reflect what each session actually ran.
- **Product-protocol success (product arm only; a stricter check than key-facts or full-answer
  correctness).** 3/4 for each runtime, for two distinct, non-overlapping reasons: `claude-code-6`
  had no qualifying terminal kmp-test attempt despite reaching a correct final answer;
  `codex-cli-5`'s kmp-test envelope was malformed (a result/status contradiction) despite also
  reaching a correct final answer. Both are protocol-adherence misses, not answer-correctness misses
  — both cells' key-facts and full-answer match are `true` in the per-cell table above.

## What this benchmark does NOT measure

Mirrors Evidence1's own section of the same name, carried forward, plus what's new to Evidence2's
own design:

- **Generalization beyond this one anchor scenario.** `coverage-threshold-failure-v2` only (D3);
  no claim is made, implied, or should be inferred about either runtime's behavior on any other
  task, scenario family, or codebase.
- **A cross-runtime ranking or "winner."** Even with effort equalized (A7), the within-arm
  Claude-vs-Codex comparison this campaign adds is descriptive only — medians and ranges, no
  significance test, no ratio, no "faster"/"better" language. It is a comparison of two products at
  matched effort, not a claim that `high` means the same effective thing mechanically across two
  different products (see Design above).
- **A cross-runtime comparison of `num_turns` (Amendment A9).** Claude counts assistant turns;
  Codex reports exactly one user turn per non-interactive session by construction. These measure
  different things, not the same thing at different rates — turns is reported per runtime only,
  everywhere in this document, never presented side by side.
- **The two held-out scenarios' capability.** `nowinandroid-core-common` and
  `deterministic-unit-test-failure` are explicitly deferred to v2.1 (§2 of the preregistration,
  each for a specific verified reason) — this benchmark says nothing about either.
- **A comparison against Evidence1's own numbers.** See Scope above — different harness commit,
  different (amended) reasoning-effort design, different isolation guarantee, different dispatch
  order. Any single metric that is genuinely unaffected by those changes may be compared; nothing
  else should be.

## Threats to validity

Full detail: a dedicated controls audit (2026-09-30, read-only against the measured checkout,
harness commit `c15aae3`) is published alongside this document as
[`controls-audit.md`](./controls-audit.md). This section distills that audit's own findings, same
convention as Evidence1's README.

Known in advance, stated now so the shape is right when real numbers land:

- **Environment flake, both tallies: 0 and 0.** `infra-flake-classifier.mjs` (D13) classified all 16
  campaign cells directly from their raw transcripts: 0 were flagged infra-flake-suspected (an
  infra-level failure indistinguishable from a real result before being caught), and consequently 0
  were excluded or retried under D8's own no-retry-no-replacement rule. This "0 flakes" claim carries
  the same evidentiary weight as Evidence1's own detailed H1 writeup: the classifier ran, it produced
  a `rollup` of 0/0/0/0 (flagged/probe_failed_absorbed/probe_failed_unrecovered/unknown) for every one
  of the 4 (runtime × arm) groups, and the Sensitivity table in Results above is mechanically
  identical to the primary aggregate table as a direct consequence (0 cells excluded), not a
  shortcut.
- **Exposure asymmetry (kmp_test_count vs. gradle_count, per runtime × arm, from this campaign's own
  `campaign-summary.json`):**

  | runtime | arm | kmp_test_count | gradle_count |
  |---|---|---|---|
  | claude-code | product | 12 | 0 |
  | claude-code | free | 0 | 14 |
  | codex-cli | product | 13 | 0 |
  | codex-cli | free | 0 | 8 |

  D4 closes the WORST exposure risk (ground truth itself, now host-side only, verified per-cell). It
  does NOT close the softer one Evidence1 also flagged: the skill snapshot and a runnable `kmp-test`
  shim still exist as siblings of the agent's own workspace on every invocation, including free-only
  ones — same `matrix-runner.mjs` mechanism as Evidence1, unchanged by this closure. The
  `kmp_test_count: 0` pattern holds across all 8 free cells, both runtimes (generalized from canary
  to the full campaign n) — a carried-over, not new, limitation.
- **Single scenario (D3, anchor only)** — both held-out scenarios explicitly deferred to v2.1, each
  for a specific verified reason (missing offline Gradle seed dependencies for one, an
  out-of-seed pinned commit needing a network-mutating operation for the other), not a blanket
  deferral. State plainly this design cannot speak to generalization beyond
  `coverage-threshold-failure-v2`.
- **n=4** — not a statistically powered sample, same standing limitation as Evidence1; state
  explicitly that this design cannot distinguish product from free-baseline effects at this n if
  the campaign's own primary metric is at or near ceiling in both arms (as Evidence1's was). The
  same caveat applies to the new within-arm cross-runtime comparison A7 adds (except `num_turns`,
  which Amendment A9 excludes from that comparison entirely — see below, not an n=4 issue).
- **Effort now matched, not a claim of mechanical equivalence (D2, amended by A7)** — both runtimes
  set to `high` and recorded per cell, closing A3 and enabling the descriptive cross-runtime
  comparison above. This is **not** a claim that `high` means the same effective thing across two
  different products mechanically — reasoning-effort labels are provider-defined and not
  independently calibrated against each other. The comparison this enables is descriptive only
  (medians/ranges, no ratio, no significance test) and holds only at each runtime's own `high`
  setting; it is not a generalization to any other effort level for either runtime. (Originally
  preregistered as an asymmetric, deliberately-uncompared design — Claude `high`, Codex `low`; A7
  superseded that specific choice, not the general caution about cross-product effort-label
  comparability.)
- **`num_turns` is not a cross-runtime metric (Amendment A9)** — struck from A7 §3's comparison
  list after canary 2 showed why: Codex reports `num_turns: 1` on every cell, by construction of
  how Codex CLI's own result event counts turns (one non-interactive session, one reported turn);
  Claude counts assistant turns within the session (`5` and `12` observed in canary 2). This is not
  a capability difference under study — it is two runtimes defining "turn" differently at the CLI
  level. Reported per runtime only, in every table and figure in this document; never compared,
  ranked, or ratioed across runtimes.
- **Cost is estimated from tokens for both runtimes (D12, confirmed by Amendment A9)** — canary 2
  showed `total_cost_usd` comes back `null` for every cell on both runtimes under this harness
  (Claude: absent from this runtime's result event schema under OAuth; Codex: no cost reporting on
  this event), so `cost-estimate.mjs`'s token-based estimate is the real, primary cost figure for
  both, not a fallback used for one and bypassed by real billing for the other. On top of that,
  Codex's own uncached-input cost is additionally priced as a RANGE (input rate to cache-write
  rate), not a single number, because gpt-5.6-terra's own billing for uncached input vs cache-write
  is ambiguous at the API level (see the commit closing this — model billing ambiguity). Any
  published Codex cost figure must carry both ends of that range, never a single point estimate
  presented as precise; Claude's estimate is a single figure (no equivalent billing ambiguity for
  that provider).
- **Inherited from Evidence1, not re-audited here unless the controls audit finds otherwise**: A1
  (Codex `model_resolved` is an echo), A2 (alias identity, no snapshot pin for either runtime),
  Gradle `cache_state` label accuracy, project-instruction-file asymmetry (Codex's `AGENTS.md`
  auto-load vs Claude's no-`CLAUDE.md` repo). List each in the real document only after confirming
  it still applies to Evidence2's own harness commit — do not assume carry-over without checking.

## Limitations

Condensed restatement of Threats to validity above (same relationship Evidence1's own Limitations
section has to its own Experimental controls section — a summary, not new content): one anchor
scenario only, n=4 not statistically powered, effort now matched at `high` for both runtimes but
not claimed mechanically equivalent across products, a within-arm cross-runtime comparison is
descriptive only and excludes `num_turns` entirely (Amendment A9 — the two runtimes define "turn"
differently), cost is estimated from tokens for both runtimes (Amendment A9) with Codex's own
uncached-input cost additionally a range rather than a point estimate, A1/A2 inherited from
Evidence1 and uncontrolled, environment flake 0/0 and 0 cells excluded (D13), and the free-arm
exposure asymmetry (`kmp_test_count: 0` across all 8 free cells, both runtimes) carried over
unchanged from Evidence1.

## Reproducibility and availability

Mirrors Evidence1's own Reproducibility section shape:

- Harness commit (canary): `1f00eb5` (canary 2, the passing run that validated the pipeline actually
  used for the campaign; canary 1 ran harness `86359b3`, which Amendment A8 fixed forward to
  `c1cd938` before canary 2 ran).
- Harness commit (campaign): `c15aae3` (full SHA `c15aae3daf1ff9428c3d88e336047d3baf042717`, per this
  campaign's own `provenance.repo_commit`).
- **Parity: measured product == shipped product.** `git diff --quiet c15aae3 <closing branch> -- lib
  bin .skills scripts gradle-plugin package.json .claude-plugin` is empty: the product the campaign
  measured is byte-identical to the product this closing PR ships (tree ids: `lib` e7a82855,
  `bin` 5ac6bf8a, `.skills` 5a9a6418, `scripts` 3afe88b1, `gradle-plugin` 49c93f0f, `.claude-plugin`
  8e0c1b00, `package.json` 44df8d25). The release tag is cut from this PR's squash-merge; the same
  check is repeated against the tag after release.
- Canary / campaign IDs: campaign `48458826-2386-4e4d-a93f-01641f44253c`; canary `4ec724d9` (final,
  PASS, 4/4 accepted). A prior canary `bcf3c82c` failed pre-Amendment-A8 (see the canary note in
  Results above) and is not pooled with either.
- Gate validation campaign IDs (RED/GREEN, mechanism check only, not benchmark data): GREEN
  `bb236210` (harness `86359b3`) PASS; GREEN `dc9f5da7` (harness `c1cd938`) PASS; post-campaign
  GREEN `339dc895` (harness `c5a7fa6`, the published harness, real VM backends) PASS.
- Manifest / analysis commands: `node tools/agentic-eval/campaign-summary.mjs <campaign-dir>`,
  `node tools/agentic-eval/cost-estimate.mjs <campaign-dir>`,
  `node tools/agentic-eval/evidence2-tables.mjs <campaign-dir> --write` (this document).
- `node tools/decouple-audit.mjs` result against this committed bundle: 0 hits (verified 2026-09-30
  against the working tree as committed by this closing pass). Per D10, this needed to be genuinely
  thorough, not a repeat of Evidence1's lighter-touch review, because schema v9's `executed_commands`
  raw-command disclosure is a materially larger public surface than Evidence1 ever published; the
  check covers this document, its Results tables, and the two generator scripts unchanged from this
  pass.
- **Availability**: points at the published harness (same `tools/evidence1/runtime/` relocation
  target and squash-commit-with-no-private-history discipline already proven for Evidence1's own
  two published files — D10) plus the install/run path documented alongside it. Until the harness
  is published, state plainly (as Evidence1's own document does) that the commit-based checks above
  can only be run by maintainers, and the product-code parity result is stated as verified on
  whatever date it's actually checked.

## What gets published (D10)

Runtime code only (not the full harness/broker apparatus), sanitized (email addresses removed,
machine-specific paths genericized), relocated to `tools/evidence1/runtime/`, published as fresh
squash commits with no private history. `node tools/decouple-audit.mjs` clean before publication —
explicitly including the new `executed_commands` (schema v9) raw-command disclosure, which is a
materially larger public surface than Evidence1 ever shipped (Evidence1 never disclosed raw
commands at all).

`CHANGELOG.md` `[Unreleased]` entry (docs/evidence, not a release) — no README "What's new" section
(standing project rule). Any published ratio traces to the same project/campaign capture on both
sides — no cross-project hybridization.

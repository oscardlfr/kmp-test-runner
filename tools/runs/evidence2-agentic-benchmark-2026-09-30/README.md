<!--
Revision 2 (Amendment A9). Both amendments' exact text read directly off
docs/audits/evidence2-preregistration.md on codex/agentic-eval-codex-runtime before writing anything
here, not recalled or paraphrased secondhand -- A9 landed on that branch (2026-09-30, before the
campaign) between revision 1 and this one. A9 corrects A7 S3 (num_turns struck from the
cross-runtime comparison -- Codex always reports num_turns:1 by construction, Claude counts
assistant turns; canary 2 observed 1 vs 5/12), confirms D12's token-based cost estimate is the
campaign's real, live path for BOTH runtimes (total_cost_usd came back null for every canary-2
cell on both runtimes, not just Codex), and commits the campaign's own LiveRunning window to the
same host-quiescence discipline canary 2 already used. Every place this revision touches A9 is
marked inline. Sections still marked [PLACEHOLDER] are genuinely campaign/publication-dependent
(dates, IDs, commits, counts) -- not filled here, per the auditor's own instruction.
-->

# Evidence2 agentic benchmark — Claude Code vs Codex CLI, product-assisted vs free-baseline (anchor scenario only)

[PLACEHOLDER: campaign completion date]

## Summary

[PLACEHOLDER — mirrors Evidence1's Summary bullet list once real data exists: runtimes, scenario,
conditions, design shape, primary result (key facts), within-runtime product-vs-free deltas per
runtime, cells declared/accepted/rejected/missing, and (new vs. Evidence1) the descriptive
within-arm Claude-vs-Codex comparison Amendment A7 adds (**turns excluded per Amendment A9** — see
below) — medians/ranges only, no significance test, no ratio claim, no "faster"/"better" language,
stated as a comparison at matched effort, not a claim that the two runtimes' `high` settings mean
the same effective thing mechanically.]

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

[PLACEHOLDER — mirrors Evidence1's Method + Environment + Treatment texts + Gate validation
sections once real data exists.] Known in advance, not placeholders:

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
- [PLACEHOLDER: gate validation RED/GREEN campaign IDs and harness commits, once run — same
  no-provider mechanism-check pattern as Evidence1's own "Gate validation" section, not benchmark
  data itself.]
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
[PLACEHOLDER — this block is filled in by `node tools/agentic-eval/evidence2-tables.mjs <campaign-dir> --write` once the campaign completes. Never hand-edit between these markers. Per Amendment A9, `num_turns` in these tables is reported per runtime only — never presented as a cross-runtime comparison.]
<!-- evidence2-tables:end -->

Canary (4 sessions, pipeline validation only, never pooled into the campaign's own n=4/arm/runtime)
reported separately from the campaign above, same standing rule as Evidence1. [PLACEHOLDER: canary
results summary and ID, once run under the A7-amended registry.]

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

Full detail: a dedicated controls audit (to be run the same way as Evidence1's own, read-only
against the measured checkout) — **[PLACEHOLDER: link to this campaign's own
`controls-audit.md` once written — the "controls-audit pointer" this skeleton owes]**. This section
distills it, same convention as Evidence1's README.

Known in advance, stated now so the shape is right when real numbers land:

- **Environment flake, both tallies [PLACEHOLDER: fill with real counts]** — Evidence1's own
  closure was built specifically because of a Windows execution-policy bug (H1) that silently
  broke every campaign on `Evidence1-Runner-E2E` for 9 days before detection. State here, even if
  the answer is "none observed": (a) how many Evidence2 sessions, if any, hit an infra-level
  failure indistinguishable from a real result before being caught, and (b) how many were caught
  and excluded/retried under D8's own no-retry-no-replacement rule. Both tallies, not just one —
  a "0 flakes" claim needs the same evidentiary weight as Evidence1's own detailed H1 writeup, not
  an unstated absence. (The campaign's own `infra-flake-classifier.mjs` output and the Results
  section's Sensitivity table above are the mechanical source for this — never hand-counted.)
- **Exposure asymmetry [PLACEHOLDER: fill with real per-cell kmp_test_count/gradle_count, same
  shape as Evidence1's own table]** — D4 closes the WORST exposure risk (ground truth itself, now
  host-side only, verified per-cell). It does NOT close the softer one Evidence1 also flagged: the
  skill snapshot and a runnable `kmp-test` shim still exist as siblings of the agent's own
  workspace on every invocation, including free-only ones — same `matrix-runner.mjs` mechanism as
  Evidence1, unchanged by this closure. State this as a carried-over, not new, limitation, backed
  by the same style of evidence Evidence1 used (`kmp_test_count:0` pattern across all free cells,
  generalized from canary to full campaign n).
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
Evidence1 and uncontrolled, and [PLACEHOLDER: the real flake and exposure-asymmetry tallies once
known].

## Reproducibility and availability

[PLACEHOLDER — mirrors Evidence1's own Reproducibility section shape:]

- Harness commit (canary): [PLACEHOLDER]
- Harness commit (campaign): [PLACEHOLDER]
- **Parity with the published release** — the same two-checks pattern Evidence1 used (`git diff
  --stat <release-tag> <harness-commit> -- lib bin scripts package.json gradle-plugin
  .claude-plugin`, both must be empty) — run and report for both the canary's and campaign's own
  harness commit before publishing any results.
- Canary / campaign IDs: [PLACEHOLDER]
- Gate validation campaign IDs (RED/GREEN, mechanism check only, not benchmark data): [PLACEHOLDER]
- Manifest / analysis commands: `node tools/agentic-eval/campaign-summary.mjs <campaign-dir>`,
  `node tools/agentic-eval/cost-estimate.mjs <campaign-dir>`,
  `node tools/agentic-eval/evidence2-tables.mjs <campaign-dir> --write` (this document).
- `node tools/decouple-audit.mjs` result against this committed bundle: [PLACEHOLDER — must be
  clean before publication; per D10, this pass "needs to be genuinely thorough, not a repeat of
  Evidence1's lighter-touch review" because schema v9's `executed_commands` raw-command disclosure
  is a materially larger public surface than Evidence1 ever published].
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

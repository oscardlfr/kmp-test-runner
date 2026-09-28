# Publication note (not part of the preregistered text)

This note is added by the publishing session and sits outside the locked document below. Nothing
in the preregistered text has been edited for accuracy, clarity, or anything else — only copied.

- Source commit: `15ad0dd6598c71fb12754e47ce5b024797f6a033`
- Source path: `docs/audits/evidence1-preregistration.md`
- Git blob id: `2d5426ca393e9ea6d4b00a8aa27567e09a0ff21b`
- Verify independently:
  `git rev-parse 15ad0dd6598c71fb12754e47ce5b024797f6a033:docs/audits/evidence1-preregistration.md`

Three clarifications on wording in the locked text below, recorded here instead of edited into the
text itself, so the original stays intact:

- "sealed network" (section 9) describes the no-provider gate runs. During the live sessions this
  campaign measures, the network was restricted to the provider hosts listed in
  `controls-audit.md`, not fully sealed.
- References to "Phase 4", "Phase 6", and "step 2.x" point to the closure's internal working plan
  (`PLAN-A-cierre-evidence1.md`), which is not published. They are left as written because this
  document is reproduced verbatim from the locked source, amendments included.
- `AUDITORIA-EVIDENCE1-2026-09-27.md`, named in the root-cause background above, is an internal
  audit document and is not published alongside this preregistration.

---
<!-- VERBATIM-START: everything below this line is byte-for-byte identical to blob 2d5426ca393e9ea6d4b00a8aa27567e09a0ff21b (docs/audits/evidence1-preregistration.md @ 15ad0dd6598c71fb12754e47ce5b024797f6a033) -->

# Evidence1 preregistration: Claude vs Codex, product vs free-baseline

Written before any live session of this closure (PLAN-A-cierre-evidence1.md step 2.9), committed
before the Phase 4 canary. Locks the design, treatments, environment normalizations, and metric
definitions ahead of time so none of them can be adjusted after seeing results. Where this
document and code disagree once live sessions start, code is the ground truth for WHAT ran, but
this document is the ground truth for WHAT WAS PROMISED — a mismatch between them is itself a
finding to report, not something to quietly reconcile.

Root-cause background: the 2026-09-27 independent audit (`AUDITORIA-EVIDENCE1-2026-09-27.md`)
traced every live campaign run on the `Evidence1-Runner-E2E` VM between 2026-09-14 and 2026-09-23 to
a real product bug (H1: `kmp-test` on Windows launches its PowerShell wrapper without
`-ExecutionPolicy Bypass`), fixed via [PR #521](https://github.com/oscardlfr/kmp-test-runner/pull/521)
(squash commit `da990280`, released in `v0.15.0`). **Amendment, 2026-09-28**: narrowed from "every
live campaign since 2026-09-10" — H1 demonstrably did not manifest in the 2026-09-10 canary (product
3/3 strict success with real `kmp-test` envelopes: Skill → describe → parallel filtered, ~120s); the
likely reason — PowerShell 7 on that VM, present in August 2026 — is not recorded for that specific
date. That canary is a separate campaign and is not pooled here. This preregistration governs the
measurement that follows the fix's release, not the historical (quarantined) data from the affected
`Evidence1-Runner-E2E` VM, nor the separate 2026-09-10 campaign.

## 1. Design

One pre-registered scenario, two runtimes, two arms per runtime, 4 repetitions per runtime in a
counterbalanced AB/BA/BA/AB order — 8 cells per runtime, 16 cells total:

- Runtime `claude-code`, campaign design `claude-product-vs-free-baseline-v1`
  (`tools/agentic-eval/scenario-campaign-plan.mjs`): order `[[A,B],[B,A],[B,A],[A,B]]`, `repeats: 4`.
- Runtime `codex-cli`, campaign design `codex-product-vs-free-baseline-v2`
  (same file): order `[[A,B],[B,A],[B,A],[A,B]]`, `repeats: 4`.
- Cell `A` = `condition: current-skill`, `product_access_mode: product-assisted` ("product").
- Cell `B` = `condition: no-skill`, `product_access_mode: free-baseline-no-product` ("free").

Phase 4 canary (one cell per runtime × arm, 4 sessions total) uses the matching single-cell
designs: `claude-product-canary-v1`, `claude-free-baseline-canary-v1`, `codex-product-canary-v1`,
`codex-free-baseline-canary-v1` (same file).

## 2. Scenario

`coverage-threshold-failure-v2` (`tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json`).
Tagged `train`: the skill was tuned against this scenario family. Declared as a limitation in
publication (section 8), not concealed.

- Project: NowInAndroid (`android/nowinandroid`), pinned commit `7d45eae4f8720a0c77f507712ba2437ff974b6ed`.
- Target module: `:core:domain`.
- Ground truth: `outcome_kind: coverage_threshold_exceeded`, `missed_lines: 23`, `threshold: 15`
  (the scenario's own `min_missed_lines`), `modules_contributing: 1`. Real test count: 4 (kmp-test's
  own `individual_total`; Gradle's own `tests.total`/`passed` — both providers agree on 4).
  kmp-test's own task-dispatch `tests.total` is 1 (one module dispatched), a DIFFERENT number from
  the real test count 4 — this is exactly the `total` ambiguity D2/H15 exists to route around (see
  section 5).
- Prompt, `expected.*`, and the policy allowlists are untouched by this closure (hard rule 2).

## 3. Models

- Claude Code, runtime `claude-code`, model `claude-sonnet-5` (`tools/agentic-eval/models/registry.json`,
  the registry's own `default: true` entry).
- Codex CLI, runtime `codex-cli`, model `gpt-5.6-terra` (same registry, `default: true`).

## 4. Treatment texts (exact, D4)

Both runtimes, free arm (`no-skill`): the invocation is byte-for-byte the scenario's own prompt
text, unmodified. No treatment applied.

Both runtimes, product arm (`current-skill`), from `tools/agentic-eval/product-treatment.mjs`
(`applyExplicitProductTreatment`), after step 2.4 removed `TERMINAL_ENVELOPE_DIRECTIVE`:

- Claude: prepends exactly —
  `Before any Bash call, invoke the Skill tool with skill "kmp-test-runner:kmp-test-runner". Wait
  for its result and apply its decision protocol to the task below. If the Skill tool cannot load
  that exact skill, stop without running tests; do not reconstruct it from memory.`
  — then a blank line, then the scenario prompt, unmodified. Delivered via the Skill tool
  instruction (not a `/plugin:skill` slash command, which expands client-side and would not emit
  an observable `Skill` tool_use event) — `runtimeContext.productTreatmentDelivery:
  'claude-model-skill-tool'`.
- Codex: prepends exactly `$kmp-test-runner`, then a blank line, then the scenario prompt,
  unmodified — `runtimeContext.productTreatmentDelivery: 'codex-skill-reference'`.

Skill snapshot: materialized via `git archive` at `PINNED_SKILL_SHA =
27c943dc392675f78209a78ce09adb4f79283e3e` (`tools/agentic-eval/cli.mjs`) — the `v0.15.0` release
tag's own commit. **Amendment, 2026-09-28, before any live session of this closure (legitimate per
this document's own rule: amendable until live data exists):** originally pinned at
`2112aed96686ee159f851e00c2efa553e58473fc`, unchanged by this closure except step 2.1's revert of
the unmeasured d2138ae edit. Advanced to the `v0.15.0` tag commit per D1 (measure the POST-fix
PUBLISHED version) — kmp-test-runner's skill install uses `git archive` at this exact pin, not
HEAD, so leaving the old pin in place would have measured a stale skill snapshot alongside the
newly-published CLI, contradicting D1's own intent. `git diff --stat 2112aed96686ee159f851e00c2efa553e58473fc
v0.15.0 -- .skills/ .claude-plugin/` (run before advancing the pin): **`SKILL.md` itself is
unchanged** — the skill text measured here is identical to the one the 2026-09-10 canary measured,
that specific claim still holds. Four other files differ: `.claude-plugin/plugin.json` (version
string only), and three reference docs (`references/cli/envelope-schema.md`,
`references/cli/exit-codes.md`, `references/troubleshooting/no-summary.md`) updated across PR
#521/#523 to document the new `wrapper_no_output` error code and coverage-field additions this
same closure's own H1 fix and Plan B's parallel work introduced — documentation of already-measured
product behavior, not a change to the skill's own decision logic.

## 5. Environment normalizations (2.2, 2.3)

Applied identically to product and free arms, both runtimes, and the fake-provider smoke gate —
the one documented divergence from here on is provider transport itself:

- `tools/agentic-eval/materialize.mjs`: the per-cell `GRADLE_USER_HOME`'s `gradle.properties` now
  carries `org.gradle.configuration-cache=false` alongside the pre-existing `org.gradle.daemon=false`
  (H9 — the fixture's own `configuration-cache=true` left `aapt2` unresolved under this eval's
  sealed network + compact prewarmed seed; a normal networked environment would not hit this).
- `tools/agentic-eval/runtimes/claude-code.mjs`: `prepareIsolatedHome` sets
  `BASH_DEFAULT_TIMEOUT_MS=600000` and `BASH_MAX_TIMEOUT_MS=600000` explicitly, for both Claude
  conditions (Codex is untouched — these are Claude Code-specific env vars). Names/defaults
  verified against the raw fetched page at `docs.claude.com/en/docs/claude-code/env-vars` before
  use, not an LLM-mediated summary (H17 — past the 120s ambient default, a still-running Bash
  command moves to background instead of dying, which the grader reads as malformed).

## 6. Metric definitions (D2)

**Primary, arm-neutral: "key facts."** From each condition's `outcome_assessment`
(`graders.mjs`): does the agent's final claim (or, for product, the terminal tool envelope) name
module `:core:domain`, `outcome_kind: coverage_threshold_exceeded`, `missed_lines: 23`, and
`threshold: 15`? This is the metric both arms are compared on — computable for kmp-test and Gradle
evidence alike, unlike strict `success` (see below).

**Secondary:**
- Full-answer match (`task_outcome_matched`): the above, PLUS `total: 4`, `passed: 4`, `failed: 0`,
  `modules_contributing: 1` — the stricter, ambiguity-sensitive metric (H15: an agent that
  echoes kmp-test's own `tests.total: 1` task-dispatch count instead of the real test count 4 fails
  this one, not the primary metric).
- Efficiency: duration, tool call count, retries (`cell_metrics`, campaign-summary.mjs).
- Strict `success` (`graders.mjs`): reported **only for the product arm**, explicitly labeled "product
  protocol, not a cross-arm comparison" wherever shown. By design, Gradle can never be
  `coverage_threshold_exceeded`'s terminal evidence (`graders.mjs:826-834`), so free-baseline
  cannot win this metric regardless of how correct its answer is — never used to compare runtimes
  or arms against each other.

**Amendment, 2026-09-28, after the Phase 4 canary (`7867b2bc-1f51-408f-af7e-642b7267eecc`), before
campaign `705c625c`:** the canary reached `Closed`, 4/4 sessions accepted. Per
`node tools/agentic-eval/campaign-summary.mjs`: key facts 4/4 across all four cells, full-answer 0/4
(H15, as anticipated above — every cell's final claim names the correct
`outcome_kind`/`missed_lines`/`threshold`, none reproduces the ambiguous `total`/`passed` pair).

Declared limitation, discovered by this canary: the free arm's `kmp_test_vs_gradle` split is
`{kmp_test_count: 0, gradle_count: 0}` for the `codex-cli` free cell, although that cell's final
claim correctly states `missed_lines: 23` — a value obtainable only from a real coverage run. (The
`claude-code` free cell's Gradle command WAS recognized: `{kmp_test_count: 0, gradle_count: 1}` —
this is not uniform across the two free cells, and is reported as such rather than as one blanket
free-arm behavior.) `retries`/`testInvocationsTotal` (`graders.mjs:2710-2717`) count only EXECUTED
attempts the classifier recognizes as `kmp-test parallel` or a policy-allowed Gradle task; an
attempt in a form the classifier does not recognize is invisible to this count, not merely
uncredited toward it. Consequence: `retries` and `test_invocations_total` are not comparable across
arms and will be reported for the **product arm only** in publication — the free arm's
Gradle-invocation count is a floor on real tool use, not a measured count of it.

No change to `graders.mjs` (including its tool-kind classifier), the prompt, the skill, or either
agent runtime in response to this finding — the classifier gap is documented, not patched,
consistent with hard rule 2 (prompt/`expected.*`/policy allowlists untouched) and this closure's
no-mid-measurement-tuning discipline.

## 7. Cell treatment rules

- **Accepted** (integrity checks pass) → counts in its arm's denominator, including when the
  semantic answer is wrong. A negative result is a valid observation, not something to discard.
- **Rejected, Codex, matching ALL of the following** (defined in `campaign-summary.mjs`, step
  2.10 — design reviewed with the auditor session before implementation, redirected from an
  earlier design that would have touched dispatch-accounting.mjs/cell-integrity.mjs's closed
  contracts) → counts as a valid **negative** observation, not missing data:
  - runtime `codex-cli`;
  - `failed_checks` is a subset of `{hookAccountingOk, toolResultsCompleteOk}`;
  - `correlation_observability.missing_result_counts_by_kind.shell >= 1`, and `.skill == 0` and
    `.other == 0`;
  - every `correlation_issue_counts` entry is 0 (excludes an orphaned tool result, which would
    indicate a parser defect, not abandonment);
  - `pre_inference_failure.terminal_present == true`, `terminal_result_subtype == "success"`,
    `terminal_is_error == false`.

  Rationale (E1/E3, AUDITORIA section 7): the JSONL stream is complete — Codex closed its own
  turn (`turn.completed`) with a `command_execution` it started but never completed. This is
  observed agent/runtime behavior, not a capture defect, so rejecting it would both discard a
  real failure and favor Codex by removing it from the denominator. Outcome for such a cell =
  its own `outcome_assessment` (normally `claim-missing`, i.e. negative); efficiency = its own
  `cell_metrics`; listed separately in publication as "the agent closed the turn with N command(s)
  still in progress." No cap on N.
- **Rejected, any other reason** → missing data, with its rejection reason stated. Not silently
  dropped, not counted as a data point either.
- **No retries, no cell replacement**, in canary or campaign (hard rule 8). The canary alone may
  repeat once, and only after a deterministic fix.

## 8. Analysis command (2.10)

`node tools/agentic-eval/campaign-summary.mjs <campaign-dir>` — reads `manifest.json` (rejects if
`provider_mode` is not `live`), reads every `private/<runtime>-<n>/{record,audit,rejection}.json`,
and emits JSON + Markdown per (runtime, arm): declared/accepted/rejected counts with reasons, key
facts, full-answer match, strict `success` (product only, labeled as such), duration/tool-call/
retry stats, kmp-test and Gradle invocation counts, token usage, cost (if present), skill
activation (Claude). Not yet implemented as of this commit (2.9 precedes 2.10 in this plan); this
section will be re-verified against the real CLI surface once 2.10 lands, before the canary runs.

## 9. What gets published

Per Phase 6 of the closure plan:

- A public evidence document (e.g. `tools/runs/evidence1-agentic-benchmark-<date>.md`), styled like
  this project's July benchmarks: design and environment (Windows 11, isolated VM, sealed network,
  configuration cache disabled, Claude Bash timeout raised), the exact treatment texts above,
  results per runtime and arm with **no cross-provider "winner" headline**, missing cells with
  their reasons, and these limitations stated explicitly:
  - single scenario, tagged `train` (the skill was tuned against this family);
  - n=4 per arm per runtime;
  - Windows only;
  - strict `success` reachable by the product arm only;
  - the prompt's own `total` ambiguity (unique tests vs. executions);
  - prior campaigns (2026-09-10 through 2026-09-23) are quarantined by this audit's own findings,
    not part of this measurement;
  - JUnit-XML capture is not used for Codex's own Gradle attempts on this scenario: its
    PostToolUse hook's correlation with a real transcript has never been verified (no fixture,
    `hookStats` hand-set in tests). `junit-evidence.mjs`'s `attributeCondition` exempts `codex-cli`
    from the capture-completeness requirement so an unverified mechanism cannot silently reject a
    cell, but does not fabricate evidence either — `outcomeMatches`/`junitOk` still correctly reads
    "unverified" for a Codex Gradle attempt, exactly as it already did before H16 made Codex's
    `./gradlew` commands classify as relevant at all. Neither D2's key-facts metric nor this
    scenario's strict `success` (product-only by design) depends on this.
- `node tools/decouple-audit.mjs` clean before publication — no local or guest paths in public text.
- `CHANGELOG.md` `[Unreleased]` entry (docs/evidence, not a release). No README "What's new"
  section (standing project rule). Any published ratio traces to the same project/campaign capture
  on both sides — no cross-project hybridization.

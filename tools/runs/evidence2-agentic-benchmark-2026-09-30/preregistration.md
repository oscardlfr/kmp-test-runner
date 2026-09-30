# Evidence2 preregistration: Claude vs Codex, product vs free, anchor scenario only

Written before any live session of this closure. Locked at the commit that adds this file to
`docs/audits/evidence2-preregistration.md` — no further edits once a live session runs; any design
change after the GREEN gate must be a documented amendment committed BEFORE the canary. Where this
document and code disagree once live sessions start, code is ground truth for WHAT ran; this
document is ground truth for WHAT WAS PROMISED — a mismatch is itself a finding to report, not
something to quietly reconcile. Mirrors `docs/audits/evidence1-preregistration.md`'s own
convention.

Thirteen binding decisions (D1-D13) are referenced by number throughout, matching this closure's own
running decision log.

## 1. Design

Two runtimes, two arms, **one scenario** (the anchor — D3), **n=4** reps per cell — matching
Evidence1's own shape exactly. Counterbalanced on **two independent axes**, both genuinely separate
mechanisms:
- Arm order within each runtime's own repetition sequence: `[[A,B],[B,A],[B,A],[A,B]]`, unchanged
  mechanism from Evidence1.
- **D7 — runtime dispatch order across the campaign, alternating first-mover per round** (new):
  `evidence1-run.ps1`'s `Invoke-E1RunLiveRunningState`, via
  `evidence1-run-manifest-contract.psm1`'s `Get-E1RunManifestExpectedCells` (the single source of
  truth both the dispatch loop and `max_session_count` validation read from), now alternates which
  runtime dispatches first each round — round 0: claude-code then codex-cli; round 1: codex-cli
  then claude-code; etc. Every prior campaign, including Evidence1's own, ran Claude first every
  round without exception. Committed `cd47245`; verified directly against a real manifest this
  session (campaign `583a708d-82dd-4e19-b88f-368aa66015cb`): `Get-E1RunManifestExpectedCells`
  returns round0 claude-code(product)→codex-cli(product), round1 codex-cli(free)→claude-code(free).

- Runtime `claude-code`, campaign design `claude-product-vs-free-baseline-v1`
  (`tools/agentic-eval/scenario-campaign-plan.mjs`): order `[[A,B],[B,A],[B,A],[A,B]]`, `repeats: 4`.
- Runtime `codex-cli`, campaign design `codex-product-vs-free-baseline-v2` (same file): order
  `[[A,B],[B,A],[B,A],[A,B]]`, `repeats: 4`.
- Cell `A` = `condition: current-skill`, `product_access_mode: product-assisted` ("product"). Cell
  `B` = `condition: no-skill`, `product_access_mode: free-baseline-no-product` ("free").

**D8 — size.** n=4 per cell. Canary 4 sessions (1 cell per runtime per arm), campaign 16 sessions
(2 runtimes × 2 arms × n=4), live ceiling 24 total — matching Evidence1's own exact shape. One
canary repeat is permitted, and only after a deterministic fix; zero campaign retries, no cell
replacement. Canary results are reported separately and are never pooled into the campaign's own n.

## 2. Scenario

**D3 — anchor only.** `coverage-threshold-failure-v2`
(`tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json` +
`tools/agentic-eval/corpus/expected/coverage-threshold-failure-v2.json` post the D4 isolation
split). Unchanged from Evidence1, for direct comparability with its published numbers. Tagged
`train`: the skill was tuned against this scenario family — declared as a limitation in
publication (§9), not concealed.

- Project: NowInAndroid (`android/nowinandroid`), pinned commit
  `7d45eae4f8720a0c77f507712ba2437ff974b6ed`.
- Target module: `:core:domain`.
- Ground truth: `outcome_kind: coverage_threshold_exceeded`, `missed_lines: 23`, `threshold: 15`
  (the scenario's own `min_missed_lines`), `modules_contributing: 1`. Real test count: 4
  (kmp-test's own `individual_total`; Gradle's own `tests.total`/`passed` — both providers agree on
  4). kmp-test's own task-dispatch `tests.total` is 1 (one module dispatched) — the exact ambiguity
  **D5 (H15 fix)** below exists to route around.
- Prompt, `expected.*`, and the policy allowlists are untouched by this closure **except for D5's
  requested-field rename (`total`→`test_count` plus its one-clause definition) — see the
  Amendments section (amended, A1)**.

**Both held-out scenarios (design.md (b)) are explicitly excluded from tonight's live numbers**,
each for a specific, verified reason, not a blanket deferral:
- `nowinandroid-core-common`: the guest's offline Gradle seed lacks
  `app.cash.turbine:turbine:1.2.0` and `org.jetbrains.kotlin:kotlin-test-junit:2.3.0` — confirmed
  via the `run-gradle-task-offline` probe (commit `c198b0d`), `offline_resolved: false`.
- `deterministic-unit-test-failure`: its pinned commit (`058f0e4375ec51ff8811ba2d0bb10bc4c1b4fdb8`)
  is outside the seed, and verifying it needs an elevated, network-mutating operation outside this
  closure's own safe channel.

Both are deferred to a future "v2.1" once the seed is extended — see
`heldout-provisioning-plan.md`.

## 3. Isolation guarantee (new — Evidence1 had no equivalent section)

**D4.** Neither the scenario's own `expected` block, nor this preregistration document, nor
`corpus/scenarios/coverage-threshold-failure-v2.json`'s own `expected` field, is present anywhere
on the guest filesystem for any cell, in either arm. The corpus scenario definition is split at
materialization time:
- `corpus/scenarios/<id>.json` (ships to the guest): `id`, `family`, `project_alias`/`url`/`commit`,
  `prompt`, `policy`, `fixture_setup`, `tags` — everything the session and the skill's own policy
  hook actually need. No `expected` block.
- `corpus/expected/<id>.json` (host-side only, never copied to the guest): `expected`,
  `expected_outcome`, `first_useful_signal_predicate`. `loadScenarioById`
  (`tools/agentic-eval/cli.mjs`) merges both host-side, with graceful fallback to a legacy inline
  `expected` field for pre-split test fixtures.

Grading runs host-side, against the host-only `corpus/expected/` file, never copied to the guest.
An automated pre-session probe (`tools/agentic-eval/isolation-probe.mjs`) verifies this per cell
before dispatch — `findLeakedExpectedValues` (scoped to exactly module, outcome_kind, missed_lines,
threshold — never `individual_total`/`evidence_task`, whose real values are small enough to produce
false-positive matches against unrelated content), `findProductSurfaceForFreeCell`,
`findForbiddenHarnessPaths`, combined via `checkIsolationProbe({roots, expected, isFreeCell})` —
and blocks dispatch on failure, recorded as a harness-integrity failure, not "rejected," not
"missing." Free cells additionally get no skill snapshot and no kmp-test shim anywhere under their
workspace or its temp-root siblings (product cells still get both, as the treatment requires).
Committed `1d63a48`.

This section exists because Evidence1's own closure disclosed, and this session independently
verified by reading the scenario JSON directly, that its harness did NOT have this guarantee — the
full ground truth sat in plain JSON on the guest, unavoidably, because grading ran guest-side. That
is flagged as a HIGH-severity, primary-metric-affecting item in Evidence1's own published
controls-audit.md, item 1. This section is Evidence2's answer to it.

## 4. Models

**D1 — product baseline.** kmp-test-runner `0.16.0` candidate: PR #534's envelope schema 3,
`contracts.coverage_evidence`, explicit-coverage-tool fail-closed behavior. Baseline PR #537 @
`6fedb13d57ebdb38ca123c24ab16c5d469a007d8`, merged into the eval branch as `8e98bba`. The deployed
binary reports `0.16.0` / schema 3 (`bin/kmp-test.js --version --json`:
`{"version":"0.16.0","schema_version":3,"contracts":{"coverage_evidence":1}}`, confirmed this
session against the real merged binary).

**D11 — product baseline, re-merge policy.** As D1. Re-merge only if PR #537's product code
changes before the canary or campaign actually run.

- Claude Code, runtime `claude-code`, model `claude-sonnet-5`.
- Codex CLI, runtime `codex-cli`, model `gpt-5.6-terra`.

**D2 — reasoning effort, pinned and recorded for both, for the first time.**
- Claude: argv `--effort high` (`condition-launcher.mjs`'s `buildBaseInvocation`, inserted right
  after `--model <model>`) — verified on the pinned Claude Code `2.1.238` via `--help` output from
  the canonical provisioning archive (SHA-256 `7d6c38f6…`).
- Codex: `model_reasoning_effort=low` (models registry) — unchanged mechanism.
- Recorded per cell as `reasoning_effort_requested`/`reasoning_effort_source` (schema v9), closing
  Evidence1's own disclosed gap where Claude's effort was neither set nor recorded at all.
  Aggregated per campaign into `campaign-summary.json`'s `provenance.reasoning_effort` (schema 2,
  per-runtime `{values, mixed}`). No cross-runtime comparison is drawn from the two labels — `high`
  and `low` are not asserted to mean the same effective thing across two different products.

## 5. Treatment texts (exact)

The treatment wrappers themselves are byte-identical to Evidence1's **(amended, A1 — see
Amendments)**. Both runtimes, free arm (`no-skill`): the invocation is the scenario's own prompt
text, which differs from Evidence1's only by D5's requested-field rename (§2/§6) — no other
change. Both runtimes, product arm (`current-skill`), from
`tools/agentic-eval/product-treatment.mjs` (`applyExplicitProductTreatment`), prepends the
following unchanged wrapper text before that same (D5-renamed) prompt:

- Claude: prepends exactly — `Before any Bash call, invoke the Skill tool with skill
  "kmp-test-runner:kmp-test-runner". Wait for its result and apply its decision protocol to the
  task below. If the Skill tool cannot load that exact skill, stop without running tests; do not
  reconstruct it from memory.` — then a blank line, then the scenario prompt, unmodified.
- Codex: prepends exactly `$kmp-test-runner`, then a blank line, then the scenario prompt,
  unmodified.

**New**: the actual delivered, post-treatment prompt is hashed per cell (`delivered_prompt_sha256`,
schema v9) — Evidence1 only ever hashed the pre-treatment prompt. `treatment_delivery_sha256`
(also schema v9) hashes the delivered skill/plugin content itself, distinct from the existing
source-snapshot hash — `null` with reason `condition-no-skill` for free cells.

## 6. Metric definitions

**Primary, arm-neutral: "key facts."** Unchanged definition from Evidence1 §6: does the agent's
final claim (or, for product, the terminal tool envelope) name module `:core:domain`,
`outcome_kind: coverage_threshold_exceeded`, `missed_lines: 23`, and `threshold: 15`? This is the
one metric directly comparable to Evidence1's own published numbers.

**D5 — H15 fix, applied here, not left as a documented ambiguity.** The prompt's requested field is
renamed from `total` to `test_count`, with an inline clause distinguishing it from a build tool's
own task-dispatch count ("test_count is the number of individual test methods that ran, not a
build tool's own task-dispatch count"), applied uniformly across all corpus scenarios. The grader
(`graders.mjs`'s `compareKmpEvalResultBlockToObserved`) compares the renamed field against
kmp-test's own `individual_total` specifically — this was already the comparison target before the
rename; the fix is purely the requested-field name at the prompt/key-name boundary. **The anchor's
primary metric (key facts) stays comparable to Evidence1; full-answer match is NOT comparable
between v1 and v2** — Evidence2's full-answer-match rate is no longer expected to fail by design
the way Evidence1's H15 made it fail in every free cell and most product cells, so a rate that
still comes back low in Evidence2 is a genuine finding, not the same documented, anticipated
artifact Evidence1 reported.

**Secondary, unchanged in kind**: efficiency (duration, tool calls, retries — product-arm-only per
Evidence1's own amendment). Strict `success`: product-arm-only, unchanged rationale.

**D6 — schema 3 alignment.** Every product envelope this harness accepts as well-formed has
`schema_version === 3` (`ENVELOPE_SCHEMA_VERSION`, sourced from `lib/envelope/exit-codes.js`, not
hardcoded here). Numeric coverage fields (`missed_lines`, `threshold`, `modules_contributing`) are
trusted only when `supportsRunnerContract(envelope, 'coverage_evidence', 1)` returns true — checked
independently at both grader sites that read coverage data (commit `53ce262`):
`deriveObservedKmpTestResult`'s coverage branch (used by `final_answer_consistent_with_evidence`)
and `validateKmpEnvelopeForAttempt` (used by `expectedOutcomeMatched`). An envelope failing that
check grades as `coverage_data_unavailable`, its own tracked bucket in
`coverage-gate-observability.mjs` (`COVERAGE_GATE_ERROR_BUCKET_FIELDS` / `bucketForErrorCode`),
never silently folded into a generic environment-error count, and never treated as if the numeric
fields it carries are real.

**D12 — Codex token/cost parity reporting.** Both runtimes' token usage and estimated API cost are
recorded and reported with the same field shape (`cost-estimate.mjs`, schema 2,
`runtimes.<id>.cells[].tokens`). Binding, runtime-specific token mapping, verified against each
runtime's own real ingestion code: Codex's raw `usage.input` includes any cached portion (OpenAI's
`input_tokens` is the total prompt size, `cached_input_tokens` a subset of it, never additive), so
`tokens.input = usage.input − usage.cached_input`; Claude's `usage.input` is already
cache-exclusive, no subtraction. `tokens.cache_creation` is always 0 for Codex (its
`turn.completed` usage event has no cache-write token dimension at all) and `usage.cache_write`
as-is for Claude. Real, official list prices for both models, fetched 2026-09-29 and cross-checked
against raw fetched page content, not an LLM-mediated summary alone:
- `claude-sonnet-5` (platform.claude.com/docs/en/about-claude/pricing): input 2 / 5m cache-write
  2.5 / 1h cache-write 4 / cache-read 0.2 / output 10 (USD per million tokens).
- `gpt-5.6-terra` (developers.openai.com/api/docs/pricing): input 2 / cached-input 0.2 /
  cache-write 2.5 / output 12 (USD per million tokens).

Per OpenAI's own published Input pricing tooltip ("Input tokens are either Input, Cached Input, or
Cache Write and writes are not an additive fee"), Codex's uncached-input rate is genuinely
ambiguous between the plain-input and cache-write price, because Codex does not report cache
writes in its own usage event. Both `cache_write_5m`/`cache_write_1h` are set to the real published
cache-write rate (2.5, not 0), and `uncached_input_may_be_cache_writes: true` plus the quoted
tooltip (`pricing_note`) are recorded on the codex-cli runtime entry, so Codex's uncached input is
bounded between the input and cache-write prices rather than asserting a single false-precision
number. This is an estimate, not billed spend, for either runtime.

## 7. Cell treatment rules

Unchanged from Evidence1 §7:
- **Accepted** (integrity checks pass) → counts in its arm's denominator, including when the
  semantic answer is wrong.
- **Rejected, Codex, matching Evidence1's own 5-criterion abandoned-command shape** → counts as a
  valid negative observation, not missing data.
- **Rejected, any other reason** → missing data, with its rejection reason stated.
- **No retries, no cell replacement** (D8), in canary or campaign. The canary alone may repeat
  once, and only after a deterministic fix.

**New addition**: a cell that fails the isolation probe (§3) is a harness-integrity failure,
recorded and reported separately from all three categories above — not folded into any of them.

**D9 — classifier.** `command-classify.mjs`'s tool-kind classifier is fixed from the canary's own
real recorded commands (`executed_commands`, schema v9) — never a synthetic guess — then FROZEN
before the campaign runs. The frozen version is recorded in the campaign's own analysis output, so
any later classifier change is visible as a version difference, not a silent behavior drift between
canary and campaign.

## 8. Analysis command

`node tools/agentic-eval/campaign-summary.mjs <campaign-dir>` — reads `manifest.json` (rejects if
`provider_mode` is not `live`), reads every `private/<runtime>-<n>/{record,audit,rejection}.json`,
and emits JSON + Markdown per (runtime, arm): declared/accepted/rejected counts with reasons, key
facts, full-answer match, strict `success` (product only, labeled as such), duration/tool-call/
retry stats, kmp-test and Gradle invocation counts, token usage, skill activation (Claude), and
(schema 2) `provenance.reasoning_effort` per runtime (D2).

`node tools/agentic-eval/cost-estimate.mjs <campaign-dir>` — companion generator, shares cell
selection with `campaign-summary.mjs` via the exported `loadCountedCellTokens` (single source of
truth for "which cells count," so the two documents can never silently disagree), emits schema-2
`cost-estimate.json` per D12 above.

## 9. What gets published

**D10 — publication.** After the campaign closes: runtime code only (not the full harness/broker
apparatus), sanitized — email addresses removed, machine-specific paths genericized — relocated to
`tools/evidence1/runtime/`, published as fresh squash commits with no private history (same
discipline already proven for Evidence1's own two published files). `node
tools/decouple-audit.mjs` clean before publication, including the new raw-command disclosure
(`executed_commands`, schema v9) — a materially larger public surface than Evidence1 ever published
(which never disclosed raw commands at all); this sanitization pass needs to be genuinely thorough,
not a repeat of Evidence1's lighter-touch review.

A public evidence document (e.g. `tools/runs/evidence2-agentic-benchmark-<date>.md`), styled like
Evidence1's own published benchmarks and this project's July benchmarks: design and environment,
the exact treatment texts above, results per runtime and arm with **no cross-provider "winner"
headline**, missing/rejected/harness-integrity-failed cells with their reasons, and these
limitations stated explicitly:
- Single scenario, tagged `train` (the skill was tuned against this family) — both held-out
  scenarios deferred to v2.1 (§2).
- n=4 per arm per runtime, Windows only — unchanged from Evidence1.
- Strict `success` reachable by the product arm only.
- The prompt's `test_count` field is now unambiguous (D5); full-answer match is not comparable
  between Evidence1 and Evidence2.
- Reasoning effort now pinned for both runtimes (D2, Claude `high` / Codex `low`) — the labels are
  not claimed to mean the same effective thing across two different products.
- Codex's uncached-input cost is priced as a range (input rate to cache-write rate), not a single
  number (D12).
- `CHANGELOG.md` `[Unreleased]` entry (docs/evidence, not a release). No README "What's new"
  section (standing project rule). Any published ratio traces to the same project/campaign capture
  on both sides — no cross-project hybridization.

## Final numbers

- Canary: 4 sessions (1 cell per runtime per arm) — D8.
- Campaign: 16 sessions (2 runtimes × 2 arms × n=4) — D8.
- Live ceiling: 24 total (canary + campaign), matching Evidence1's own ceiling exactly.
- Scenario: anchor only (`coverage-threshold-failure-v2`) — D3; both held-out scenarios deferred to
  v2.1.
- Product under measurement: kmp-test-runner `0.16.0`, envelope schema `3` — D1/D11.

## Amendments

**A1 (2026-09-29, before any live session):** §2 and §5 corrected. The anchor's prompt text
differs from Evidence1's ONLY by D5's rename of the requested field `total` → `test_count` plus
its one-clause definition; the expected VALUES and the policy allowlists are unchanged (expected
moved host-side per D4). The treatment wrappers (§5) are byte-identical to Evidence1's. The
primary metric (key facts) keeps its definition and stays comparable, on a near-identical prompt.

**A2 (2026-09-29, before any live session):** Product baseline moves under D11's own pre-declared
re-merge policy, a disclosed environment flake is recorded as a threat to validity, a new binding
decision D13 defines a symmetric infra-flake flag (implemented and tested, not just proposed — see
§4), and an infrastructure fix made before any live session is recorded for completeness.

**1. Product (D1/D11).** This is D11's own re-merge clause firing, not a new policy: "Re-merge only
if PR #537's product code changes before the canary or campaign actually run." It has now fired
three times, and the product commit and its eval-branch merge commit are two different, parallel
chains — §4/D1 itself already distinguishes them ("Baseline PR #537 @ `6fedb13d…`, merged into the
eval branch as `8e98bba`"), so this amendment keeps that distinction rather than collapsing it:
- **Product:** `6fedb13` (§4's own cited baseline, "chore(release): bump version to 0.16.0") →
  `df994b6` → `31cf450` → `0c9fbff`.
- **Eval-branch merges:** `8e98bba` (brings `6fedb13` in) → `5154389` (brings `df994b6` in) →
  `c2955d7` (brings `31cf450` in) → `bb3ca33` (brings `0c9fbff` in).

First re-merge, before tonight: `df994b6` ("fix(docs,agentic-eval): CodeRabbit round on #537 --
table pipe escape + schema-pairing validation") changed exactly three files — a consumer-skill
treatment-text fix (`.skills/kmp-test-runner/references/cli/envelope-schema.md`, an unescaped table
pipe) and two `tools/agentic-eval/` files (`readme-evidence.mjs` plus its test) — no `lib/` or
`bin/` file (confirmed via `git show --stat`, not assumed). It was re-merged via `5154389` so that
measured equals shipped: this closure measured against `df994b6` for the duration of tonight's own
diagnostic work.

Second re-merge: the GREEN gate's own diagnostic work (this document's own Environment Finding
below) surfaced a pre-release PRODUCT defect — `lib/project/cache.js`'s Gradle task-discovery probe
failed silently (`if (result.error || result.status !== 0 || !result.stdout) return null`), giving
no signal to the caller when the probe itself failed rather than genuinely finding nothing. Per
this project's own pre-release rule (fix everything found by a release gate before the tag, no
deferral), the fix landed on the same PR #537 as `31cf450` ("fix(model): surface gradle task-probe
failures and retry once"): `warnings[]` gains `gradle_probe_failed` (with a `recovered` field), and
`task_not_found` gains `probe_failed: true`, plus exactly one retry on a non-timeout probe failure.
Re-merged via `c2955d7`, diff against `31cf450` confirmed empty on every path this study measures
(`lib bin scripts .skills .claude-plugin package.json gradle-plugin`).

Third re-merge: the auditor's own review of `31cf450` before approving it for a live measurement
found a real cache-replay bug — a cached project model could replay a PREVIOUS run's
`probeFailure` on a `describe` cache hit, rather than reflecting the current run. Fixed as
`0c9fbff` ("fix(model): never replay a cached probe failure"), found and fixed before any live
session, not after. Re-merged via `bb3ca33`, diff against `0c9fbff` confirmed empty on the same
paths. `0c9fbff` is the measured product for D1/D11 as of this amendment. No live session (canary
or campaign) has run against any of `df994b6`, `31cf450`, or `0c9fbff` — every re-merge in this
chain is a pre-release fix, not a mid-study product change.

**2. Environment finding, disclosed as a threat to validity.** A non-deterministic Gradle/Kotlin
compiler fault was observed once during this closure's own pre-canary diagnostics, independent of
kmp-test-runner's own code. Verbatim signature (from a real `gradlew tasks --all --offline`
invocation against `core/database/build.gradle.kts`):

```
Script compilation error:

  class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ByteArrayCharSequence cannot be cast to class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ZipEntryDescription (org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ByteArrayCharSequence and org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ZipEntryDescription are in unnamed module of loader org.gradle.internal.classloader.VisitableURLClassLoader @619a5dff)
```

Environment: Gradle 9.4.0, Kotlin (embedded) 2.3.0, JDK 21.0.12.1 (Eclipse Adoptium), on the pinned
guest toolchain. Measured rate: 14 direct `gradlew tasks --all` invocations total (probe P1 + probe
P2 + the 12-run frequency test that followed the retry-wedge fix below), 1 crash (P2, an `--offline`
run) — `--offline` split 1/7, non-`--offline` split 0/7. This small a sample cannot pin the true
rate more precisely than "rare," nor confirm or rule out an `--offline`-specific tendency either
way.

Separately: 1 failure in 2 real product-smoke-internal probe runs, of unrecorded cause — the
pre-fix product discarded the probe's own output on failure (the same `cache.js` silent-null
defect §1 fixes), so the exact cause of that specific failure was never captured and cannot be
claimed as observed. It is consistent with, not proven to be, the same environment fault as P2; no
inference beyond that is drawn here.

The fault is non-deterministic and, given its cause (a Kotlin compiler internals class-cast), could
in principle affect any Gradle invocation in either arm (product or free) — an environment
property, not something either treatment condition is known to cause or avoid. §3/D13 covers the
symmetric handling; the paragraph after it (exposure asymmetry) covers a real, disclosed difference
in how often each arm actually invokes Gradle.

**3. D13 — infra-flake flag, preregistered and applied symmetrically.** Signature-only, deliberately
narrower than the first draft: `executed_commands` (schema v9) holds shell commands, not tool-level
edits, and Write/Edit/`apply_patch` edits are not reliably visible across runtimes in the same shape
— per-runtime edit-precedence detection would have been an unvalidated mechanism baked into a frozen
classifier. Dropped entirely; the regex below does the discriminating work instead.

A cell is flagged `infra_flake_suspected: true` if, and only if, any recorded output of the cell
(Gradle output inside the raw transcript, including kmp-test's own envelope text) matches:

```
/org\.jetbrains\.kotlin\.cli\.jvm\.compiler\.jarfs\.\w+ cannot be cast to class org\.jetbrains\.kotlin\.cli\.jvm\.compiler\.jarfs\./
```

This is an internal compiler-classloader identity cast — not a shape an agent's own build-script
edit can produce, so it needs no separate precedence check. The generic string `Script compilation
error` does NOT flag on its own: an agent's own broken edit legitimately produces that exact text,
so treating it alone as infra-flake evidence would misattribute a real, agent-caused failure as
environmental. A `gradle_probe_failed` warning (Plan B) with `recovered: false` flags ONLY if its
own carried message matches the same regex above; Plan B is asked to include the exception line in
that warning's excerpt so this is checkable at all. A `recovered: false` warning whose message does
NOT carry the signature is classified `probe_failed_unrecovered` — reported, not flagged, because an
agent's own broken build script can produce an unrecovered probe failure too, indistinguishable from
this environment fault by warning shape alone.

A cell is flagged whenever the signature appears anywhere in its recorded output, including a
`gradle_probe_failed` excerpt with `recovered: true`; this keeps the flag symmetric with a free-arm
agent that re-ran Gradle after the crash. `recovered:true` warnings WITHOUT the signature are counted
as absorbed events, reported and never flagged.

**Exposure asymmetry (disclosed, not corrected for).** The number of Gradle invocations per session
differs by arm: each product-arm kmp-test call includes an internal discovery probe plus dispatch,
so a probe crash there can be absorbed by Plan B's own retry before the agent ever sees it; a
free-arm crash surfaces directly to the agent as raw Gradle output, who may or may not retry it
themselves. This is a real, structural difference in exposure, not something D13's flag can equalize
— it is disclosed here, not corrected for. `gradle_probe_failed` occurrences with `recovered: true`
are reported per (runtime, arm) as "infra events absorbed" — visible in the record, never flagged
and never excluded from either the primary or sensitivity analysis.

**Fail-closed.** A cell whose raw transcript is missing or unreadable classifies as
`infra_flake_suspected: "unknown"` — never coerced to `false` — and is counted separately per
(runtime, arm) alongside the flagged/absorbed/unrecovered counts, so a gap in the evidence is
visible rather than silently treated as clean.

PRIMARY analysis includes ALL cells regardless of this flag — the flag never removes a cell from the
primary denominator or changes its grade. A SEPARATE SENSITIVITY analysis excludes only
`infra_flake_suspected: true` cells (not `unknown` ones) and is reported alongside, never in place
of, the primary numbers. Flagged, absorbed, unrecovered, and unknown counts are all reported per
(runtime, arm), not just as one campaign-wide total, so an asymmetry would be visible rather than
averaged away. The flag, the regex, and the classifier's own version are frozen together with D9's
own classifier freeze, at the canary (same freeze point, same rationale: visible as a version
difference if it ever changes, never a silent drift between canary and campaign) — the classifier
must be implemented and tested before the canary runs, since D9-style freezing only means something
if the frozen thing already exists.

**4. Mechanism — implemented and tested, not just proposed.** A new, separate, small script —
`tools/agentic-eval/infra-flake-classifier.mjs` — not a change to `campaign-summary.mjs`'s own
`CAMPAIGN_SUMMARY_SCHEMA` (kept at 2; no ripple into the README generator, `readme-evidence.mjs`,
or its `validateSummary`). Invoked as `node tools/agentic-eval/infra-flake-classifier.mjs
<campaign-dir>`.

Reads, per cell, one source (R5 dropped the `executed_commands`/edit-precedence read entirely, since
that mechanism no longer exists): the cell's raw transcript, already copied per cell by Evidence1's
own existing artifact-copy bundles (`agentic-eval-accepted-raw-transcript` /
`agentic-eval-rejected-raw-transcript`, `evidence1-artifact-copy-contract.psm1`) into this closure's
private forensic-storage root. The actual Gradle invocation output and, once Plan B lands, the
envelope's own `warnings[]` text live here — not in the compact `record.json`/`audit.json` pair,
which stays untouched by this classifier. `campaign-summary.mjs`'s own `loadCell` (verified against
that file directly) is still how cells are enumerated; only the read target per cell changes.

   Confirmed against Plan B's real merged code (`lib/orchestrators/orchestrator-utils.js`'s
   `buildProbeFailureWarning`, `lib/project/cache.js`'s `buildProbeFailureExcerpt`), not assumed:
   the warning object is `{code:'gradle_probe_failed', reason, exit_code, attempts, recovered,
   message}`, where `message` embeds the excerpt verbatim after a newline when present. The
   classifier's regex is checked against the whole transcript text, so it does not depend on the
   warning's own exact key order or serialization surrounding it.

Output lands at `<campaign-dir>/infra-flake-classification.json` (new file, not overwriting
anything `campaign-summary.mjs`/`cost-estimate.mjs` already produce): schema 1, the frozen
classifier version (D9-aligned), and per cell `{cellKey, runtime_id, arm, infra_flake_suspected,
reason}` where `infra_flake_suspected` is one of `true` (regex-matched), `false` (transcript read,
no match), or `"unknown"` (transcript missing/unreadable — R6, never coerced to `false`), plus
`reason` additionally carrying `probe_failed_unrecovered` or `probe_failed_absorbed` when those
apply even though they don't set the flag itself. Rollup is per (runtime, arm): flagged / absorbed /
unrecovered / unknown counts, all four, not just the flagged one.

The sensitivity analysis itself needs no schema change either: `campaign-summary.mjs` gains one
new, optional CLI flag, `--exclude-cells <infra-flake-classification.json>`, which filters cells
out of `expectedCellsFromManifest`'s own list before analysis and writes to a caller-supplied output
path (so it never overwrites the primary run). Its own output shape is identical
`CAMPAIGN_SUMMARY_SCHEMA` 2 JSON, just computed over fewer cells — the two documents (primary,
sensitivity) sit side by side, both real `campaign-summary.mjs` output, distinguished only by which
cells went in. This is the "small tested script" the auditor asked for, plus one minimal, additive
flag on an already-existing analysis command — not a new schema anywhere.

Tests (R7, done, not just proposed): committed `9f2aa05` (classifier + `--exclude-cells`, both
verified by deliberately breaking each and confirming the corresponding test failed before
restoring — not just asserted passing on first write). A precedence bug found on auditor review
(the classifier returned on the first `gradle_probe_failed` match instead of scanning all of them,
so an absorbed warning followed by a later unrecovered one was misclassified) fixed and verified the
same way in `f3397db`. The classifier fixture was then rebuilt from actually running the real merged
product code (`buildProbeFailureExcerpt`/`buildProbeFailureWarning`), not a guessed shape,
`9e24f75` — which surfaced a real, now-explicitly-tested behavior: a `recovered:true` warning whose
carried excerpt is itself the jarfs signature (because `cache.js`'s retry logic spreads the first
failed attempt's own excerpt forward into the recovered result) still flags, matching this
section's own symmetric-flagging sentence above, added on the auditor's own review of that finding.
Covers: the regex matches and flags; a generic "Script compilation error" without the jarfs cast
does not flag; a missing/unreadable transcript classifies `"unknown"`, never `false`;
`recovered:false` without the signature counts as `probe_failed_unrecovered`; `recovered:true`
without the signature counts as `probe_failed_absorbed`; `recovered:true` WITH the signature still
flags; `--exclude-cells` with an empty list is byte-identical to today's output.

**5. Infrastructure robustness fix, made before any live session.** While diagnosing the above, a
real, independent infrastructure fault was found and fixed: `schtasks.exe /Run` (the broker's
scheduled-task trigger) can report success while silently failing to start when it races the
previous invocation's own `-Once`/`MultipleInstances=IgnoreNew` teardown, orphaning a queued request
and wedging the broker for every later caller. Fixed in both call sites
(`evidence1-broker-capability-client.psm1`, `evidence1-host-elevated-runner-client.ps1`): bounded
retry-until-claimed (6 attempts, 5s apart, capped so it can never exceed the pre-existing
`-TimeoutMinutes`/pickup-timeout contract), verified RED before GREEN with real Pester/vitest
coverage, committed `6328e60` and `52645fb`. This is a harness/broker change, not a product change
— it does not touch `lib/`, `bin/`, or anything D1/D11 measure, and no live (canary or campaign)
session had run when it was found or fixed.

**A3 (2026-09-29, before any live session):** A correction to A2 §2's own diagnostic provenance,
five further infrastructure fixes made before any live session, confirmation that none of this
reaches the live-session path itself, and confirmation that the anchor source template needed no
re-provisioning.

**1. Correction to A2 §2.** Every diagnostic Gradle invocation A2 §2 cites — probe P1, probe P2, the
12-run frequency test, and the 2 product-smoke-internal runs — executed against the Evidence1
stage-B harness checkout and the Evidence1 NowInAndroid template, not the Evidence2 scenario source,
because of the dot-source parameter-clobbering bug fixed below (`bc7dd6a`). Root cause:
`evidence1-dual-condition-canary-launch.ps1:5-6` declares `$HarnessDir`/`$SourceTemplateDir` with its
own Evidence1 defaults; every guest bundle that dot-sourced it via `. $worker -InternalLibrary` with
no matching arguments silently rebound those two names, in the bundle's own scope, to those
defaults — a directory never changed, a variable did. Confirmed live: the product-identity check
added the same night (`7f3417c`) observed guest HEAD `2c177c0` (the Evidence1 fixture commit) 80
seconds after ToolchainReady had verified `ee6d82b` in the same directory.

The Kotlin/Gradle compiler crash A2 §2 documents (the jarfs classloader-identity cast) is a property
of the pinned guest toolchain (Gradle 9.4.0, Kotlin embedded 2.3.0, JDK 21.0.12.1) and its Gradle
seed, not of which NowInAndroid commit's source is being compiled — the crash counts and rates A2 §2
reports stand unchanged; only their source attribution is corrected here, from the Evidence2 scenario
template to the Evidence1 template. The product fix A2 §1 already records
(`lib/project/cache.js`'s silent-null probe-failure defect) stands on its own merits regardless of
which template exposed it — that defect is in kmp-test-runner's own probe-failure handling, not in
either NowInAndroid checkout.

**2. Further infrastructure fixes, made before any live session.** All harness-only; none touch
`lib/`, `bin/`, or anything D1/D11 measure:
- `7f3417c` — in-guest product-identity assertion in `run-agentic-eval-product-smoke`: an early
  check (guest HEAD, `lib`/`bin`/`.skills` tree hashes, against ToolchainReady's own already-verified
  target) before the pre-clean/seed/clone/Gradle run, and a late check (the measured kmp-test
  envelope's own reported version) after it — both fail-closed, with bounded realpath/reparse-point/
  PATH diagnostics captured every run to explain a future mismatch rather than only detect one.
- `ee6d82b` — LiveRunning failure-reason propagation in `evidence1-provider-runtime-real.psm1`: the
  `provider_runtime_real_worker_failed` path previously discarded the guest bundle's own verdict/
  reason_code/output and stamped two identical back-to-back timestamps instead of the real guest
  transport duration; both fixed.
- `bc7dd6a` — the dot-source fix itself (§1 above): all four guest-bundle dot-sources of the worker
  now pass their overlapping variables back explicitly, plus a generic AST-based Pester guard that
  fails closed on any future dot-source of a `param()`-having script that omits an overlapping name
  — proven against the real pre-fix module history (7 violations found), not only a synthetic case.
- `20b6ef4` — `product_smoke_input_missing` and the two probe bundles' equivalent guards now name
  the specific missing input (`reason_code:InputName`) instead of only the bundle-level reason code
  — confirmed live: the first run after `bc7dd6a` needed a second diagnostic round to learn that
  `SourceTemplateDir`, not one of the other four required inputs, was the one absent.
- `5427357` — source-identity assertion, alongside the pre-existing product-identity one: both
  `run-agentic-eval-product-smoke` (after its clone) and the live session path's own
  `Set-E1AgenticEvalSourceOrigin` (after setting the origin remote) now assert the checkout's HEAD
  and tree against the anchor scenario's own `project_commit`, fail-closed, recorded in the receipt.
  The expected tree is derived from that commit inside the checkout's own repository, never a
  second, externally-supplied value to keep in sync.

**3. The live-session path was audited and confirmed unaffected.** Traced
`Invoke-E1DualConditionCanarySession` (`evidence1-dual-condition-canary-launch.ps1:186`) and every
callee reachable under `-InternalLibrary`: every harness/source-template/attestation/private-root
read goes through `$CurrentCampaignInputs.<field>` exclusively — never a bare `$HarnessDir`/
`$SourceTemplateDir`/etc. All bare references to the worker's other declared parameters exist only in
the file's legacy top-level dispatch path, which is unreachable under `-InternalLibrary` (that branch
returns before the legacy code is ever reached). The clobbered local in `run-agentic-eval-session`
itself (fixed in `bc7dd6a` regardless) was therefore never consumed downstream. Independently, the
published Evidence1 campaign's own provenance was re-verified directly against all 16 raw per-cell
`record.json` files (`705c625c-a72f-47a3-996b-534d2aabccdd`, both `claude-code-{0..7}` and
`codex-cli-{0..7}`): all 16 report `repo_commit` `15ad0dd6598c71fb12754e47ce5b024797f6a033`, matching
that campaign's own declared `ToolchainReady` target commit exactly — zero mismatches.

**4. The anchor source needed no re-provisioning.** The guest's Evidence1-path template
(`C:\kmp-eval\NowInAndroid-evidence1-coverage-threshold-windows-stageb-v1`) is the certified anchor
source: its own `HEAD` and tree, read directly from the guest via `get-dual-condition-plan-bindings`
(a dry-run-only bundle — `Test-Path`/`git rev-parse` only), are `7d45eae4f8720a0c77f507712ba2437ff974b6ed`
/ `42c35b4f46f4fe5dfa23d2e3bf739cb487abb985`, matching the host's own ground-truth clone
(`git rev-parse 7d45eae^{tree}`) exactly. `7d45eae` is also `evidence1-hyperv-warm-canonical-gradle-
cache-direct.ps1`'s own hardcoded anchor commit, confirming this guest template is the one its own
certified Gradle seed was warmed and offline-certified for. The path name is inherited from
Evidence1 (this guest template was provisioned for that campaign, not this one) — a name, not a
provenance gap: every diagnostic run tonight that the dot-source bug silently redirected here
(§1 above) measured this exact, correct anchor commit the whole time, and P4 plus the 12-run
frequency test's own real results already stand as prior, independent confirmation it builds and
tests correctly. Manifest `583a708d-82dd-4e19-b88f-368aa66015cb`'s own `source_template_dir` is
repointed to this guest path (§2's `5427357` now asserts it fail-closed on every future run); no
guest-side re-provisioning, cache warm, or seed change was needed or made.

**5. Scoring clarification, found via real production evidence, fixed before any live session
(`a06c14f`, `1962ef3`).** `codex-cli-0`'s own real incident diagnostic (pulled via
`artifacts.copy_read_only`, incident `6f72634a-a1c3-4521-ae34-3152ad21e274`) failed pre-redaction
schema validation with `task_outcome_mismatch_fields... must be a canonical unique field list, empty
only for a matched outcome` — a real run record lost, not a hypothetical. Root cause: `graders.mjs`'s
`compareKmpEvalResultBlockToObserved` folds `unexpected_key_count` into `matches_observed`
(documented there as deliberate — that diagnostic object is also serialized verbatim into
`terminal_evidence.final_answer_block`'s own closed sidecar schema, shared with the legacy
`checks[]`/`success` gate, which must stay exactly as it was), but `computeTaskOutcome`'s own
`mismatchFields` is built only from `missing_fields`/`mismatch_fields` — so an unexpected-key-only
deviation (every required field present and correct, one extra field beyond the closed set) produced
`task_outcome_matched:false` paired with an empty `task_outcome_mismatch_fields`, tripping
`schemas.mjs`'s own invariant. Fix: `task_outcome_matched` now means content correctness alone
(`missing_fields.length===0 && mismatch_fields.length===0`), computed inline in
`computeTaskOutcome`, never reading `matches_observed`; `computeProductE2eSuccess` (now exported for
direct unit testing) separately requires `unexpectedKeyCount===0`, so a hedged-but-content-correct
answer still fails the metric that decides the study's outcome. `compareKmpEvalResultBlockToObserved`
and the legacy gate are byte-for-byte unchanged. A second commit (`1962ef3`) adds a schema-layer
backstop: `validateRun` now rejects `product_e2e_success:true` whenever
`task_outcome_unexpected_key_count>0`, independent of which code path produced the record. Both
RED/GREEN-verified (the RED case reverted-and-confirmed-failing before the fix, restored after).

**6. Windows long-path hardening, found via real production evidence, fixed before any live session
(commits below).** `claude-code-0`'s own real incident diagnostic (incident
`ccc5fdb2-e583-46f4-b0d2-03c13af4aae0`) recorded `phase:finalizing_matrix` (the untagged fallback)
with `spawn_started:0` and `reason` beginning `ENOENT, The system cannot find the file specified.
'\?\<USER_PATH>` — a raw Win32 `FormatMessage`-shaped message, not Node's own
`ENOENT: no such file or directory, <syscall> '<path>'` format. Confirmed empirically on this exact
host (the same one `56edfac`'s own commit message already established has
`HKLM FileSystem\LongPathsEnabled=1` set): `fs.mkdtempSync` fails past ~260 resolved characters
regardless of that registry flag (measured threshold: succeeds at 201 chars, fails at 267+), while
`fs.mkdirSync`/`fs.realpathSync`/`fs.realpathSync.native`/`fs.readFileSync`/`fs.writeFileSync`/
`fs.statSync` all succeed past 350 — a real, distinct Node/libuv gap `56edfac`'s own delete-side fix
(`fs.rmSync`) never covered. `acquireSharedEvalResources` (`matrix-runner.mjs`) and its callees
(`materializeSkillSnapshot`/`materializeGradleUserHome`/`buildPolicySettingsFile`/`buildPathShim`,
plus the per-cell JUnit-evidence scratch dir) called bare `mkdtempSync(join(tmpdir(), prefix))` in 8
places across `matrix-runner.mjs`/`materialize.mjs`/`condition-launcher.mjs`/`path-shim.mjs`, several
untagged (an untagged throw defaults to `finalizing_matrix`, exactly what was observed) and two
(`materializeScenarioProject`'s fixtureDir, `materializeGradleUserHome`'s own snapshotDir) using
mkdtempSync purely to generate a unique name before immediately deleting/overwriting it. Fix:
`materialize.mjs` exports `mkdtempLongPathSafe`/`allocateTempDirPath` (`mkdirSync`-based, matching
the proven-safe primitive; `baseDir` injectable for deterministic tests, never `process.env`
mutation) — every prior `mkdtempSync` call site in the pre-spawn path now goes through one of these,
and every previously-untagged `acquireSharedEvalResources` call site is now individually wrapped and
tagged `acquiring_shared_resources`; the per-cell JUnit-evidence dir is tagged `materializing_cell`.
On failure, the new primitive's own error message carries `err.code`/`err.syscall`, the candidate
directory's own basename (never the real tmpdir() root), and the full resolved length — never a raw
absolute path. RED/GREEN-verified directly (a deep, git-bash-creatable path that plain `mkdtempSync`
provably fails against; `mkdtempLongPathSafe` succeeds at the identical depth; a normal-length
regression case; the failure-message shape). Separately, `incident-diagnostics.mjs`'s
`finalizeIncident` now always computes and attaches `path_diagnostics` (schema 3/4, additive to the
existing schema 1/2 `failed_cell_correlation` axis) — `temp_dir_length`/`cwd_length`/
`runtime_command_length` (plain integers, never PII) plus `temp_dir_relative`/`cwd_relative` (the
filesystem root stripped; the existing redaction pass is still the backstop) — from this process's
own ambient state, no call site changed, so the next run's own receipt settles this hypothesis
precisely, with or without a live guest shell, whether or not it recurs. One open item, deliberately
not chased further per the one-pass instruction it was raised under: `Invoke-E1BoundedProcess`
(`evidence1-dual-condition-canary-contract.psm1:1225`) uses .NET's `Process.Start` with a
caller-supplied `WorkingDirectory`, a documented separate Windows long-path gap — but that call
necessarily completes (node has to start) before `finalizeIncident` can ever run inside it, so it is
ruled out as the direct source of claude-code-0's own artifact specifically; `path_diagnostics` will
catch a residual `child_process.spawnSync`-level cause (a different, CreateProcess-specific gap) if
one remains.

**A4 (2026-09-29, before any canary): a second, independent infra-flake signature (D13), found live
during the gate's own re-verification after A3 §6 — STOP, not yet mitigated.** After redeploying
commit `f5a5f8d` and re-running the gate on a fresh campaign (`99f67197-93bf-43a0-bd0f-160f2e6eb52e`,
required because `583a708d`'s own `LiveRunning` slot-guard correctly refused to replay a `runs_root`
left behind by its earlier failed attempt — `indeterminate_prior_attempt`, not a defect), its own
`DryRunPassed` product-smoke Gradle build failed: `FAILURE: Build failed with an exception. * What
went wrong: Gradle build daemon disappeared unexpectedly (it may have been killed or may have
crashed)`. `product_identity_verified`/`source_identity_verified` were both still `true` on that same
attempt — the harness/product deployment itself was correct; the daemon death is a separate,
environment-level fault, matching D13's own existing jarfs-cast precedent (an internal Gradle/JVM
process fault, not a shape an agent's own build-script edit can produce).

Root cause, established from the provisioning profile directly, not assumed: this VM
(`Evidence1-Runner-E2E`) is provisioned from
`tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json` with `processor_count: 4`,
`startup_memory_bytes: 8589934592` (exactly 8 GiB), `dynamic_memory: false` — a **fixed**, non-dynamic
8 GiB ceiling, confirmed against the live VM's own `Off`-state inspection the same session. NowInAndroid's
own `gradle.properties` (verified directly against a local ground-truth clone, not assumed from the
auditor's own framing) requests `org.gradle.jvmargs=... -Xmx4g -Xms4g` for the Gradle daemon AND
`kotlin.daemon.jvmargs=... -Xmx4g -Xms4g` for the Kotlin daemon — 8 GiB committed via `-Xms` alone
(committed up front, not merely a ceiling), before Windows itself, before the broker/dispatch
processes, and before the actual forked test JVM `:core:domain:test` needs its own separate heap.
This is systematic memory pressure, not a one-off: the two daemons' own committed floor alone already
equals the VM's entire fixed RAM allocation.

Per the auditor's own explicit instruction, the mitigation choice (an environment-level, symmetric
override of the Gradle JVM args in the seed's `GRADLE_USER_HOME/gradle.properties`, or a VM memory
change) is the auditor's, not applied here. This amendment records the finding and the classifier fix
only; no live sessions ran between finding this and reporting it.

Classifier fix (D13, `infra-flake-classifier.mjs`): `INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE`
(`/Gradle build daemon disappeared unexpectedly/`) added as a second, independent signature alongside
the existing jarfs-cast one — same symmetric guarantee, same `signature_match` outcome, checked both
against the raw transcript text and inside a `gradle_probe_failed` warning's own carried message,
mirroring the jarfs signature's own two check sites exactly. RED/GREEN-verified (the new daemon-
disappeared test reverted-and-confirmed-failing before the fix, restored after; 22/22 pass).

**A5 (2026-09-29, before any canary): systematic Gradle daemon-memory-pressure mitigation
(A4's finding) — resolved as VM memory 8 → 12 GiB plus the pre-existing `gradle.properties`
override, validated by 3 consecutive clean smokes. Two other configurations were tried and failed
for reasons left unexplained; both recorded verbatim below, per the auditor's instruction, rather
than folded into the working explanation.**

**1. Two independent deployment channels can silently drift — discovered live, mitigated by a
manual check, not (yet) an automated gate.** `docs/audits/*.psm1` guest-bundle dispatch (the
`run-agentic-eval-product-smoke` bundle used by every smoke below) runs through the elevated
broker's own deployment (`evidence1-install.ps1 -UpdateBroker`, `deployment_root` under
`C:\ProgramData\KmpEval\Evidence1ElevatedRunner\...`) — a channel entirely separate from
`Invoke-E1RunPrepareHarness`'s sync of the Node harness checkout (`$HarnessDir`, `ToolchainReady`).
Confirmed live: two consecutive post-commit smoke retries silently ran OLD guest code because only
the harness channel had been re-synced — the broker was still deployed at a commit from before this
session's own work (`1cff2a3`), caught by comparing a live receipt's `gradle_memory_override_sha256`
(`undefined`) against the current HEAD's own constant. An automated `broker_deployment_stale`
coherence gate at `ToolchainReady` was proposed and then explicitly deferred by the auditor to land
before publication, not before this canary — substituted for tonight with a one-shot **manual**
check, repeated before every redeploy-and-validate cycle below: local `git rev-parse HEAD`, the
broker's own `after_state.source_git_commit` (from its `-UpdateBroker` report), and
`ToolchainReady.receipt.json`'s `detail.prepare_harness.target_commit`, all three compared for exact
equality. Every redeploy in this amendment (round 3, round 4, and the final merge) was followed by
this check before any smoke ran against it.

**2. Round 1/round 2 (prior to this amendment, restated for continuity — see the commit log, not
repeated in full here): `43de5ca` → bug found by the auditor (unconditionally overwrote
`gradle.properties` with only the memory-cap lines, silently dropping the seed's own
`org.gradle.daemon=false`/`org.gradle.java.installations.auto-download=false`, making the daemon
MORE likely to survive, not less) → fixed round 2, `98f937b`: canonical 5-key content
(`org.gradle.daemon`, `org.gradle.java.installations.auto-download`, `org.gradle.configuration-cache`,
`org.gradle.jvmargs`, `kotlin.daemon.jvmargs`), a fail-closed guard
(`gradle_user_home_properties_unexpected_key`) against silently dropping any future unknown seed key,
and a cross-language SHA-256 test proving the Node constant
(`GRADLE_USER_HOME_CANONICAL_PROPERTIES`) and all three PowerShell guest-bundle copies are
byte-identical. `cfada16` closed a related `.gitattributes` gap (`eol=lf` pin missing for
`evidence1-guest-bundle-contract.psm1`, discovered via an unexpectedly large diff caused by the
Edit tool silently normalizing that file's line endings — functionally harmless, fixed for
completeness). Live-verified working (smoke 1/5, `no_gradle_daemon_survived: true`,
`gradle_memory_override_sha256` matching the then-current constant exactly) once the broker/harness
drift in §1 was caught and both channels redeployed.

**3. Round 3 — VM memory 8 → 16 GiB, jvmargs caps dropped entirely (auditor-directed pivot, a
user-approved direction relayed by the auditor): FAILED, unexplained, left for separate
investigation.** Rationale for the pivot: raising the VM's own memory lets NowInAndroid build with
its own unmodified `gradle.properties`, at full speed — the host has 64 GB RAM with headroom.
Committed `91cb129`: a new host-only, closed-parameter, fail-closed broker script,
`evidence1-hyperv-set-vm-memory-direct.ps1` (`-VMName`/`-ExpectedVMId` closed to the E2E profile,
`-StartupMemoryGiB` restricted to `{8, 12, 16}`, requires the VM already `Off` or fails closed, sets
static memory via `Set-VMMemory -DynamicMemoryEnabled $false`, reads back and fails closed on
mismatch, writes a before/after receipt) — registered in `evidence1-host-elevated-runner.ps1`'s
`$AllowedScripts`, the proven, currently-live dispatch mechanism, NOT the closed capability registry
in `evidence1-broker-capability-contract.psm1`/`evidence1-vm-state-hyperv.psm1`: that path is
explicitly marked "DRAFTED, NEVER EXECUTED CODE" in its own module header and is not wired into any
live dispatch route today. Pester: 8/8 green, the read-back-mismatch assertion RED/GREEN-verified
(temporarily disabled the guard, confirmed the test failed, restored, confirmed green). The
`gradle.properties` override was simultaneously reduced to 3 keys (`org.gradle.daemon`,
`org.gradle.java.installations.auto-download`, `org.gradle.configuration-cache`; the two jvmargs
lines removed), cross-language test and fail-closed guard preserved. Provisioning profile
(`evidence1-windows-hyperv-e2e-v1.json`) `startup_memory_bytes` set to `17179869184`.

Deployed (broker `1cff2a3`-lineage self-update to `91cb129`, 70 scripts, 0 UAC) and dispatched live:
the memory-set script itself succeeded — receipt confirms `before.startup_bytes: 8589934592`,
`after.startup_bytes: 17179869184`, `dynamic_memory_enabled: false` throughout. But
`evidence1-run.ps1` then failed at `VmReady` on `Start-VM`, reproduced twice (once fresh, once after
archiving the receipt and retrying): `HARD STOP: No se pudo iniciar 'Evidence1-Runner-E2E'. No se
pudo inicializar la memoria` (Windows Spanish-locale text for "Could not start
'Evidence1-Runner-E2E'." / "Could not initialize memory.") — verbatim, both times. Host RAM
(`Get-CimInstance Win32_OperatingSystem`) read 63.69 GB total, ~32 GB free both immediately before
and after the two attempts — no top process held more than ~1.5 GB. `Microsoft-Windows-Hyper-V-Worker-Admin`
event-log read was denied (`Attempted to perform an unauthorized operation`) from this session, so
Hyper-V's own stated reason was never observed directly. The VM was cleanly `Off`
(`memory_assigned_bytes: 0`, no stuck/partial state) after both attempts — no cleanup was needed.
**This failure is recorded as observed and unexplained.** The working hypothesis offered at the time
— a Hyper-V-side ceiling below raw host total, most plausibly NUMA-node-scoped memory with no
spanning configured, since plenty of raw free RAM coexisted with a hard, repeatable failure — is a
hypothesis only, not confirmed, and is left to the auditor to take up separately.

**4. Round 4 — 12 GiB, jvmargs caps still dropped: VM started, but the build failed reproducibly
(2/2) with a signature that does not match A4's daemon-death finding. FAILED, unexplained, not
classified as an infra-flake.** Memory-set to 12 GiB (`before.startup_bytes: 17179869184`,
`after.startup_bytes: 12884901888`) succeeded and `evidence1-run.ps1` reached `VmReady` through
`RestrictedReady` cleanly both real attempts (one intervening attempt hit the familiar
`guest_bundle_vm_must_be_running` VM-state hiccup — not a real data point, VM had been power-cycled
between attempts). Both genuine attempts then failed identically at `DryRunPassed`
(`dry_run_product_smoke_failed` / `product_smoke_semantic_mismatch`): `error_codes:
["coverage_data_unavailable"]`, `no_gradle_daemon_survived: true` (the daemon-disabled config was
honored; this is not a daemon-death signature), all 13 JaCoCo modules report "No coverage data"
simultaneously, `COVERAGE_MODULES_CONTRIBUTING: 0`, and the captured stderr tail is truncated
mid-way through a PowerShell "Preparing modules for first use" progress record — verbatim from both
receipts (preserved at
`C:\kmp-eval\scratch\evidence1-run\99f67197-93bf-43a0-bd0f-160f2e6eb52e\stale-12gib-attempt1\` and
`...\stale-12gib-attempt2\`, raw envelope included, archived rather than deleted per this project's
own "never discard, always archive" convention). No `OutOfMemoryError`, no daemon-disappeared text,
and no jarfs signature appear in either transcript. **This is recorded as an unexplained finding,
not as a confirmed cause.** A hypothesis was offered at the time this was reported (the
coverage-XML-dispatch step spawns several new PowerShell-based reader processes immediately after
the build, and on a 12 GiB VM with NowInAndroid's own 8 GiB of Gradle/Kotlin daemon heaps only just
beginning teardown there may be too little headroom for those new process spawns) — labeled here,
as instructed, as a hypothesis, not a finding. Per the auditor's explicit instruction,
`coverage_data_unavailable` is NOT added to `infra-flake-classifier.mjs`: it is also a legitimate
product outcome under other conditions, so it is not an infra-exclusive signature, and D13 stays
signature-based only, unchanged by this amendment.

**5. Final validated configuration.** VM memory: 12 GiB static (`dynamic_memory: false`,
`startup_memory_bytes: 12884901888`), locked into
`tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json` (`07e5d1f`) so a future
re-provisioning matches what was actually validated. `gradle.properties` override: restored to the
round-2 5-key content byte-for-byte (`f5c541d`; confirmed via `git diff` against `cfada16` — the
Node constant and the Pester test file are unchanged from that commit, the guest-bundle `.psm1` diff
is empty too) —

```
org.gradle.daemon=false
org.gradle.java.installations.auto-download=false
org.gradle.configuration-cache=false
org.gradle.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=256m -XX:+HeapDumpOnOutOfMemoryError -Xmx3g
kotlin.daemon.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=320m -XX:+HeapDumpOnOutOfMemoryError -Xmx2g
```

SHA-256: `4d8794cd187e680485b0e9abfa2f41c58b61b7e45a478450a4c84342947bc8f7` — identical to the
original round-2 value, confirming the restoration is byte-exact, not merely equivalent. Validated
by 3 consecutive clean smokes after redeploying both channels and confirming the manual coherence
check (§1) at `f5c541d`: durations 342150 ms, 215174 ms, 215117 ms; all three PASS,
`error_codes: ["coverage_threshold_exceeded"]` (the fixture's own designed semantic outcome, matching
every prior successful round-2 run), `no_gradle_daemon_survived: true`, and
`gradle_memory_override_sha256` matching the value above on all three. `codex/eval-summary-per-cell`
(`90b7e80`, based on `91cb129`, auditor-reviewed and approved, additive-only:
`tools/agentic-eval/campaign-summary.mjs` and its test) was merged after the 3-smoke series and
before this amendment's own commit (merge commit `e58ac85`); its 33-test file passes green on the
merged tree. Final HEAD `07e5d1f`, confirmed coherent (local `git rev-parse HEAD`, the broker's
`after_state.source_git_commit`, and `ToolchainReady.receipt.json`'s
`detail.prepare_harness.target_commit` all equal) before the GREEN gate.

**A6 (2026-09-29, after the first canary attempt, before any further canary): guest disk
exhaustion on canary attempt 1 (campaign `8869d9c2`), remediated by a guest-side cleanup dispatch
(120 of 134 tracked private-root directories deleted, 0 failures, guest C: free space 1.58 GB →
60.4 GB); a separate, still-open HOST-side disk risk found during remediation is recorded here
rather than silently fixed.**

**1. Canary attempt 1 failure.** All four provider sessions (`claude-code` round 0/1, `codex-cli`
round 0/1) failed identically at `LiveRunning` with `reason_code: agentic_eval_session_failed`,
`output_summary.failure_reason: dual_condition_runtime_nonzero_no_evidence`,
`benchmark_status: transport-failed`, and a sanitized diagnostic line reading
`scenario_failed_acquiring_shared_resources_0_1_cells_evaluated_0_spawned_0_raw_persisted_0_spawn_failed_einprogress...`
(receipt: `C:\kmp-eval\scratch\evidence1-run\8869d9c2-8e05-482c-9dae-4f734c9d1d60\LiveRunning.receipt.json`).
The guest's own `inventory-guest-disk-usage` bundle, dispatched during this remediation, confirmed
the mechanism: `c_drive_free_bytes: 1698856960` (1.58 GB) against `c_drive_total_bytes: 136025468928`
(126.7 GB) — 134 tracked private-root directories (`campaign`, `closure-smoke`,
`dual-condition-canary`, `eval-v2-gate`, `live-product-free` modes; every prior smoke, probe, and
canary attempt this whole session) had accumulated on the guest with no cleanup mechanism until
tonight's own `run-agentic-eval-disk-cleanup` bundle (see this document's own commit history,
`docs/audits/evidence1-guest-bundle-contract.psm1`, for that bundle's build-out and its own PS 5.1
transport bug — a separate finding from this one).

**2. Remediation.** Every one of the 134 tracked private-root directories was classified
safe-to-delete or held back by cross-referencing the guest's own inventory against this host's
`C:\kmp-eval\scratch\evidence1-run\<campaign_id>\` receipt trees: a directory is **safe** if (a) no
matching host `evidence1-run` directory exists at all (a probe/smoke/diagnostic byproduct, never a
tracked evidence campaign — `campaign`/`closure-smoke`/most of `dual-condition-canary`'s
`runtime-temp-*`/`preflight-*` entries), (b) an `EvidenceCopied.receipt.json` exists anywhere under
that campaign's host directory, including an archived `stale-*` subfolder (proof the evidence was
copied off the guest at least once), or (c) the host directory exists but never reached
`LiveRunning` (no live evidence was ever generated on the guest for it). Anything else is **HOLD**.
120 of 134 classified safe; dispatched in one `run-agentic-eval-disk-cleanup` call
(`PrivateRootRelativePathsJson` only — `TempDirNamesJson`/`CompactSeedNamesJson` both `[]`, scope
kept to private roots for this round) and all 120 deleted with zero failures. Guest
`c_drive_free_bytes`: 1,698,914,304 → 64,867,917,824 (1.58 GB → 60.4 GB freed). By mode: `campaign`
18 entries/24.31 GB, `closure-smoke` 2/~0 GB, `dual-condition-canary` 84/15.18 GB, `eval-v2-gate`
1/1.40 GB (`99f67197`, cited via its own archived
`stale-post-green-for-inventory/EvidenceCopied.receipt.json`), `live-product-free` 15/15.59 GB (10
of the 15 cited via their own top-level `EvidenceCopied.receipt.json`: `1b15e760`, `689b7772`,
`6a8bbd9d`, `705c625c`, `7867b2bc`, `87126210`, `c7c2432b`, `d16b51fd`, `f01037a8`, `f68688b3`; the
remaining 5 — `275517a4`, `6544d09f`, `a4cbbf04`, `aca2b7cb`, `ccab44c7` — classified safe under
reason (a) or (c), no host `evidence1-run` directory or no `LiveRunning` reached).

**3. HOLD (not deleted, needs an explicit decision).** 14 of 134 entries, 8.30 GB: 7
`closure-smoke` (trivial, <150 KB each), 1 `eval-v2-gate` (`583a708d`, 1.40 GB), 6
`live-product-free` (`011c89b6`, `3003308f`, `8869d9c2` — this canary's own campaign, `9cf40485`,
`a5709dfc`, `e96e3bc5`) — each has a host `evidence1-run` directory that reached `LiveRunning` with
no `EvidenceCopied` receipt anywhere. `8869d9c2` specifically never reached `EvidenceCopied` because
it failed at `LiveRunning` (this amendment's own §1) — its guest-side directory is the only place
any of its partial session output exists; deleting it without a decision would destroy that. The
guest slot guard already retires `8869d9c2` regardless (a new canary id is required next), which
does not by itself make deleting its guest directory safe.

**4. TempDirNames/CompactSeedNames backlog — deliberately out of scope this round.** The compact
per-session Gradle seed copies under the guest's `C:\E1G` (`compact_gradle_seed_copies_bytes:
14035782324`, ~13.1 GB, 27 copies) and the harness-prefixed `%TEMP%` entries
(`temp_harness_prefixed_bytes: 76508406`, 8 dirs) were not touched: both were dispatched empty in
every attempt tonight, and deriving a safe compact-seed name list needs its own verification (the
apparent name↔campaign-id mapping — a compact seed name matches a `dual-condition-canary` campaign
id with dashes stripped — was not confirmed against the guest's actual `C:\E1G\*` directory listing
before this amendment). Left as a follow-up, not folded into this round's dispatch under the
same "verify, don't assume" discipline this session already applied to the private-root list.

**5. Host-side disk risk — found during remediation, NOT remediated, recorded for the auditor.**
The guest's own free-space recovery (§2) does not touch the HOST's disk: Hyper-V differencing disks
are copy-on-write, and deleting files inside the guest does not shrink or compact the underlying
`.avhdx` on the host. Checking the host while verifying this remediation found the host's own `C:`
drive at 12.42 GB free of 1.86 TB (100% used) — `Get-CimInstance Win32_LogicalDisk`, confirmed live,
not estimated. Two Hyper-V VM families under `C:\kmp-eval\` account for 272.27 GB: the live E2E VM
(`hyperv-e2e\Evidence1-Runner-E2E`, 19.2 GB base + one 113.4 GB differencing disk, most recent write
today from this remediation's own guest I/O) and a second, non-E2E-suffixed VM
(`hyperv\Evidence1-Runner`, 16.6 GB base + four differencing disks totaling ~109.8 GB, most recent
write 2026-09-27) whose retirement status is not established here. That accounts for only 272 GB of
the ~1.85 TB actually in use — the remaining ~1.58 TB is outside `C:\kmp-eval\` and outside this
session's own investigation scope. No host-side file was deleted or merged: checkpoint removal
needs Hyper-V's own `Remove-VMSnapshot`/merge path (raw file deletion of a differencing disk in use
can corrupt the VM), and the second VM's own status was not established before this amendment.
Flagged to the auditor before proceeding to any further disk-consuming operation (a fresh GREEN
gate run) — **not yet resolved as of this amendment.**

**A6 addendum (2026-09-29, same day, before the GREEN gate): §5's host risk is resolved, root
cause identified, guard/parity work deferred to publication hardening — not blocking this
campaign.**

**1. Root cause of the 12 GiB gap.** The VM's own `Virtual Machines\<vm-id>.VMRS` file (the
Hyper-V saved-state file) was found to be exactly 12.00 GiB, logical size equal to allocated size
(`GetCompressedFileSizeW`), matching `MemoryStartup` exactly. This is Hyper-V's save-state
reservation for `AutomaticStopAction=Save` — the `New-VM` default, which this repository's
provisioning (`tools/evidence1/provisioning/evidence1-windows-vm.ps1`) never overrides (`grep
AutomaticStopAction`: 0 hits). The reservation exists only while the VM is running; the other,
`Off` VM (`hyperv\Evidence1-Runner`) has no such file. Switching to `AutomaticStopAction=ShutDown`
would release it once the VM is stopped — not yet done, see §3.

**2. Host space resolved directly, independent of any VM change.** The user freed host space
directly: C: free read at 181415559168 B (168.96 GiB) around 22:35 local. Independently
re-verified moments later in this session, live: 280299094016 B (261.05 GiB) — consistent with
continued freeing rather than a stale or one-off reading. Both readings are roughly an order of
magnitude above the worst-case bound this amendment's own §2 established (leaf `(virtual_size -
file_size) + 3 GiB` = 17.55 GiB for the E2E VM's differencing disk as inspected then). The
guest-side crisis this amendment opened with, and the host-side crisis its own §5 found, are both
resolved as of this addendum.

**3. Guard and parity work deferred, not abandoned.** A principled `Invoke-E1RunVmReadyState`
guard (`required = max(15 GiB floor, leaf slack + 3 GiB)`, computed from a live VHD-chain
inspection rather than the flat 15 GiB floor alone) and an `AutomaticStopAction=ShutDown` change
(new host-elevated script, provisioning-profile parity, drift-check coverage) were drafted
mid-session as WO-A7, then descoped once the user's own direct host-space fix made them
unnecessary for this campaign — no campaign data depends on either. Only the already-complete,
green-tested piece was kept: `evidence1-hyperv-inspect-vhd-chain-direct.ps1`'s read-only receipt
now also reports `automatic_stop_action` and `memory_startup_bytes` (`de8473b`), so a future WO
has the evidence already in hand without re-deriving it. The guard and the stop-action change
itself are left to a post-campaign publication-hardening WO, to be validated by a fresh GREEN gate
run on the published harness SHA at that time — not by this campaign's own gate.

**A7 (2026-09-29, decided with the user, before any campaign session; canary `bcf3c82c` continues
to Closed as pipeline validation only, its Codex cells labeled "low (pre-A7)"): reasoning effort
equalized to `high` for both runtimes — a cross-runtime comparison at mismatched effort levels
(Claude `high`, Codex `low`) is not meaningful, and the user wants Claude and Codex compared
against each other, with the skill and in the free arm.**

**1. D2 amended.** Was: Claude `--effort high` (Claude Code's own documented default,
`condition-launcher.mjs:128`), Codex `model_reasoning_effort=low`, with an explicit "no
cross-runtime comparison is drawn from the two labels" restriction (§4, superseded by this
amendment's §3 below). Now: effort equalized at `high` for both. Claude is unchanged (already
`high`, already the documented default). Codex moves from `low` to `high` —
`tools/agentic-eval/models/registry.json`'s `gpt-5.6-terra` entry, `default_reasoning_mode: "low"`
→ `"high"`, the only entry changed. `reasoning_effort_requested`/`reasoning_effort_source`
(schema v9, D2's own per-cell recording mechanism) are unaffected in shape — they will simply
record `high` for Codex going forward instead of `low`.

**2. Models stay tier-matched.** `claude-sonnet-5` ↔ `gpt-5.6-terra` is unchanged — the
"Balanced" pair (`docs/audits/evidence1-stabilization-plan.md` §6.1). Equalizing effort is a
control-variable change, not a model-selection change; D1/D11's product baseline and the two
runtimes/models under §4 are otherwise as written.

**3. Analysis plan gains a DESCRIPTIVE cross-runtime comparison.** §6/§8's existing per-runtime
metric definitions and analysis command are unchanged in mechanism; added on top, within each
arm (product, free) separately: Claude vs Codex on the same metrics already collected per cell —
key facts, tool calls by kind, wall-clock duration, tokens, cost, turns — n=4 per cell per
runtime, reported descriptively (medians/ranges, no significance test, no ratio claim, no
"faster"/"better" language). This is a comparison of two products at matched effort, not a claim
that `high` means the same effective thing across them mechanically — §4's own qualifier on that
point stands; only the blanket "no cross-runtime comparison is drawn" restriction is superseded,
specifically for this descriptive, same-arm, same-metrics comparison.

**4. New canary required under the amended controls, with session-ceiling accounting.**
`bcf3c82c` (canary 1, pre-A7 Codex effort) already spawned 4 real provider sessions; `8869d9c2`
(the disk-exhaustion failure) spawned 0 (failed before any session started). A new canary under
the A7-amended registry spawns 4 more, and the campaign spawns 16 (D8) — running total
0 + 4 + 4 + 16 = 24 sessions against this closure's own 24-session ceiling: exactly at the
ceiling, not over it.

**A8 (2026-09-30, before canary 2 `4ec724d9`; docs-only, no code changes): canary 1 (`bcf3c82c`)
outcome recorded per cell, the deterministic fixes since GREEN `dc9f5da7` cited by SHA, canary 2's
justification under D8, and the Claude OAuth freshness check ahead of the campaign's own
auth-failure rule.**

**1. Canary 1 (`bcf3c82c`) outcome, per cell.** LiveRunning ended `FAIL`
(`reason_code: one_or_more_provider_sessions_failed`), followed by failure-safe closure —
`bcf3c82c` never reached `EvidenceCopied`/`Closed`. The per-cell evidence below was retrieved
afterward via the separate, read-only `artifacts.copy_read_only` capability (operation ids
`f82265c9…`, `940223ab…`), not the campaign's own automatic copy path.
- `claude-code` round 0 (product): **rejected**, `noPreInferenceFailureOk`
  (`tools/agentic-eval/cell-integrity.mjs`) — HTTP 401, "OAuth access token has expired," zero
  usage recorded. An existing rule (§7: "Rejected, any other reason → missing data, with its
  rejection reason stated") firing on a provider/auth event, not a harness or product defect.
- `codex-cli` round 0 (product): **accepted**.
- `codex-cli` round 1 (free) and `claude-code` round 1 (free): both **transport-failed at
  finalization** — confirmed by reading both cells' own `incident.json` (schema 3,
  `phase: "finalizing_matrix"`), identical reason on both: `Run record [0] (repetition 0,
  no-skill) failed pre-redaction schema validation: [{"field":
  "outcome_assessment.task_outcome_mismatch_fields","message":"must be a canonical unique field
  list, empty only for a matched outcome"}]` — the D5 requested-field vocabulary drift (`'total'`
  surviving in `TASK_OUTCOME_MISMATCH_FIELD_VALUES` where the grader already emitted
  `'test_count'`), a harness defect, not a product or provider failure. Both incidents' own
  `counts` show `raw_persisted: 1, spawn_failed: 0` — the sessions ran and produced real evidence;
  only the run-record finalization step failed.

**2. Deterministic fixes since `dc9f5da7`, by SHA.**
- `c1cd938` — the vocabulary drift's single source of truth:
  `TASK_OUTCOME_MISMATCH_FIELD_VALUES` (`outcome-assessment-contract.mjs`) corrected
  `'total'`→`'test_count'`; `graders.mjs`'s own `KMP_EVAL_RESULT_FIELD_ORDER` now imports that
  constant instead of maintaining a second literal array; `analysis.mjs`'s `TEST_COUNT_FIELDS`
  corrected the same way. This is the fix for §1's free-arm incidents above.
- `3a74db7` — the Gradle basename classifier (`GRADLEW_TOKENS` Set → `GRADLEW_TOKEN_RE` basename
  regex, `command-classify.mjs`). Grading-time only: it makes a Gradle call that was previously
  misclassified `other-bash` visible to the classification and policy rules that already existed
  for `tool_kind: gradle` (`evaluateGradleAttempt`, the `bash_tool_use_present` policy check) — it
  does not change what either rule requires or permits, and does not touch `policy-hook.mjs`'s own
  separate, narrower `GRADLE_LEADING_TOKENS`, which gates live dispatch and is unaffected.
- `7b635ee` — test-only (`tests/vitest/evidence1-final-codex-host-ops.test.js`'s own
  `literalRunnerArray` helper); no `docs/audits/*.ps1` file touched.
- `1143968`, `6485c00` — read-only host-elevated forensic scripts (guest directory listing; guest
  credential file `LastWriteTimeUtc`/`Length` only, never content), both outside the live
  session/product dispatch path.

**3. Canary 2's justification.** D8: "One canary repeat is permitted, and only after a
deterministic fix." All three of §2's fixes are deterministic (harness/grading/test, not product)
and land after `bcf3c82c`'s own failures were root-caused — the repeat is the one D8 already
permits, not an additional one. This canary is also the second "4" in A7 §4's own running-total
accounting: `bcf3c82c` spawned 4 sessions, the disk-exhaustion failure `8869d9c2` spawned 0, this
canary spawns 4 more, the campaign spawns 16 — `0 + 4 + 4 + 16 = 24`, exactly A7 §4's own ceiling,
not a new or additional budget line.

**4. GREEN `dc9f5da7` at `c1cd938`: PASS 10/10** — `BrokerReady`, `VmReady`, `ToolchainReady`,
`AuthReady`, `RestrictedReady`, `DryRunPassed`, `LiveAuthorized`, `LiveRunning` (4/4 cells
accepted, 0 semantic rejections), `EvidenceCopied` (4/4 cells copied), `Closed` (publication
committed, 8 artifacts). The canary SHA differs from `dc9f5da7`'s own `c1cd938` only by §2's
`6485c00`/`7b635ee`/`3a74db7` plus this amendment itself (docs-only) — `git diff --stat
c1cd938..HEAD` confirmed a clean linear chain of exactly those 3 commits, nothing else in
between. Full vitest suite at the canary SHA: 8455 passed, 0 failed, 165 files, 4 skipped
(pre-existing, unrelated to this round's changes).

**5. Claude OAuth freshness, ahead of the campaign's own auth-failure rule.**
`Evidence1RuntimeState\claude\.credentials.json`: `last_write_time_utc: 2026-09-29T21:30:09.398Z`,
`length_bytes: 509` (content-free stat, VM confirmed `Off`) — checked the same night, ahead of
this canary. This is supporting evidence only, not a guarantee: the campaign's own GO still
requires canary 2's Claude cells to be free of a `noPreInferenceFailureOk`-shaped auth rejection
like §1's `bcf3c82c` one. Should canary 2 hit the same failure mode, the existing rule applies
unchanged — rejected, not replaced, disclosed — same as §1 records for `bcf3c82c`.

**A9 (2026-09-30, before the campaign; docs-only, no code changes): canary 2 (`4ec724d9`) results,
the D9 classifier freeze values, a correction to A7 §3's own cross-runtime metric list, the cost
method the campaign will actually use, and a host-quiescence commitment for the campaign's own
LiveRunning window.**

**1. Canary 2 (`4ec724d9`) outcome.** All 10 states `PASS`, SHA `1f00eb5a8f80a6d5e2234c969a0cd2c4078d4811`
(A8). LiveRunning: 4/4 cells **accepted** — §1's `noPreInferenceFailureOk` auth rejection did not
recur (both Claude cells accepted; the credential file's own `last_write_time_utc` was unchanged
by the canary, i.e. no token refresh occurred, and the existing session was valid throughout).
Controls verified per-cell: `reasoning_effort_requested: "high"` on all 4 (Claude via
`harness-pinned-cli-flag`, Codex via `model-registry-default-reasoning-mode` — different sources,
both resolving to A7's own equalized value). Both free-arm cells (`codex-cli-1`, `claude-code-1`)
graded `task_outcome_matched: false` — a real free-baseline result on this anchor scenario, not a
harness defect (both cells still accepted per §7's own rule); `product_e2e_success` is `null` on
both, exactly as D5/graders.mjs already requires for any condition other than `current-skill`.

**2. Gradle classification verified — 3a74db7's own precondition for D9 satisfied.** Every
gradle-mentioning entry in each free-arm cell's `executed_commands` (schema v9) was checked two
ways: the audit sidecar's own `tool_calls[].tool_kind` for that attempt, and a fresh
`classifyBashCommand` re-run against the same raw string from the current `command-classify.mjs`.
9 gradle-mentioning commands total (4 in `codex-cli-1`, 5 in `claude-code-1`); every pure `gradlew`
invocation classified `gradle` in both checks, and every compound or non-invocation mention (a
`Get-Content`/`cat` reading a `.gradle.kts` file, a semicolon-chained command whose first token
isn't `gradlew`) correctly classified `other` in both — zero misses, zero false positives.
Disclosure: the forms actually used this canary (`.\gradlew.bat` via Codex's PowerShell wrapper,
bare-forward-slash `./gradlew` from Claude) were both already recognized by the pre-3a74db7 token
Set; this canary's own traffic did not happen to exercise the specific bare-`.\gradlew`-without-`.bat`
or absolute-path forms 3a74db7 newly covers. The fix stays justified by the direct, reproducible
testing already on record, not by this canary having needed it.

**3. D9 classifier freeze.** `infra-flake-classifier.mjs` classified all 4 cells `infra_flake_suspected:
false, reason: "clean"` (rollup: 0 flagged / 0 absorbed / 0 unrecovered / 0 unknown, all four
(runtime, arm) pairs) — no jarfs environment fault this canary. Frozen values, computed from this
canary's own real transcripts and independently recomputed after the WO-C12 port (§4 below) to
confirm the port changed only the CLI entry guard: `INFRA_FLAKE_CLASSIFIER_VERSION = 1`;
`logic_sha256 = sha256(INFRA_FLAKE_SIGNATURE_RE.source + '\n' +
INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE.source + '\n' + classifyTranscriptText.toString()) =
f91985672fcc1df147f2b3e56c11ca104f870502dac8bba4e8ed524235590b0f`. Unchanged before and after the
port (recomputed, not assumed). The campaign's own analysis output records both values per D9's
own requirement, so a later classifier change is visible as a version difference, never a silent
drift.

**4. Analysis tools converged from the publication branch (`75f4fba`).**
`campaign-summary.mjs`, `infra-flake-classifier.mjs`, and their tests were ported from
`codex/wo-c12-grid-redesign` tip `783623d` — strict supersets of the eval branch's own copies
(byte-identical to shared base `86359b3`, confirmed by diff before porting). Includes the
CLI-entry-guard fix (`import.meta.url` vs `file://${argv[1]}` never matches on Windows) verified
by a real, non-empty-JSON subprocess run; §3's `logic_sha256` recomputed identical before and
after, confirming the port touched only the CLI guard, never the frozen classification logic.
`readme-evidence.mjs`/`evidence2-tables.mjs` stay canonical on #537 and are not ported. Full
vitest suite green post-port: 8458 passed, 0 failed, 165 files.

**5. Correction to A7 §3 — `num_turns` is not a cross-runtime metric.** A7 §3 listed "turns" among
the metrics compared descriptively across runtimes within each arm. Canary 2's own real data shows
why that is not meaningful: Codex reports exactly `num_turns: 1` on both its cells (one non-interactive
session, one reported turn, by construction of how Codex CLI's own result event counts turns), while
Claude reports `5` and `12` (Claude Code counts assistant turns within the session). This is not a
capability difference the study is trying to measure — it is two runtimes defining "turn" differently
at the CLI level. `num_turns` is struck from A7 §3's cross-runtime list and reported per runtime only,
never compared. Every other metric A7 §3 lists (key facts, tool calls by kind, wall-clock duration,
tokens, cost) is unaffected — each is already defined identically per runtime (D12 for tokens/cost;
`tool_kind` values are the same closed enum for both via `command-classify.mjs`).

**6. Cost method the campaign will actually use.** Canary 2 confirms D12's fallback path is the
live path, not a hypothetical: `total_cost_usd` came back `null` for every cell on both runtimes
(Claude: `"not present on this runtime's result event schema"` under OAuth; Codex:
`"no_cost_reporting"`). D12's token-based estimate (`cost-estimate.mjs`, real published per-token
pricing for both models, `uncached_input_may_be_cache_writes` disclosed for Codex) is therefore
the campaign's primary and only cost figure for both runtimes — not a fallback used for one and
real billing for the other. No amendment to D12 itself; this confirms it was already the right
design for exactly this situation.

**7. Host quiescence — a commitment for the campaign, informed by the canary.** No heavy host
workload (a GREEN/gate run, Docker, a full vitest/Pester suite) ran during canary 2's own
LiveRunning window (2026-09-29T23:01:17Z–23:23:47Z) — confirmed by this session's own action log,
not inferred. The campaign's own LiveRunning window will be held to the same discipline: any WO-A8
work during the campaign runs in a separate worktree, single-file test runs only, no full suite
until the campaign's own LiveRunning completes — so wall-clock duration and the provider/worker
timeout budgets stay uncontaminated by host contention neither runtime's own numbers are meant to
reflect.

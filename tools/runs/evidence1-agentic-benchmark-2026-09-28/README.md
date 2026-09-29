# Evidence1 agentic benchmark — Claude Code vs Codex CLI, product-assisted vs free-baseline

2026-09-28

## Summary

- **Runtimes**: Claude Code (`claude-sonnet-5`) and Codex CLI (`gpt-5.6-terra`, low reasoning effort
  — see Models).
- **Scenario**: `coverage-threshold-failure-v2` — NowInAndroid's `:core:domain` module, one
  pre-registered coverage-gate task. Single scenario (see Limitations).
- **Conditions**: `product-assisted` (skill available and explicitly invoked) vs
  `free-baseline-no-product` (skill not installed and `kmp-test` absent from PATH; product files —
  the skill snapshot, the kmp-test shim — and the harness checkout remain on disk regardless of arm,
  see Experimental controls and threats to validity — not merely an instructed no-use condition; see
  Terminology).
- **Design**: 4 repetitions per runtime per arm, counterbalanced AB/BA/BA/AB order — 8 cells per
  runtime, 16 cells total. Preceded by a 4-session canary (1 cell per runtime per arm).
- **Primary result (key facts)**: 16/16 in the campaign, 4/4 in the canary — correctness is at
  ceiling in both arms, both runtimes. At n=4 per group, this design cannot distinguish product from
  free on this metric.
- **Within claude-code**, product vs free: no wall-clock difference at the median (189.9 s vs
  191.2 s), fewer tool calls with the product (4 vs 13), and a lower estimated cost with the product
  ($0.086–$0.137 vs $0.146–$0.218). Full-answer match: 4/4 with the product (0/1 in the canary — see
  Results), 0/4 with the free baseline — a mismatch on `total`/`passed`; the declared values are not
  recorded, so the cause cannot be independently confirmed for the free arm (see Results). Strict
  success is product-only: 4/4.
- **Within codex-cli** (fixed at low reasoning effort throughout — see Experimental controls): wall-
  clock differs between arms at the median — product 290.1 s (198.4–476.9), free 222.0 s
  (195.3–251.8); tool calls product 13 (4–27), free 12 (8–24). The product arm's higher median and
  wider range trace to two cells where the agent invoked kmp-test 6 and 4 times (retries 5 and 3)
  rather than once; the other two product cells were clean (1 invocation, 0 retries) at 198.4 s and
  224.5 s. Full-answer match / strict success: 0/4 with the product (H15 in every case, and in every
  case the only failing check — the product's own terminal evidence matched expected — see Results),
  0/4 with the free baseline.
- **No cross-runtime comparison, no ratio, no winner, no pooling of canary and campaign data** — see
  Experimental controls and threats to validity for why two runtimes measured under genuinely
  different conditions cannot be ranked against each other here, and Metric definitions for the
  design.
- **Cells declared / accepted / rejected / missing**: canary 4/4/0/0; campaign 16/16/0/0.

## The Windows execution-policy bug (H1) and why this document exists

Every agentic campaign run on the `Evidence1-Runner-E2E` VM (Windows 11 Pro, no PowerShell 7 on
`PATH`) between 2026-09-14 and 2026-09-23 measured a broken harness, not the product. The 2026-09-10
canary is a separate case, excluded from that range deliberately: H1 demonstrably did not manifest
there (product 3/3 strict success with real `kmp-test` envelopes — Skill → describe → parallel
filtered, ~120s). The likely reason — PowerShell 7 on that VM, present in August 2026 — is not
recorded for that specific date; that canary is a separate campaign and is not pooled with either
the broken-harness data above or anything measured below.

Root cause: on Windows, `kmp-test`'s script-backed subcommands (`parallel`,
`changed`, `android`, `benchmark`, `coverage`) and `update` spawned `powershell.exe`/`pwsh` with no
`-ExecutionPolicy` override. `pwsh` (PowerShell 7) defaults to `RemoteSigned` and is unaffected, but
kmp-test falls back to Windows PowerShell 5.1 when `pwsh` isn't on `PATH` — and 5.1's own default
policy on a client Windows edition that has never had one explicitly configured is `Restricted` (a
restrictive GPO produces the same effective policy). Under `Restricted`, PowerShell refused to load
the `.ps1` wrapper at all, before a single line of it ran. Every one of the five script-backed
subcommands then silently fell through to the legacy output parser against completely empty stdout
and reported a soft `no_summary` (0 tests, `exit_code 1`) in under a second — indistinguishable from
"ran fine but produced nothing parseable." This is the exact failure mode this closure's own gate
(below) reproduces and then resolves.

Fixed in [PR #521](https://github.com/oscardlfr/kmp-test-runner/pull/521) (squash commit `da990280`,
merged into `develop` 2026-09-27): both spawns now pass `-ExecutionPolicy Bypass`, scoped to that one
child process only. A new discriminated code, `errors[].code: "wrapper_no_output"` (`ENV_ERROR`, exit
`3`), replaces the misleading soft `no_summary` for this specific failure class going forward, so a
future recurrence (a different missing-shell/permission cause, for instance) is diagnosable instead of
silent.

**Consequence for this document**: every campaign on the `Evidence1-Runner-E2E` VM before this fix
measured whether an agent could work around a broken harness, not whether it could use the product
correctly. That data is quarantined, not reinterpreted or blended with what follows (2026-09-10's own
campaign is a separate case per the previous paragraph — H1 did not manifest there — also not blended
in). Everything below this
point measures product code (`lib`, `bin`, `scripts`, the skill) identical to `develop`@`da990280`
(gate validation below; harness commit `47783fa`) and to the `v0.15.0` tag (canary and campaign).

## Terminology

Neither condition is a blind or unaided agent. Both run inside their own CLI, with a guided task
prompt and whatever prior knowledge the underlying model already has.

- **`product-assisted`** — the skill is genuinely present and the agent is explicitly instructed to
  invoke it before any Bash call (see Treatment texts for the exact wording).
- **`free-baseline-no-product`** — unlike this project's earlier `raw-gradle-no-kmp` benchmarks
  (an *instructed* no-use condition, with the tool still reachable), `kmp-test` is absent from the
  free arm's PATH and the skill is not installed (verified by construction:
  `condition-launcher.mjs`'s `envWithoutPathEntry` + `envWithoutProductHarnessSurface`,
  defense-in-depth at two independent layers). The harness's own copy remains on the guest disk (the
  harness runs from there), and no free-baseline cell was observed invoking it (kmp-test
  invocations in free cells, per `campaign-summary.mjs`'s `by_runtime_arm[].kmp_test_vs_gradle`:
  canary `kmp_test_count: 0` for both `claude-code` and `codex-cli` free cells (n=1 each); campaign
  `kmp_test_count: 0` for both runtimes' free cells again, now at n=4 each) — stated as an
  observation backed by campaign data, not a claim that the binary is literally unreachable by an
  agent that went looking on the filesystem.

No claim in this document should be read as a cross-provider "winner" headline (see Metric
definitions) — Gradle can never produce this scenario's terminal evidence shape, so free-baseline
cannot win strict `success` regardless of how correct its answer is, by design, not by provider skill.

## Design

One pre-registered scenario, two runtimes, two arms per runtime, 4 repetitions per runtime in a
counterbalanced AB/BA/BA/AB order — 8 cells per runtime, 16 cells total:

- Runtime `claude-code`, campaign design `claude-product-vs-free-baseline-v1`: order
  `[[A,B],[B,A],[B,A],[A,B]]`, `repeats: 4`.
- Runtime `codex-cli`, campaign design `codex-product-vs-free-baseline-v2`: order
  `[[A,B],[B,A],[B,A],[A,B]]`, `repeats: 4`.
- Cell `A` = `condition: current-skill`, `product_access_mode: product-assisted` ("product").
- Cell `B` = `condition: no-skill`, `product_access_mode: free-baseline-no-product` ("free").

A 4-session canary (1 cell per runtime per arm) preceded the campaign; canary results are reported
separately and are not pooled into the campaign's own n=4/arm/runtime.

## Scenario

`coverage-threshold-failure-v2`. Tagged `train`: the skill was tuned against this scenario family
(stated as a limitation below, not concealed).

- Project: NowInAndroid (`android/nowinandroid`), pinned commit
  `7d45eae4f8720a0c77f507712ba2437ff974b6ed`.
- Target module: `:core:domain`.
- Ground truth: `outcome_kind: coverage_threshold_exceeded`, `missed_lines: 23`, `threshold: 15`,
  `modules_contributing: 1`. Real test count: 4 (both kmp-test's `individual_total` and Gradle's own
  `tests.total`/`passed` agree). kmp-test's own task-dispatch `tests.total` is 1 (one module
  dispatched) — a different number from the real test count 4; see Metric definitions.

## Models

- Claude Code, runtime `claude-code`, model `claude-sonnet-5`, CLI version `2.1.238`
  (`get-cli-version` bundle, canary and campaign `ToolchainReady.receipt.json`). Requested model
  equals resolved model in every record.
- Codex CLI, runtime `codex-cli`, model `gpt-5.6-terra`, CLI version `0.154.0` (same source).
  Requested model equals resolved model in every record. The registry's `default_reasoning_mode` for
  this runtime is `"low"`, passed through explicitly as `-c model_reasoning_effort=low`
  (`tools/agentic-eval/runtimes/codex-cli.mjs:302`) — set, but not recorded per cell; the only proxy
  is `usage.reasoning_output` (present for Codex, always null for Claude).
- **Claude's reasoning/thinking effort is UNCONTROLLED and UNRECORDED, not "defaulted."** No argv,
  config, or env wiring in this harness sets it for Claude Code at all
  (`tools/agentic-eval/runtimes/claude-code.mjs:215-222` — the adapter accepts an additional model
  only when its registry entry has `default_reasoning_mode: null`, precisely because no corresponding
  argv/config wiring exists to apply a non-null value). This is an absence of control, not a known,
  comparable setting. Claude Code's own documentation
  (`code.claude.com/docs/en/model-config`, "Adjust effort level") describes a three-step resolution
  order — an explicit choice (env var, `--effort`, `/effort`), then a saved per-model setting, then
  the model's own default (`high` for `claude-sonnet-5`) — and states plainly that "effort levels
  control adaptive reasoning, which lets the model decide whether and how much to think on each step."
  None of this harness's own code sets any of the first two, so resolution would fall through to the
  documented default *if* nothing else intervenes — but that has **not** been verified against CLI
  2.1.238 specifically, nor is it established whether the guest's runtime state directory
  (`CLAUDE_CONFIG_DIR`) carries a saved per-model setting from a prior session that would resolve
  first, before the documented default is ever reached. See Experimental controls and threats to
  validity, item 5.
- **The two runtimes are consequently not run at comparable, both-known reasoning/effort settings**:
  Codex is pinned to low reasoning effort, set and code-verified though not recorded per cell; Claude
  Code's effort is neither set by this harness nor recorded, and its actual value here is not
  established. This is one more reason results are never read as a cross-runtime "winner" comparison
  (see Metric definitions, Terminology, Experimental controls and threats to validity).

## Method

Each cell: (1) the scenario's pinned NowInAndroid commit is materialized into a fresh, isolated
worktree; (2) a per-condition environment is built — the product arm gets `kmp-test` on `PATH` (a
thin wrapper pinned to this harness's own `bin/kmp-test.js`, never a global install) and the skill
installed; the free arm gets neither, removed at two independent layers (PATH-entry stripping plus a
harness-surface env-var scrub) rather than merely instructed not to use them; (3) the runtime adapter
(Claude Code or Codex CLI) dispatches the treated prompt as a real, non-interactive session and
records the structured transcript; (4) the transcript is graded against the scenario's own
pre-registered expected outcome — module identity, outcome kind, and the specific numeric facts in
Metric definitions below — never against a live re-run of the task; (5) accepted cells are published
to a private evidence root and a decouple-audited public root; `campaign-summary.mjs` aggregates
per-runtime/arm statistics from the accepted (and D3-reclassified negative) records only.

## Environment

Windows 11, isolated Hyper-V VM (`Evidence1-Runner-E2E`), cold Gradle cache with a compact prewarmed
seed. During a live session (`RestrictedReady.receipt.json`, verified against the canary,
`7867b2bc`): network mode `restricted`, adapter connected, default-outbound firewall `Block`, with
exactly seven pinned hosts allowed through — `api.anthropic.com`, `platform.claude.com`,
`claude.ai`, `claude.com`, `auth.openai.com`, `chatgpt.com`, `ab.chatgpt.com`. No package-repository
host is pinned, so Gradle runs entirely from the prewarmed seed, never a live resolve. The
records' own `execution_profile.network_mode` is `"restricted"`, matching this. This is distinct
from the no-provider gate-validation runs, which run fully network-`offline` (see
`Closed.receipt.json`'s `network_result` for those) — the two are not the same claim and are not
conflated here.
Applied identically to product and free arms, both runtimes:

- Gradle configuration cache disabled (`org.gradle.configuration-cache=false` in the per-cell
  `GRADLE_USER_HOME`) — the sealed network + compact seed left `aapt2` unresolved otherwise; a
  normally-networked environment would not need this.
- Claude Code's own Bash timeout raised (`BASH_DEFAULT_TIMEOUT_MS`/`BASH_MAX_TIMEOUT_MS=600000`) so a
  still-running command doesn't move to background mid-measurement.

## Treatment texts (exact)

Both runtimes, free arm (`no-skill`): the invocation is byte-for-byte the scenario's own prompt
text, unmodified. No treatment applied.

Both runtimes, product arm (`current-skill`):

- Claude: prepends exactly —
  `Before any Bash call, invoke the Skill tool with skill "kmp-test-runner:kmp-test-runner". Wait
  for its result and apply its decision protocol to the task below. If the Skill tool cannot load
  that exact skill, stop without running tests; do not reconstruct it from memory.`
  — then a blank line, then the scenario prompt, unmodified.
- Codex: prepends exactly `$kmp-test-runner`, then a blank line, then the scenario prompt,
  unmodified.

Skill snapshot: `PINNED_SKILL_SHA = 27c943dc392675f78209a78ce09adb4f79283e3e` — the `v0.15.0` release
tag's own commit, materialized via `git archive` (`tools/agentic-eval/cli.mjs`). Advanced from the
original `2112aed96686ee159f851e00c2efa553e58473fc` pin per D1 (measure the POST-fix PUBLISHED
version), before any live session of this closure. `SKILL.md` itself is unchanged between the two
pins — the skill text measured here is identical to the one the separate 2026-09-10 canary measured.
Three reference-doc files differ (`.claude-plugin/plugin.json`'s version string aside):
`references/cli/envelope-schema.md`, `references/cli/exit-codes.md`,
`references/troubleshooting/no-summary.md` — updated across PR #521/#523 to document the new
`wrapper_no_output` error code and coverage-field additions this closure's own H1 fix and a parallel
workstream introduced. Documentation of already-measured product behavior, not a change to the
skill's own decision logic.

## Metric definitions

**Primary, arm-neutral: "key facts."** Does the agent's final claim (or, for product, the terminal
tool envelope) name module `:core:domain`, `outcome_kind: coverage_threshold_exceeded`,
`missed_lines: 23`, and `threshold: 15`? Computable identically for kmp-test and Gradle evidence,
unlike strict `success`.

**Secondary:**
- Full-answer match: the above, plus `total: 4`, `passed: 4`, `failed: 0`, `modules_contributing: 1`
  — the stricter metric an agent fails if it echoes kmp-test's own task-dispatch count (`total: 1`)
  instead of the real test count (4).
- Efficiency: duration, tool call count, retries.
- Strict `success`: reported **only for the product arm**, explicitly labeled "product protocol, not
  a cross-arm comparison" wherever shown — never used to compare runtimes or arms against each other.

## Cell treatment rules

- **Accepted** (integrity checks pass) counts in its arm's denominator, including when the semantic
  answer is wrong. A negative result is a valid observation, not something to discard.
- **Rejected, Codex, abandoned-command criteria** (all five conditions defined in
  `docs/audits/evidence1-preregistration.md` section 7) counts as a valid **negative** observation:
  outcome = its own `outcome_assessment` (normally negative); listed separately as "the agent closed
  the turn with N command(s) still in progress."
- **Rejected, any other reason** counts as missing data, with its rejection reason stated — not
  silently dropped, not counted as a data point either.
- No retries, no cell replacement, in canary or campaign. The canary alone may repeat once, and only
  after a deterministic fix.

## Gate validation: the measurement instrument, proven in both directions

Before spending any live session, this closure validated that the measurement pipeline itself
correctly discriminates a broken product from a fixed one — using zero real agent sessions. Two
fixtures (deterministic stand-ins for the Claude Code / Codex CLI runtimes, already used by this
harness's own test suite) gained an additive branch that fires only when their working directory is
the real materialized scenario workspace: instead of a canned literal, they genuinely invoke the real
`kmp-test` CLI (product arm) or `gradlew` directly (free arm) and relay whatever actually happens
through the same grading pipeline live sessions use. This exercises the real harness end to end — real
product code, real Gradle, the real isolated VM, zero API cost, zero live sessions — twice, against
two different commits:

| | Product (both runtimes) | Free (both runtimes) | Cells accepted | Campaign state |
|---|---|---|---|---|
| **RED** — pre-fix (before `da990280`) | `success:false`; grading fails at `authoritative_target_matches_expected` ("envelope names no module at all: no_summary / incoherent scope"); 1470ms (codex-cli) / 1847ms (claude-code) | Real `gradlew` build succeeds | 4/4 | `Closed`, 0 sessions, no UAC |
| **GREEN** — post-fix (`da990280`, this document's own harness commit) | `success:true`; `outcome_kind:coverage_threshold_exceeded`, `total:4`, `passed:4`, `failed:0`, `missed_lines:23`, `threshold:15`, `modules_contributing:1`, `exit_code` matches expected; 140232ms (codex-cli) / 147583ms (claude-code) — a real Gradle test+coverage run, not an instant failure | Real `gradlew` build succeeds | 4/4 | `Closed`, 0 sessions, no UAC |

Nothing about the gate mechanism differs between the two rows — only the guest's own `repo_commit`
does. The RED run's product cells reproduce H1's exact symptom (the soft `no_summary` described
above); the GREEN run's product cells succeed with the scenario's exact expected numbers the moment
the fix lands underneath the same mechanism. This is evidence the instrument works, not a benchmark
result — it says nothing about how a live agent performs and is never pooled with the canary/campaign
numbers below. Figures are each cell's own `record.wall_clock_ms` (`c7c2432b` for RED, `6a8bbd9d` for
GREEN); both product cells' `observed_result` in each row report the exact numbers shown, not an
approximation.

**Two re-validation GREENs**, run after the harness changes below landed (same mechanism, same
scenario, zero live sessions): `87126210` (harness commit `97139fa`) and `d16b51fd` (harness commit
`bbefc60`) — both report the identical product-cell scenario numbers as the original GREEN above
(`outcome_kind:coverage_threshold_exceeded`, `total:4`, `passed:4`, `failed:0`, `missed_lines:23`,
`threshold:15`, `modules_contributing:1`), confirming the harness changes made between the original
gate and the canary did not alter the measurement instrument's own behavior on the no-provider path.

**Harness changes between the gate and the canary** (all failure-path-only — none touch the prompt,
skill, grader, classifier, or the success/no-provider path the gate validates above):
- Fail-safe closure on a mid-campaign crash (best-effort VM-off/network-offline): `70fe951`,
  `15f2dde`.
- Broker fast-fail on an unpicked-up or stalled request, and run-level stall recovery made
  state-based rather than message-based: `f0db67d`, `97139fa`.
- Stop replaying an already-started guest bundle on retry, and sanitize the resulting failure
  reason: `f25edbd`, `bbefc60`.

These changes exist because of a real incident, not speculative hardening: canary attempt
`a5709dfc-98bc-43c1-a633-8ed64741e615` failed when its logon-candidate loop replayed an already-
started guest bundle after a post-completion process-cleanup failure, and the slot guard correctly
refused the replay rather than silently discarding or duplicating a real session's result — see
Results below for the accepted repeat.

## Results — canary (4 sessions)

Campaign `7867b2bc-1f51-408f-af7e-642b7267eecc`, reached `Closed`, 4/4 sessions accepted. (A first
canary attempt, `a5709dfc-98bc-43c1-a633-8ed64741e615`, failed at `LiveRunning` on a harness-side
defect — a real session's result was being discarded by an unsafe retry loop, not a product or
agent failure — and was not resumed; it is not pooled with the results below. Per the cell
treatment rules, the canary was permitted to repeat once, and only after a deterministic fix; this
is that one repeat.) Figures below are from `node tools/agentic-eval/campaign-summary.mjs
<campaign-dir>`, not hand-derived.

| Runtime | Arm | Key facts | Full-answer match | Strict success | Duration (agent CLI wall-clock) | Tool calls |
|---|---|---|---|---|---|---|
| claude-code | product | 1/1 | 0/1 | 0/1 | 186.9s | 3 |
| claude-code | free | 1/1 | 0/1 | n/a | 242.9s | 16 |
| codex-cli | product | 1/1 | 0/1 | 0/1 | 215.0s | 5 |
| codex-cli | free | 1/1 | 0/1 | n/a | 245.9s | 10 |

Duration is each record's own `wall_clock_ms` (the agent CLI process's own span). The broader
orchestrated session — including per-cell setup/teardown around the CLI invocation — spanned
4m41s–5m30s across the four cells; that wider span is not what the table above reports.

All four cells miss full-answer match for the same reason (H15, see Metric definitions and the
preregistration's 2026-09-28 amendment to section 6): each cell's final claim names the correct
`outcome_kind`/`missed_lines`/`threshold`, but not the ambiguous `total`/`passed` pair. This is the
metric design working as anticipated, not a new finding.

The product arm's strict `success` (0/1 in both cells) has the identical H15 cause, not a separate
product failure: strict `success` requires `final_answer_consistent_with_evidence` in addition to
the outcome match, and H15 fails that check in both product cells the same way it fails full-answer
match. Both product cells' own terminal tool evidence matched cleanly —
`authoritative_outcome_matches_expected: true`, `provider_evidence_status: "matched"`,
observed `total:4`/`passed:4`, `missed_lines:23`, `threshold:15` — the product correctly ran and
reported the scenario; only the agent's own restated summary echoed the ambiguous field.

Declared limitation (preregistration amendment, section 6): the free arm's kmp-test-vs-Gradle
invocation classifier did not recognize the `codex-cli` free cell's Gradle command at all
(`kmp_test_count: 0, gradle_count: 0`), although that cell's final claim correctly states
`missed_lines: 23` — obtainable only from a real coverage run. The `claude-code` free cell's Gradle
command WAS recognized (`kmp_test_count: 0, gradle_count: 1`) — not uniform across the two free
cells. Consequence: `retries`/`test_invocations_total` are not comparable across arms and are
reported for the **product arm only**, below and in the campaign results. No change was made to the
grader, classifier, prompt, skill, or either agent runtime in response to this.

## Results — campaign (16 sessions)

Campaign `705c625c-a72f-47a3-996b-534d2aabccdd`, reached `Closed`, 16/16 accepted, 0 rejected, 0
missing (n=4 per runtime/arm group throughout). Figures below are from `node
tools/agentic-eval/campaign-summary.mjs <campaign-dir>` and, for cost, computed directly from each
accepted cell's own `record.tokens`, not hand-derived or estimated from an aggregate.

| Runtime | Arm | n accepted | n rejected | n missing | Key facts | Full-answer match | Strict success |
|---|---|---|---|---|---|---|---|
| claude-code | product | 4 | 0 | 0 | 4/4 | 4/4 | 4/4 |
| claude-code | free | 4 | 0 | 0 | 4/4 | 0/4 | n/a |
| codex-cli | product | 4 | 0 | 0 | 4/4 | 0/4 | 0/4 |
| codex-cli | free | 4 | 0 | 0 | 4/4 | 0/4 | n/a |

Key facts is 16/16 — correctness is at ceiling in both arms at this sample size; the design cannot
distinguish product from free on this metric here. For the product arm, the full-answer/strict-
success mismatch is consistent with H15: strongly indicated, not directly observed (see Metric
definitions): the terminal kmp-test envelope itself matched expected exactly, and only the agent's
own restated `total`/`passed` differed from it — the agent's own declared values are not captured as
a record field, but the tool's own ambiguous task-dispatch count (`tests.total:1`) was visible to it
in the same envelope. For the free arm, the
same fields mismatch, but H15's specific mechanism cannot apply as directly — the free arm never
sees a kmp-test envelope to echo. H15 is the documented ambiguity and the likely but unverified
factor there too, not a confirmed one: the free arm's own declared values are not recorded, so what
actually produced the mismatch is not established. claude-code's product arm did **not** repeat the
canary's H15 miss this time (4/4, not 0/1); codex-cli's product arm did (0/4, matching the canary).
This is reported as observed, not smoothed into a single cross-runtime rate.

**Strict success detail (codex-cli product, 0/4).** In all four cells the only failing grading
check is `final_answer_consistent_with_evidence` (the H15 field-mismatch on `total`/`passed`) — not
a failure of the product's own evidence. In all four cells `terminal_evidence.outcome_matches_expected:
true` and the kmp-test envelope's own observed result matched the expected scenario facts exactly
(`total:4`, `passed:4`, `failed:0`, `missed_lines:23`, `threshold:15`, `modules_contributing:1`).
The product correctly ran and reported the scenario in every one of these four cells; only the
agent's restated `total`/`passed` differed from the evidence (declared values not recorded).

**Efficiency, median (range):**

| Group | Wall-clock (agent CLI, `record.wall_clock_ms`) | Tool calls |
|---|---|---|
| claude-code product | 189.9 s (183.2–205.4) | 4 (3–4) |
| claude-code free | 191.2 s (176.2–228.1) | 13 (10–13) |
| codex-cli product | 290.1 s (198.4–476.9) | 13 (4–27) |
| codex-cli free | 222.0 s (195.3–251.8) | 12 (8–24) |

**retries / test_invocations_total** (`record.retries` / `record.test_invocations_total`) — per the
preregistration's 2026-09-28 amendment, reported for the **product arm only**, not comparable across
arms:
- claude-code product: `retries:0, test_invocations_total:1` in all 4 cells.
- codex-cli product: cell round 0 `retries:5, test_invocations_total:6`; round 3 `retries:0, total:1`;
  round 5 `retries:0, total:1`; round 6 `retries:3, total:4`. The two elevated cells (rounds 0 and 6)
  are exactly the two duration/tool-call outliers above (476.9 s/21 calls and 355.7 s/27 calls) — the
  retries are the direct explanation for that variance, not a coincidence.

**Claude estimated cost per session** (from each cell's own `record.tokens` × official Claude Sonnet
5 pricing, verified 2026-09-28 against `platform.claude.com/docs/en/about-claude/pricing`: input
$2/MTok, 5-minute cache write $2.50/MTok, 1-hour cache write $4/MTok, cache read $0.20/MTok, output
$10/MTok — labelled an estimate, not a billed figure, and given as a range across the 5m/1h cache-write
price and the 4 cells in each arm):
- product: **$0.086–$0.137**
- free: **$0.146–$0.218**

Not computed for Codex: there is no spend cap in this design, and cost is not a preregistered
metric.

### Missing / rejected cells

None. All 16 declared cells were accepted; 0 rejected, 0 missing.

## What this benchmark does NOT measure

- A cross-provider "winner" — strict `success` is reachable by the product arm only, by construction
  (Gradle can never be this scenario's terminal evidence), so it is never used to rank runtimes or
  arms against each other.
- General kmp-test-runner performance — single scenario, single project, single module.
- Behavior on any platform but Windows.
- The exact numeric value the product's coverage-gate reports in a normally-networked, non-sealed
  environment (this measurement disables the Gradle configuration cache; see Environment).

## Experimental controls and threats to validity

A dedicated controls audit (2026-09-28, read-only against the measured checkout) cross-checked every
experimental parameter against the canary's four records and, after the campaign, the campaign's own
16, against the relevant source: whether it is set by the harness, whether the set value is actually
recorded per cell, and whether it is identical across arms. The full audit, sanitized and
decouple-audit-clean, is published alongside this document as
[`controls-audit.md`](./controls-audit.md) — every citation
and the complete per-parameter breakdown live there. This section distills that audit's own two
products — a controls table and a gaps-ranked-by-threat list — into what a reader needs to correctly
bound this benchmark's claims.
Classification legend: **CONTROLLED** (set and recorded per cell); **SET-NOT-RECORDED** (set, but
no per-cell field — recoverable only from code or the unpublished manifest); **UNCONTROLLED**
(not set by the harness at all).

**Compact controls table:**

| Parameter | Claude | Codex | Class |
|---|---|---|---|
| Scenario ground truth on the guest filesystem | The harness checkout — needed on the guest for grading to run at all — carries `tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json` with the scenario's expected module, outcome kind, missed lines and threshold in plain JSON, plus this preregistration's own stated ground truth | Same, plus `.codex/hooks.json` inside the workspace carries that checkout's absolute path | UNVERIFIABLE — commands are not recorded, so whether an agent ever reads outside its own workspace cannot be ruled out. Symmetric across arms. Affects the **primary** metric (key facts), not only efficiency — see ranked list, item 1 |
| Reasoning/thinking effort | Not set anywhere in this harness; actual value not established (see Models) | `low`, set via `-c model_reasoning_effort=low` | Claude: UNCONTROLLED. Codex: SET-NOT-RECORDED |
| Spend cap | `--max-budget-usd 2` | None — no cap exists | Claude: SET-NOT-RECORDED (manifest only, no per-cell field, no `error_max_budget_usd` signal if hit). Codex: UNCONTROLLED |
| Provider / worker timeout | 1800 s / 1860 s | Same | SET-NOT-RECORDED (manifest only; a worker-timeout kill writes no record at all, which would silently drop the longest sessions as "missing" rather than a negative observation) |
| Tool surface & visibility | `Bash`, `Skill` only; gate-verified | Runtime default tool set, not restricted, not verified; **only `command_execution` items are counted** — other item types (file-edit, web-search, MCP) are silently uncounted | Claude: CONTROLLED (gate). Codex: UNCONTROLLED, partly unobserved |
| Treatment text actually sent | Not hashed — only the pre-treatment prompt is hashed | Same | SET-NOT-RECORDED |
| Model identity | Alias (`claude-sonnet-5`), not a dated/pinned snapshot; served snapshot not observed | Same, and `model_resolved` is an echo of the configured value, not an independent observation | UNCONTROLLED-VARIABLE |
| Gradle `cache_state` label | Recorded as `"cold"` | Same | Hard-coded label — **inaccurate here**: the seed is prewarmed, so the dependency/wrapper/transform caches are actually warm |
| Cell order | Claude always dispatched first within each round (product/free/free/product/free/product/product/free); AB/BA/BA/AB counterbalanced across the 4 repetitions | Codex follows Claude in every round | SET-NOT-RECORDED (recoverable only from timestamps/manifest) |
| Free-arm exposure to product files | The skill snapshot and a runnable `kmp-test` shim are created as siblings of the agent's own `%TEMP%` workspace on **every** invocation, including free-only ones (`tools/agentic-eval/matrix-runner.mjs:160-163`) | Same, plus `.codex/hooks.json` inside the workspace carries the harness checkout's absolute path | UNVERIFIABLE whether an agent ever reads them — commands are not recorded. Evidence consistent with non-use: `kmp_test_count:0` in all 8 free cells this campaign (both runtimes, generalizing the canary's single-cell observation to n=4 each) |
| Project instruction files | Repo has no CLAUDE.md; whether Claude reads AGENTS.md is not established | NowInAndroid's own `AGENTS.md` (with a `./gradlew {variant}Test` recipe) is loaded by Codex's default project-doc behavior, in **both** arms | UNCONTROLLED-CONSTANT (present for Codex regardless of arm, not disclosed as a record field) |

**Launcher environment variables set but stripped before ever reaching a session** (verified by
executing the harness's own env-builder): `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `ENABLE_CLAUDEAI_MCP_SERVERS`,
`CLAUDE_CODE_DISABLE_ARTIFACT`, `GRADLE_OPTS`, plus `USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA` on
Windows. CLI defaults apply for all of these regardless of what the launcher set.

**Two things checked post-hoc against this campaign's own data and confirmed NOT to have occurred:**
- Timeout truncation: the longest session, 476.9 s, is well under the 1800 s provider cap.
- Budget truncation: Claude's highest estimated cost, $0.218, is well under the $2 cap.

**Gaps ranked by threat to validity** (condensed from the full audit; see
[`controls-audit.md`](./controls-audit.md) for every
citation):

1. **HIGH — the scenario's ground truth is present, in plain text, on the guest filesystem, and this
   is unverifiable.** The harness checkout that every session needs for grading also carries
   `tools/agentic-eval/corpus/scenarios/coverage-threshold-failure-v2.json` (module, outcome kind,
   missed lines, threshold — everything the **primary** key-facts metric checks) and this
   preregistration's own stated ground truth. For Codex, `.codex/hooks.json` inside the workspace
   additionally carries that checkout's absolute path. An agent that explored outside its intended
   workspace could read the answer directly rather than measure it — commands are not recorded, so
   this cannot be ruled out, and it is symmetric across both arms. Evidence consistent with measured,
   not read, answers: the kmp-test terminal evidence matched expected in 8/8 accepted product cells
   this campaign; `claude-code`'s free arm shows 11 recognized Gradle invocations across its 4 cells,
   consistent with genuinely running the build. `codex-cli`'s free arm cannot be excluded on this
   evidence alone: 0 recognized Gradle invocations and, again, no recorded commands to check against.
2. **HIGH — free-arm product-file exposure**, above. Direction: can only inflate the free arm's
   apparent capability, which shrinks the measured product benefit. Not ruled out by this campaign,
   only made less likely by the `kmp_test_count:0` pattern holding at n=4 per runtime now, including
   `codex-cli` free showing `gradle_count:0` in all four campaign cells too — the declared
   preregistration-amendment limitation (recognized-invocation undercounting for Codex's free arm)
   holds at full campaign scale, not just the one canary cell.
3. **HIGH, but resolved for this data — truncation.** Confirmed absent this campaign (above). Still a
   standing design gap: neither cap nor timeout is recorded per cell, so a future run could truncate
   silently.
4. **MEDIUM (preregistered) — the measurement instrument is asymmetric.** Strict success and
   first-signal metrics are unreachable for the free arm by construction; Codex's tool counts exclude
   non-command items. Arms are compared on key facts only, per design.
5. **MEDIUM — effort, argv, delivered-prompt hash, and env key set are all unrecorded per cell**,
   Claude's reasoning effort chief among them (see Models). The within-runtime product-vs-free effect
   holds only at Codex's fixed low effort and at Claude's own unestablished effort — a
   generalization limit, not a defect in what was measured.
6. **MEDIUM-LOW — order and model identity.** Claude ran first in every round this campaign (not
   fully counterbalanced within a round, only across the 4-repetition design); model ids are alias
   form, and the actual served snapshot is never observed.
7. **LOW — Codex's `AGENTS.md` exposure**, above: symmetric across Codex's own two arms, but
   unrecorded, and gives the free arm a ready-made Gradle recipe that may also compete with the skill
   in the product arm.
8. **LOW, publication-accuracy risk — several recorded labels are not true observations**: Gradle
   `cache_state:"cold"` (above), `env_allowlist_profile:"narrow"`, and Codex's
   `permission_mode_used`/`model_resolved` are hard-coded labels or echoes, not independent
   measurements.

## Limitations

See Experimental controls and threats to validity, above, for the detailed per-parameter audit this
list summarizes.

- Single scenario, tagged `train` (the skill was tuned against this scenario family).
- n=4 per arm per runtime (campaign), n=1 per arm per runtime (canary) — not a statistically powered
  sample.
- Windows only.
- Strict `success` reachable by the product arm only.
- The prompt's own `total` ambiguity (unique tests vs. task-dispatch executions) — see Metric
  definitions.
- Prior campaigns on the `Evidence1-Runner-E2E` VM (2026-09-14 through 2026-09-23) are quarantined by
  the 2026-09-27 independent audit's own findings (a real product bug, fixed separately) — not part
  of this measurement, not comparable to it. The separate 2026-09-10 canary (H1 did not manifest
  there) is also excluded, but for a different reason: it is a single-session canary, not this
  design's own campaign, not because its data is suspect.
- JUnit-XML capture is not used for Codex's own Gradle attempts on this scenario: its PostToolUse
  hook's correlation with a real transcript has never been verified. `junit-evidence.mjs` exempts
  `codex-cli` from the capture-completeness requirement so an unverified mechanism cannot silently
  reject a cell, but does not fabricate evidence either — `outcomeMatches`/`junitOk` still correctly
  reads "unverified" for a Codex Gradle attempt. Neither the primary metric nor this scenario's
  strict `success` (product-only by design) depends on this.

## Reproducibility

**Availability:** the harness cited below is published in place — `docs/audits/` (the
provisioning, broker-status, and dual-condition canary modules) and `tools/evidence1/`
(entry points `evidence1-install.ps1` and `evidence1-run.ps1`, plus the Windows/Hyper-V
base under `tools/evidence1/provisioning/`, its own [README](../../evidence1/provisioning/README.md)).
Reproducing a run requires supplying your own: a Windows host with the Hyper-V role enabled, a
Windows 11 ISO, and your own Claude Code and Codex CLI accounts — each authenticated with a
one-time interactive OAuth login inside the guest VM before any unattended session runs. The
guest VM is fixed at 4 virtual processors and 12 GiB of memory, and the harness requires about
131 GiB free on the VM's volume for a freshly provisioned VM. From there, `evidence1-install.ps1`
(one elevated, one-time install that provisions the broker and guest toolchain) and
`evidence1-run.ps1` (the campaign driver) are the two entry points; no credential, token, or
private identifier is embedded in the published harness itself.

- Harness commit (canary): `bbefc600b9399a22803c88a29def5a50934106fe` — this is NOT the `v0.15.0` tag's
  underlying commit (`git cat-file -t c458e6ad10ee2dddd57b0a787935e959e5498676` is `tag`: that SHA is
  the annotated tag OBJECT, not a commit; `git rev-parse v0.15.0^{commit}` resolves it to
  `27c943dc392675f78209a78ce09adb4f79283e3e` — the same commit as `PINNED_SKILL_SHA` above) but the
  harness commit and that resolved tag commit are identical on every product-code path (see parity
  check below).
- Harness commit (campaign): `15ad0dd6598c71fb12754e47ce5b024797f6a033` (`705c625c`'s own
  `ToolchainReady.receipt.json`, `detail.prepare_harness.target_commit`) — this is the canary's own
  harness commit (`bbefc60`) plus this closure's own preregistration amendment, and nothing else
  (`git diff --stat bbefc60 15ad0dd` touches only `docs/audits/evidence1-preregistration.md`).
- **Parity with the published release** (two separate checks, both must be empty):
  - Product code (canary harness commit): `git diff --stat v0.15.0 bbefc600b9399a22803c88a29def5a50934106fe -- lib bin
    scripts package.json gradle-plugin .claude-plugin` — **empty, verified 2026-09-28.**
  - Product code (campaign harness commit): `git diff --stat v0.15.0 15ad0dd6598c71fb12754e47ce5b024797f6a033 -- lib
    bin scripts package.json gradle-plugin .claude-plugin` — **empty, verified 2026-09-28.**
  - Skill: `SKILL.md` unchanged between the original pin and the `v0.15.0`-tag pin actually measured
    (`27c943dc392675f78209a78ce09adb4f79283e3e`); three reference-doc files differ, documenting
    already-measured behavior, not a decision-logic change — see Treatment texts' Skill snapshot
    note for the full, verified detail.
  - Result: **parity confirmed** — product code byte-identical to the published release on every
    measured path, for both the canary's and the campaign's own harness commit; skill decision logic
    byte-identical, only its reference docs differ.
- Canary campaign ID: `7867b2bc-1f51-408f-af7e-642b7267eecc` (the accepted repeat; first attempt
  `a5709dfc-98bc-43c1-a633-8ed64741e615` failed on a harness defect and is not pooled — see Results).
- Campaign ID: `705c625c-a72f-47a3-996b-534d2aabccdd` — `Closed`, verdict `PASS`, 16/16 accepted.
- Gate validation campaign IDs (no-provider mechanism check, not benchmark data — see "Gate
  validation" above): RED `c7c2432b-cb66-41b5-bd7a-2790191c4e7f` (pre-fix), GREEN
  `6a8bbd9d-db3d-4776-bd9d-c8d361180a6e` (post-fix, harness commit `47783fa919668e028aaa3ee5226733eb1ec988ec`,
  a merge of `develop`@`da990280` into this closure's own working branch).
- Manifest / analysis command: `node tools/agentic-eval/campaign-summary.mjs <campaign-dir>`
- `node tools/decouple-audit.mjs`, run directly as the literal CLI command against this committed
  bundle (this file now lives in the repo under `tools/runs/`, not scratch): **clean (1050 files, 3
  public rules)**, verified 2026-09-28. This exact command is also the required `decouple-audit` CI
  check on every PR touching this bundle.

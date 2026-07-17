# Agentic usage measurement

## Purpose

This document defines a future benchmark for measuring how `kmp-test-runner`
changes a real agent's testing workflow. It is different from
[`token-cost-measurement.md`](token-cost-measurement.md): token-cost measurement
counts command outputs and report payloads; agentic usage measurement evaluates
the whole loop from user request to verified diagnosis or fix.

No results are published here yet. The goal is to make the methodology
stable before running any expensive or API-backed measurement.

[`README.md`](../README.md)'s "Agentic usage — token-cost rationale"
section links to this document and states plainly that no agentic
benchmark results are published yet. Nothing in the README depends on any
number in this document, and that stays true regardless of how this
document's internal structure evolves — as long as it continues to exist
at this path and continues to describe an unpublished, future methodology.

## What this measures

This benchmark measures the cost of the agent's entire testing workflow,
not a single command's output. Concretely, it covers steps such as:

- diagnosing which test(s) failed and why;
- selecting the right `kmp-test` (or raw Gradle) command for the situation;
- parsing a `--json` envelope and branching on its exit code or status field;
- deciding the next action — rerun scoped, inspect a report, ask for
  clarification, or stop;
- producing a final summary or fix recommendation the user can act on.

Metrics include token counts where available, elapsed time, turns, tool
calls, commands run, retry count, pass/fail outcome, and human
intervention — defined precisely in Metrics and Token accounting below,
alongside the qualitative Ease-of-use rubric for dimensions that resist a
clean automatic count.

### Question

When two agents get the same KMP testing task, how much does the
`kmp-test-runner` skill and JSON workflow change the cost of reaching a correct,
verified outcome?

The comparison should cover:

- elapsed time;
- context consumed;
- number and quality of tool calls;
- correctness of diagnosis or fix;
- ease of use and recovery from common Gradle/KMP failure modes.

### Conditions

Run each scenario in two conditions.

| Condition | Agent setup | Expected path |
|-----------|-------------|---------------|
| Baseline | Same model, no `kmp-test-runner` skill or project-specific test guidance beyond normal repo docs | Discover Gradle modules, run raw Gradle commands, inspect logs and reports manually |
| `kmp-test` skill | Same model plus the `kmp-test-runner` skill / guidance | Use `kmp-test` commands, prefer `--json` for machine-readable results, branch on envelope codes |

Both conditions should use the same model, same repository commit, same task
prompt, same machine class, same tool permissions, and isolated worktrees.

### Metrics

Prefer metrics that can be captured automatically and interpreted without
vendor-specific assumptions.

| Metric | Definition | Why it is stable |
|--------|------------|------------------|
| Task success | Agent reaches the expected diagnosis, patch, or verified conclusion | Primary outcome |
| Time to first useful signal | Wall-clock time until the agent identifies the relevant failing module, test, error code, or next action | Captures practical latency |
| Total wall-clock | Time from task start to final verified answer | Easy to compare with cold/warm cache noted |
| Commands run | Count of shell/tool commands, grouped as successful, failing, repeated, or exploratory | Measures operational friction |
| Test attempts | Count of Gradle/`kmp-test` test invocations | Separates test-loop cost from general exploration |
| Output bytes read | stdout/stderr bytes returned to the agent | Provider-neutral context proxy |
| Transcript tokens | Token estimate for prompts, tool outputs, and final answer | Use offline tokenizer first; official APIs only with approval |
| Tool calls / turns | Number of agent-tool interactions and user-visible turns | Captures steering overhead |
| Human intervention count | Number of clarifications or user corrections needed | Measures autonomy |
| Verification quality | Whether the final answer includes the right validation command and result | Guards against lucky guesses |
| Privacy cleanliness | Whether raw private paths/logs/module names leak into artifacts | Required for publishable evidence |

Retry count is not a separate row: it is the "repeated" bucket inside
Commands run, plus Test attempts for the test-invocation loop specifically.

### Token accounting

Use three levels, in this order:

1. **Bytes**: always record stdout/stderr byte counts. This is stable and
   model-independent.
2. **Offline token estimate**: use a local tokenizer for reproducible
   same-machine comparisons.
3. **Official token APIs**: call Anthropic/OpenAI token-count APIs only after
   explicit maintainer approval, because those runs can consume quota and may
   require private transcript handling.

If official token counts are used, record the exact model/tokenizer endpoint,
date, and whether chunking was needed.

### Ease-of-use rubric

Some dimensions are qualitative but can still be scored consistently. Score
each from 1 to 5 after reading the transcript.

| Dimension | 1 | 3 | 5 |
|-----------|---|---|---|
| Signal clarity | Agent cannot tell what failed | Agent finds the likely failing area after extra probing | Agent gets the actionable failure directly |
| Command ergonomics | Many custom Gradle/report steps | Some trial-and-error | One or two obvious commands |
| Error recoverability | Agent misclassifies environment/tooling failures | Agent recovers after manual inspection | Agent branches correctly on structured codes |
| Context economy | Large logs dominate the transcript | Some summarization, still noisy | Transcript stays focused on the decision |
| Final confidence | Weak or unverified answer | Partial verification | Clear diagnosis/fix plus focused verification |

Keep qualitative scores secondary to the automated metrics. They are useful for
reviewing transcripts, not for making headline claims alone.

## What this does NOT measure

- **Raw output compression ratios (the A/B/C approaches).** Comparing raw
  Gradle/Kover output, markdown summaries, and `--json` envelopes for a
  single command capture is [`token-cost-measurement.md`](token-cost-measurement.md)'s
  job. This document treats a single command's token cost as one input among
  several, not the outcome being measured.
- **General model quality.** This is not a benchmark of which model is
  "smarter." Both conditions in Conditions use the same model, so any
  measured difference is attributable to the presence of the
  `kmp-test-runner` skill/guidance, not the underlying model.
- **A replacement for token-cost measurement.**
  [`token-cost-measurement.md`](token-cost-measurement.md) and
  [`tools/measurement-registry.mjs`](../tools/measurement-registry.mjs)
  remain the source of truth for per-command, per-feature token-cost ratios.
  This document is additive: it measures the agent workflow around a
  command, not the command's payload.
- **Benchmarking against private projects by default.** Any scenario that
  touches a private/internal project requires explicit maintainer approval
  before it runs, the same as private-project token-cost measurement.
  Public-project scenarios are the default; see Evidence and privacy policy.

## Scenario matrix

Start small and expand only after the harness is boring.

| Scenario | What it tests | Notes |
|----------|---------------|-------|
| Unit failure | Basic KMP test failure diagnosis | Stable, cheap, first pilot scenario |
| Multi-module changed test | Whether the agent scopes the right modules | Good fit for `kmp-test changed` |
| Coverage threshold failure | Whether the agent can find missed lines without reading large Kover output | Exercises the largest token-cost gap |
| JDK/AGP mismatch | Whether the agent recognizes environment preflight signals | Useful for failure-code branching |
| Android instrumented failure | Whether the agent handles device/emulator-specific testing | Run only when the hardware/emulator state is stable |
| Public project success path | Whether the agent completes a clean run efficiently when nothing is broken, without over-exploring or retrying needlessly | Baseline for overhead when there is no failure to diagnose |
| iOS simulator test path | Whether the agent runs and interprets iOS-target KMP tests (e.g. `iosSimulatorArm64Test`) via `kmp-test` the same way it handles JVM/Android tests | Run only when a macOS host with Xcode/simulator runtime is available; skip on Linux/Windows runners |
| macOS native test path | Whether the agent runs and interprets macOS-target KMP tests (e.g. `macosX64Test`/`macosArm64Test`) via `kmp-test` | Run only when a macOS host is available; treat as optional until macOS CI runners are budgeted |
| Private project validation path | Whether findings from the public-project scenarios above generalize to a large, realistically-configured private project (analogous to the anonymized `private-large-A` reference used for coverage/benchmark token-cost evidence) | Alias-only, local-only; requires explicit maintainer approval before it runs; no private repo names, paths, or transcripts committed |

Each scenario should have a known expected outcome and a deterministic
verification command. Avoid tasks whose success depends on network state,
flaky devices, or broad refactors.

Platform-specific rows (iOS, macOS) and the private-project row are
placeholders until the required hardware and approval exist — do not run
them speculatively.

## Evidence and privacy policy

This section consolidates the privacy and evidence-handling rules that were
previously scattered across Harness shape, Token accounting, and Run
discipline. It applies to every scenario in the matrix above, public or
private.

- **Public project scenarios.** Sanitized command output, aggregate metrics
  tables, and redacted transcripts may be committed once a scenario has run —
  the same way [`token-cost-measurement.md`](token-cost-measurement.md)
  commits its public OSS captures. Raw full transcripts stay local; only
  redacted aggregates and summaries are committed.
- **Private project scenarios.** Private/internal projects are referenced by
  alias only (for example `private-large-A`, mirroring the anonymized
  reference already used for coverage and benchmark token-cost evidence) —
  never by real name, URL, or path. Raw private transcripts, logs, module
  names, and screenshots are never committed; they stay local-only for audit.
- **Explicit approval before touching private data.** A scenario only runs
  against a private project, and no private capture is ever sent to an
  Anthropic/OpenAI token-count endpoint, without explicit maintainer approval
  first. Public projects are the default.
- **Official token-count APIs.** Governed by the three-level Token accounting
  approach above — bytes first, then an offline tokenizer, then official
  APIs only with approval. When official APIs are used, also record the
  exact model/tokenizer endpoint, the date, and whether chunking was needed.
- **API keys are never persistent, and docs never show a real-looking key
  shape.** If a run needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, inject it
  inline for that single command only — for example
  `ANTHROPIC_API_KEY="<inline-token>" node ...` or, better,
  `ANTHROPIC_API_KEY="$(cat <gitignored-key-file>)" node ...` — never
  `export` it into a shell profile, a persistent CI secret scope beyond one
  job step, or any committed config. Placeholder only: never paste a real
  key into a doc, command, or anything else that lands in git history.

## Registry relationship

[`tools/measurement-registry.mjs`](../tools/measurement-registry.mjs) shipped
after this document was first written, and now records every token-cost
measurement in
[`tools/runs/measurement-registry.jsonl`](../tools/runs/measurement-registry.jsonl).
This section states plainly whether a future agentic-usage measurement wave
should write into that registry, since a reader would reasonably expect it to.

### Why the current registry does not fit

The registry's `CANONICAL_FIELDS` are: `schema, run_id, date,
release_context, platform, os_version, node_version, java_version,
project_alias, project_visibility, project_url, project_commit, feature,
scope, command_shape, measurement_kind, cache_state, approach, tokenizer,
token_count, bytes, chunking, raw_capture_committed, raw_capture_location,
privacy_status, source_artifact, notes`. That schema is shaped around a
single axis — an (`approach`, `tokenizer`) pair mapped to one `token_count`,
for a single command capture — and it does not fit an agentic workflow run,
for four concrete reasons:

- `feature` is constrained to `VALID_FEATURES` from
  [`measure-token-cost.js`](../tools/measure-token-cost.js) — `parallel`,
  `coverage`, `changed`, `benchmark`, `info`, `describe` — all single-command
  shapes, not multi-step workflows.
- `measurement_kind` is one of `full-matrix | smoke | trace-validation |
  private-reference` — none of these describe a multi-turn agent session.
- `approach` is one of `A | B | C` (raw / markdown / JSON), a per-command
  comparison axis with no equivalent in an end-to-end workflow.
- There is no field for wall-clock time, turn count, tool-call count, retry
  count, human-intervention count, or task success/fail — the metrics this
  document's Metrics table is built around.

Forcing agentic-usage data into this schema would mean leaving most fields
empty or meaningless for every agentic row, or overloading existing fields
with new meanings (for example, repurposing `approach` to mean "baseline vs.
skill" instead of "raw vs. markdown vs. JSON"). Both are worse than a
dedicated schema.

### What a future run record might look like

A lightweight harness should record each run as structured metadata:

```json
{
  "scenario": "coverage-threshold",
  "condition": "kmp-test-skill",
  "model": "model-name",
  "repo_sha": "abc123",
  "started_at": "2026-07-16T00:00:00Z",
  "ended_at": "2026-07-16T00:05:00Z",
  "success": true,
  "commands": [
    {
      "cmd": "kmp-test coverage --json",
      "exit_code": 1,
      "duration_ms": 42000,
      "stdout_bytes": 734,
      "stderr_bytes": 0
    }
  ],
  "first_useful_signal_ms": 42000,
  "human_interventions": 0,
  "notes": "No raw private logs committed."
}
```

Fields like `condition`, the nested `commands` array,
`first_useful_signal_ms`, and `human_interventions` have no equivalent column
in `CANONICAL_FIELDS`; the reverse is also true, since this shape has no
`approach`/`tokenizer`/`chunking` axis — a workflow run is not a
single-command A/B/C comparison.

### Recommendation

Do not extend `tools/measurement-registry.mjs` or
`tools/runs/measurement-registry.jsonl` for agentic-usage data. Instead, a
future implementation phase should propose a separate registry — for example
`tools/runs/agentic-usage-registry.jsonl` (with a validator module analogous
to `tools/measurement-registry.mjs`, if/when implemented) — with its own
schema shaped around the run record above (scenario, condition, model, repo
commit, timestamps, success, per-command list, first-useful-signal latency,
human interventions, notes), plus the privacy-relevant fields already
established by the token-cost registry (`project_alias`,
`project_visibility`, `raw_capture_committed`, `raw_capture_location`,
`privacy_status`) for consistency.

This is a design proposal only. No new registry file, schema module, or
validator is implemented in this PR — that is future implementation work,
tracked the same way the rest of this document is: as methodology, not
shipped tooling.

## Acceptance criteria for a future measurement wave

A future measurement wave is ready to run, and its results are ready to be
trusted, only when all of the following hold:

- **Repeatable commands and scenarios.** Every scenario in Scenario matrix
  has a fixed task prompt, a deterministic verification command, and a known
  expected outcome.
- **Public/private separation is explicit.** Each run is labeled public or
  private before it starts; private runs additionally require the explicit
  approval and alias-only handling described in Evidence and privacy policy.
- **Platform is recorded.** Every run records the OS/platform it ran on
  (mirroring the token-cost registry's `platform`/`os_version` fields), since
  the Android/iOS/macOS rows in Scenario matrix are only meaningful with that
  context.
- **Model and tooling versions are recorded.** Every run records the exact
  model name, the `kmp-test-runner` version or commit, and the target repo
  commit — mirroring `project_commit` and the model fields the token-cost
  registry already tracks.
- **Raw artifacts are classified.** Every artifact is explicitly marked
  committed (redacted, public) or local-only (raw, potentially private)
  before the run is considered done.
- **Summary docs stay clean.** Committed summaries never contain secrets, API
  keys, or private repo names/paths/module names/transcripts — only aliases
  and redacted aggregates.
- **README promotion requires evidence.** No result is promoted to a README
  headline unless it is backed by same-scenario evidence checked into this
  repo, consistent with today's README note that no agentic benchmark
  results are published yet.

### Reporting format

Publish a compact aggregate table first:

| Scenario | Condition | Success | First signal | Wall-clock | Commands | Output bytes | Transcript tokens |
|----------|-----------|--------:|-------------:|-----------:|---------:|-------------:|------------------:|
| Unit failure | Baseline | TBD | TBD | TBD | TBD | TBD | TBD |
| Unit failure | `kmp-test` skill | TBD | TBD | TBD | TBD | TBD | TBD |

Then add a short interpretation:

- where `kmp-test` reduced context or tool calls;
- where it did not help;
- whether the skill caused any wrong turns;
- whether the results justify a broader official-token run.

Do not publish a README headline until at least the pilot scenarios are complete
and the raw evidence has been checked for privacy.

### Run discipline

- Randomize condition order when practical.
- Use separate worktrees per condition.
- Reset the repo and build cache policy between runs, or label runs clearly as
  cold-cache / warm-cache.
- Keep prompts identical except for condition-specific allowed tooling.
- Do not let one agent see the other condition's transcript.
- Record failures and abandoned runs; do not silently drop inconvenient data.
- Never commit raw private captures.

## Current status

- This document is a methodology and design proposal only. No agentic-usage
  measurements, pilot runs, or registry rows have been executed or committed
  as part of this PR — the Reporting format table above is still `TBD`
  placeholders.
- The `tools/runs/agentic-usage-registry.jsonl` schema sketched under
  Registry relationship is a proposal, not an implementation; no such file
  exists in this repo yet.
- Nothing in [`README.md`](../README.md) currently depends on any number in
  this document — it only links here and states that no agentic benchmark
  results are published yet.
- Future docs-alignment or measurement work should reference this document
  rather than re-deriving the methodology inline. If the methodology
  changes, update it here first, then update whatever links to it.

# Agentic usage measurement

## Purpose

This document defines the benchmark for measuring how `kmp-test-runner`
changes a real agent's testing workflow. It is different from
[`token-cost-measurement.md`](token-cost-measurement.md): token-cost measurement
counts command outputs and report payloads; agentic usage measurement evaluates
the whole loop from user request to verified diagnosis or fix.

This is no longer a proposal without an implementation. A working harness
exists at [`tools/agentic-eval/`](../tools/agentic-eval/), and accepted
Claude Code evidence produced under its strict command policy is committed
under `tools/runs/`. What remains unpublished is a headline: no number from
this methodology has been promoted to the README, and the acceptance
criteria below still gate that promotion. Treat this document as the
methodology of record for a harness that runs, not as a sketch for one that
might.

[`README.md`](../README.md)'s "Agentic usage — token-cost rationale"
section links to this document and states plainly that no agentic
benchmark results are published yet. Nothing in the README depends on any
number in this document, and that stays true regardless of how this
document's internal structure evolves -- as long as it continues to exist
at this path and continues to describe a methodology whose results are not
promoted to the README.

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

### Measurement axes

These axes are independent and must never be collapsed into one another.
Overloading any two of them is how a measurement stops meaning what its
label says.

| Axis | What it identifies | Example values |
|------|--------------------|----------------|
| Runtime | The agent product itself: its loop, tool set, permission system, skill delivery, and event protocol | `claude-code` |
| Runtime version | The exact CLI build that produced the transcript | an exact Claude Code version string |
| Model profile | The requested and resolved model identity within a runtime | requested vs resolved model strings |
| Execution profile | The command-control and isolation contract the session ran under | `strict-policy-v1` |
| Skill condition | Whether the pinned `kmp-test-runner` skill snapshot was present | `no-skill`, `current-skill` |
| Platform | The host operating system | `windows`, `macos` |

A runtime is not a model, and a model is not a runtime. The same model
reached through two different agent products is two different runtimes,
because the loop, tools, permissions, and skill mechanics differ. A runtime
version change is a partition change, not noise. An execution profile is
independent of both: it describes what the agent was allowed to run and what
contained it, not who ran it.

Only the skill condition is deliberately varied to answer this document's
question. Every other axis is held fixed within a comparison and recorded on
every run so that pooling incompatible runs is detectable rather than
invisible.

### The observed within-partition contrast

The quantity this document measures is:

```text
observed_contrast = metric(current-skill) - metric(no-skill)
```

evaluated within a single complete partition -- same runtime, runtime
version, model profile, execution profile, platform, scenario, project
commit, harness commit, skill pin, and cache policy. A difference measured
across any of those boundaries is not this contrast at all and must not be
reported as one.

**This value is descriptive.** It is the difference actually observed
between two sets of sessions. On its own it is neither a causal estimate
nor a measure of reliability: it carries no uncertainty, and nothing about
subtracting two numbers turns them into an effect. Call it an observed
contrast, and say how many sessions produced it.

A stronger causal claim requires, at minimum, all of the following:

- treatment assignment randomized or otherwise identified by a
  pre-registered experimental design, with run order pre-registered and
  counterbalanced;
- enough independent units to distinguish the contrast from session-to-
  session variation;
- explicit control of the partition keys above and of known confounders
  (cache state, ordering, host load, model-side drift);
- an uncertainty or sensitivity estimate reported alongside the number.

Until those hold, the honest wording is "observed contrast", not "effect".

The focused pilots in this program run four repetitions per condition. Four
repetitions are an **intervention signal** -- enough to notice that
something changed and to decide whether a larger measurement is worth
funding. They are not a demonstrated effect, they do not support a
confidence interval anyone should act on, and no report may present them as
one.

An observed difference between two runtimes is an observed cross-runtime
difference, and it stays exclusively descriptive. It is not this contrast, and it is not a causal
ranking: the products differ in prompt scaffolding, tool availability,
permission behavior, context handling, and hidden system content, none of
which this methodology controls. Cross-runtime numbers may be reported side
by side with their partition keys attached. They may never be subtracted
from each other and presented as an effect, and no runtime may be declared
better than another on this evidence.

### Pre-registered run order

Order is a confounder, so it is fixed in advance and recorded, never chosen
after seeing results.

The Claude 2x2 pilot has four conditions:

```text
A = strict-policy-v1 / no-skill
B = strict-policy-v1 / current-skill
C = sandboxed-unrestricted-v1 / no-skill
D = sandboxed-unrestricted-v1 / current-skill
```

Its order is this Williams design, four blocks, each condition appearing
once in every position and each ordered pair balanced:

```text
block 0: A B D C
block 1: B C A D
block 2: C D B A
block 3: D A C B
```

This replaces "balanced order" as a description with a sequence that can be
checked. Four independent shuffles are not equivalent and are not permitted.

A two-condition pilot uses a pre-registered counterbalanced order in which
each condition appears twice in each position.

In both cases the concrete campaign runbook must write the literal sequence
and record its hash **before any live session is spent**. The sequence is
then fixed: it may not be reinterpreted, reordered, or re-derived after
results are observed, and a deviation is recorded as a deviation rather than
folded into the design.

Pre-registering the order is necessary, not sufficient. It removes order as
an uncontrolled confounder; it does not by itself license a causal reading.
The four-repetition pilots still fail the remaining requirements above --
too few independent units, no uncertainty estimate -- so their results stay
descriptive. Do not read the presence of a Williams design as a promotion
from contrast to effect.

### Conditions

Run each scenario in two conditions. These two rows are the skill-condition
axis; every other axis above is held fixed across the pair.

| Condition | Agent setup | Expected path |
|-----------|-------------|---------------|
| `no-skill` | Same model, no `kmp-test-runner` skill or project-specific test guidance beyond normal repo docs | Discover Gradle modules, run raw Gradle commands, inspect logs and reports manually |
| `current-skill` | Same model plus the pinned `kmp-test-runner` skill snapshot | Use `kmp-test` commands, prefer `--json` for machine-readable results, branch on envelope codes |

`no-skill` means the skill is genuinely absent, not that the prompt asks the
agent to pretend it is absent.

Both conditions must use the same runtime, runtime version, model profile,
execution profile, platform, repository commit, task prompt, machine class,
tool permissions, and cache policy, in isolated worktrees.

### Product access and product usage

The skill-condition axis is not the same thing as product access. A `no-skill`
run in the current two-condition harness means the pinned skill snapshot was
absent, but it does **not** by itself prove that the product CLI was hidden from
the agent. Treating that row as a free baseline would overstate the evidence.

Analysis therefore records two separate layers:

| Layer | Question | Closed values |
|-------|----------|---------------|
| Product access mode | What product surface was available to the agent? | `product-assisted`, `product-visible-no-skill`, `free-baseline-no-product`, `contaminated-baseline`, `product-access-not-recorded` |
| Product usage mode | What kind of terminal evidence path did the agent actually use? | `product-cli`, `direct-build-tool`, `mixed-product-and-build-tool`, `manual-other`, `none` |

`product-assisted` is the current-skill/product-visible condition: the pinned
skill and product CLI are both part of the treatment. `product-visible-no-skill`
means the skill is absent but the product may still be discoverable in the
workspace. It is useful for measuring discoverability without guidance, but it
is **not** a no-product baseline. `free-baseline-no-product` is reserved for the
future baseline where the agent can see only the target repository and standard
toolchain. `contaminated-baseline` is reserved for any supposed free baseline
where product files, commands, docs, or generated artifacts are discoverable.

`run --campaign-design claude-2x2-williams-v1 --dry-run` makes this contract
structural by printing `product_access_mode` for every planned cell. That
historical Evidence 1 campaign intentionally contains eight `product-assisted`
cells and eight `product-visible-no-skill` cells, and zero
`free-baseline-no-product` cells.

`run --campaign-design claude-product-vs-free-baseline-v1 --dry-run` is the
separate free-baseline control: eight unrestricted cells comparing
`current-skill/product-assisted` against `no-skill/free-baseline-no-product`.
For the free-baseline cells, the runner removes the `kmp-test` shim from the
child `PATH`, strips `KMP_EVAL_*`/`KMP_TEST_*` variables from the child
environment, never delivers the skill, and runs the product-access preflight
against the materialized source workspace before spawning. A contaminated
baseline fails closed before any live session starts.

Before any `free-baseline-no-product` live run is accepted as such, the
operator must run the offline product-access preflight against the source-only
workspace:

```bash
node tools/agentic-eval/cli.mjs product-access preflight \
  --mode free-baseline-no-product \
  --workspace <source-only-workspace>
```

The preflight fails closed as `contaminated-baseline` if it can observe product
workspace markers, a `kmp-test`/`kmp-test-runner` executable on `PATH`, a
`kmp-test-runner` package manifest dependency, or product-specific
`KMP_EVAL_*`/`KMP_TEST_*` environment variables. Its JSON reports closed
status/count fields only; it deliberately does not print workspace paths, PATH
entries, or environment values. This is an environment-surface gate, not a
claim that the model has no latent knowledge of the product.

Product usage mode is derived from structured accepted-audit tool-kind counts,
not from raw transcript text. It distinguishes product CLI use from direct build
tool use and from mixed sessions. This lets reports say, for example, "the
programmatic product outcome matched but the final answer protocol failed"
without converting that into "the product failed."

In analysis schema v5, `success` remains the full harness success criterion:
correct target, correct expected outcome, usable evidence, and final answer
consistency. It must not be used alone as the product-quality metric. The
product-specific diagnostic fields are:

| Field | Meaning |
|-------|---------|
| `product_cli_used` / `product_cli_command_count` | Whether and how often the product CLI was observed in the accepted audit sidecar |
| `product_cli_recognized_operation_distribution` | Closed-vocabulary product operation counts (`parallel`, `coverage`, `doctor`, etc.) derived from sidecar `recognized_operation`, never raw argv |
| `product_cli_parallel_command_count` / `product_cli_coverage_command_count` / `product_cli_describe_command_count` / `product_cli_doctor_command_count` | Operation-specific product CLI counts for comparing product path quality without opening raw transcripts |
| `direct_build_tool_command_count` | Direct build-tool invocations observed without naming a concrete private or project-specific command in the public analysis output |
| `task_outcome_matched` | Alias of the graded expected outcome axis, published with a task-oriented name for product-vs-baseline interpretation |
| `evidence_quality` | Closed vocabulary separating `product-canonical`, `baseline-verifiable`, `malformed-evidence`, `claim-only`, and `no-evidence` |
| `answer_protocol_matched` | Whether the final answer followed the requested reporting protocol, separate from the task outcome itself |
| `programmatic_evidence_available` / `canonical_final_answer_available` / `canonical_output_available` | Whether the run produced independently parseable terminal evidence, a matching final answer block, and both together |
| `programmatic_product_outcome_matched` | Product CLI was used and the structured terminal evidence matched the expected outcome |
| `final_answer_protocol_only_failure` | The expected outcome matched, but the final answer did not satisfy the reporting protocol |

Run schema v7 persists `product_access_mode` on each promoted record. Earlier
records are analyzed through the compatibility view implied by their
`condition` (`current-skill` -> `product-assisted`, `no-skill` ->
`product-visible-no-skill`) so historical product-visible observations are not
mistaken for true `free-baseline-no-product` cells.

This separation is mandatory for Evidence 1 interpretation. A run with
`success:false` and `programmatic_product_outcome_matched:true` is not evidence
that the product failed; it is evidence that the product-side result and the
agent's final reporting behavior diverged. Conversely, a no-skill run that
uses the product CLI is not a free baseline; it is a product-visible/no-skill
observation. A free-baseline run may produce a parseable final claim without
authoritative terminal evidence; analysis reports that as
`evidence_quality: claim-only`, not as product-equivalent evidence.

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
| Output bytes read | stdout/stderr bytes returned to the agent, over an explicitly recorded surface set | A common physical unit; comparable only against the same surface set |
| Runtime-reported usage | The token dimensions the runtime itself exposes for the session, stored per dimension exactly as reported | A faithful record of what that runtime/model/version reported; not a guaranteed-complete or billable total |
| Offline token estimate | A local tokenizer's count over canonical text volume | Reproducible on one machine; an estimate, never a billable token count |
| Tool calls / turns | Number of agent-tool interactions and user-visible turns | Captures steering overhead |
| Human intervention count | Number of clarifications or user corrections needed | Measures autonomy |
| Verification quality | Whether the final answer includes the right validation command and result | Guards against lucky guesses |
| Privacy cleanliness | Whether raw private paths/logs/module names leak into artifacts | Required for publishable evidence |

Retry count is not a separate row: it is the "repeated" bucket inside
Commands run, plus Test attempts for the test-invocation loop specifically.

### Token accounting

Three distinct kinds of number live here. They are not interchangeable, they
are stored separately, and they are never summed together.

1. **Bytes over a recorded surface set.** Always record stdout/stderr and
   tool-result byte counts, together with **which surfaces were captured**.
   A byte is a common physical unit, so bytes are the axis that can carry a
   cross-runtime table -- but equal byte counts are not equal context. What
   each runtime puts on those surfaces, how it truncates, what it summarizes
   before the model sees it, and what it adds invisibly all differ. Bytes
   measure what the harness captured, not what the model processed.
2. **Offline token estimate.** A local tokenizer over canonical text volume.
   Reproducible for same-machine comparison, clearly labelled an estimate,
   and never presented as a billed or billable count.
3. **Runtime-native usage.** Whatever token dimensions the runtime itself
   reports for the session, recorded per dimension exactly as exposed and
   attributed to that runtime, runtime version, and model. This is a
   faithful record of what that runtime reported -- no more. It does not
   guarantee that hidden system prompts, all context the model actually
   processed, or every billable unit are included, and a runtime may change
   what it reports between versions without saying so.

Runtime-native dimensions stay separate from each other and from every other
runtime's. Do not derive a single total by adding dimensions whose semantics
differ, and do not rank two runtimes by their native counts: tokenizers,
hidden system content, cache semantics, and billing units are all runtime and
model specific.

A cross-runtime byte table must state, per runtime, **which surface set** the
bytes cover and the **completeness status** of that capture. If the surface
sets are not equivalent, the table is labelled descriptive and limited, and
the non-equivalence is stated on the table rather than in a footnote nobody
reads. An unlabelled cross-runtime byte comparison is not publishable.

An unavailable dimension is recorded as `not recorded`. It is never recorded
as zero, and it is never quietly omitted so that a downstream average treats
it as zero. `not recorded` is a fact about the observation; `0` is a claim
about the session, and the two must never be confused.

Official Anthropic/OpenAI token-count APIs are a separate step, permitted
only after explicit maintainer approval, because those calls can consume
quota and may require private transcript handling. If they are used, record
the exact model/tokenizer endpoint, the date, and whether chunking was
needed.

Cost is not derived from a current price page during aggregation. A cost
figure requires a dated snapshot artifact, and any result carrying one keeps
both the native usage and the snapshot's identity.

### Treatment size is not consumption

A separate confusion is worth naming explicitly, because it looks like a
token measurement and is not one. Three quantities are recorded separately
and never summed:

1. **Static treatment size.** The artifact **made available to the runtime**,
   measurable offline before any session: the canonical prompt's SHA-256 and
   UTF-8 byte length, the skill source SHA, the snapshot manifest's hash, its
   summed blob byte length, its file count, and the delivery mode. These are
   **artifact sizes**, and "made available" is not "loaded": a snapshot of N
   bytes does not mean N bytes entered the context window -- a runtime may
   index it, load it lazily, summarize it, or never read parts of it. Never
   render these as tokens consumed, context actually loaded, or billable
   cost. Under `no-skill` the snapshot fields are `null` with the closed
   reason `condition-no-skill`, never `0`.

   To be comparable across hosts these values are computed from **Git
   objects, not checkout bytes** -- blobs under the skill's canonical root,
   paths normalized to `/` and sorted, hashed over a canonical JSON
   manifest -- so that `core.autocrlf`, per-file `eol` attributes, locale and
   path separators cannot make Windows and macOS disagree about the same
   skill. Symlinks, submodules and out-of-root paths fail closed. Prompt
   bytes are the harness's canonical prompt before any runtime wrapping;
   hidden runtime scaffolding is neither counted nor estimated, and any
   observable adapter wrapping is a separate surface. The normative
   definition lives in the plan's Token and cost contract.
2. **Observed end-to-end session usage.** The runtime-reported dimensions
   plus wall-clock, turns, commands, tool results and captured bytes. The
   `current-skill` minus `no-skill` difference over this is a whole-session
   contrast.
3. **Usage attributable to loading the skill.** Recorded only when the
   runtime explicitly attributes usage to skill or plugin content. It stays
   **dimensional** -- input, cached input, cache write, output and reasoning
   output kept separate, with an explicit unit -- because a single scalar
   would re-introduce exactly the summation rule 3 above forbids, and would
   hide which dimension the runtime actually attributed. Either it is
   runtime-reported, with at least one dimension holding a non-negative
   integer and a stated unit, or it is `not recorded`, with every dimension
   null and a closed reason. It is never the residual between the two arms,
   which also absorbs different trajectories, tool calls, retries and cache
   behavior; calling that residual "the skill's token cost" is a fabricated
   attribution. A null dimension is never rendered as zero, and cost or AI
   units never live in this structure.

Reports show all three separately. A session-level contrast answers "what
did these sessions cost"; it does not answer "what did loading the skill
cost", and only (3) can.

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
  "smarter." Both conditions in Conditions hold the model fixed, so an
  observed contrast is not a model difference. That is a statement about
  what the contrast excludes, not a demonstration that the skill caused it;
  see The observed within-partition contrast for what a causal claim would
  additionally require.
- **Which agent runtime is better.** Runtimes differ in tool set, permission
  model, prompt scaffolding, context handling, and hidden system content.
  None of that is controlled here, so a runtime-to-runtime difference is
  neither a within-partition contrast nor a causal ranking. Cross-runtime
  figures are descriptive only, reported side by side with their partition
  keys, never subtracted into an effect and never used to declare a winner.
  See The observed within-partition contrast.
- **Cross-runtime token equivalence.** Native token counts from different
  runtimes are not one currency; see Token accounting.
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
| Unit failure | Basic KMP test failure diagnosis | Stable, cheap, candidate early scenario — the actual first committed pilot (2026-07-17) used KaMPKit's success-path and no-test-diagnostic scenarios instead, for public-repo verifiability (see Current status); a genuine test-failure scenario remains pending |
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
- **Official token-count APIs.** Governed by Token accounting above: bytes,
  offline estimate, and runtime-native usage are recorded separately, and
  official token-count APIs are an extra step taken only with approval. When
  official APIs are used, also record the exact model/tokenizer endpoint, the
  date, and whether chunking was needed.
- **API keys are never persistent, and docs never show a real-looking key
  shape.** If a run needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, inject it
  inline for that single command only — for example
  `ANTHROPIC_API_KEY="<inline-token>" node ...` or, better,
  `ANTHROPIC_API_KEY="$(cat <gitignored-key-file>)" node ...` — never
  `export` it into a shell profile, a persistent CI secret scope beyond one
  job step, or any committed config. Placeholder only: never paste a real
  key into a doc, command, or anything else that lands in git history.

## Execution profiles

The execution profile records what the agent was permitted to run and what
contained it while it ran. It is an axis in its own right, not a property of
the runtime and not a property of the skill condition.

### `strict-policy-v1` -- what the harness's own records were measured under

Every committed accepted scenario record produced by the current agentic-eval
harness so far ran under its strict command policy: a pre-tool hook evaluates
each shell attempt, allows or denies it against a closed allowlist, and every
attempt is accounted for per attempt. That is a real environment with real
external validity limits, and it is the environment those records describe.
It is not a claim about how an unconstrained agent behaves.

The scope of that sentence is exactly the harness's own accepted scenario
records. It does not extend to the v1 pilot or the v2 benchmark below, which
predate the harness, were not produced by it, and carry no execution-profile
identity at all.

### `sandboxed-unrestricted-v1` -- proposed, not implemented

The plan in
[`docs/audits/agentic-eval-claude-codex-v1-plan.md`](audits/agentic-eval-claude-codex-v1-plan.md)
proposes a second profile that removes the harness command allowlist in order
to measure the missing comparison arm. It does not exist. No run has used it,
no record carries it, and nothing in this document authorizes running one.

The runtime-neutral-records PR (`agent_runtime`/`execution_profile`/
`skill_observation`/`usage` groups, schema v6 -- see "The schema v6 groups"
below) reserves `sandboxed-unrestricted-v1` as a closed `execution_profile.id`
enum VALUE in `schemas.mjs`, so a future record CAN validly carry it once one
exists. That is a schema-level reservation only: `execution-profiles/
registry.json` registers exactly one entry, `strict-policy-v1`, and
`resolveSelection()` fails closed on `--execution-profile
sandboxed-unrestricted-v1` today exactly like any other unregistered id. No
registry entry, no isolation implementation, and no adapter capability
targets it -- everything below this point remains "proposed, not
implemented" in the real-world sense; only the schema's own closed
vocabulary changed.

If it is ever built, removing the allowlist is only admissible inside an
external containment boundary, because the policy hook was never an operating
system or filesystem sandbox and a runtime's own workspace flag is defense in
depth rather than a substitute. The stated prerequisites are:

- a disposable VM, dedicated runner, or equivalently reviewed boundary --
  never the maintainer's normal workstation, and never a dangerous
  permission-bypass flag used in place of containment;
- no maintainer data mounted, and a campaign-specific workspace as the only
  writable project surface;
- no ambient secrets beyond the minimum credential the runtime needs to
  authenticate;
- a disposable HOME and user state;
- a documented network mode;
- destruction or rollback of the environment after evidence is preserved;
- an isolation attestation recorded in the run metadata, so a reader can tell
  from the record alone which boundary produced it.

Command accounting does not relax when the policy hook is absent. Every tool
attempt still needs a correlated result and a place in the dispatch
accounting. Policy fields are then `not_applicable`, which is a distinct
value: they are never fabricated as allow decisions and never counted as zero
denials from a policy that did not run. A missing attempt is a failure under
either profile.

Results from the two profiles are separate partitions. The unrestricted arm,
if it ever exists, supplies a comparison that strict-policy evidence cannot
supply on its own; it does not retroactively reinterpret or rewrite the
strict-policy results already committed.

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

### What actually exists: a versioned run-record family

What this section once sketched as a future registry exists, but not as a
registry. There is no central append-only ledger for agentic-usage runs.
What exists is a **versioned run-record family, its validators, and a
committed evidence corpus**: per-run record files, each declaring its own
schema version, validated by
[`tools/agentic-eval/schemas.mjs`](../tools/agentic-eval/schemas.mjs), stored
under `tools/runs/`.

At the time of writing, `LATEST_RUN_SCHEMA` is `6` and
`SUPPORTED_RUN_SCHEMAS` is `[1, 2, 3, 4, 5, 6]`: every historical record keeps
validating under the schema version it declared, and new records are stamped
with the latest. Accepted scenario records carry an accepted-audit sidecar,
whose own supported schemas are `[1, 2, 3]` -- a schema-v5 record accepts
only sidecar schema 1 or 2, a schema-v6 record accepts only sidecar schema 3
(see "The schema v6 groups" below).

Those records already cover the fields the sketch called for -- condition,
scenario, model requested and resolved, repo/project commits, timestamps,
wall-clock, success, first-useful-signal latency, tool/shell/test-invocation
counts, byte counts, human interventions, retries, and the privacy fields
inherited from the token-cost registry's conventions -- plus fields the
sketch never anticipated, such as per-check grading detail, policy allow/deny
accounting, and skill-availability evidence.

The literal field inventories are frozen by
`tests/vitest/agentic-eval-schemas.test.js` and
`tests/vitest/agentic-eval-accepted-run-audit.test.js` rather than restated
here. Those tests freeze the **implementation's** inventories: they fail if
the schema module's field set changes, which is what makes restating the list
here unnecessary. They do not read this document and cannot detect prose that
has gone stale, so the narrative around them still requires deliberate
maintenance. Read the schema module for the authoritative list.

### The schema v6 groups

[`docs/audits/agentic-eval-claude-codex-v1-plan.md`](audits/agentic-eval-claude-codex-v1-plan.md)
proposed a schema v6 that would add explicit `agent_runtime`,
`execution_profile`, `skill_observation`, and `usage` groups, so that the
axes named above are recorded structurally instead of being implied by which
harness produced the file. The runtime-neutral-records PR implements exactly
that: every schema-v6 record carries all four groups, required and
non-nullable on every `run_kind`, populated from a registry-resolved
runtime/model/execution-profile selection
([`registries.mjs`](../tools/agentic-eval/registries.mjs)) rather than a
hardcoded Claude Code assumption. `agent_runtime` records runtime ID,
requested/resolved model, and expected/observed vendor; `execution_profile`
records the resolved profile's id, canonical hash, isolation kind, and
network mode (plus, when applicable, an isolation attestation hash --
`strict-policy-v1`'s own frozen semantics require it `null`, since that
profile never requires attestation); `skill_observation` records delivery
mode, availability/activation evidence, source SHA, and treatment size (see
"Treatment size is not consumption" above -- the v6 `treatment_size` group is
the SAME artifact-availability measurement, not a new one); `usage` records
the four runtime-reported dimensions plus a separate
`attributable_to_skill_load` group, never inferring zero for an unavailable
dimension.

Historical v1-v5 records and v1/v2 sidecars stay frozen and are not
regraded -- `aggregate`/`analyze` project all three new structural partition
keys (`agent_runtime`/`execution_profile`/`skill_treatment`) as the literal
`"not-recorded"` sentinel for any record below schema v6, never `null`,
never inferred from `claude_code_version` or hook/policy fields. A metric
absent from an older record renders as `not recorded`, never zero, exactly
as this document has always required.

This PR is schema/registry/reporting scope only: the runtime/execution-
profile registries reserve `codex-cli` / `sandboxed-unrestricted-v1` as
closed schema enum VALUES (so a future record can validly carry either), but
register no such entry, no adapter, and no isolation implementation -- see
"`sandboxed-unrestricted-v1` -- proposed, not implemented" above, which
still applies in full. A real non-Claude adapter, a real
`sandboxed-unrestricted-v1` isolation implementation, and this harness's own
no-policy-hooks execution mode remain future PRs' scope, not authorized or
implemented here.

### Recommendation

Do not extend `tools/measurement-registry.mjs` or
`tools/runs/measurement-registry.jsonl` for agentic-usage data. That
recommendation stands. It was satisfied by the versioned run-record family
and its evidence corpus, not by a second registry: no
`tools/runs/agentic-usage-registry.jsonl` exists in this repo, and none is
planned. The token-cost registry remains the source of truth for
per-command, per-feature token-cost ratios only.

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

- Fix condition order in advance using the pre-registered counterbalanced
  sequence from Pre-registered run order, and record its hash before the
  first live session. Ad-hoc randomization per campaign is not a substitute:
  it cannot be checked afterwards and it leaves order confounded.
- Use separate worktrees per condition.
- Reset the repo and build cache policy between runs, or label runs clearly as
  cold-cache / warm-cache.
- Keep prompts identical except for condition-specific allowed tooling.
- Do not let one agent see the other condition's transcript.
- Record failures and abandoned runs; do not silently drop inconvenient data.
- Never commit raw private captures.

## Current status

- **A public pilot exists.** [`tools/runs/agentic-usage-pilot-2026-07-17.md`](../tools/runs/agentic-usage-pilot-2026-07-17.md)
  ran the first small comparative pilot against this methodology — one public
  project ([`touchlab/KaMPKit`](https://github.com/touchlab/KaMPKit)), two
  scenarios, two conditions, n=1 per cell — with sanitized command logs
  committed under [`tools/runs/agentic-usage-pilot-2026-07-17/`](../tools/runs/agentic-usage-pilot-2026-07-17/).
  This is preliminary, disclosed, exploratory evidence, not a statistically
  powered measurement wave: n=1 per cell, single-rater non-blind grading, and
  a confirmed instrumentation-bug confound (see that document's
  Interpretation section) all mean its numbers should not be read as clean
  condition contrasts. The Reporting format table above remains `TBD`
  placeholders — that table is this document's own future-format sketch, and
  the pilot's actual results live in the pilot document instead of being
  transcribed into this table.
- **A v2 benchmark exists, with cleaner controls.**
  [`tools/runs/agentic-usage-benchmark-v2-2026-07-17.md`](../tools/runs/agentic-usage-benchmark-v2-2026-07-17.md)
  is the direct follow-up the v1 pilot's own Interpretation section
  recommended: one shared, self-tested logging harness used identically by
  every cell (closing v1's hand-rolled-wrapper confound), plus required
  coverage of [`android/nowinandroid`](https://github.com/android/nowinandroid)
  (Google's official Android reference app) alongside KaMPKit, three
  scenarios, n=2-3 per cell (up from v1's n=1), sanitized logs committed
  under [`tools/runs/agentic-usage-benchmark-v2-2026-07-17/`](../tools/runs/agentic-usage-benchmark-v2-2026-07-17/).
  This closes v1's specific confound and adds an official-project scenario,
  but it is still not a statistically powered sample and still cannot
  produce a true with/without-`kmp-test`-access comparison (see that
  document's Terminology section) — both limitations carry forward from v1
  unchanged. Its own honest reading, stated plainly in its Interpretation
  section, is that raw Gradle execution time did *not* favor
  `kmp-test-json` in this data; the measured advantage is in avoiding
  Gradle task-name discovery, not speed or command count.
- **An instrumented harness exists, and so does accepted Claude Code
  evidence.** [`tools/agentic-eval/`](../tools/agentic-eval/) is the
  implementation of this methodology: it spawns each condition, parses the
  runtime's structured transcript, enforces per-attempt command accounting,
  grades named checks, and writes schema-validated records with accepted-run
  audit sidecars under `tools/runs/`. Later dated canary campaigns extended
  that evidence on Windows and macOS. All of it was produced under one
  runtime (`claude-code`) and one execution profile (`strict-policy-v1`), on
  one model profile per campaign, and it is scoped to exactly that partition.
  Schema v6 (see "The schema v6 groups" above) now records that same
  partition structurally on every new record instead of leaving it implicit
  in which harness produced the file -- it does not change what was measured
  or widen the partition itself; `aggregate`/`analyze` still refuse to pool a
  pre-v6 record with a v6 one. It is preserved as-is: earlier campaigns are
  not regraded under later graders, not relabelled under later terminology,
  and not pooled across harness or schema generations.
- The v1 pilot and v2 benchmark above predate that harness and remain exactly
  as they were reported, including their own stated confounds. Their
  condition labels are the same two skill conditions this document now names
  `no-skill` and `current-skill`; renaming the axis here does not restate,
  reinterpret, or re-derive any number they published.
- The registry once sketched here was never built as a registry. What
  satisfies its purpose is the versioned run-record family, its validators
  and the committed evidence corpus described under Registry relationship.
  No `tools/runs/agentic-usage-registry.jsonl` exists in this repo, and none
  is planned.
- Nothing in [`README.md`](../README.md) currently depends on any number in
  this document, the pilot, or the v2 benchmark — it only links here and
  states that no agentic benchmark results are published yet. That sentence
  is now stale in the narrow sense that two rounds of evidence exist, but
  neither round's own Interpretation section claims its evidence is solid
  enough to promote to a README headline yet; that stays a deliberate,
  explicit deferral, not an oversight.
- Future docs-alignment or measurement work should reference this document
  rather than re-deriving the methodology inline. If the methodology
  changes, update it here first, then update whatever links to it.

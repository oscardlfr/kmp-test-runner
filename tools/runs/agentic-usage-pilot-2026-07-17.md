# Public agentic usage pilot — 2026-07-17

## Summary

This is a small, public-only **controlled comparative pilot**, not a blind academic
benchmark and not a definitive result — see Terminology and Methodology below. It
measures the end-to-end agent workflow cost of two ways an agent can determine whether
a KMP project's unit tests pass: driving the Gradle wrapper directly (`raw-gradle`
condition) vs. preferring the `kmp-test` CLI's `--json` mode (`kmp-test-json`
condition). This is distinct from [`token-cost-measurement.md`](../../docs/token-cost-measurement.md),
which compares a single command's output size — this pilot instead follows the whole
agent loop: commands run, wall-clock time, bytes read, retries, and whether the final
diagnosis is correct.

- **Project**: [`touchlab/KaMPKit`](https://github.com/touchlab/KaMPKit) (public), commit
  `b3a7784fb969a8558b88c80674c8b596944cdab7`, branch `main`.
- **Scenarios**: (1) success path — `:shared` module, real unit tests exist and pass;
  (2) no-test diagnostic path — `:app` module, zero unit test source exists.
- **Conditions**: `raw-gradle` vs `kmp-test-json` (see Terminology — deliberately not
  called "baseline").
- **Results**: all 4 cells reached the correct diagnosis (`success: true,
  expected_outcome_matched: true`). The most robust finding is about *verification and
  recovery behavior*, not speed — see Results and Interpretation. A confound (two
  independent hand-rolled logging-wrapper bugs, both landing in `raw-gradle` cells and
  neither in `kmp-test-json` cells) makes this pilot's wall-clock/command-count numbers
  unsafe to read as clean condition effects; this is disclosed explicitly rather than
  smoothed over.

## Terminology

Neither condition is a blind or unaided agent. Both run inside Claude Code, with full
repository context, a guided task prompt, and whatever prior knowledge the underlying
model already has. Calling either one "baseline" would imply a degree of experimental
control this design does not have, so this document avoids that word entirely and uses:

- **`raw-gradle` condition** — the agent is instructed to use the Gradle wrapper
  directly, and is explicitly told not to use `kmp-test`/`kmp-test-runner` even if it
  appears available as a skill.
- **`kmp-test-json` condition** — the agent is instructed to prefer the `kmp-test`
  CLI's `--json` mode when it fits.

For readers of [`docs/agentic-usage-measurement.md`](../../docs/agentic-usage-measurement.md),
this pilot's `raw-gradle` condition corresponds to that document's "Baseline" column,
and `kmp-test-json` corresponds to its "`kmp-test` skill" column. The methodology
document's own Conditions table is left verbatim — this section exists to bridge
terminology, not to rename the source document.

**A further, more precise limitation, worth stating explicitly: this pilot does not
measure "agent without access to `kmp-test`" vs "agent with access to `kmp-test`."**
The `raw-gradle` condition's agent runs in an environment where the `kmp-test-runner`
skill genuinely *is* available (confirmed via a throwaway pre-check — see Methodology),
and is given an explicit prompt instruction not to use it. That is a meaningfully
different, weaker condition than an agent that has no access to the tool at all and so
never considers it. This pilot cannot and does not claim to show what an agent would do
if `kmp-test` simply didn't exist in its environment — only what an agent does when
told not to reach for a tool it can see. A future wave aiming for a genuine
"without vs. with" comparison would need a real no-access condition (the skill/tool
genuinely absent or uninstalled, not merely prohibited by instruction), independent
sessions per condition, symmetric prompts, the same pre-validated logging wrapper for
every cell, and ideally repeated trials — none of which this pilot attempts. Until
that exists, no README claim should describe agents as being faster or better "with
`kmp-test`" in a with/without sense — this pilot only supports the narrower claim that
this document already makes throughout: a `raw-gradle`-vs-`kmp-test-json` comparison
under instructed conditions, not a with/without-access benchmark.

## What this pilot does NOT measure

Stated explicitly so the results below aren't over-read:

- **Real agent-model token consumption.** A subagent's actual token usage is not
  introspectable from outside the tool-call boundary that dispatched it. Only the
  stdout/stderr byte counts of the commands it ran were captured — a proxy for context
  cost, not a token count. Any offline tokenizer estimate below applies only to that
  captured command-output text, not to the agent's full internal reasoning/context.
- **Internal tool-call/turn count as the model itself experiences it.** A subagent may
  batch or abstract tool calls in ways this harness cannot observe from outside.
  `commands_total` below counts shell commands routed through the per-cell logging
  wrapper, not model-level tool-call turns — recorded as `tool_calls_or_turns:
  not-recorded`, never estimated.
- **Real economic/API cost.** Not computed, not estimated.

This is a **command/time/output pilot, not a full model-token benchmark.**

## Prompts used

Composed once and reused verbatim per cell (worktree paths sanitized to
`$KMP_WORKSPACE`-style placeholders below; only the module name and the
condition-specific tooling line differ between cells). Full unsanitized record kept
locally, not committed. The `raw-gradle` template's tooling-prohibition line was
calibrated against a throwaway pre-check confirming the `kmp-test-runner` skill really
is visible in this environment regardless of task-scoped working directory, with the
exact description text a subagent would see ("Use when the user asks to run tests...").

**Common template** (all cells; `{WORKTREE_PATH}` / `{MODULE}` / `{CONDITION_LABEL}` /
`{CONDITION_TOOLING_LINE}` resolved per cell):

```
You are working in a local git worktree checkout of the public GitHub project touchlab/KaMPKit, pinned at commit b3a7784fb969a8558b88c80674c8b596944cdab7. Your working directory is: {WORKTREE_PATH}

Task: Determine whether the `{MODULE}` module's unit tests pass. Report the pass/fail count (or, if there are no unit tests to run for this module, say so clearly and explain why you believe that).

{CONDITION_TOOLING_LINE}

Rules:
1. Work fully autonomously. Do not ask me any clarifying questions — make your best judgment call and proceed.
2. Before giving your final answer, run at least one command whose output directly supports/verifies your conclusion (not just your first signal — an explicit confirmation step).
3. Logging requirement (mandatory): before running ANY real shell command in this task, first define a PowerShell wrapper function in your shell session that (a) starts a [System.Diagnostics.Stopwatch], (b) runs the real command, capturing its stdout and stderr into separate variables/files, (c) stops the stopwatch, (d) appends exactly one JSON line to the file {WORKTREE_PATH}\.pilot-log.jsonl with these fields: n (1-based sequential integer, assigned and written atomically), cmd, exit_code, duration_ms, stdout_bytes, stderr_bytes, (e) still shows you the real command's normal output afterward. Route every subsequent real command through this wrapper. Self-test it on a trivial command first.
3b. Run every command SYNCHRONOUSLY in the foreground and wait for it to return normally — do NOT background a command and then poll or monitor it. [Cells 3-4 additionally received a specific, evidence-based note about a ~600s tool-level auto-backgrounding ceiling observed in cells 1-2, with instructions to terminate cleanly and retry once rather than spin on redundant monitors if hit — added mid-pilot per Methodology's "Prompt evolution" note, not present in cells 1-2's original text.]
4. Track the wall-clock moment (ms since task start) at which you first knew the real answer, before your final verification command — first_useful_signal_ms_self_reported.
5. Privacy requirement: never paste raw local.properties contents or a full raw Gradle/doctor/environment-probe dump into any log field or notes — describe or byte-count it instead.
6. Write one final JSON object to {WORKTREE_PATH}\.pilot-summary.json with: condition, success, expected_outcome_matched, exit_codes, elapsed_ms_total_self_reported, first_useful_signal_ms_self_reported, commands_total, test_attempts, retry_count, stdout_bytes_total, stderr_bytes_total, human_interventions (0 — autonomous), notes.
7. Also give a short plain-English final answer as your response.
```

**`raw-gradle` tooling line:**
```
Tooling constraint: use the Gradle wrapper (`gradlew.bat` in your working directory) directly for all test-related commands. Do NOT invoke the `kmp-test-runner` skill, and do NOT run any `kmp-test` command or any `node .../bin/kmp-test.js ...` command, even if one appears available to you as a skill or tool — treat it as if it does not exist for this task. If you notice a skill named `kmp-test-runner` in your available-skills list, deliberately ignore it.
```

**`kmp-test-json` tooling line:**
```
Tooling constraint: prefer the `kmp-test` CLI's `--json` mode when it fits this task. It is available at `$KMP_WORKSPACE/kmp-test-runner/bin/kmp-test.js` (invoke via `node <that path> <subcommand> --project-root {WORKTREE_PATH} ... --json`). You may fall back to the Gradle wrapper directly if `kmp-test` doesn't fit some part of the task.
```

Per-cell resolved values: `{MODULE}` = `:shared` for scenario 1, `:app` for scenario 2;
`{CONDITION_LABEL}` = `raw-gradle` or `kmp-test-json` as above.

## Methodology

### Project & scenario selection

A single project serves both scenarios, per the task brief's own scope recommendation.
[`touchlab/KaMPKit`](https://github.com/touchlab/KaMPKit) was chosen because a local
checkout already existed as a real, verifiable git clone (`git remote -v` confirms the
public GitHub remote) at a known-good commit — `b3a7784fb969a8558b88c80674c8b596944cdab7`
("Bump the minor group with 14 updates (#358)") — that a prior session had already
validated end-to-end (see
[`tools/runs/token-cost-validation-windows-2026-07-17.md`](../token-cost-validation-windows-2026-07-17.md)).
Two other candidate public projects (DroidconKotlin, a clean natural `no_test_modules`
repro with zero test source; PeopleInSpace) were considered and dropped for this specific
pilot: neither local copy is a real git clone (both are zip-extracted GitHub snapshots
with no `.git`), so neither can produce a verifiable `repo_url`/commit pair — a hard
requirement here. Both remain reasonable candidates for a future wave once cloned properly.

Filesystem-verified module facts (not assumed): `:app` has `src/main` only, zero test
source anywhere under `app/`. `:shared` has real tests — `androidHostTest` (2 files) plus
`commonTest` (8 files, e.g. `BreedRepositoryTest.kt`, `DogApiTest.kt`) via KMP's
`withHostTestBuilder{}` DSL, reachable via the real Gradle task
`shared:testAndroidHostTest`. Both scenarios are organic, pre-existing repository states
— no source edits, no synthetic fixture:

- **Scenario 1 (success path)**: does `:shared`'s unit tests pass? (They do — this is a
  real, positive result to verify, not a foregone conclusion known in advance to either
  condition's agent.)
- **Scenario 2 (no-test diagnostic path)**: does `:app`'s unit tests pass? The correct
  answer is "there are no unit tests to run" — a no-test/no-op condition, not a genuine
  assertion failure. This is intentionally scoped narrowly: this pilot does **not** claim
  to have exercised a genuine test-failure diagnosis (a real assertion failing), only the
  narrower "recognize there's nothing to run, don't claim false success" case. See
  Interpretation for why a true failure-diagnosis scenario remains future work — this PR
  deliberately does not add a BACKLOG.md entry (see Non-goals in the PR description); the
  follow-up is tracked here, in this document, only.

### Prompt evolution

The `raw-gradle` prompt's synchronous-execution rule (3b) was strengthened once, before
S1/kmp-test-json or either S2 cell ran: S1/raw-gradle's first attempt (fully discarded,
see Results Note 1) backgrounded its real test command instead of running it
synchronously, breaking the logging wrapper's integrity. The corrected rule was applied
identically to every cell dispatched afterward — S1/kmp-test-json, both S2 cells, and
S1/raw-gradle's own redo — so no cell after the first attempt ran under a different
instruction shape than any other. A second, evidence-based refinement (an explicit note
about the ~600s auto-backgrounding ceiling observed in cells 1-2, with guidance to
terminate-and-retry-once rather than spin) was added before dispatching cells 3 and 4,
once that pattern was confirmed twice. This means cells 1-2 and cells 3-4 did not run
under byte-identical prompts — a real deviation from "compose once, reuse verbatim,"
disclosed here rather than glossed over. The condition-defining content (the tooling
line — the only thing that should differ between `raw-gradle` and `kmp-test-json` for a
fair comparison) never changed.

### Isolation

Each of the 4 (scenario × condition) cells ran in its own `git worktree`, detached at
commit `b3a7784...`, under a local scratch directory outside both this repo and the
KaMPKit clone. Worktrees share the origin clone's `.git` object store (no re-clone) and
the machine's global Gradle dependency cache (`~/.gradle/caches`, not per-worktree), but
each gets a filesystem untouched by `kmp-test`'s own gitignored `.kmp-test-runner/`
cache directory — condition `kmp-test-json` never inherited a pre-warmed project-model
cache from a prior run. `local.properties` (gitignored, Android SDK path) was copied
into each of the 4 worktrees as one-time setup, representing "a machine with the SDK
already configured" — not part of what was measured. `gradlew --stop` ran before every
cell to clear residual Gradle daemon state; note that Gradle's daemon registry is
global, not per-worktree-directory, so daemon-level JVM warmth could still leak across
cells despite file isolation — this is a known limitation, not something the worktree
design eliminates.

### Execution order

Sequential, never concurrent, despite worktrees making concurrent execution file-safe
— wall-clock and first-signal timing are core metrics, and concurrent Gradle builds
would contend for CPU/IO and bias timing. Order: S1-raw-gradle, S1-kmp-test-json,
S2-kmp-test-json, S2-raw-gradle.

### Timing authority

Each cell's `elapsed_ms_total` is timestamped by the orchestrator (dispatch/return of
the agent call), not the subagent's own self-report — the self-reported total is kept
as a secondary cross-check field only. Per-command `duration_ms` came from a
`Stopwatch`-based logging wrapper each subagent was required to route commands through
(a functional spec, not pre-written code). `first_useful_signal_ms` is inherently
unfalsifiable as pure self-report; the subagent's claimed value is recorded, but the
graded value used in the results table below was recomputed by the orchestrator from
the timestamped command log during grading.

### Grading

Single-rater, non-blind — the same person who set up all 4 cells graded all 4 cells,
fully aware which log belongs to which condition. True blinding isn't achievable in
this design. The Ease-of-use rubric (when scored) uses the methodology document's own
pre-written 1/3/5 anchors rather than free-form judgment. `raw-gradle`-condition logs
were grepped for any `kmp-test`/`bin/kmp-test.js` string as an automatic contamination
check — a hit would invalidate that run.

### Sample size

n=1 per cell — 4 data points total, no repeated trials, no variance estimate. This is
explicitly a small pilot, not a statistically powered measurement.

### Acceptance criteria walkthrough

Checked against [`docs/agentic-usage-measurement.md`](../../docs/agentic-usage-measurement.md)'s
"Acceptance criteria for a future measurement wave":

| Criterion | Status |
|---|---|
| Repeatable commands and scenarios | Partial — see "Prompt evolution" above; the prompt was refined twice mid-pilot (disclosed, not hidden), so "byte-identical across all 4 cells" does not hold, though the condition-defining tooling line never changed |
| Public/private separation explicit | Public-only; no private project touched |
| Platform recorded | Windows 11 Pro 10.0.22631 |
| Model and tooling versions recorded | Node v24.12.0, npm 11.6.2, OpenJDK Temurin 23.0.2 (host default; project's own Gradle toolchain resolved Zulu 21 independently), Gradle 9.6.1, `kmp-test-runner` at the `feature/agentic-usage-pilot` branch tip |
| Raw artifacts classified | Sanitized logs committed under `tools/runs/agentic-usage-pilot-2026-07-17/`; unsanitized originals local-only |
| Summary docs stay clean | Validated via `tools/decouple-audit.mjs` + manual grep, see Validation |
| README promotion requires evidence | Deliberately deferred this PR — n=1/single-rater is too thin to promote; see Interpretation |

## Results

n=1 per cell. Wall-clock is orchestrator-measured (dispatch→return of the agent call,
authoritative); self-reported totals are shown in notes as a secondary cross-check.
Transcript-token estimates were not computed for this pilot — see "What this pilot
does NOT measure" and Methodology; stdout/stderr byte counts are the primary,
provider-neutral context proxy used instead.

| Scenario | Condition | Success | First useful signal | Wall-clock (orchestrator) | Commands | Test attempts | Retries | stdout/stderr bytes | Human interventions | Verification quality |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Success path (`:shared`) | `raw-gradle` | ✅ | ~46.1 min (self-report; not independently re-derivable — see note 1) | **~57.2 min** ⚠️ (includes ~30 min stall — see note 1) | 15 (see note 1) | 1 | 3 | 1,888 / 10,963 ⚠️ (known undercount — note 1) | **1** (overridden — see note 1) | focused |
| Success path (`:shared`) | `kmp-test-json` | ✅ | ~14.4 min | ~21.7 min (self-report: ~16.8 min) | 7 | 3 | 1 | 8,979 / 69 | 0 | focused (strong — note 2) |
| No-test diagnostic (`:app`) | `kmp-test-json` | ✅ | ~1.7 min | ~11.9 min (self-report: ~5.1 min) | 8 | 2 | 0 | 6,395 / 82 | 0 | **focused — strongest** (note 3) |
| No-test diagnostic (`:app`) | `raw-gradle` | ✅ | ~5 sec (static check — see note 5) | ~42.9 min ⚠️ (heavily inflated — note 5) | 11 | 4 | 2 | 5,235 / 0 | 0 | focused |

**Note 1 — S1/raw-gradle incident.** This cell's first invocation attempt (fully
discarded, not in the table) lost its logging wrapper's integrity after the real test
command was backgrounded rather than run synchronously; the prompt was patched with an
explicit synchronous-execution rule before any other cell ran, and this cell was redone
cleanly under the corrected prompt. That redo then hit a genuine ~30-minute Gradle-daemon
stall (confirmed via external OS process inspection: near-zero CPU, zero network
connections, zero `build/` output) on its first real command, which required one
orchestrator intervention — an external process diagnostic plus a specific fallback
task-name suggestion — before the subagent could recover and complete successfully. The
subagent independently re-verified the orchestrator's claim before acting (matched
PID/start-time/empty build dir itself, used the clean `gradlew --stop` protocol rather
than blindly force-killing an externally-asserted PID) — a genuinely good piece of
autonomous skepticism, but the intervention itself still counts as a real
`human_interventions` event, so it is graded `1`, not the subagent's self-reported `0`. A
logging-wrapper counter collision (self-disclosed by the subagent, caused by two
in-flight commands computing the same sequence number) also corrupted the byte count for
one entry — almost certainly the largest single contributor — so the byte totals for this
cell are a known undercount, not a precise measurement, even after the correction below.
The ~57.2 min wall-clock figure is real and disclosed, but should **not** be read as "how
long the `raw-gradle` condition normally takes" — see Interpretation.

**Post-review correction (caught in PR review, not by the original grading pass):** the
subagent's own self-reported `commands_total`/`stdout_bytes_total`/`stderr_bytes_total`
(14 / 1,853 / 10,333) undercounted the actually-committed `.pilot-log.jsonl` by one line
— a trailing `Get-Date -Format o` housekeeping timestamp (`n=15`) was logged *after* the
subagent computed its own summary totals, so it never made it into the subagent's math,
only into the committed file. The table above and `summary.json` now report the
independently-recomputed true sum over all 15 committed lines (15 / 1,888 / 10,963); the
original self-reported values are preserved in `summary.json`'s `*_self_reported` fields
for transparency. This is a distinct issue from the sequence-collision undercount
described above — both are real, and both point the same direction (undercounting), so
neither correction should be read as resolving the other.

**Note 2 — S1/kmp-test-json verification behavior.** This cell's first `kmp-test parallel
--json` attempt hit the *same* ~600-second stall ceiling as S1/raw-gradle's first attempt
(see Note 4) — but this subagent recognized the ceiling itself and recovered via a clean
`TaskStop` + retry, with **no orchestrator intervention needed**. After a successful
retry, the subagent noticed a suspicious "up_to_date" status and a JUnit XML timestamp
that looked stale, and — rather than accepting its first success signal at face value —
ran an independent forced-fresh cross-check (`gradlew --rerun-tasks`, bypassing kmp-test
entirely) before concluding. The underlying pass/fail conclusion is solid (confirmed
twice, once forced-fresh); this pilot does **not** independently confirm *why* the
timestamp looked stale in the first place (the worktree was freshly created this session
with no pre-existing `build/`, so the root cause is unclear), so this is reported as an
example of strong verification behavior, not as a claim about a real caching defect.

**Note 3 — S2/kmp-test-json, cleanest cell.** Converged with no stall, no retries, and
three independent, mutually-agreeing confirmations of the same conclusion (`kmp-test
describe --json`, `kmp-test parallel --json`, and a direct `gradlew` cross-check showing
Gradle's own `NO-SOURCE` task outcome) — the strongest verification_quality grade of the
four cells. Dependency caches were already warm by the time this cell ran (shared global
Gradle cache, benefiting from the two S1 cells' prior real builds), so the cold-bootstrap
ceiling that affected both S1 cells did not recur here.

**Note 4 — the ~600s stall is a shared infrastructure quirk, not a condition effect.**
Both `raw-gradle` and `kmp-test-json` hit what looks like the same underlying ~600-second
synchronous-command ceiling on their first real Gradle invocation in a cold worktree —
this reads as a tool/harness-level auto-backgrounding threshold, unrelated to which
condition was in use. What differed was recovery quality, not exposure to the stall
itself. See Interpretation for why this matters for reading the results honestly.

**Note 5 — S2/raw-gradle's wall-clock is dominated by a self-instrumentation bug, not
Gradle.** 3 of 4 `:app:test` attempts appeared to hang past the tool's foreground ceiling
with near-zero CPU — superficially identical to S1/raw-gradle's stall symptom. This time
the subagent read the Gradle daemon's own log file directly and found the underlying
build had *already completed* (`BUILD SUCCESSFUL in 9s`) while its own PowerShell
logging-wrapper script was still hung on a redundant nested-process EOF bug — not a real
Gradle/environment stall. It rewrote its own wrapper and the next attempt returned
cleanly in 10s with the definitive result. No orchestrator intervention was needed —
self-diagnosed and self-fixed. The *first useful signal*, notably, came almost
immediately (~5s, from a direct static filesystem check of `app/src/`) — everything after
that was verification, not discovery. See Interpretation for the pilot-design implication
of this cell landing on the same condition as S1's stall.

## Interpretation

**Both `raw-gradle` cells drew a self-instrumentation bug; neither `kmp-test-json` cell
did — this is very likely a property of the pilot's own harness design, not of the tools
being compared, and it is the single most important caveat for reading this table.**
This pilot asked each subagent to hand-roll its own PowerShell logging wrapper from a
functional spec (deliberately not pre-written code — see Methodology), and two
independent, different implementation bugs (a sequence-number collision in S1, a
nested-process EOF bug in S2) happened to land in the two `raw-gradle` cells and zero
`kmp-test-json` cells. With n=1 per cell, that is fully consistent with chance — four
coin flips landing bug/bug/clean/clean is unremarkable — but it means the wall-clock
numbers in the table above measure "agent + hand-rolled instrumentation + tool" cost, not
"agent + tool" cost cleanly. Do not read `raw-gradle`'s much larger wall-clock numbers as
a claim that raw Gradle is slower to drive than `kmp-test-json` — both underlying Gradle
executions, once each cell's instrumentation bug was worked around, completed in single-
digit-to-low-double-digit seconds. A concrete recommendation for any future wave: supply
a single pre-tested shared logging wrapper to every cell instead of asking each subagent
to write its own — this pilot deliberately chose the hand-rolled approach to keep the PR
scope to docs+evidence only (see Non-goals), and paid for that choice in exactly the way
this finding shows.

**The clearest, most confidently-stated finding of this pilot is about verification
behavior and recovery, not raw speed.** With n=1 per cell and one cell's wall-clock
inflated by a disclosed ~30-minute stall-and-intervention incident, this pilot does not
produce a clean, comparable "X is N× faster" number — and does not claim to. What it does
show with reasonable confidence:

- **Both conditions reached the correct diagnosis for both scenarios, every time.** All
  4 cells ended `success: true, expected_outcome_matched: true`. This pilot does not show
  `kmp-test` succeeding where raw Gradle failed, or vice versa — at n=1 per cell, both
  are capable of the same correct outcome, sometimes needing more recovery effort than
  others.
- **Recovery from the shared ~600s stall (Note 4) was uneven, but not cleanly by
  condition.** Of the two `raw-gradle` cells, one (S1) needed an orchestrator
  intervention to recover from a genuine environment-level Gradle-daemon stall; the
  other (S2) self-diagnosed and self-fixed a *different*, subtler problem (its own
  wrapper's nested-process bug, correctly distinguished from a real Gradle hang by
  reading the daemon's own log file) with no help at all — arguably the single most
  impressive piece of autonomous debugging in the whole pilot. Both `kmp-test-json`
  cells also recovered from stall-like symptoms (one genuine ~600s ceiling, one none at
  all) without any orchestrator help. Read together: 3 of 4 cells self-recovered from
  friction with zero human intervention; only 1 of 4 needed help. That 1-in-4 happened
  to be a `raw-gradle` cell, but with n=1 per condition this is not strong evidence that
  `raw-gradle` needs more help in general — it is one disclosed data point.
- **The instrumentation-bug confound (see Note 5) makes command-count and wall-clock
  comparisons unsafe to read as condition effects.** Commands were lower for
  `kmp-test-json` in both scenarios (7 vs 14 for S1, 8 vs 11 for S2) — but most of each
  `raw-gradle` cell's extra commands were stall/retry/diagnostic cycles caused by a
  wrapper bug specific to that cell, not organic task complexity. This pilot cannot
  cleanly attribute the command-count gap to the `raw-gradle` condition itself, only to
  "the cells that happened to draw a wrapper bug." Byte counts show **no clean
  directional pattern at all**: S1's `raw-gradle` byte total is an unreliable undercount
  (Note 1), and S2 actually favors `raw-gradle` (5,235 vs 6,395 bytes) — the opposite of
  what a naive reading might expect. **This pilot does not support a "`kmp-test-json`
  always uses fewer bytes" claim.** For that specific, well-evidenced claim, the existing
  published [token-cost measurement](../../docs/token-cost-measurement.md) (a controlled
  single-command output-size comparison, not this pilot's noisier workflow-cost measure)
  remains the correct source — this pilot measures a different thing and should not be
  read as either confirming or contradicting it.
- **`kmp-test-json`'s verification was consistently strong.** Both `kmp-test-json` cells
  showed thorough, structured verification — S1 caught and resolved an internal doubt via
  an independent cross-check tool, and S2 reached the pilot's single cleanest, fastest,
  most-verified result via three independently agreeing confirmations. Both `raw-gradle`
  cells also verified adequately (each reached "focused" on the rubric), but neither
  matched S2/kmp-test-json's three-way confirmation depth.
- **First-useful-signal speed tracked agent strategy, not just condition.**
  S2/raw-gradle's ~5-second first signal (a direct static filesystem check) was faster
  than any `kmp-test-json` cell's first signal — a `raw-gradle` agent that thinks to
  check the filesystem before reaching for Gradle can be very fast to a first (unverified)
  answer. This cuts against reading "first signal" as a clean condition-level metric in
  this pilot.

**Why this should not be promoted to README yet.** n=1 per cell, single-rater non-blind
grading, one project, two scenarios, a confirmed instrumentation-bug confound affecting
exactly the `raw-gradle` cells and not the `kmp-test-json` cells, and one cell that
required a real intervention a larger sample might or might not repeat. This is
preliminary, disclosed, exploratory evidence — useful for deciding what a larger,
better-instrumented follow-up wave should measure (starting with: give every cell the
same pre-tested logging wrapper instead of asking each to hand-roll one), not for a
headline ratio claim.

## Privacy

Public project only (`touchlab/KaMPKit`, MIT-licensed, real GitHub remote). No private
project names, no persistent API keys (none used at all — offline byte-counts only, no
tokenizer/API call was needed). All local absolute paths (the worktree scratch
directories, this repo's own checkout path) are replaced with a `$KMP_WORKSPACE`-style
placeholder throughout this document and in the committed logs, including inside each
JSONL log line's `cmd` field — the primary leak vector, not just doc prose. The 4 JSONL
logs and `summary.json` received their own dedicated sanitization grep pass, separate
from the normal PR-diff review, since structured log content doesn't always read
clearly in a diff view. Verified via `node tools/decouple-audit.mjs` and a manual grep
for private project names, literal `C:\Users\...` paths, device-serial-shaped strings,
and `sk-ant-`/`sk-proj-` patterns.

## Raw artifacts

- **Committed** (sanitized): `tools/runs/agentic-usage-pilot-2026-07-17/*.jsonl`,
  `tools/runs/agentic-usage-pilot-2026-07-17/summary.json`.
- **Local-only** (not committed): the 4 git worktrees themselves (removed after the
  pilot via `git worktree remove --force`), unsanitized prompt/log originals.
- **Simplified reproduction** (for a reader who wants to spot-check one command, not
  reproduce the full 4-worktree fairness protocol):
  ```
  git clone https://github.com/touchlab/KaMPKit
  cd KaMPKit && git checkout b3a7784fb969a8558b88c80674c8b596944cdab7
  # add local.properties with your own Android SDK path
  ./gradlew.bat :shared:testAndroidHostTest --console=plain   # raw-gradle condition
  node <kmp-test-runner>/bin/kmp-test.js parallel --project-root . --module-filter shared --test-type androidUnit --json   # kmp-test-json condition
  ```

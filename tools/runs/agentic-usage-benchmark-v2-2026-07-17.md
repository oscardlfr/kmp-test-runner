# Public agentic usage benchmark v2 — 2026-07-17

## Summary

This is a public-only **controlled comparative benchmark**, the second wave after
[`tools/runs/agentic-usage-pilot-2026-07-17.md`](../agentic-usage-pilot-2026-07-17.md) (v1). It
compares the same two conditions as v1 — driving Gradle directly (`raw-gradle-no-kmp`) vs.
preferring the `kmp-test` CLI's `--json` mode (`kmp-test-json`) — across **two public projects**:
[`touchlab/KaMPKit`](https://github.com/touchlab/KaMPKit) (continuity with v1) and
[`android/nowinandroid`](https://github.com/android/nowinandroid) (Google's official Android
reference app, required by this wave's brief and not attempted in v1).

- **Projects/commits**: KaMPKit `b3a7784fb969a8558b88c80674c8b596944cdab7` (same commit v1 used);
  NowInAndroid `7d45eae4f8720a0c77f507712ba2437ff974b6ed`.
- **Scenarios**: (1) success path — KaMPKit `:shared`, real unit tests exist and pass; (2) no-test
  diagnostic path — KaMPKit `:app`, zero unit test source exists; (3) bounded official-project
  scenario — NowInAndroid `core:common`, a single small module on a 30+-module project, real unit
  tests exist and pass.
- **Conditions**: `raw-gradle-no-kmp` vs `kmp-test-json` (see Terminology).
- **Repetitions**: 3 per KaMPKit cell (12 real determinations), 2 per NowInAndroid cell (4 real
  determinations) — reduced for NowInAndroid per this wave's own brief ("if NowInAndroid is heavy,
  reduce repetitions and label that row clearly"), based on a calibration probe (see Methodology).
- **Results**: all 6 cells reached the correct diagnosis (`success: true,
  expected_outcome_matched: true`). Unlike v1, there is **no hand-rolled-wrapper confound** — every
  command in every cell (23 commands total: 4+5+4+4+3+3 across the 6 cells) was routed through one
  shared, self-tested Node harness (`harness.mjs`, committed in this run's directory), verified
  against every subagent's own report.
- **What's genuinely new here, read plainly**: raw Gradle execution time (isolated from kmp-test's
  own wrapper overhead) was **not** faster with `kmp-test-json` in this data — see Interpretation.
  The measured advantage of `kmp-test-json` in this wave is in avoiding Gradle task-name discovery
  entirely (a real, observed friction point for `raw-gradle-no-kmp` on both projects), not in
  fewer commands or lower wall-clock. This benchmark also surfaced what looks like a genuine
  correctness gap in `kmp-test describe` (see Candidate follow-up improvements) — a substantive
  side effect of measuring, not something being fixed in this PR.

## Terminology

Same as v1, restated here rather than assumed: neither condition is a blind or unaided agent. Both
run inside Claude Code, with a guided task prompt and whatever prior knowledge the underlying model
already has.

- **`raw-gradle-no-kmp` condition** — the agent is instructed to use the Gradle wrapper directly,
  and is explicitly told not to use `kmp-test`/`kmp-test-runner` even if it appears available as a
  skill.
- **`kmp-test-json` condition** — the agent is instructed to prefer the `kmp-test` CLI's `--json`
  mode when it fits.

**The same limitation v1 disclosed still applies and is not resolved by this wave**: this is not a
"with vs. without `kmp-test-runner` access" benchmark. Every subagent ran with full filesystem/tool
access in an environment where `kmp-test-runner` genuinely exists; `raw-gradle-no-kmp` is an
*instructed* no-use condition, not a sandboxed true absence. No claim in this document should be
read as "agents without access to `kmp-test` behave like X" — only "agents told not to reach for
`kmp-test` behave like X." A genuine no-access condition (the tool literally uninstalled/unreachable)
remains future work, same as v1 stated.

## What changed vs. v1 (the point of this wave)

v1's Interpretation section named one concrete confound and one concrete recommendation. Both are
addressed directly:

1. **Confound**: each v1 subagent hand-rolled its own PowerShell timing wrapper from a functional
   spec; two independent wrapper bugs landed in both `raw-gradle` cells and zero `kmp-test-json`
   cells, making v1's wall-clock/command numbers unsafe to read as clean condition effects.
   **Fix in v2**: one pre-built, self-tested Node harness (`harness.mjs`), identical for every cell,
   committed in this run's directory so the exact logging mechanism is auditable in the PR diff.
   Every subagent was instructed to route every real command through it and never hand-roll timing.
   **Zero wrapper bugs occurred in any graded cell** — but this precise claim needs its own honest
   caveat, not a blanket "zero bugs": see "Harness bugs found and fixed before any graded cell ran"
   below.
2. **Missing coverage**: v1 used a single project (KaMPKit) and never attempted an official,
   large, multi-module reference project. **Fix in v2**: NowInAndroid (Google's official Android
   sample, 30+ modules) is now covered, bounded to a single small module per this wave's own
   "prefer honest bounded measurements over noisy huge runs" instruction.
3. **Not fixed, disclosed instead**: this wave still cannot produce a true with/without-access
   comparison (see Terminology) and still uses n=2-3 per cell, not a statistically powered sample.
   Both limitations carry forward from v1 unchanged.

## What this benchmark does NOT measure

Stated explicitly, same spirit as v1's own list:

- **Real agent-model token consumption.** Only stdout/stderr byte counts of routed commands were
  captured — a context-cost proxy, not a token count.
- **Full agent-turn wall-clock.** Unlike v1 (which had the orchestrator precisely timestamp
  dispatch→return per cell), this wave does **not** have a precise orchestrator-measured
  `elapsed_ms_total` — that timestamping discipline was not set up before dispatch this time. What
  this wave *does* have, precisely: the sum of harness-logged `duration_ms` per cell (real,
  objective, but a lower bound — it excludes the subagent's own thinking/report-writing time
  between commands). This is a genuine instrumentation gap vs. v1, disclosed rather than
  papered over with an estimate.
- **True cold-cache Gradle execution.** See Methodology's Cache honesty section — every cell in
  this run shares the machine's global Gradle dependency cache and, it turns out, its build/task
  cache too (see below). Nothing here should be read as "how long a cold build takes."
- **Real economic/API cost.** Not computed, not estimated.
- **A statistically powered sample.** n=2 (NowInAndroid) or n=3 (KaMPKit) per cell. Individual
  numbers below are illustrative, not proof of a stable population-level effect.

## Prompts used

Composed once per (project, condition) pair and used verbatim for that cell (worktree paths
sanitized to `<USER_PATH>`-style placeholders below by the harness itself; this document's prose
also avoids raw paths). Unlike v1, the synchronous-execution and shell-timeout guidance was
included in every prompt **from the start** — v1 had to patch this in mid-pilot after discovering
a ~600s tool-level ceiling; this wave already knew about it and stated it up front, so no prompt
had to change mid-run.

**Common template** (all 4 cells; scenario list, tooling line, and log path(s) vary per cell):

```text
You are helping verify whether a [Kotlin Multiplatform project's / large official Android
reference project's module's] unit tests pass. This is part of an internal tooling benchmark
measuring agent workflow behavior — run the task exactly as instructed below, using the shared
measurement harness for every real command.

Your working directory for this ENTIRE task is: {WORKTREE_PATH}
This is a git worktree of the public GitHub project {PROJECT_URL}, pinned at commit {COMMIT_SHA}
({COMMIT_SUBJECT}).

{SCENARIO_LIST — module name(s), repetition count, "no tests exist" framing where applicable}

{CONDITION_TOOLING_LINE}

Logging requirement (mandatory): before running ANY real shell command that builds, tests, or
inspects this project, route it through the shared measurement harness instead of running the raw
command directly:
  node "<path to harness.mjs>" --log "<LOG_PATH>" -- <your real command and its args>
Do NOT hand-roll your own timing wrapper. Do NOT run any build/test/inspection command outside the
harness. {LOG_PATH_SWITCH_INSTRUCTION where a cell has 2 scenarios}

Environment note: your shell tool's foreground execution ceiling defaults to ~120s and can be
raised up to 600s via an explicit timeout parameter. Any command that invokes Gradle should be run
with an explicit generous timeout (request the maximum available) and executed SYNCHRONOUSLY in
the foreground — never background a long-running command and then poll/monitor it. If a command
still hits the ceiling, let it terminate cleanly and retry once rather than spinning.

Rules:
1. Work fully autonomously. Do not ask me any clarifying questions.
2. Before giving your final answer, run at least one command whose output directly
   verifies your conclusion — not just your first signal.
3. Privacy: never paste raw local.properties contents or a full raw environment-probe dump.
4. Don't edit any source file.

Final structured report required: per-scenario outcome per repetition, retries and why,
verification command(s) used, a confidence statement, friction/improvement observations
(or "nothing notable" — do not manufacture one), and a plain-English final answer.
```

**`raw-gradle-no-kmp` tooling line:**
```text
Tooling constraint: use the Gradle wrapper (gradlew.bat in your working directory) directly for
all build/test-related commands. Do NOT invoke the kmp-test-runner skill, and do NOT run any
kmp-test command or any node .../bin/kmp-test.js ... command, even if one appears available to you
as a skill or tool — treat it as if it does not exist for this task. If you notice a skill named
kmp-test-runner in your available-skills list, deliberately ignore it.
```

**`kmp-test-json` tooling line:**
```text
Tooling constraint: prefer the kmp-test CLI's --json mode when it fits this task. It is available
at <absolute path to bin/kmp-test.js> (invoke via node <that path> <subcommand> --project-root
{WORKTREE_PATH} ... --json). You may fall back to the Gradle wrapper directly if kmp-test doesn't
fit some part of the task, but note that fallback explicitly.
```

Per-cell resolved scenario lists: KaMPKit cells got both `:shared` (success, 3 reps) and `:app`
(no-test, 3 reps), in that order. NowInAndroid cells got only `core:common` (2 reps). No prompt
was edited mid-run; the one methodology adjustment that happened (switching NowInAndroid's third
scenario from `feature:foryou:impl` to `core:common`) happened **before** any real subagent prompt
was written, during calibration — see below.

## Methodology

### Project & scenario selection

KaMPKit's `:shared` (real tests, `commonTest`+`androidHostTest`) and `:app` (zero test source)
reuse v1's exact modules and exact commit, for direct continuity — filesystem facts re-verified,
not re-assumed. NowInAndroid was newly added this wave per the brief's requirement; both existing
local clones (`KaMPKit-fresh`, `nowinandroid`) already matched their respective GitHub remotes'
live `HEAD` at benchmark time (confirmed via `git ls-remote`), so no fresh network clone was needed.

**The NowInAndroid scenario changed during calibration, and that change is disclosed here rather
than hidden.** A `tools/runs/multi-project-token-cost-2026-07-16/` capture (untracked local
evidence from the day before this benchmark) had already surfaced an organic (non-synthetic)
failure in NowInAndroid at this commit: module `feature:foryou:impl`,
`errors:[{"code":"module_failed","setup_failed":true}]`. This looked like a promising candidate to
satisfy both the "NowInAndroid official-project scenario" requirement and the "real
failure/diagnostic scenario, no synthesis" stretch goal in one bounded scenario — so before writing
it into any real subagent prompt, it was calibration-probed directly (harness-wrapped, in the
pre-existing `OFFICIAL_PROJECTS/nowinandroid` clone, discarded from evidence either way, logged to
`calibration-probe.jsonl` for transparency):

- First calibration run: reproduced the failure (`exit_code:1`, `module_failed`,
  `feature:foryou:impl`), genuinely fresh (`fresh:0, up_to_date:0` — not a stale-cache artifact),
  ~25s. `individual_total:0` in the same response — meaning **zero individual JUnit tests were
  even counted**, despite the module-level failure. This is consistent with `setup_failed:true`:
  something failed before any test could execute, not a test assertion.
- Reading the JUnit XML the run had just written showed 0 failures across both test classes in the
  module (`ForYouScreenScreenshotTests`, `ForYouViewModelTest`) — with 5-day-old timestamps. The
  real failure was happening *before* those XML files, likely in the Roborazzi screenshot-testing
  plugin's separate `finalizeTestRoborazziDemoDebug` step (a post-hoc screenshot-comparison
  aggregation task, not the JUnit test task itself).
- A second calibration run (raw `gradlew.bat :feature:foryou:impl:testDemoDebugUnitTest`,
  immediately after the first) came back **BUILD SUCCESSFUL** — the same
  `finalizeTestRoborazziDemoDebug` step that failed the first time passed cleanly the second time,
  with unchanged inputs.

**Verdict: this failure is not reliably reproducible across consecutive invocations, so it was not
used.** Per this wave's own explicit instruction ("If it doesn't reproduce cleanly or reads as
environment-specific... never synthesize a source edit to force one"), the scenario was switched
to `core:common` — a small, non-flaky, plain-JVM module confirmed (via the same calibration
process) to have exactly one real unit test that passes. This flaky-failure finding is itself
recorded as a "candidate follow-up improvement" observation below, not discarded as noise.

### Cache honesty

All 4 real-cell worktrees plus the calibration probe share this machine's *global* Gradle
dependency cache and daemon registry — deliberate (re-downloading dependencies per cell would
multiply runtime for no measurement benefit). What this run discovered, and what makes this more
than a theoretical caveat: **Gradle's build/task cache is content-keyed, not path-keyed.** Every
cell's very first real test command came back served from cache (`FROM-CACHE`, `UP-TO-DATE`, or
`from_cache:1` depending on which tool reported it) — including cells in worktrees that had *never*
been touched before, because a different worktree of the *identical commit* had already produced a
cache entry Gradle correctly recognized as reusable. Every subagent independently noticed this
(without being told to expect it) and forced a genuine re-execution via `--rerun-tasks` before
concluding. **cache_state for this entire run is "warm — shared global Gradle dependency AND
build/task cache across all cells and the calibration probe," never cold, and per this wave's own
instruction, cache-hit and forced-fresh timings are never averaged together** — see Results.

### Isolation & execution order

Git worktrees off the pre-existing local clones (`OFFICIAL_PROJECTS/KaMPKit-fresh`,
`OFFICIAL_PROJECTS/nowinandroid`), detached at the pinned commits, one worktree per (project ×
condition) — 4 total. `local.properties` (gitignored, Android SDK path) copied into each as
one-time setup. Removed via `git worktree remove --force` after evidence capture. Dispatched
**sequentially, never concurrently** — same reasoning as v1: concurrent Gradle builds, even in
separate worktrees, would contend for CPU/IO and bias timing. Order: `kampkit-kmp-test-json` →
`kampkit-raw-gradle-no-kmp` → `nowinandroid-kmp-test-json` → `nowinandroid-raw-gradle-no-kmp`.

### Harness bugs found and fixed before any graded cell ran

The harness's own self-test (trivial `node -e` success/failure/redaction commands, all passing)
did **not** exercise the `.bat`-file spawn path at all, since that codepath was added afterward.
Real bugs surfaced once the harness was pointed at actual `gradlew.bat` invocations during the
NowInAndroid calibration probe (`calibration-probe.jsonl`, lines `n=2` and `n=3`, both
`exit_code:1`) — logged there rather than hidden, exactly like everything else in this document:

1. Windows dynamic `import()` rejected a raw filesystem path for `tools/lib/redact.mjs`
   (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) — needed `pathToFileURL()`. Caught by the harness's own
   self-test, before any calibration or graded command ran; no JSONL line exists for this crash
   since it happened before the harness could even start logging.
2. Node's `spawn()` with `shell:false` cannot directly execute `.bat` files on Windows
   (`EINVAL`) — a documented Node/Windows limitation. The first fix attempt (`shell:true`) traded
   this for a different failure: Node's own `DEP0190` deprecation warning (unescaped argument
   concatenation) plus a functional failure to resolve `gradlew.bat` at all (`calibration-probe.jsonl`
   `n=2`). A second attempt (explicit `cmd.exe /c` with an argv array) also failed to resolve the
   file under this Git Bash environment (`n=3`, `"retry after cmd.exe fix"`). The fix that actually
   worked: route through `bash -c` with each argument POSIX-quoted explicitly — this repo's own
   shell environment already runs `.bat` files correctly via its MSYS layer, confirmed directly
   before relying on it (`calibration-probe.jsonl` `n=4`, a `gradlew.bat --version` smoke test).

Both bugs were fixed, and the fix was verified working (smoke test, then a real calibration run),
**before the first real subagent was ever dispatched** — none of the 6 graded cells' 23 commands
hit either bug. This is disclosed in full because the whole point of this wave is closing v1's
wrapper-confound finding, and an unqualified "zero bugs" claim would not survive a reader checking
`calibration-probe.jsonl` against it, which is exactly what caught this during review.

### One dispatch-level infrastructure failure, disclosed

The first `kampkit-kmp-test-json` dispatch failed mid-task with a connection error ("Connection
closed mid-response") unrelated to either condition's behavior — pure session infrastructure, not
a tooling or agent-reasoning failure. It had completed 3 of 3 planned Scenario A commands's worth
of partial progress (1 exploratory `describe` + 2 of the intended repetitions) before dying, and
had not started Scenario B. Rather than resume an agent with uncertain post-disconnect internal
state, the partial JSONL log was discarded and the cell was redispatched fresh with an identical
prompt. **This is not counted anywhere in this document's `retry_count` or `human_interventions`
fields** — those describe condition behavior, not session infrastructure — but it is disclosed
here in full rather than silently omitted, matching this document's own standard for the
`describe`/`parallel` and cache-hit findings below.

### Timing & verification authority

Every `duration_ms` in the results below is the harness's own `process.hrtime.bigint()`
measurement around the actual child process — not a subagent self-report, not an estimate.
Verification quality was assessed by reading each subagent's disclosed verification method (did it
re-read raw JUnit XML independent of the tool's own parser? did it force a fresh execution rather
than trusting a cache hit?) — the same rubric spirit as v1's Ease-of-use dimensions, without
formally scoring 1-5 given the small sample. Every JSONL log and `summary.json`'s cross-checked
sums were independently verified against each subagent's own report before being accepted (trust
but verify) — no cell's numbers in this document are taken from a subagent's self-report alone.

### Sample size & acceptance criteria walkthrough

n=3 per KaMPKit cell (12 real determinations total), n=2 per NowInAndroid cell (4 real
determinations total) — reduced for NowInAndroid per this wave's own brief. Checked against
[`docs/agentic-usage-measurement.md`](../../docs/agentic-usage-measurement.md)'s acceptance
criteria: repeatable commands (yes — zero mid-run prompt edits, unlike v1); public/private
separation explicit (public-only, both projects real GitHub remotes); platform recorded (Windows
11 Pro, below); model/tooling versions recorded (below); raw artifacts classified (sanitized JSONL
+ harness + summary.json committed; unsanitized subagent transcripts are session-local, not
committed); summary docs clean (verified via `tools/decouple-audit.mjs` + manual grep, see
Privacy); README promotion requires evidence (deliberately deferred this PR — see Interpretation).

**Environment**: Windows 11 Pro 10.0.22631, Node v24.12.0, Git 2.46.2, host JDK Temurin 23.0.2
(project Gradle toolchains resolved their own versions independently — Zulu 21 for KaMPKit, per
its wrapper; NowInAndroid's `gradle-wrapper.properties` pins Gradle 9.4.0), `kmp-test-runner`
v0.14.0 (this repo's `develop` tip at benchmark time, unreleased at the exact commit used).

## Results

Cache-hit and forced-fresh durations are reported **separately per this wave's explicit
instruction** — they measure different things (a cache lookup vs. a real compile+test execution)
and averaging them would be misleading. "Verify" = the verification method(s) beyond the first
signal.

### KaMPKit (n=3 real determinations per cell)

| Scenario | Condition | Outcome | Cache-hit rep | Forced-fresh reps | Commands | Verify |
|---|---|---:|---:|---|---:|---|
| Success (`:shared`) | `kmp-test-json` | ✅ 24/24 pass | 2,965 ms | 14,526 ms, 9,489 ms | 4 | raw JUnit XML re-read, independent parser |
| Success (`:shared`) | `raw-gradle-no-kmp` | ✅ 24/24 pass | 2,268 ms | 8,022 ms, 7,958 ms | 4 | raw JUnit XML re-read, timestamp-confirmed fresh |
| No-test (`:app`) | `kmp-test-json` | ✅ correctly "no tests" | n/a | 894, 896, 866 ms | 5 | `--include-untested` + `describe` static model, both agree |
| No-test (`:app`) | `raw-gradle-no-kmp` | ✅ correctly "no tests" | n/a | 2,388, 6,696, 1,648 ms | 4 | forced rerun + all-variant `:test` + filesystem check |

### NowInAndroid `core:common` (n=2 real determinations per cell, bounded scope)

| Condition | Outcome | Cache-hit rep | Forced-fresh rep | Commands | Verify |
|---|---:|---:|---:|---:|---|
| `kmp-test-json` | ✅ 1/1 pass | 32,085 ms | 9,517 ms | 3 | cache-served + forced-fresh kmp-test runs + standalone JUnit-XML parse, all agree |
| `raw-gradle-no-kmp` | ✅ 1/1 pass | 15,435 ms | 3,791 ms | 3 | forced rerun (XML timestamp advanced) + direct XML parse (console gives no counts) |

All 6 cells: `retry_count: 0`, `human_interventions: 0` (the one dispatch-level infrastructure
retry is disclosed separately above, not folded into either field). Full per-command detail in
`summary.json` and the 6 per-cell `.jsonl` files.

## Interpretation

Following this wave's own instruction to separate what the data proves, suggests, and does not
measure — and to separate Gradle execution time from agent workflow time.

**What the data proves (n=2-3, so "proves" means "these specific runs showed," not "this is a
stable population effect"):**
- Both conditions reached the correct diagnosis on all 3 scenarios, every time (6/6 cells,
  `expected_outcome_matched: true`). Neither condition failed where the other succeeded.
- `kmp-test-json` never needed to know an actual Gradle task name — `--module-filter` resolved
  `:shared`, `:app`, and `core:common` correctly across two projects with *different* task-naming
  conventions (`testAndroidHostTest` for KaMPKit's KMP module, `testDebugUnitTest` for its plain
  Android module, `test` for NowInAndroid's plain-JVM `core:common`). `raw-gradle-no-kmp` had to
  discover each task name itself every time (via `:tasks` or reading build files) — real,
  consistently observed friction, present in all 3 raw-gradle cells.
- Both conditions independently discovered and correctly handled the shared-cache trap (see Cache
  honesty) without being told to expect it, and both used the same recovery strategy
  (`--rerun-tasks`) to force a genuine independent determination.

**What the data suggests, but does not prove at this sample size:**
- **Raw Gradle execution time (forced-fresh, isolated from kmp-test's own wrapper overhead) was
  not faster with `kmp-test-json` here — if anything, the opposite.** KaMPKit `:shared` forced-fresh:
  `kmp-test-json` averaged ~12.0s (14.5s, 9.5s) vs. `raw-gradle-no-kmp`'s ~8.0s (8.0s, 8.0s).
  NowInAndroid `core:common` forced-fresh: `kmp-test-json` 9.5s vs. `raw-gradle-no-kmp` 3.8s. This
  is a small, un-powered sample, but it is consistent in direction across both projects, so it is
  reported plainly rather than smoothed over: `kmp-test`'s orchestration layer (project-model
  resolution, JDK detection, module scanning) adds real overhead on top of the underlying Gradle
  invocation, even when scoped to one already-known module via `--module-filter`. **This benchmark
  does not support a "`kmp-test-json` is faster" claim, at any ratio, for this kind of
  single-module bounded task.**
- **Command count was a wash, not a clean win either way.** KaMPKit success: 4 vs. 4 (tied).
  KaMPKit no-test: 5 (`kmp-test-json`) vs. 4 (`raw-gradle-no-kmp`) — `kmp-test-json` used *more*
  commands here, because that subagent chose extra cross-checks, not because the tool was less
  efficient. NowInAndroid: 3 vs. 3 (tied). **This benchmark does not support a "`kmp-test-json`
  always uses fewer commands" claim either** — for the existing, narrower, well-evidenced claim
  about output *size* (not command count), the published
  [token-cost measurement](../../docs/token-cost-measurement.md) remains the correct source.
- Where `kmp-test-json` plausibly *does* help, based on what was actually observed rather than
  assumed: task-name discovery is exactly the kind of friction that scales worse with project size
  and inconsistent per-module conventions (NowInAndroid mixes `test`, `testDebugUnitTest`, and
  flavored variants across modules in the same repo) — `--module-filter` abstracts that away
  uniformly. This reads as the more credible value proposition than raw speed, consistent with
  v1's own "verification and recovery behavior, not raw speed" finding.

**What this benchmark does not measure:** see the dedicated section above (full agent-turn
wall-clock, real token consumption, true cold-cache execution, economic cost, a statistically
powered sample). None of the numbers above should be read as generalizing beyond these 3 specific
scenarios on these 2 specific projects at this specific commit pair.

**Why this should not be promoted to a README headline yet.** n=2-3 per cell, single-rater
grading, two projects, no statistically powered sample, and — unlike a clean "X is faster" story —
this wave's own honest reading is that raw execution time did not favor `kmp-test-json` here. Per
`docs/agentic-usage-measurement.md`'s own acceptance criteria and this wave's brief, README
promotion stays deferred until evidence is stronger and the maintainer explicitly approves it.

## Candidate follow-up improvements

Collected as observations only during this benchmark — **not implemented in this PR**. This PR
does not touch `.skills/kmp-test-runner/**`, `lib/**`, `bin/**`, or `README.md` for any reason,
including anything found here, so that measuring and fixing stay separate and this evidence stays
comparable to a future rerun. A future dedicated PR/wave may act on these, ideally with its own
before/after measurement.

### Potential product bug (not just a guidance gap)

- **`kmp-test describe` disagrees with `kmp-test parallel` about whether KaMPKit's `:shared` module
  has unit tests.** `describe --module-filter shared --json` reports `test_tasks.unit: null` for
  `:shared` — which reads as "no unit tests exist." But `parallel --module-filter shared --json`
  correctly auto-detects and runs 24 real, passing tests via the `testAndroidHostTest` task. The
  KaMPKit subagent's own analysis: `:shared` uses the newer AGP-9 `kmpAndroidLibrary`
  `withHostTestBuilder{}` DSL, and `describe`'s static model appears unable to name the resulting
  host-test task, while `parallel`'s runtime resolution can. **An agent that trusted `describe`
  alone (a reasonable "check before running" strategy `describe` exists to support) would wrongly
  conclude `:shared` has no unit tests to run.** `test_tasks.unit: null` is genuinely ambiguous —
  it is the *correct* answer for `:app` (which really has none) and the *wrong* answer for
  `:shared` (which has 24 passing tests), and nothing in the field distinguishes the two cases
  without independently running `parallel` to check. Repro: KaMPKit `b3a7784`, compare
  `kmp-test describe --module-filter shared --json` against
  `kmp-test parallel --module-filter shared --json` on the `:shared` module.

### Skill / UX / documentation observations

- **No first-class "force a genuinely independent run" flag.** Every one of the 6 cells needed
  `--gradle-args "--rerun-tasks"` (kmp-test-json) or bare `--rerun-tasks` (raw-gradle) to get a
  real second execution rather than a cache hit — discovered independently by every subagent, not
  prompted. A first-class `--rerun`/`--fresh-tests`-style flag would make "give me a clean
  independent determination" discoverable without reaching into Gradle's own flag surface
  (`--fresh-daemon` restarts the daemon but doesn't force task re-execution — a plausible false
  lead for a reasonable-sounding guess).
- **`tests.total`/`passed`/`failed` count test *tasks*, `individual_total` counts test *methods*,
  and there's no `individual_passed`/`individual_failed` split.** Multiple subagents noted this was
  briefly ambiguous when asked to "report the pass/fail count" — the per-method split has to be
  inferred (task-level `failed:0`) or confirmed by reading the JUnit XML directly.
  `describe`/`parallel` field semantics in general were reported as needing a source dive to
  interpret with full confidence (e.g. what exactly `execution: {fresh, up_to_date, from_cache}`
  buckets mean) — a one-line schema doc per field would help a consumer without repo access.
  Positive counterpoint: `skipped[].reason` strings (e.g. `"no test source set"`) were repeatedly
  called out as immediately clear.
- **`no_test_modules` (exit 2) reads like a config/usage error, not "legitimately nothing to run."**
  Same exit-code class as a bad flag. The `skipped[].reason` message is what actually disambiguates
  it, and does so well — but the exit code alone doesn't.
- **Task-name convention inconsistency within a single project is real, not hypothetical.**
  NowInAndroid alone mixes plain `test` (`core:common`, JVM convention), `testDebugUnitTest`
  (classic Android convention, used by `:app` in KaMPKit too), and flavored variants
  (`testDemoDebugUnitTest` for `has_flavor:true` modules like `feature:foryou:impl`) — all in the
  same repository. A raw-gradle agent has to read `build.gradle.kts` / convention-plugin source per
  module to be sure; `--module-filter` abstracted every one of these correctly without the agent
  needing to know the underlying task name.
- **The NowInAndroid flaky-failure finding itself (see Methodology) is worth a skill note**: an
  agent relying solely on `errors[].code: module_failed` for a Roborazzi/screenshot-test module
  could reasonably want to know that `setup_failed: true` + `individual_total: 0` together are a
  signal to check whether the failure is upstream of test execution (build/plugin-level) before
  concluding "N tests failed" — this benchmark's own calibration nearly made exactly that mistake
  before checking the raw JUnit XML.
- No friction was reported for `--module-filter` resolving unambiguously on NowInAndroid's
  30+-module structure — both conditions targeted `core:common` correctly in one shot.

## Privacy

Public projects only (`touchlab/KaMPKit`, MIT-licensed; `android/nowinandroid`, Apache-2.0-licensed
— both real GitHub remotes, verified via `git ls-remote`). No private project names, no persistent
API keys (none used — offline byte counts only). All local absolute paths are redacted to
`<USER_PATH>`-style placeholders by the harness itself, inline, before any JSONL line ever touches
disk — not a post-hoc doc pass. Verified via:
- `node tools/decouple-audit.mjs` — clean.
- A dedicated manual grep sweep across the entire run directory (all 8 committed files) for
  `C:\Users\...` / `/Users/...` / `/home/...` paths, device-serial-shaped strings, and `sk-ant-`/
  `sk-proj-` patterns — zero hits.
- `node harness.mjs --verify tools/runs/agentic-usage-benchmark-v2-2026-07-17/` — every JSONL line
  parses and has all required fields with the correct types (fails closed on a missing/malformed
  field, not just invalid JSON); every cell's `summary.json` sums match its `.jsonl` file exactly.

## Raw artifacts

- **Committed** (sanitized): `tools/runs/agentic-usage-benchmark-v2-2026-07-17/harness.mjs`,
  `self-test.jsonl`, `calibration-probe.jsonl` (disclosed calibration data, not counted as graded
  evidence — see Methodology), the 6 per-cell `*.jsonl` logs, `summary.json`.
- **Local-only** (not committed): the 4 git worktrees (removed via `git worktree remove --force`
  after evidence capture), unsanitized subagent transcripts.
- **Simplified reproduction** (spot-check one cell, not the full 4-worktree protocol):
  ```sh
  git clone https://github.com/touchlab/KaMPKit
  cd KaMPKit && git checkout b3a7784fb969a8558b88c80674c8b596944cdab7
  # add local.properties with your own Android SDK path
  ./gradlew.bat :shared:testAndroidHostTest --console=plain --rerun-tasks   # raw-gradle-no-kmp
  node <kmp-test-runner>/bin/kmp-test.js parallel --project-root . --module-filter shared --json --gradle-args --rerun-tasks   # kmp-test-json

  git clone https://github.com/android/nowinandroid
  cd nowinandroid && git checkout 7d45eae4f8720a0c77f507712ba2437ff974b6ed
  ./gradlew.bat :core:common:test --console=plain --rerun-tasks   # raw-gradle-no-kmp
  node <kmp-test-runner>/bin/kmp-test.js parallel --project-root . --module-filter core:common --json --gradle-args --rerun-tasks   # kmp-test-json
  ```

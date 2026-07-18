# tools/agentic-eval — reproducible skill evaluation harness

Reusable tooling that proves, technically, whether Claude Code's Skill-matching mechanism
invokes the `kmp-test-runner` skill under controlled conditions. This is a **foundation**, not
a benchmark: no results are published here, and the full corpus is not executed by this PR. See
[`docs/agentic-usage-measurement.md`](../../docs/agentic-usage-measurement.md) for the broader
methodology this implements a piece of.

**Scope note:** an earlier version of this PR also included six scenario definitions, a grader
registry, and a natural-trigger corpus-probe path. Two independent review passes found the
scenario/grader layer incomplete (missing fixtures, non-reproducible mutations, grading via
broad keyword matching rather than structured evidence) and found several real correctness bugs
in the foundation layer itself. This PR was narrowed to the foundation only — launcher, policy,
parser, privacy, schema, lifecycle, and a genuinely-passing calibration/smoke acceptance gate.
Scenario/grader completeness is tracked as a follow-up (see BACKLOG.md).

## Why this exists

Two prior measurement rounds in this repo (`tools/runs/agentic-usage-pilot-2026-07-17/`,
`tools/runs/agentic-usage-benchmark-v2-2026-07-17/`) never made the skill technically absent in
their "no-skill" condition — they prompt-instructed the agent to *pretend* it didn't exist — and
never observed a real `Skill` tool-invocation event; "skill used" was inferred by grepping
shell-command text for `kmp-test`. This harness closes both gaps with technical isolation and a
real event-level invocation proof — including the outcome of that invocation, not just its
presence (see "Attempted vs. confirmed invocation" below).

## Conditions

- **`no-skill`** — the skill is technically absent (proven via the `init` event's `plugins[]`
  array being empty, not asserted from flag choice).
- **`current-skill`** — the skill is loaded via `--plugin-dir` from a git-archive snapshot of a
  pinned commit (`c5c0661852f7c9da145ef56892048e706216a6ce` by default), never the live working
  tree, so the evaluated skill content can't silently drift.
- **`candidate-skill`** — accepted as a future path in the schema; `condition-launcher.mjs`
  throws a clear, typed error if selected. Not implemented here.

Both conditions receive byte-identical argv, environment, and policy configuration — the *only*
difference is the presence of `--plugin-dir`. `condition-launcher.mjs`'s `buildConditionArgv()`
enforces this mechanically (condition A's argv is an exact prefix of condition B's; B's only
suffix is `['--plugin-dir', <snapshot>]`).

## Attempted vs. confirmed invocation

A `Skill` `tool_use` block proves the model *tried* to invoke a skill — it does not prove the
invocation succeeded. On a real captured no-skill transcript, the model calls `Skill` with
`{skill: "kmp-test-runner"}` anyway (the prompt asked for it directly), gets back
`<tool_use_error>Unknown skill: kmp-test-runner</tool_use_error>` with `is_error:true` on the
correlated `tool_result` (matched by `tool_use_id`), and tells the user the skill doesn't exist.
`stream-parser.mjs`'s `findSkillInvocation()` reports this correctly via two separate fields:

- `skill_invocation_attempted` — a matching `Skill` `tool_use` block was found, regardless of
  outcome.
- `skill_invoked` — that attempt's own `tool_result` was found and was **not** an error. Never
  assumed true from the tool_use block alone, and never assumed true when no result exists yet.

An earlier version of this harness only checked for the `tool_use` block, so a no-skill run's
record could show `skill_available:false` and `skill_invoked:true` in the *same record* —
directly self-contradictory. `schemas.mjs` now also rejects that combination at the schema level
(`skill_invoked:true` requires `skill_invocation_attempted:true`).

## Run kinds

- **`calibration`** — explicit-invocation only (the prompt directly asks for the skill by name).
  Proves invocation *mechanics*: both conditions must show a genuine attempt (the prompt actually
  drives one), and confirmed invocation must track availability exactly (A attempts and fails, B
  attempts and succeeds). A failure here is a harness bug, not a measurement result.
- **`smoke`** — one bounded scenario, both conditions, through the real CLI end-to-end. Proves
  the pipeline works with **equivalent real diagnostic work in both arms** — not just skill
  availability. `smokeHardGate()` requires, in *both* conditions: skill availability matches
  expectation (A:false, B:true), the process completed normally with a zero exit code, its own
  `result` event was not an error, every Bash call reached the policy hook
  (`hookAccountingOk`), `hook_call_count >= 1` **and** `hook_deny_count === 0` **and** the
  hook's own allow-count matches its call-count exactly — not merely "zero denies" — so a
  malformed, unparseable hook decision (neither an explicit allow nor a deny) can't silently
  pass (`realWorkOk`), the two specific expected commands (`kmp-test doctor`, `kmp-test
  describe`) were each run with their own correlated, non-error result — not just "N Bash calls
  happened" (`exactCommandsOk`), and a transcript with zero malformed lines
  (`cleanTranscriptOk`). It deliberately does **not** require the skill to actually trigger in
  condition B — whether it triggers naturally on smoke's prompt is an open question for a future
  corpus-probe run, not something smoke should presuppose. An earlier, open-ended smoke prompt
  drove the agent toward general exploration (`ls`/`pwd`/`git status`/`find`) that the policy
  hook correctly denies by design — 11/13 and 6/6 real calls were denied in that run, meaning
  smoke never actually exercised real diagnostic work despite passing its (much narrower) old
  gate. The current prompt names the exact two read-only commands to run, removing the need to
  explore.
- **`scenario`** / **`corpus-probe`** — accepted in the schema as future `run_kind` values; not
  produced by anything in this PR. `aggregate.mjs`/`schemas.mjs` refuse to fold any
  `benchmark_eligible:false` record into a publishable aggregate, so nothing this PR produces can
  ever be miscounted as measurement data.

Every record this PR's code can actually produce is `benchmark_eligible: false`.

## No committable evidence before every gate passes

`cli.mjs`'s `finalizeAndWriteRecords()` is the **only** path that writes to a committable
`tools/runs/agentic-eval-<kind>/` directory, and it runs every gate in order before writing
anything:

1. Full schema validation (`validateRun`) on both records.
2. A **freshly recomputed** `policy_sha256` (via `computePolicySha256({fresh:true})`) matched
   against both records — catches evidence that has silently gone stale relative to the current
   `policy-hook.mjs` content, which a format-only check (`/^[0-9a-f]{64}$/`) can't detect.
3. The privacy fail-closed check (`assertCleanOrThrow` from `privacy.mjs`) on each record's
   serialized text — refuses (throws, writes nothing) if any leak survives redaction. An earlier
   version of this harness imported this function and never called it.
4. The run-kind's own hard acceptance predicate (see "Run kinds" above).

Any failure returns `{ok:false, reason}` and writes nothing — verified directly:
`tests/vitest/agentic-eval-cli-integration.test.js` spawns real `node cli.mjs calibrate|smoke`
subprocesses against fake `claude` fixtures (`tests/fixtures/fake-claude-*/`) covering both a
passing scenario and three distinct failure scenarios (no attempt at all, all commands denied, a
malformed transcript line), asserting zero evidence files are written on every failure path.
Every subprocess this test file spawns is pointed at an isolated `KMP_EVAL_RUNS_ROOT` (a
fresh, per-test temp directory) instead of the real, shared `tools/runs/` tree — an earlier
version of this test file read/wrote/deleted directly under the real path, which would have
destroyed real committed evidence the moment any existed there.

Redaction protects **both** the written file and stdout — `finalizeAndWriteRecords()` returns the
same redacted text it wrote to disk (parsed back, not the original in-memory record), and every
caller (`cmdCalibrate`/`cmdSmoke`) prints that redacted object, never the original. An earlier
version redacted only the file and printed the original, unredacted record to the terminal.

`cli.mjs`'s `parseArgs()` treats a flag with no value (or one immediately followed by another
flag, e.g. a trailing `--private-patterns-file` with nothing after it) as a hard parse error, not
a silently-`undefined` flag — this matters specifically for `--private-patterns-file`, where a
silently-ignored value previously meant private-pattern redaction was silently disabled and the
run still reported `privacy_status: 'public'` with no error at all.

`calibrationHardGate()`/`smokeHardGate()` are named, exported functions (not inline closures)
specifically so each sub-check (`invocationOk`, `processOk`, `resultOk`, `hookAccountingOk`, and
for smoke also `realWorkOk`, `exactCommandsOk`, `cleanTranscriptOk`) can be unit-tested in
isolation with precise synthetic inputs — `tests/vitest/agentic-eval-hard-gates.test.js` flips
exactly one input per test and asserts exactly one named sub-check goes false while every other
named sub-check in the same failure-reason string stays true. This is deliberately a different
proof than the real-subprocess fake-`claude` fixtures in `agentic-eval-cli-integration.test.js`:
constructing a real subprocess transcript that fails *exactly* one sub-check and none of the
others is fragile in its own way (several real event shapes this would require, like a denied
command's own `tool_result` shape, aren't independently verified anywhere in this harness, so
fabricating one risks encoding an unverified guess as confirmed fact). Where a single fake-claude
scenario genuinely trips more than one sub-check at once — e.g. zero commands run at all fails
both `realWorkOk` and `exactCommandsOk`, since neither can be satisfied by zero commands — that's
disclosed as the same underlying fact tripping two named checks, not presented as single-cause
isolation.

## Isolation

- **Environment**: `env-builder.mjs`'s `buildEvalEnv()` is allowlist-only, starting from the
  narrowest defensible set (OS essentials, PATH, locale, temp, Java, Android). `HOME`/
  `USERPROFILE`/`APPDATA` are *not* included — verified empirically that a real `claude -p`
  session authenticates fine without them (OAuth resolves via the OS credential store).
- **kmp-test pinning**: `path-shim.mjs` generates a PATH-prepended shim that invokes *this
  worktree's* `bin/kmp-test.js`, never a stray global install. The pinned path is single-quote
  escaped inside the generated shim (never double-quoted, which would let a `$`/backtick/`$(...)`
  in the worktree path get shell-expanded on every invocation).
- **kmp-test config isolation**: the shim — not the parent claude session's own environment —
  redirects `HOME`/`USERPROFILE` for the grandchild `node bin/kmp-test.js` process only, so
  `~/.kmp-test/config.json` can never affect either arm, while the parent session keeps its real
  profile for OAuth. `KMP_EVAL_TEMP_HOME` itself is wiped and recreated before **each** condition
  of a run-pair (not just allocated once) — otherwise whatever the first-run condition wrote
  there could leak into the second.
- **Command policy**: `policy-hook.mjs`, a `PreToolUse` hook, is the **sole** command-approval
  mechanism (an earlier `--allowedTools` pattern-list design was tested directly and found
  insufficient — see the PR description's evidence table). It's a narrow, explicit-grammar
  allowlist (not a denylist): only `kmp-test <allowed-subcommand>` and
  `<fixture-anchored-gradlew> <allowed-task>` shapes are approved, every path argument is
  resolved via `fs.realpathSync()` (never lexically inspected — closes shell/env-expansion,
  symlink/junction escapes, and PATH-order substitution), and policy configuration
  (`KMP_EVAL_ALLOWED_GRADLE_TASKS`, `KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS`,
  `KMP_EVAL_EXPECTED_FIXTURE_ROOT`) comes only from harness-controlled environment variables,
  never the hook's own stdin payload. `condition-launcher.mjs`'s `buildSharedEnv()` routes this
  policy config through `policy-config.mjs`'s own validator *before* it ever reaches the env
  object, so invalid grammar/duplicates/non-array input fail loudly at harness-construction time
  instead of surfacing only as an opaque runtime hook denial. The hook's own response is flushed
  (gated on `process.stdout.write()`'s completion callback) before the hook process exits —
  `process.exit()` immediately after starting a write can truncate it on a piped stdout.
- **Bash resolution**: every `bash -c` invocation in this harness (git/tar piping, the measured
  `claude` spawn) goes through `resolve-bash.mjs`'s `resolveBash()`. **On Windows specifically**,
  this never resolves to an ambiguous bare `'bash'`: PATH resolution of a bare `'bash'` is
  **not** unambiguous there — if WSL is installed, `System32\bash.exe` (a launcher into the WSL
  subsystem, with WSL's own path translation) can resolve ahead of Git for Windows' MSYS2
  `bash.exe` depending on PATH order — confirmed directly (this exact ambiguity broke 6 tests
  when the suite ran under a shell where System32 preceded Git's `bin/` on PATH). On Windows,
  `resolveBash()` checks well-known Git for Windows install locations first, falls back to
  deriving `bash.exe` from `where git`'s own install root, and supports an explicit
  `KMP_EVAL_BASH_PATH` override — it never silently falls back to an ambiguous bare `'bash'` on
  that platform. On POSIX, `resolveBash()` *does* return the bare string `'bash'` as-is — PATH
  resolution there has no WSL-style split to be ambiguous about, so the extra resolution logic
  is Windows-only.

**This is a verified command-policy boundary for a pinned, trusted fixture/scenario project —
not an OS/filesystem sandbox.** Once a command is approved, Gradle build-script code and
kmp-test itself execute with full host permissions. Acceptable specifically because
fixture/scenario projects are pinned, committed, and trusted; never claimed as a general
sandbox. No OS-level sandbox exists on native Windows. `schemas.mjs` accepts
`termination_reason: 'unsupported-platform-profile'` as a future graceful-degradation value (a
scenario that genuinely needs more than the hook's approved grammar allows should report this
instead of the hook's permissions being widened to force completion) — **stated precisely: no
code path in this PR actually produces that value today.** `condition-launcher.mjs`'s real
termination logic only ever assigns `null` (normal completion, any exit code), `'timeout'` (the
harness's own timer fired), or `'error'` (the process was killed by an external signal). Wiring
an actual graceful-degradation path is future work, not implemented here.

## Materialization and cleanup

Every fixture — calibration project, scenario project, or the skill snapshot itself — is
materialized into a fresh `os.tmpdir()`-rooted directory immediately before use (`materialize.mjs`),
never run in place inside this repo. For the two conditions of one run-pair, the same temp path
is reused, wiped, and re-populated from the pristine source between conditions — literally the
same cwd, never state leaking from one condition into the other. Same discipline for
`GRADLE_USER_HOME` (snapshotted once per run-pair, restored to that exact snapshot before each
condition — no dependency prewarming actually happens as of this PR; `runPrewarm` is an optional
hook a caller can supply, but `cli.mjs` doesn't supply one today, so the "snapshot" is of an
otherwise-empty directory).

`cli.mjs`'s `runConditionPair()` returns a `cleanup()` function the caller invokes from a
`finally` block on a **successful** resolution, removing every temp directory it created (shim,
skill snapshot, both of `materializeGradleUserHome`'s temp directories, `KMP_EVAL_TEMP_HOME`, the
generated `--settings` file's directory) and, for a scenario project specifically,
`materialize.mjs`'s `removeScenarioWorktree()` — a plain directory delete leaves the source
repo's `.git/worktrees/` metadata registered forever even after the directory is gone.

That returned `cleanup()` handle is **not** the only cleanup path. `runConditionPair()` accumulates
an internal list of cleanup steps as each resource is actually created (not all at once at the
end); if acquisition fails partway through — the skill-snapshot `git archive`/validation, either
condition's own `materializeFixture` call, or anything else before the function would otherwise
return — an internal `try`/`catch` runs every step queued so far before rethrowing, so a caller's
own `try { await runConditionPair(...) } finally { cleanup() }` was never the only thing standing
between a failure and a leak. `materializeSkillSnapshot()` has the equivalent internal guard for
its own temp directory. This was a real gap found by an independent review pass: previously the
returned `cleanup()` was the *only* mechanism, and a caller only ever receives it once
`runConditionPair()` has already resolved successfully — a failure inside the function itself
left every resource created up to that point on disk permanently. A leftover git-worktree
registration from exactly this failure mode was found in the wild during that same review pass
and has been removed; `tests/vitest/agentic-eval-run-condition-pair.test.js` now drives the real
function with an injected mid-acquisition failure and asserts every temp resource created before
the injection point is gone afterward.

Verified directly: `agentic-eval-cli-integration.test.js` asserts zero leftover temp directories
(via a `TEMP`/`TMP`/`TMPDIR`-redirected, test-exclusive tmp root — a global `os.tmpdir()` count is
not safe to assert against under concurrent test-file execution) and zero leftover `git worktree
list` entries after both a passing and a failing run.

## Usage

```bash
node tools/agentic-eval/cli.mjs --help
node tools/agentic-eval/cli.mjs calibrate            # explicit-invocation calibration, both conditions
node tools/agentic-eval/cli.mjs smoke --source-repo-dir <local-clone> --pinned-commit <sha>
node tools/agentic-eval/cli.mjs corpus validate       # validates trigger-queries.json shape and banned-term rules
node tools/agentic-eval/cli.mjs validate --run <path> # validates a single run record against RUN_SCHEMA
node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
```

Both `calibrate` and `smoke` accept `--model <name>` and an optional
`--private-patterns-file <path>` — supplying the latter loads additional private-project
redaction rules (via `tools/lib/redact.mjs`'s `loadPrivateRules`) and marks the resulting
records `privacy_status: 'redacted-private'` instead of `'public'`. This PR's own usage
(the synthetic calibration fixture and public KaMPKit) never supplies it.

Raw transcripts always stay local under `tools/runs/agentic-eval-*/raw/` (gitignored). Only
sanitized, schema-valid, `findLeaks()`-clean run records are ever committed — and only once
`finalizeAndWriteRecords()`'s full gate sequence passes (see above).

## Schemas

Hand-rolled (`CURRENT_*_SCHEMA` int + `CANONICAL_FIELDS` array + `typeof`/enum/regex
validators), matching `tools/measurement-registry.mjs`'s existing convention — no JSON-schema
library exists anywhere in this repo's own code, so none is added here. Every legitimately-
nullable metric is `{value: T|null, reason: string|null}` — "never infer missing metrics, store
null with a reason" is enforced by the validator, not just a comment. Beyond the `{value,reason}`
shape, each nullable metric's *value* is also domain-checked once present (boolean for status
metrics, non-negative integer for counts/bytes, non-negative number for timings) — a
shape-valid-but-wrong value (e.g. `skill_invoked: {value: "false", reason: null}`, a string
instead of a boolean) previously passed validation silently.

## Fairness Contract

`aggregate.mjs`/`schemas.mjs` refuse to fold runs into one aggregate unless they agree on every
`HARD_PARTITION_FIELDS` key: `scenario_id`, `condition`, `family`, `run_kind`, `cache_state`,
`project_commit`, `model_resolved`, `platform`, `skill_source_sha`, `policy_sha256`,
`kmp_test_cli_source_sha`, `daemon_policy` — the last seven guard against silently averaging
across a re-pinned scenario commit, a different resolved model, a different host platform, a
different skill snapshot, a changed policy-hook version, a different harness code version, or a
different Gradle daemon policy (e.g. one run's daemon left enabled). The bucket key itself is
built via `JSON.stringify()` of the field-value array, not a plain `.join(' ')` — a space-join
lets two runs whose field values differ only in *where* a space falls collide into the same
bucket key while their actual values differ (e.g. `project_commit:'abc def', model_resolved:'x'`
vs. `project_commit:'abc', model_resolved:'def x'` both join to the same string); JSON encoding
unambiguously delimits each element regardless of its own content. Duplicate or empty `run_id`
values are rejected before counting, so a re-submitted run can't inflate `run_count`. Any
`benchmark_eligible: false` record is refused outright. `aggregateRuns()` also validates every
record against the full run schema before bucketing — a record that's partition-field-valid but
broken elsewhere (e.g. a malformed `tokens` object) is excluded and reported per-record, not
silently folded into a group.

Schema validation is not limited to shape and enum membership: `exit_code` must be null or an
integer; `started_at`/`ended_at` must be valid ISO timestamps with `ended_at` never before
`started_at`; `wall_clock_ms` must be a non-negative finite number (never legitimately null, since
it's always computed from real timestamps); `hook_call_count`/`hook_deny_count` must be
non-negative integers with deny never exceeding call; `policy_allowed_gradle_tasks`/
`policy_allowed_kmptest_subcommands` array elements must be non-empty strings; `errors[]` elements
must be objects; and `skill_invoked: true` is rejected outright unless
`skill_invocation_attempted: true` is also set (the schema-level enforcement of "Attempted vs.
confirmed invocation" above).

**Provenance**: every run record's `kmp_test_cli_version` (from this worktree's own
`package.json`), `kmp_test_cli_source_sha`/`repo_commit` (this worktree's own `git rev-parse
HEAD`, resolved fresh — not the pinned *skill* snapshot SHA, which is a separate field,
`skill_source_sha`), and `resolved_kmp_test_executable_path` are real, resolved values, cached
once per process. An earlier version of this harness left all three CLI-identity fields
permanently `null` and populated `repo_commit` with the pinned skill SHA instead of the harness's
own commit — silently correct only by coincidence when the checkout happened to sit exactly at
that pinned SHA, wrong the moment `develop` moved forward. Evidence writes
(`writeRunRecordEvidence`) are atomic per file (write to a `.tmp-<random>` sibling, then rename
into place) so a mid-write failure can't leave a half-written record on disk.

## Explicit limitations

- No full benchmark is executed by this PR; no performance claim is made.
- Public-project scenarios only; no private project is referenced.
- `candidate-skill` is schema-supported but not implemented.
- Scenario definitions, their fixture projects, and structured (non-keyword) grading are
  deferred to a follow-up PR — see BACKLOG.md. `corpus/trigger-queries.json` (the natural-trigger
  query set) remains in scope and is validated by `corpus validate`; nothing in `corpus/scenarios/`
  exists in this PR.
- Wildcard support in `--module-filter`/`--test-filter` is out of scope for the policy hook's
  grammar in this PR (a shell could re-expand an unquoted wildcard after the hook approves it) —
  documented as a future grammar extension.
- No dependency prewarming happens for `GRADLE_USER_HOME` as of this PR (see "Materialization
  and cleanup" above) — the isolation guarantee (byte-identical reset between conditions) holds
  regardless, but real Gradle invocations inside a measured session will resolve dependencies
  from a cold cache every time.
- `docs/agentic-usage-measurement.md` is intentionally not edited by this PR even though its
  "Registry relationship" section is effectively fulfilled here — cross-linking it is reasonable
  follow-up, flagged in the PR body.

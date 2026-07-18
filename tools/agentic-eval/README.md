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
  availability. The hard gate requires `hook_call_count >= 1` and `hook_deny_count === 0` in
  *both* conditions, plus a clean (no malformed lines) transcript in both. It deliberately does
  **not** require the skill to actually trigger in condition B — whether it triggers naturally on
  smoke's prompt is an open question for a future corpus-probe run, not something smoke should
  presuppose. An earlier, open-ended smoke prompt drove the agent toward general exploration
  (`ls`/`pwd`/`git status`/`find`) that the policy hook correctly denies by design — 11/13 and
  6/6 real calls were denied in that run, meaning smoke never actually exercised real diagnostic
  work despite passing its (too-narrow) old gate. The current prompt names the exact two
  read-only commands to run, removing the need to explore.
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
  `claude` spawn) goes through `resolve-bash.mjs`'s `resolveBash()`, never a bare `'bash'`. A
  bare `'bash'` relies on PATH resolution, which is **not** unambiguous on Windows: if WSL is
  installed, `System32\bash.exe` (a launcher into the WSL subsystem, with WSL's own path
  translation) can resolve ahead of Git for Windows' MSYS2 `bash.exe` depending on PATH order —
  confirmed directly (this exact ambiguity broke 6 tests when the suite ran under a shell where
  System32 preceded Git's `bin/` on PATH). `resolveBash()` checks well-known Git for Windows
  install locations first, falls back to deriving `bash.exe` from `where git`'s own install
  root, and supports an explicit `KMP_EVAL_BASH_PATH` override — it never silently falls back to
  an ambiguous bare `'bash'`.

**This is a verified command-policy boundary for a pinned, trusted fixture/scenario project —
not an OS/filesystem sandbox.** Once a command is approved, Gradle build-script code and
kmp-test itself execute with full host permissions. Acceptable specifically because
fixture/scenario projects are pinned, committed, and trusted; never claimed as a general
sandbox. No OS-level sandbox exists on native Windows — if a scenario genuinely needs more than
the hook's approved grammar allows, the run is marked `termination_reason:
'unsupported-platform-profile'` rather than widening permissions to force completion.

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
`finally` block, removing every temp directory it created (shim, skill snapshot, both of
`materializeGradleUserHome`'s temp directories, `KMP_EVAL_TEMP_HOME`, the generated `--settings`
file's directory) and, for a scenario project specifically, `materialize.mjs`'s
`removeScenarioWorktree()` — a plain directory delete leaves the source repo's
`.git/worktrees/` metadata registered forever even after the directory is gone. Verified
directly: `agentic-eval-cli-integration.test.js` asserts zero leftover temp directories (via a
`TEMP`/`TMP`/`TMPDIR`-redirected, test-exclusive tmp root — a global `os.tmpdir()` count is not
safe to assert against under concurrent test-file execution) and zero leftover `git worktree
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
`project_commit`, `model_resolved`, `platform`, `skill_source_sha`, `policy_sha256` — the last
five guard against silently averaging across a re-pinned scenario commit, a different resolved
model, a different host platform, a different skill snapshot, or a changed policy-hook version.
Duplicate or empty `run_id` values are rejected before counting, so a re-submitted run can't
inflate `run_count`. Any `benchmark_eligible: false` record is refused outright. `aggregateRuns()`
also validates every record against the full run schema before bucketing — a record that's
partition-field-valid but broken elsewhere (e.g. a malformed `tokens` object) is excluded and
reported per-record, not silently folded into a group.

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

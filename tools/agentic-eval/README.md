# tools/agentic-eval — reproducible skill evaluation harness

Reusable tooling that proves, technically, whether Claude Code's Skill-matching mechanism
invokes the `kmp-test-runner` skill under controlled conditions. This is a **foundation**, not
a benchmark: no results are published here, and the full corpus is not executed by this PR. See
[`docs/agentic-usage-measurement.md`](../../docs/agentic-usage-measurement.md) for the broader
methodology this implements a piece of.

## Why this exists

Two prior measurement rounds in this repo (`tools/runs/agentic-usage-pilot-2026-07-17/`,
`tools/runs/agentic-usage-benchmark-v2-2026-07-17/`) never made the skill technically absent in
their "no-skill" condition — they prompt-instructed the agent to *pretend* it didn't exist — and
never observed a real `Skill` tool-invocation event; "skill used" was inferred by grepping
shell-command text for `kmp-test`. This harness closes both gaps with technical isolation and a
real event-level invocation proof.

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

## Run kinds — calibration vs. natural-probe vs. corpus-probe vs. smoke

- **`calibration`** — explicit-invocation only (the prompt directly asks for the skill by name).
  Proves parser/mechanics work. A failure here is a harness bug, not a measurement result.
- **`corpus-probe`** — natural, non-hinting prompts (see `corpus/trigger-queries.json`).
  `skill_invoked: false` here is valid *data*, not a failure — this is what a future real
  measurement wave would actually run.
- **`smoke`** — one bounded scenario, both conditions, through the real CLI end-to-end. Proves
  the harness works; explicitly not a benchmark result.
- **`scenario`** — the only `run_kind` whose records may ever be `benchmark_eligible: true`. Not
  produced by anything in this PR — `aggregate.mjs` refuses to fold any other run_kind's records
  into a publishable aggregate.

Every record this PR's code can actually produce is `benchmark_eligible: false`.

## Isolation

- **Environment**: `env-builder.mjs`'s `buildEvalEnv()` is allowlist-only, starting from the
  narrowest defensible set (OS essentials, PATH, locale, temp, Java, Android). `HOME`/
  `USERPROFILE`/`APPDATA` are *not* included — verified empirically that a real `claude -p`
  session authenticates fine without them (OAuth resolves via the OS credential store).
- **kmp-test pinning**: `path-shim.mjs` generates a PATH-prepended shim that invokes *this
  worktree's* `bin/kmp-test.js`, never a stray global install — confirmed empirically (a global
  v0.9.1 install would otherwise have been silently used instead of the pinned worktree's
  0.14.0).
- **kmp-test config isolation**: the shim — not the parent claude session's own environment —
  redirects `HOME`/`USERPROFILE` for the grandchild `node bin/kmp-test.js` process only, so
  `~/.kmp-test/config.json` can never affect either arm, while the parent session keeps its real
  profile for OAuth.
- **Command policy**: `policy-hook.mjs`, a `PreToolUse` hook, is the **sole** command-approval
  mechanism (an earlier `--allowedTools` pattern-list design was tested directly and found
  insufficient — see the PR description's evidence table). It's a narrow, explicit-grammar
  allowlist (not a denylist): only `kmp-test <allowed-subcommand>` and
  `<fixture-anchored-gradlew> <allowed-task>` shapes are approved, every path argument is
  resolved via `fs.realpathSync()` (never lexically inspected — closes shell/env-expansion,
  symlink/junction escapes, and PATH-order substitution), and policy configuration
  (`KMP_EVAL_ALLOWED_GRADLE_TASKS`, `KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS`,
  `KMP_EVAL_EXPECTED_FIXTURE_ROOT`) comes only from harness-controlled environment variables,
  never the hook's own stdin payload.

**This is a verified command-policy boundary for a pinned, trusted fixture/scenario project —
not an OS/filesystem sandbox.** Once a command is approved, Gradle build-script code and
kmp-test itself execute with full host permissions. Acceptable specifically because
fixture/scenario projects are pinned, committed, and trusted; never claimed as a general
sandbox. No OS-level sandbox exists on native Windows — if a scenario genuinely needs more than
the hook's approved grammar allows, the run is marked `termination_reason:
'unsupported-platform-profile'` rather than widening permissions to force completion.

## Materialization

Every fixture — calibration project, scenario project, or the skill snapshot itself — is
materialized into a fresh `os.tmpdir()`-rooted directory immediately before use (`materialize.mjs`),
never run in place inside this repo. For the two conditions of one run-pair, the same temp path
is reused, wiped, and re-populated from the pristine source between conditions — literally the
same cwd, never state leaking from one condition into the other. Same discipline for
`GRADLE_USER_HOME` (prewarmed once per run-pair, restored to that exact snapshot before each
condition).

## Usage

```bash
node tools/agentic-eval/cli.mjs --help
node tools/agentic-eval/cli.mjs calibrate            # explicit-invocation calibration, both conditions
node tools/agentic-eval/cli.mjs corpus validate       # validates corpus/ shape and banned-term rules
node tools/agentic-eval/cli.mjs validate --run <path> # validates a single run record against RUN_SCHEMA
node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
```

Raw transcripts always stay local under `tools/runs/agentic-eval-*/raw/` (gitignored). Only
sanitized, schema-valid, `findLeaks()`-clean run records are ever committed.

## Schemas

Hand-rolled (`CURRENT_*_SCHEMA` int + `CANONICAL_FIELDS` array + `typeof`/enum/regex
validators), matching `tools/measurement-registry.mjs`'s existing convention — no JSON-schema
library exists anywhere in this repo's own code, so none is added here. Every legitimately-
nullable metric is `{value: T|null, reason: string|null}` — "never infer missing metrics, store
null with a reason" is enforced by the validator, not just a comment.

## Fairness Contract

Two separate benchmark families: `test-only` (raw Gradle vs. kmp-test with coverage disabled)
and `coverage` (raw test + equivalent manual coverage work vs. default kmp-test coverage) — never
compared against each other. `aggregate.mjs` refuses to fold runs into one aggregate unless they
agree on `family`, `cache_state`, and `run_kind`, and independently refuses any
`benchmark_eligible: false` record outright.

## Explicit limitations

- No full benchmark is executed by this PR; no performance claim is made.
- Public-project scenarios only; no private project is referenced.
- `candidate-skill` is schema-supported but not implemented.
- Two of the six defined scenarios (`deterministic-unit-test-failure`,
  `coverage-threshold-failure`) reference purpose-built fixture projects for determinism: the
  scenario *definitions* exist; the fixture project *content* is a follow-up, not built by this
  PR.
- Wildcard support in `--module-filter`/`--test-filter` is out of scope for the policy hook's
  grammar in this PR (a shell could re-expand an unquoted wildcard after the hook approves it) —
  documented as a future grammar extension.
- `docs/agentic-usage-measurement.md` is intentionally not edited by this PR even though its
  "Registry relationship" section is effectively fulfilled here — cross-linking it is reasonable
  follow-up, flagged in the PR body.

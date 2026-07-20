# Agentic-eval harness — live validation evidence (2026-07-20)

## What this is

A fresh, from-scratch live invocation of the `tools/agentic-eval/` harness against real Claude via
Claude Max/OAuth, run after PR #377 (`fix(agentic): relax calibration no-skill-arm invocation
contract`, merged as `c06bfad576738311ace43a694681002b85907c65`). This is **not** a retry of the
2026-07-19 attempt, which spent 2 of its 4 authorized sessions on `calibrate` and was correctly
rejected by the *then*-buggy gate (it required the no-skill arm to always attempt the `Skill` tool
first; the arm legitimately never did). No evidence was written by that rejected attempt — nothing
here reuses or extends it. This is an **n=1 paired calibration + n=1 paired smoke validation, not
a benchmark**. It makes no performance, cost-saving, or skill-efficacy claim of any kind. All four
new run records are `benchmark_eligible: false`.

## Authorization / auth proof (booleans only — no account details)

Checked twice: once in my own interactive shell, and — because that alone doesn't prove what the
*measured child* `claude -p` process actually receives — once again through the harness's own
`buildEvalEnv()`-constructed environment (the harness is allowlist-only; nothing not explicitly
named ever reaches the child, verified empirically here rather than only by reading the code).

- `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL` /
  `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` / `CLAUDE_CODE_USE_FOUNDRY` present at
  Process, User, or Machine scope (parent shell): **false**, all scopes, all variables
- `KMP_EVAL_RUNS_ROOT` set (would silently redirect evidence to a non-default, possibly
  non-gitignored directory): **false**
- `KMP_EVAL_BASH_PATH` set: **false**
- Any auth-shaped key name surviving into the constructed measured-child environment
  (`buildEvalEnv(process.env)`, keys only, never values): **false** (zero matches)
- `claude auth status`, run **with that same constructed child environment**: `loggedIn`:
  **true**, `authMethod`: **claude.ai**, `apiProvider`: **firstParty**, `subscriptionType`:
  **max**
- `apiKeySource` / `apiKeyHelper` not present in the inspected parent scopes or effective
  measured-child configuration: **true** (not a claim about every possible configuration source
  in existence — scoped to what was actually inspected: `claude auth status`'s own output, and
  `~/.claude/settings.json`)

Budget note: each condition runs under the harness's internal `--max-budget-usd` safety ceiling
(default $0.60/condition) — an internal cap on Agent SDK usage, not a per-token API charge. A
`claude -p` session under Max/OAuth draws on the subscription's own Agent SDK usage allocation;
the ceiling bounds that usage, it does not mean money is necessarily billed. 4 sessions
(2 commands × 2 conditions) × $0.60 = a $2.40 aggregate ceiling value, consumed as Max-plan usage.

## Sanitized commands run

`<KaMPKit clone>` below is a deliberate substitution for the real local scratchpad filesystem
path — everything else is the literal command.

```bash
node tools/agentic-eval/cli.mjs calibrate --model claude-sonnet-5

node tools/agentic-eval/cli.mjs smoke \
  --source-repo-dir <KaMPKit clone> \
  --pinned-commit b3a7784fb969a8558b88c80674c8b596944cdab7 \
  --project-alias kampkit --model claude-sonnet-5
```

Each ran exactly once — no retries, substitutions, or extra probes. Exactly 4 live Claude
sessions total (the full authorized budget, none unused, none exceeded). Starting state:
`origin/develop` fast-forwarded to `c06bfad576738311ace43a694681002b85907c65` (PR #377's merge
commit) before any live call. Public project only: `https://github.com/touchlab/KaMPKit`, pinned
commit `b3a7784fb969a8558b88c80674c8b596944cdab7` ("Bump the minor group with 14 updates (#358)").
Fresh disposable clone, not the shared persistent one. No private project involved anywhere.

## Run IDs

| Run kind | Condition | run_id |
|---|---|---|
| calibration | no-skill | `calibration-no-skill-4b88b7da` |
| calibration | current-skill | `calibration-current-skill-a557bea6` |
| smoke | no-skill | `smoke-no-skill-e9c6ef18` |
| smoke | current-skill | `smoke-current-skill-00dd1291` |

## Sanitized metric table (this run, 2026-07-20)

Raw, side-by-side values only, extracted programmatically from the four committed JSON records
(never hand-transcribed). No ratio, delta, percentage, or efficacy comparison is drawn between
conditions anywhere in this report — n=1 supports nothing of the kind. Every nullable-metric
field shows its recorded `reason` when the value is null.

**Identity**

| Field | cal A (no-skill) | cal B (current-skill) | smoke A (no-skill) | smoke B (current-skill) |
|---|---|---|---|---|
| `run_kind` | calibration | calibration | smoke | smoke |
| `condition` | no-skill | current-skill | no-skill | current-skill |
| `model_requested` | claude-sonnet-5 | claude-sonnet-5 | claude-sonnet-5 | claude-sonnet-5 |
| `model_resolved` | claude-sonnet-5 | claude-sonnet-5 | claude-sonnet-5 | claude-sonnet-5 |
| `claude_code_version` | 2.1.215 | 2.1.215 | 2.1.215 | 2.1.215 |

**Usage**

| Field | cal A | cal B | smoke A | smoke B |
|---|---|---|---|---|
| `tokens.input` | 2 | 16 | 4 | 4 |
| `tokens.output` | 205 | 2526 | 1168 | 1045 |
| `tokens.cache_read` | 13762 | 150499 | 30411 | 24839 |
| `tokens.cache_creation` | 2243 | 25029 | 4071 | 10279 |
| `wall_clock_ms` | 7879 | 54007 | 79200 | 83168 |
| `output_bytes` | 0 | 3664 | 3017 | 3017 |
| `stream_json_bytes` | 6531 | 61339 | 24604 | 22467 |

**Behavior**

| Field | cal A | cal B | smoke A | smoke B |
|---|---|---|---|---|
| `tool_calls_total` | 0 | 7 | 2 | 2 |
| `shell_commands_total` | 0 | 6 | 2 | 2 |
| `hook_call_count` | 0 | 6 | 2 | 2 |
| `hook_deny_count` | 0 | 3 | 0 | 0 |
| `permission_mode_used` | dontAsk | dontAsk | dontAsk | dontAsk |
| `skill_available.value` | false | true | false | true |
| `skill_invocation_attempted.value` | **false** | true | false | false |
| `skill_invoked.value` | false | true | false | false |

**Result**

| Field | cal A | cal B | smoke A | smoke B |
|---|---|---|---|---|
| `exit_code` | 0 | 0 | 0 | 0 |
| `terminated` | false | false | false | false |
| `termination_reason` | null | null | null | null |
| `success` | null ("calibration run -- success grading not applicable") | null (same) | null ("smoke run -- success grading not applicable") | null (same) |
| `expected_outcome_matched` | null ("no scenario grader applies") | null (same) | null (same) | null (same) |
| `first_useful_signal_ms` | null ("no first-useful-signal predicate applies") | null (same) | null (same) | null (same) |
| `human_interventions` | 0 | 0 | 0 | 0 |
| `retries` | null ("not tracked for calibration runs") | null (same) | null ("not tracked for smoke runs") | null (same) |
| `test_invocations_total` | null (same reason) | null (same) | null (same) | null (same) |
| `order_index` | null | null | null | null |

**Provenance**

| Field | cal A | cal B | smoke A | smoke B |
|---|---|---|---|---|
| `kmp_test_cli_source_sha` / `repo_commit` | `c06bfad...907c65` (both fields, all 4 records) | | | |
| `kmp_test_cli_version` | 0.14.0 (all 4) | | | |
| `skill_source_sha` | null | `aeba6eaa...f688ee` | null | `aeba6eaa...f688ee` |
| `policy_sha256` | `6cef1fe4...314ef` (all 4 — identical, and independently reconfirmed against a freshly recomputed hash of the current `policy-hook.mjs`, not just internal self-consistency) | | | |
| `cache_state` | unknown (all 4) | | | |
| `daemon_policy` | disabled-via-gradle-user-home-properties (all 4) | | | |
| `env_allowlist_profile` | narrow (all 4) | | | |
| `project_alias` | calibration-project | calibration-project | kampkit | kampkit |
| `project_commit` | null | null | `b3a7784f...4cdab7` | `b3a7784f...4cdab7` |
| `project_url` | null | null | `https://github.com/touchlab/KaMPKit.git` | same |

All 23 cross-record provenance invariants (model/version/platform/harness-SHA/policy-hash
identity across all 4 records; within-pair equality of `daemon_policy`, `env_allowlist_profile`,
and both `policy_allowed_*` arrays; smoke's project identity fields matching and equal on both
arms) were checked programmatically and passed — a schema-valid record does not by itself prove a
pair is a controlled comparison, so this was verified separately, not inferred from
`validate --run`'s clean result.

## Historical context (2026-07-18 vs. 2026-07-20) — not a comparison

The table below places this run's numbers next to the previous live validation's, purely so a
reader can spot a conspicuous change. **It computes no ratio, delta, or improvement/regression
claim, and none should be inferred from it.** Between the two dates: the harness itself changed
(PR #377, `c6defac→c06bfad`, hardening `calibrationHardGate`/`smokeHardGate` with 11 new
sub-checks), the pinned skill snapshot changed (`c5c0661→aeba6ea`, PR #375's portability fix), and
the Claude Code CLI version changed (`2.1.214→2.1.215`). Any of the three could move these
numbers independent of anything the skill itself does.

The table includes all comparable usage fields plus the behavior signals most relevant to gate
validation; invariant identity, result, and provenance fields are omitted.

| Field | cal A 07-18 → 07-20 | cal B 07-18 → 07-20 | smoke A 07-18 → 07-20 | smoke B 07-18 → 07-20 |
|---|---|---|---|---|
| `skill_invocation_attempted` | true → **false** | true → true | false → false | false → false |
| `tool_calls_total` | 3 → 0 | 9 → 7 | 2 → 2 | 2 → 2 |
| `hook_call_count` / `hook_deny_count` | 2/2 → 0/0 | 8/5 → 6/3 | 2/0 → 2/0 | 2/0 → 2/0 |
| `wall_clock_ms` | 15692 → 7879 | 55147 → 54007 | 70185 → 79200 | 73815 → 83168 |
| `tokens.input` | 8 → 2 | 20 → 16 | 4 → 4 | 4 → 4 |
| `tokens.output` | 684 → 205 | 2793 → 2526 | 1204 → 1168 | 1248 → 1045 |
| `tokens.cache_read` | 63490 → 13762 | 203641 → 150499 | 30348 → 30411 | 16626 → 24839 |
| `tokens.cache_creation` | 3338 → 2243 | 26043 → 25029 | 4437 → 4071 | 18537 → 10279 |
| `output_bytes` | 165 → 0 | 3884 → 3664 | 3017 → 3017 | 3017 → 3017 |
| `stream_json_bytes` | 15363 → 6531 | 67540 → 61339 | 24685 → 24604 | 24644 → 22467 |

The most conspicuous change — calibration's no-skill arm going from `attempted:true` (it tried the
`Skill` tool and got `Unknown skill`) to `attempted:false` (it didn't try at all this time) — is
exactly the model-behavior variability PR #377's gate fix was written to legitimately tolerate,
not a regression: both shapes were always real, valid isolation proof; only the *old* gate
wrongly insisted on one of them. This report draws no conclusion about *why* the model behaved
differently between the two dates (CLI version, prompt-adjacent nondeterminism, or something
else) — only that both are valid under the current contract.

Standing confounders that make even this side-by-side non-comparable, unchanged from 07-18:
calibration's two arms do fundamentally different amounts of work (not the same task measured
faster/slower); the calibration fixture project is intentionally not a runnable Gradle project;
smoke's prompt names the exact two commands and prohibits anything else, so neither arm attempts
the `Skill` tool at all — smoke validates harness isolation and pipeline equivalence only, never
skill-triggering behavior; and conditions run in a fixed order (`current-skill` before
`no-skill`), so `cache_read`/`cache_creation` in particular are order-confounded. **This run
proves the hardened gate mechanism and harness isolation work correctly under real Claude
sessions — it does not demonstrate that the skill saves tokens, time, or errors, and no such
claim is made.**

## Gates passed

**Zero-cost preflight** (before any live invocation): worktree fast-forwarded to `c06bfad`, HEAD
and `PINNED_SKILL_SHA` both verified exact-match, worktree clean. Focused `agentic-eval` vitest
suite: 22 files / 524 tests, all pass. `decouple-audit.mjs` / `check-line-endings.mjs` /
`validate-plugin.mjs` / `git diff --check` all clean. All 4 pre-existing run records
independently re-validated via `validate --run` (clean) before any live call, with a full
untruncated SHA-256 baseline captured to an out-of-repo manifest. KaMPKit clone verified against
its real `origin` URL and the pinned commit, working tree clean. Readiness `doctor --json` /
`describe --json` ran in an isolated temporary `git worktree add --detach` off the clone (never
the clone's own working directory), both exited 0 with one valid JSON object each; the temp
worktree was removed unconditionally afterward and the clone's own working tree reconfirmed
clean, so smoke's later `materializeScenarioProject` call used a byte-for-byte pristine source.

**Calibration**: `calibrationHardGate` passed (exit 0, evidence written). A: `available:false,
attempted:false, invoked:false` — the no-skill arm never attempted the `Skill` tool at all this
time, which the *current* gate (post-#377) correctly treats as legitimate isolation proof, not a
failure. B: `available:true, attempted:true, invoked:true`. `benchmark_eligible:false` on both.
`validate --run` clean on both. *Reported honestly, not treated as a failure*: `hook_call_count`
was 0 on A (it made no tool calls of any kind — not even a `Skill` attempt, since
`skill_invocation_attempted` was `false`) and B made 6 Bash calls (plus the 1 `Skill` call,
matching `tool_calls_total:7`), 3 denied and 3 allowed. Independently re-parsed from B's raw
transcript itself, not just the aggregate counts — raw transcripts aren't version-controlled, so
this detail would otherwise be lost entirely:

- **Denied** (outside calibrate's narrow allowlist — among `kmp-test` subcommands, only `doctor`
  and `parallel` are approved): a chained shell-inspection command (a directory listing, a
  `gradlew*` glob check,
  and a bare `kmp-test --version` call, joined with `&&`), a second bare directory-listing
  command, and a Windows `dir /a` listing.
- **Allowed but failed**: the first `kmp-test parallel --json` call, exit code 3
  (`no_test_modules`) — expected, not a defect: the calibration fixture is intentionally not a
  runnable Gradle project (see Explicit limitations).
- **Allowed and succeeded**: `kmp-test doctor --json`, then a follow-up
  `kmp-test parallel --json --dry-run`.

None of this is gate-blocking — calibration's gate doesn't require `hook_deny_count===0` (only
smoke's does) — but it's a genuine, mild signal worth naming rather than collapsing into the
aggregate count alone: B reached slightly past calibration's intentionally narrow allowlist before
settling into the two approved subcommands. This is not a security or hard-gate failure — the
policy hook caught all three denied attempts correctly — but it is a real alignment/efficiency
signal for the skill-present arm. With n=1 it can't be attributed causally to the skill itself
(see Explicit limitations), and it isn't dismissed as irrelevant either — a candidate signal for
future calibration prompt/policy-alignment refinement, echoing the same observation already made
in the 2026-07-18 report.

**Smoke**: `smokeHardGate` passed on both records, including the strict `hook_deny_count===0` on
both (2/2 and 2/2 hook calls, all allowed, zero denials) and the exact expected command multiset
(`kmp-test doctor --json` then `kmp-test describe --json`, nothing else). B's `skill_available`
is `true` but `skill_invocation_attempted`/`skill_invoked` are both `false` — expected, not a
defect: smoke's prompt deliberately names the exact commands and forbids anything else, so it
never tests whether the skill triggers naturally. `project_alias`/`project_commit`/`project_url`
populated and matching the real KaMPKit project/commit on both arms. `validate --run` clean on
both.

## Evidence integrity

- **File-level diff, not just command exit code**: before/after snapshots of each directory's
  top-level `*.json` files (filenames + full hashes) confirmed exactly 2 new files per command —
  one `no-skill`, one `current-skill`, never two of the same condition — with the 2 pre-existing
  files' hashes unchanged. Each new file's own `run_id` was cross-checked against the `run_id` the
  command's own stdout JSON printed for that condition, confirming an exact match.
- **Raw transcripts**: each command also wrote exactly 2 new `.jsonl` files under its `raw/`
  subdirectory (proving real capture happened). `git status --porcelain` showed nothing under
  either `raw/` directory at any point. Independently proven *why*, not just observed: `git
  check-ignore -v` on all 4 new raw files resolved to `.gitignore:42:
  tools/runs/agentic-eval-*/raw/**` specifically — this repo's own rule, not a coincidental
  global one.
- **Pre-existing evidence untouched**: the same 5 files checked at the start of this session
  (4 JSON records + the 2026-07-18 report) were re-verified after all live calls via
  `git diff --exit-code HEAD` (clean) and a full SHA-256 recompute against the out-of-repo
  baseline manifest (`sha256sum -c`, all 5 `OK`). The 2026-07-18 report was not modified.
- **Cross-record provenance invariants**: see the Provenance sub-table above and its note — 23
  checks, all passing, verified programmatically against the actual committed JSON.
- No generated JSON was manually edited at any point.

## Explicit limitations

- This is **n=1 paired validation**, not a benchmark. No statistical claim of any kind follows
  from a single paired run per condition, and the Historical Context section above is explicitly
  not a trend line — it's two independent n=1 points with three confounding variables changed
  between them (harness, skill snapshot, Claude Code version).
- No performance, cost-saving, latency, token-efficiency, or skill-efficacy claim is made or
  implied anywhere in this report.
- Only the public `touchlab/KaMPKit` project was used. No private project, module, or
  maintainer-specific identifier appears anywhere in the committed evidence.
- Claude Max/OAuth was used throughout, verified against the actual constructed measured-child
  environment, not just the ambient interactive shell; no API key, auth token, or cloud-provider
  selector was present in either at any point checked (initial preflight and immediately before
  each of the two live calls).
- The `scenario` and `corpus-probe` run kinds, and whether the skill triggers *naturally* on an
  unprompted request, remain unimplemented/unanswered — unchanged from 2026-07-18, tracked
  separately in `BACKLOG.md`.
- Every nullable metric in the tables above is shown with its recorded reason, never invented.
- Raw JSONL transcripts for all four new runs exist locally only, under
  `tools/runs/agentic-eval-calibration/raw/` and `tools/runs/agentic-eval-smoke/raw/`, covered by
  `.gitignore` (independently reconfirmed via `git check-ignore -v` above) — never staged, never
  committed, never included in this report beyond the categorized description above.

# Agentic-eval harness — live validation evidence (2026-07-18)

## What this is

The first real, post-merge live invocation of the `tools/agentic-eval/` harness shipped in
PR #372 (`c6defac`), against real Claude via Claude Max/OAuth. **This is an n=1 paired
calibration + n=1 paired smoke validation, not a benchmark.** It makes no performance,
cost-saving, or skill-efficacy claim of any kind. All four run records are
`benchmark_eligible: false`.

## Authorization / auth proof (booleans only — no account details)

- Session authenticated via Claude Max / OAuth: **true**
- `authMethod` is `claude.ai` (not an API key): **true**
- `ANTHROPIC_API_KEY` present at Process scope: **false**
- `ANTHROPIC_API_KEY` present at User scope: **false**
- `ANTHROPIC_API_KEY` present at Machine scope: **false**
- `apiKeySource` pointing at an environment key: **false** (no such field present at all)
- `/status` independently confirmed Claude Max account by the operator: **true**

Budget note: each condition is capped by an internal SDK safety ceiling (`--max-budget-usd`,
default `$0.60`/condition), not a per-token API charge. 4 sessions (2 commands × 2 conditions)
× `$0.60` = a **$2.40 aggregate ceiling value**, consumed as Max-plan usage — not money billed.

## Sanitized commands run

`<local KaMPKit clone>` below is a deliberate substitution for the real local filesystem path —
everything else is the literal command.

```bash
node tools/agentic-eval/cli.mjs calibrate --model claude-sonnet-5

node tools/agentic-eval/cli.mjs smoke \
  --source-repo-dir <local KaMPKit clone> \
  --pinned-commit b3a7784fb969a8558b88c80674c8b596944cdab7 \
  --project-alias kampkit --model claude-sonnet-5
```

Each harness subcommand ran exactly once — no retries were issued by the operator. (This is
distinct from the `retries` metric field below, which the harness does not actually track; see
that row's note.) Baseline: `origin/develop` at `c6defac903b303e2ff76a75800c79c5eeabca9fa`
(re-verified unchanged via `git fetch` immediately before starting). Public project only:
`https://github.com/touchlab/KaMPKit`, pinned commit `b3a7784fb969a8558b88c80674c8b596944cdab7`
("Bump the minor group with 14 updates (#358)", 2026-07-13). No private project involved anywhere.

## Run IDs

| Run kind | Condition | run_id |
|---|---|---|
| calibration | no-skill | `calibration-no-skill-83e03ae5` |
| calibration | current-skill | `calibration-current-skill-286d46d9` |
| smoke | no-skill | `smoke-no-skill-a4990a7b` |
| smoke | current-skill | `smoke-current-skill-a3cd7530` |

## Sanitized metric table

Raw, side-by-side values only. **No ratio, delta, percentage, or efficacy comparison is drawn
between conditions anywhere in this report** — n=1 supports nothing of the kind. Every
nullable-metric field shows its recorded `reason` when the value is null; nothing is invented.

| Field | calibration A (no-skill) | calibration B (current-skill) | smoke A (no-skill) | smoke B (current-skill) |
|---|---|---|---|---|
| `model_resolved` | claude-sonnet-5 | claude-sonnet-5 | claude-sonnet-5 | claude-sonnet-5 |
| `claude_code_version` | 2.1.214 | 2.1.214 | 2.1.214 | 2.1.214 |
| `tokens.input` | 8 | 20 | 4 | 4 |
| `tokens.output` | 684 | 2793 | 1204 | 1248 |
| `tokens.cache_read` | 63490 | 203641 | 30348 | 16626 |
| `tokens.cache_creation` | 3338 | 26043 | 4437 | 18537 |
| `wall_clock_ms` | 15692 | 55147 | 70185 | 73815 |
| `tool_calls_total` | 3 | 9 | 2 | 2 |
| `shell_commands_total` | 2 | 8 | 2 | 2 |
| `test_invocations_total` | null (reason: "not tracked for calibration runs") | null (same) | null (reason: "not tracked for smoke runs") | null (same) |
| `retries` | null (reason: "not tracked for calibration runs") | null (same) | null (reason: "not tracked for smoke runs") | null (same) |
| `hook_call_count` | 2 | 8 | 2 | 2 |
| `hook_deny_count` | 2 | 5 | 0 | 0 |
| `output_bytes` | 165 | 3884 | 3017 | 3017 |
| `stream_json_bytes` | 15363 | 67540 | 24685 | 24644 |
| `exit_code` | 0 | 0 | 0 | 0 |
| `terminated` | false | false | false | false |
| `termination_reason` | null | null | null | null |
| `success` | null (reason: "calibration run -- success grading not applicable") | null (same) | null (reason: "smoke run -- success grading not applicable") | null (same) |
| `skill_available.value` | false | true | false | true |
| `skill_invocation_attempted.value` | true | true | false | false |
| `skill_invoked.value` | false | true | false | false |
| `project_alias` | "calibration-project" (fixed synthetic-fixture label) | same | "kampkit" | "kampkit" |
| `project_commit` | null (no real external repo) | null | `b3a7784f...944cdab7` | `b3a7784f...944cdab7` |
| `project_url` | null | null | `https://github.com/touchlab/KaMPKit` | same |

**Note on `retries`:** the harness's record builder (`buildRunRecord` in `cli.mjs`) currently
hardcodes `retries: nullableMetric(0)` unconditionally — there is no actual retry-detection logic
behind it, unlike the sibling `test_invocations_total` field one line above it in the same
function, which correctly uses `nullableMetric(null, 'not tracked for ${runKind} runs')`. This was
caught during review: the calibration current-skill transcript shows a failed `kmp-test parallel
--json` (exit code 3) followed by a `kmp-test parallel --dry-run --json` — a diagnostic follow-up
with a different flag, not necessarily a same-command retry, but the harness has no mechanism to
classify or count either way. The four committed records in this PR have been hand-corrected to
`{"value": null, "reason": "not tracked for <calibration|smoke> runs"}` to match reality, without
re-running the live sessions. The underlying `cli.mjs:525` hardcoding is a harness-code-level gap,
appropriately fixed in its own small follow-up PR, not smuggled into this evidence-only PR.

## Gates passed

**Zero-cost preflight** (before any live invocation): focused `agentic-eval` vitest suite
(21 files / 438 tests, all pass), `decouple-audit.mjs` clean, `check-line-endings.mjs` clean,
`validate-plugin.mjs` clean. **KaMPKit readiness gate**: a disposable `git worktree add --detach`
off the reused local KaMPKit clone at the pinned commit, running this same checked-out CLI's
`doctor --json` and `describe --json` against it directly (`--project-root <temp-worktree>`,
stdout/stderr captured separately) — both exited 0 with exactly one valid JSON object on stdout
and empty stderr, before the worktree was unconditionally removed (`git worktree remove --force`).

**Calibration**: the harness's own `calibrationHardGate` passed (exit 0, evidence written). The
invocation-mechanics tuple is exactly as expected — A: `available=false, attempted=true,
invoked=false`; B: `available=true, attempted=true, invoked=true`. `benchmark_eligible:false` on
both. `validate --run` clean on both.

*Finding, investigated and accepted as non-blocking*: `hook_deny_count` was nonzero on both
calibration records (A: 2/2 Bash calls denied, B: 5/8 denied). `calibrationHardGate` itself never
requires `hook_deny_count===0` — only smoke's gate does — so this did not fail the harness's own
acceptance criteria. An independent forensic re-parse of both raw transcripts (using the harness's
own exported `countHookEvents`/`findBashToolUsesWithResults`/`findUnexpectedToolUses` functions,
never re-implemented by hand) confirmed: every Bash call was mediated by the policy hook with no
bypass (`everyCallHooked: true` on both), zero tool_use outside `Bash`/`Skill`, and every denied
call's own tool_result correctly showed `resultIsError: true` — i.e. the hook actually blocked
execution, no silent allow, no side effects. The denied commands (categorized, no raw local paths)
were plain directory listings, a file read, a raw PowerShell invocation, and one `kmp-test`
subcommand (`info`) outside calibrate's intentionally narrow allowlist (`doctor`/`parallel` only)
— Claude exploring beyond the directed "use the skill" instruction, correctly and completely
intercepted by the policy hook. This demonstrates policy enforcement working as designed, not a
calibration failure. It also surfaces a possible future prompt/policy-alignment refinement for
calibration specifically — noted here as an observation only; no harness, prompt, or policy code
was changed as part of this validation task.

**Smoke**: the harness's own `smokeHardGate` passed on both records, including `hook_deny_count===0`
on both (strict, unlike calibration — smoke's prompt names the exact two commands and nothing
else is in its allowlist). Independently re-verified: both raw transcripts show exactly
`kmp-test doctor --json` then `kmp-test describe --json` and no other tool_use of any kind in
either condition — including no `Skill` tool_use attempt in the current-skill condition, hence
`skill_invocation_attempted:false`/`skill_invoked:false` even where `skill_available:true`. This
is expected, not a defect: smoke's own design deliberately does not require `skill_invoked`
(whether the skill triggers naturally on an unprompted diagnostic request is exactly the open
question a future corpus-probe run would investigate — out of scope for this foundation harness).
`project_alias`/`project_commit`/`project_url` are all populated and match the real KaMPKit
project/commit, as required for a real-external-project run-kind. `validate --run` clean on both.

**Final verification**: full `npm run test:coverage` — 67 test files, 2934 passed / 2 skipped
(no failures) — plus a post-staging rerun of `decouple-audit.mjs`/`check-line-endings.mjs`
(pre-staging runs cannot see untracked evidence, since `decouple-audit.mjs` walks `git ls-files`)
and `git diff --cached --check`, all clean.

## Explicit limitations

- This is **n=1 paired validation**, not a benchmark. No statistical claim of any kind follows
  from a single paired run per condition.
- No performance, cost-saving, latency, token-efficiency, or skill-efficacy claim is made or
  implied anywhere in this report.
- Only the public `touchlab/KaMPKit` project was used. No private project, module, or
  maintainer-specific identifier appears anywhere in the committed evidence.
- Claude Max / OAuth was used throughout; no API key was present in the environment at any scope.
- Only two run kinds exist today: `calibration` (explicit-invocation mechanics, synthetic fixture)
  and `smoke` (equivalent-real-work, one bounded real-project scenario). The `scenario` and
  `corpus-probe` run kinds, and whether the skill triggers *naturally* on an unprompted request,
  remain unimplemented/unanswered — tracked as a separate, not-yet-started BACKLOG item.
- Every nullable metric in the table above is shown with its recorded reason, never invented.
- Raw JSONL transcripts for all four runs exist locally only, under
  `tools/runs/agentic-eval-calibration/raw/` and `tools/runs/agentic-eval-smoke/raw/`, covered by
  `.gitignore` — never staged, never committed, never included in this report beyond the
  categorized (never verbatim-path) description above.

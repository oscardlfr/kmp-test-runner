# Agentic usage measurement

This document defines a future benchmark for measuring how `kmp-test-runner`
changes a real agent's testing workflow. It is different from
[`token-cost-measurement.md`](token-cost-measurement.md): token-cost measurement
counts command outputs and report payloads; agentic usage measurement evaluates
the whole loop from user request to verified diagnosis or fix.

No results are published here yet. The goal is to make the methodology stable
before running any expensive or API-backed measurement.

## Question

When two agents get the same KMP testing task, how much does the
`kmp-test-runner` skill and JSON workflow change the cost of reaching a correct,
verified outcome?

The comparison should cover:

- elapsed time;
- context consumed;
- number and quality of tool calls;
- correctness of diagnosis or fix;
- ease of use and recovery from common Gradle/KMP failure modes.

## Conditions

Run each scenario in two conditions.

| Condition | Agent setup | Expected path |
|-----------|-------------|---------------|
| Baseline | Same model, no `kmp-test-runner` skill or project-specific test guidance beyond normal repo docs | Discover Gradle modules, run raw Gradle commands, inspect logs and reports manually |
| `kmp-test` skill | Same model plus the `kmp-test-runner` skill / guidance | Use `kmp-test` commands, prefer `--json` for machine-readable results, branch on envelope codes |

Both conditions should use the same model, same repository commit, same task
prompt, same machine class, same tool permissions, and isolated worktrees.

## Scenario set

Start small and expand only after the harness is boring.

| Scenario | What it tests | Notes |
|----------|---------------|-------|
| Unit failure | Basic KMP test failure diagnosis | Stable, cheap, first pilot scenario |
| Multi-module changed test | Whether the agent scopes the right modules | Good fit for `kmp-test changed` |
| Coverage threshold failure | Whether the agent can find missed lines without reading large Kover output | Exercises the largest token-cost gap |
| JDK/AGP mismatch | Whether the agent recognizes environment preflight signals | Useful for failure-code branching |
| Android instrumented failure | Whether the agent handles device/emulator-specific testing | Run only when the hardware/emulator state is stable |

Each scenario should have a known expected outcome and a deterministic
verification command. Avoid tasks whose success depends on network state,
flaky devices, or broad refactors.

## Metrics

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

## Ease-of-use rubric

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

## Harness shape

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

The harness should save raw transcripts locally for audit, then emit only
redacted aggregate tables to committed docs. Private project paths, raw logs,
module names, and screenshots should not be committed.

## Token accounting

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

## Reporting format

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

## Run discipline

- Randomize condition order when practical.
- Use separate worktrees per condition.
- Reset the repo and build cache policy between runs, or label runs clearly as
  cold-cache / warm-cache.
- Keep prompts identical except for condition-specific allowed tooling.
- Do not let one agent see the other condition's transcript.
- Record failures and abandoned runs; do not silently drop inconvenient data.
- Never commit raw private captures.

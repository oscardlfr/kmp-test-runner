# Agentic evaluation harness

This directory contains the reproducible harness used to evaluate how coding agents discover and use `kmp-test`. The current operator entry point is [`docs/evaluation/README.md`](../../docs/evaluation/README.md); this file documents implementation contracts.

## What the harness measures

Each scenario has structured ground truth. A runtime session produces a transcript, the grader checks the required task outcome and answer protocol, and the materializer writes a sanitized scenario record. Separate analysis reports five axes:

1. skill activation;
2. execution after activation;
3. policy interaction;
4. authoritative product evidence;
5. final expected outcome.

These axes must not be collapsed into “process exited zero”. A session can terminate normally without solving the scenario.

## Command surface

```text
node tools/agentic-eval/cli.mjs corpus validate
node tools/agentic-eval/cli.mjs scope init --out <private-scope.json>
node tools/agentic-eval/cli.mjs calibrate [runtime/profile/budget options]
node tools/agentic-eval/cli.mjs smoke --source-repo-dir <clone> --pinned-commit <sha>
node tools/agentic-eval/cli.mjs run --scenario <id> --source-repo-dir <clone> --seed <n> ...
node tools/agentic-eval/cli.mjs product-access preflight --mode free-baseline-no-product --workspace <dir>
node tools/agentic-eval/cli.mjs validate --run <record.json>
node tools/agentic-eval/cli.mjs aggregate --runs-dir <dir>
node tools/agentic-eval/cli.mjs analyze --runs-dir <dir>
```

Run `node tools/agentic-eval/cli.mjs --help` for exact options. `calibrate` and `smoke` are foundation checks and always remain `benchmark_eligible: false`.

## Scenario runs

Single-profile example:

```sh
node tools/agentic-eval/cli.mjs run \
  --scenario coverage-threshold-failure-v2 \
  --source-repo-dir <clean-pinned-clone> \
  --seed 20260821 \
  --repeats 1 \
  --runtime claude-code \
  --execution-profile sandboxed-unrestricted-v1 \
  --isolation-attestation-file <private-attestation.json> \
  --dry-run
```

Campaign example:

```sh
node tools/agentic-eval/cli.mjs run \
  --scenario coverage-threshold-failure-v2 \
  --source-repo-dir <clean-pinned-clone> \
  --seed 20260821 \
  --campaign-design claude-product-canary-v1 \
  --isolation-attestation-file <private-attestation.json> \
  --dry-run
```

Registered designs include:

| Design | Shape |
|---|---|
| `claude-2x2-williams-v1` | policy profile × skill condition, 16 sessions |
| `claude-product-vs-free-baseline-v1` | product-assisted vs no-product baseline, 8 sessions |
| `claude-product-canary-v1` | one product-assisted session |
| `claude-free-baseline-canary-v1` | one no-product baseline session |

The canary designs are restricted to `coverage-threshold-failure-v2`. Registration does not authorize live use. The versioned Evidence1 launcher supports the one-cell designs when all canary parameters, passing gates, hashes, one-use claims, and explicit authorization are present.

## Runtimes and execution profiles

The runtime registry currently implements Claude Code. A historical Claude/Codex design document under `docs/audits/` is not evidence of an implemented Codex runtime.

The execution-profile registry includes `sandboxed-unrestricted-v1`; it is implemented for Claude Code and requires a valid isolation attestation. Policy/profile identity, model requested/resolved, runtime version, source pins, budget, and scope are recorded independently.

## Schemas

| Artifact | Latest schema | Supported reader range |
|---|---:|---:|
| Scenario run record | 8 | 1–8 |
| Accepted-run audit sidecar | 10 | 1–10 |
| Analysis output | 9 | current analyzer contract |

The latest constants live in `schemas.mjs`, `accepted-run-audit.mjs`, and `analysis.mjs`. Documentation should avoid hard-coding a single old schema as the only analyzable format.

Schema evolution is additive where possible. Old records remain immutable; readers either accept their schema explicitly or reject them with a typed reason.

## Acceptance and benchmark eligibility

`benchmark_eligible` is determined by protocol and integrity completeness, not by whether the agent answered correctly. A wrong answer may still be benchmark-quality evidence; a correct answer without trustworthy provenance is not.

A committable scenario record requires, as applicable:

- registered scenario/runtime/profile/campaign identity;
- pinned clean source and product revisions;
- complete runtime/model/budget metadata;
- policy hashes and current scenario ground truth;
- privacy-safe paths and aliases;
- transcript-derived grading and outcome assessment;
- a matching accepted-run audit sidecar;
- isolation attestation for profiles that require it;
- no unknown or forbidden product exposure in a free baseline.

The validator is authoritative. Never edit a sanitized record after its sidecar has been created; that breaks the bound hashes. Regenerate through the accepted pipeline instead.

## Harness provenance

`dirty_harness_tooling` is fail-closed when evidence is written to the default `RUNS_ROOT`, because that location is intended for promotable repository evidence. With a non-default `RUNS_ROOT`, the same condition is disclosed in the private scratch record but does not by itself block the run. Dirty measured product code or unresolved Git provenance remains fail-closed in either location.

## Product-assisted vs free baseline

Product-assisted conditions expose the versioned `kmp-test` skill/tool surface. A true free baseline must not expose:

- product executables on PATH;
- product-specific environment variables;
- product files or markers in the source-only workspace;
- skill material or injected product instructions.

Run the offline preflight before a free-baseline live session. The preflight demonstrates absence from the controlled local surface; it cannot prove an agent has no prior latent knowledge.

## Measurement scope

`scope init` creates a private scope file so independently launched cells can share a longitudinal measurement boundary. Omitting it creates a fresh per-invocation scope. Do not combine records from distinct scopes as if they shared one measurement population.

Scope files can contain identifying material and are not public artifacts. Public records carry only the sanitized/bound representation required by their schema.

## First useful signal

First useful signal is the first transcript event that provides the authoritative evidence required by the scenario. It is not the first tool call, first command, process start, or final answer.

If the required evidence never occurs, the value remains unavailable with a reason. Do not replace it with wall-clock duration. Post-signal time and tool calls are measured separately.

## Evidence layout

Accepted public directories use this shape:

```text
tools/runs/<dated-campaign>/
  scenario-*.json
  audit/
    scenario-*.json
  RESULTS.md
```

Only sanitized records and sidecars belong here. Raw transcripts, stdout/stderr custody, credential state, private patterns, scope files, and VM images stay outside Git.

## Offline analysis

```sh
node tools/agentic-eval/cli.mjs validate --run tools/runs/<campaign>/<record>.json
node tools/agentic-eval/cli.mjs aggregate --runs-dir tools/runs/<campaign>
node tools/agentic-eval/cli.mjs analyze --runs-dir tools/runs/<campaign>
```

`validate`, `aggregate`, and `analyze` do not launch an agent. Analysis consumes supported committed scenario records plus validated sidecars and emits deterministic classifications.

## Evidence1

Evidence1 adds a Windows Hyper-V isolation and custody layer around this harness. The canonical public guides are:

- [Windows/ISO setup](../../docs/evaluation/evidence1-windows-setup.md)
- [one-cell live canary](../../docs/evaluation/evidence1-live-canary.md)
- [2026-09-10 results](../../docs/evaluation/evidence1-results-2026-09-10.md)

Detailed scripts and forensic notes live under `docs/audits/`. They assume the prepared VM and path layout; they are not an automated clean-room VM provisioner.

## Development checks

```sh
npm test
node tools/agentic-eval/cli.mjs corpus validate
node tools/decouple-audit.mjs
```

Changes to graders, materialization, policy binding, schemas, privacy, or live launch/custody require targeted regression tests for the rejected evidence class as well as the full repository gate.

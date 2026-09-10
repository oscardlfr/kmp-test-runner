# Run an agentic evaluation

This guide covers the repository harness. Evidence1 adds a stricter VM/authentication/custody layer described in the [live canary runbook](evidence1-live-canary.md).

## 1. Validate the corpus

```sh
node tools/agentic-eval/cli.mjs corpus validate
```

`calibrate` is not part of corpus validation: it launches a live, billable foundation session. Run it only after reviewing its runtime, profile, model, and budget; its output always remains `benchmark_eligible: false`.

```sh
node tools/agentic-eval/cli.mjs calibrate --runtime claude-code
```

## 2. Pin the source

Use a clean local clone and an exact commit. Do not evaluate against a moving branch or a dirty working tree. Keep product source and scenario source pins in the resulting record.

## 3. Inspect a dry plan

Single scenario:

```sh
node tools/agentic-eval/cli.mjs run \
  --scenario coverage-threshold-failure-v2 \
  --source-repo-dir <clean-local-clone> \
  --seed 20260821 \
  --repeats 1 \
  --runtime claude-code \
  --execution-profile sandboxed-unrestricted-v1 \
  --isolation-attestation-file <private-attestation.json> \
  --dry-run
```

Registered one-cell campaign:

```sh
node tools/agentic-eval/cli.mjs run \
  --scenario coverage-threshold-failure-v2 \
  --source-repo-dir <clean-local-clone> \
  --seed 20260821 \
  --campaign-design claude-product-canary-v1 \
  --isolation-attestation-file <private-attestation.json> \
  --dry-run
```

Use `claude-free-baseline-canary-v1` for the true no-product arm. The free-baseline preflight is offline and reports counts/statuses without raw paths:

```sh
node tools/agentic-eval/cli.mjs product-access preflight \
  --mode free-baseline-no-product \
  --workspace <source-only-workspace>
```

## 4. Authorize and execute

Dry-run output is not authorization. Bind authorization to the runtime, model, campaign/design, session count, budget, pins, and isolation evidence required by the operating environment. Do not retry, replace, or respawn a one-shot cell unless a separate new authorization explicitly permits a new session.

For Evidence1, do not invoke the generic command directly; use the versioned host launcher after V1/V2/V3. See [Evidence1 live canary](evidence1-live-canary.md).

## 5. Validate before analysis

Each accepted scenario record requires a matching accepted-run audit sidecar under `audit/<same-file-name>`:

```sh
node tools/agentic-eval/cli.mjs validate --run <runs-dir>/<record>.json
node tools/agentic-eval/cli.mjs aggregate --runs-dir <runs-dir>
node tools/agentic-eval/cli.mjs analyze --runs-dir <runs-dir>
```

`analyze` is offline. It reads supported committed scenario schemas and validated sidecars; it never launches Claude or consumes raw transcripts.

## 6. Publish safely

- Copy only sanitized records and sidecars.
- Run `node tools/decouple-audit.mjs`.
- State `benchmark_eligible`, scope compatibility, exclusions, and missing measurements.
- Keep raw/custody material in the controlled evidence store.
- Put detailed interpretation in [Metrics and evidence](../metrics.md), not the README.

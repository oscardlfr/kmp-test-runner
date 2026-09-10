# Evaluation guide

This section explains how `kmp-test-runner` is evaluated, how to reproduce the
agentic harness, and how the Windows-only Evidence1 environment adds an
external isolation boundary around live sessions.

Evaluation evidence is not product documentation and it is not a release
claim by itself. A run can be structurally valid while the agent gives the
wrong answer. Conversely, a correct-looking answer is not accepted evidence
when provenance, isolation, custody, or privacy checks fail.

## Choose the right document

| Goal | Start here |
| --- | --- |
| Understand or run the portable agentic harness | [Running the agentic evaluation](running-agentic-eval.md) |
| Build a Windows VM suitable for Evidence1 | [Evidence1 Windows setup](evidence1-windows-setup.md) |
| Validate and execute an Evidence1 one-cell live canary | [Evidence1 live canary](evidence1-live-canary.md) |
| Interpret output-reduction and agentic metrics | [Metrics and measurement](../metrics.md) |
| Review the full experimental methodology | [Agentic usage measurement](../agentic-usage-measurement.md) |
| Inspect every harness invariant and schema detail | [`tools/agentic-eval` technical reference](../../tools/agentic-eval/README.md) |

The Evidence1 runbooks above are operator guides. The lower-level audited
contracts remain authoritative for failure recovery and custody edge cases:

- [Evidence1 Hyper-V operations toolkit](../audits/evidence1-hyperv-ops-toolkit.md)
- [Evidence1 post-merge validation](../audits/evidence1-post-merge-validation.md)
- [Evidence1 live state-machine ADR](../audits/evidence1-hyperv-live-state-machine-adr.md)

## Portability boundary

The repository contains two related but distinct layers.

| Layer | Supported surface | What it provides |
| --- | --- | --- |
| Agentic harness | Node.js tooling on Windows, macOS, and Linux; runtime and project-toolchain availability still apply | Scenario materialization, condition isolation, transcript parsing, grading, schema validation, aggregation, and analysis |
| `strict-policy-v1` | Runtime policy hooks | A closed command allowlist with per-attempt accounting; useful for controlled harness runs, but not an unrestricted-agent environment |
| `sandboxed-unrestricted-v1` | Any host that supplies a valid external-isolation attestation | Removes the harness command policy and delegates containment to an external sandbox; registration does not create that sandbox |
| Evidence1 | Windows host with Hyper-V and a dedicated Windows guest | The repository's implemented external-sandbox backend, including network seal, PowerShell Direct transport, one-use handoff, progress, and custody |

The harness itself has accepted Windows and macOS evidence. Evidence1 is not a
generic VM abstraction: its operational scripts use Hyper-V, Windows firewall,
scheduled tasks, VMConnect, VHD custody, and PowerShell Direct. The repository
does not currently provide an Evidence1 backend for Parallels, VMware, UTM,
Apple's Virtualization framework, or Linux hypervisors.

## Runtime support

The runtime registry is the source of truth. At the time this page was
audited, it enabled only `claude-code`. Work to validate a Codex CLI adapter is
being performed separately. Until that implementation, its tests, and its
sanitized evidence land in this branch, Codex must not be described here as a
supported runtime and no Codex result should be inferred from Claude data.

Check the live registry instead of relying on this paragraph:

```bash
node -e "console.log(require('fs').readFileSync('tools/agentic-eval/runtimes/registry.json','utf8'))"
```

## Trust levels

Use precise language when reporting a run:

- **Dry plan:** proves argument resolution and planned cell count. It starts no
  agent and proves neither authentication nor outcome correctness.
- **Calibration or smoke:** proves the mechanics of skill availability and the
  bounded pipeline. These records are always `benchmark_eligible:false`.
- **Accepted scenario record:** passed schema, privacy, transcript-integrity,
  policy/accounting, provenance, and sidecar checks. Its `success` and grading
  fields still determine whether the answer was correct.
- **Evidence1 canary:** an accepted one-session scenario plus Windows external
  isolation, live authorization, immutable handoff, and terminal custody.
- **Benchmark claim:** requires an adequate, pre-registered sample and honest
  uncertainty. A one-cell canary or a few repetitions are diagnostic evidence,
  not a population-level effect estimate.

`benchmark_eligible:true` means the protocol produced complete, internally
valid evidence. It never means that the agent succeeded or that the product is
faster, cheaper, or better.

## Non-negotiable evidence rules

- Pin the harness commit/tree, scenario, target-project commit, runtime and
  model version, execution profile, skill source, and cache policy.
- Compare conditions only within the same complete partition.
- Do not silently replace failed, interrupted, timed-out, or inconvenient
  sessions.
- Never treat a fresh run ID as authorization for another live session.
- Keep raw transcripts, prompts, responses, stderr, credentials, browser state,
  local paths, private project identities, and private module names out of git.
- Publish only schema-validated records, accepted-run sidecars, closed
  diagnostics, and reviewed aggregate reports.
- Record unavailable metrics as `null` or `not recorded`, never as zero.

Nothing in these documents grants permission to start a paid or live agent
session. Live execution remains an explicit operator decision after all
non-live gates pass.

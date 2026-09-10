# Running the agentic evaluation

This guide covers the reusable Node.js harness under `tools/agentic-eval`. It
does not provision a VM and does not imply that every execution profile is safe
on the local machine. For the repository's Windows external-isolation backend,
use [Evidence1 Windows setup](evidence1-windows-setup.md) and the
[Evidence1 live-canary runbook](evidence1-live-canary.md).

## What the harness measures

The harness compares a pinned `kmp-test-runner` skill against a technically
isolated no-skill condition while holding the rest of the run partition fixed.
For a true product baseline it additionally removes access to the product CLI.
It records several independent axes rather than collapsing them into one score:

- runtime, runtime version, requested and resolved model;
- execution profile and attestation;
- skill availability, attempted invocation, and confirmed invocation;
- product-access and product-usage modes;
- scenario outcome, authoritative evidence, and final-claim agreement;
- wall time, command/tool counts, output bytes, and runtime-native usage;
- provenance, privacy, transcript integrity, and terminal custody.

The current runtime registry enables `claude-code`. Codex support is under
separate validation and is not part of this runbook yet.

## Conditions and profiles

Skill condition and product access are separate controls:

| Condition | Skill state | Typical product access |
| --- | --- | --- |
| `current-skill` | Pinned skill snapshot is present | `product-assisted` |
| `no-skill` | Target skill is technically absent | `product-visible-no-skill` or `free-baseline-no-product` |
| `candidate-skill` | Reserved by the schema | Not implemented |

Execution profiles answer a different question:

| Profile | Enforcement | Attestation |
| --- | --- | --- |
| `strict-policy-v1` | Harness policy hook permits only the scenario's closed command set and accounts for every shell attempt | Not required |
| `sandboxed-unrestricted-v1` | Harness policy is not applicable; an external sandbox owns containment and network restriction | Required and fail-closed |

Do not call `sandboxed-unrestricted-v1` “unrestricted execution” without also
naming its external sandbox. The profile removes the harness allowlist; it does
not remove the isolation requirement.

## Prerequisites

- Node.js 18 or newer.
- Git available on `PATH`.
- A clean checkout of this repository at the exact harness commit to measure.
- A separate clean clone of the public scenario project with the scenario's
  pinned commit available locally.
- The enabled runtime CLI installed and authenticated for any live step.
- Gradle/JDK/Android SDK requirements demanded by the selected public project.
- A private-patterns file when the environment contains additional sensitive
  identifiers not covered by the repository's default privacy rules.
- For `sandboxed-unrestricted-v1`, a fresh isolation attestation produced by an
  external sandbox implementation.

Run commands from the repository root. First inspect the exact CLI surface and
registries from the checkout you are about to measure:

```bash
node tools/agentic-eval/cli.mjs --help
node -e "console.log(require('fs').readFileSync('tools/agentic-eval/runtimes/registry.json','utf8'))"
node -e "console.log(require('fs').readFileSync('tools/agentic-eval/execution-profiles/registry.json','utf8'))"
node -e "console.log(require('fs').readFileSync('tools/agentic-eval/models/registry.json','utf8'))"
```

Do not copy a model name or CLI version from an old report into a new run. The
runtime adapter must observe and record the current values.

## 1. Validate the corpus

```bash
node tools/agentic-eval/cli.mjs corpus validate
```

This validates trigger queries and every scenario file. A failure is a corpus
or schema problem; do not work around it by editing expected results immediately
before a live run.

## 2. Create a reusable measurement scope

Independent invocations get different ambient-profile partition identities by
default and therefore cannot be aggregated longitudinally. Create one local
scope file for a planned campaign:

```bash
node tools/agentic-eval/cli.mjs scope init --out <path-outside-the-repository>
```

The file contains a secret HMAC key. Keep it outside git, restrict its file
permissions, reuse it only for the intended comparable wave, and rotate it when
the ambient environment changes. The command prints the scope ID and path, not
the key.

## 3. Prepare the scenario source

Read the selected scenario before cloning anything:

```bash
node -e "console.log(require('fs').readFileSync('tools/agentic-eval/corpus/scenarios/<scenario-id>.json','utf8'))"
```

The source clone must satisfy all of these conditions:

- `origin` matches the scenario's public `project_url`;
- the pinned `project_commit` resolves locally;
- tracked files and index are clean;
- the clone is not the harness repository;
- no product marker, product dependency, product executable, or product-specific
  environment variable contaminates a `free-baseline-no-product` workspace.

Preflight a source-only baseline workspace separately:

```bash
node tools/agentic-eval/cli.mjs product-access preflight \
  --mode free-baseline-no-product \
  --workspace <source-only-workspace>
```

This emits counts and closed check IDs, never raw paths. It proves the inspected
local surface is product-clean; it does not prove that a model has no prior
knowledge of the product.

## 4. Dry-run the exact plan

For a normal paired scenario under the strict policy:

```bash
node tools/agentic-eval/cli.mjs run \
  --scenario <scenario-id> \
  --source-repo-dir <clean-local-clone> \
  --seed <pre-registered-integer> \
  --repeats 4 \
  --runtime claude-code \
  --execution-profile strict-policy-v1 \
  --measurement-scope-file <local-scope-file> \
  --max-budget-usd <approved-per-session-cap> \
  --dry-run
```

`--repeats 4` plans eight live sessions: two conditions per repetition. The CLI
accepts up to 20 repetitions, but a larger value is not implicit permission to
spend that many sessions. Inspect the dry plan's runtime/model/profile, cell
order, planned-session count, scenario/source pins, skill pin, budget, and
attestation requirements before considering live execution.

For an externally isolated campaign, select a registered campaign design and
provide the attestation:

```bash
node tools/agentic-eval/cli.mjs run \
  --campaign-design claude-product-vs-free-baseline-v1 \
  --scenario <scenario-id> \
  --source-repo-dir <clean-local-clone> \
  --seed <pre-registered-integer> \
  --runtime claude-code \
  --isolation-attestation-file <fresh-local-attestation> \
  --measurement-scope-file <local-scope-file> \
  --max-budget-usd <approved-per-session-cap> \
  --dry-run
```

Campaign designs own their repetition count and profiles. Do not add
`--repeats` or `--execution-profile` to a campaign-design invocation.

## 5. Run calibration and smoke when the environment changes

Calibration explicitly asks for the target skill and proves the skill-delivery
mechanics:

```bash
node tools/agentic-eval/cli.mjs calibrate \
  --runtime claude-code \
  --execution-profile strict-policy-v1 \
  --measurement-scope-file <local-scope-file> \
  --max-budget-usd <approved-per-session-cap>
```

Smoke performs bounded real diagnostics in both conditions against a pinned
public source clone:

```bash
node tools/agentic-eval/cli.mjs smoke \
  --source-repo-dir <clean-local-clone> \
  --pinned-commit <40-hex-project-commit> \
  --project-alias <public-alias> \
  --runtime claude-code \
  --execution-profile strict-policy-v1 \
  --measurement-scope-file <local-scope-file> \
  --max-budget-usd <approved-per-session-cap>
```

Both commands spawn live runtime sessions. Their records are foundation checks
and remain `benchmark_eligible:false`. They are not free dry runs.

## 6. Execute a reviewed scenario plan

Remove only `--dry-run` from the exact command that was reviewed. Do not change
the seed, source clone, commit, runtime, model, profile, scope, attestation,
budget, or design between preview and execution.

Before doing so, record explicit authorization covering the exact number of new
live sessions and the no-retry policy. A failed or interrupted cell is still a
consumed attempt. Do not replace it unless a new authorization explicitly
covers a replacement.

The harness fails fast on a cell-integrity failure, rejects partial matrices,
and writes raw captures beneath a gitignored `raw/` directory. A test-only
`KMP_EVAL_RUNS_ROOT` override weakens the default location guarantee and must
not be used for publishable production evidence.

## 7. Validate before aggregating

Each accepted scenario JSON must validate together with its referenced
accepted-run audit sidecar:

```bash
node tools/agentic-eval/cli.mjs validate --run <accepted-run.json>
```

Validation checks the record schema, the on-disk sidecar path and digest, and
cross-record invariants. Do not hand-edit a record to make validation pass.

Aggregate only a directory containing compatible records:

```bash
node tools/agentic-eval/cli.mjs aggregate --runs-dir <accepted-runs-directory>
node tools/agentic-eval/cli.mjs analyze --runs-dir <accepted-runs-directory>
```

Aggregation partitions on runtime, version, model, profile, platform, scenario,
project and harness provenance, skill pin, cache policy, product access, and
ambient profile. The analyzer reports activation, post-invocation execution,
policy interaction, authoritative evidence, and final outcome separately.

## Publication checklist

- Every intended cell has one terminal record; no missing or duplicate run IDs.
- Every record and sidecar validates from a clean checkout.
- The matrix is complete and the recorded order matches the pre-registered plan.
- `benchmark_eligible` is interpreted only as protocol/integrity eligibility.
- Success and each grading check are reported independently.
- Runtime-native token dimensions are not summed across incompatible semantics.
- Means are accompanied by `n`, median, minimum, maximum, and dispersion when
  sample size allows it.
- Raw transcripts, prompts, responses, stderr, secrets, local paths, and private
  identifiers remain local-only.
- Published files pass the repository privacy and decoupling checks.

For field-level contracts, rejection diagnostics, crash-safety limits, and
schema history, use the [`tools/agentic-eval` technical reference](../../tools/agentic-eval/README.md).

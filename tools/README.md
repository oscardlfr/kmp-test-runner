# Maintainer tooling

`tools/` contains repository validation, release gates, public measurement
utilities, wide-smoke drivers, local CI support, and the agentic-evaluation
harness. These files are excluded from the published npm package by
`package.json#files`; they are for maintainers and evidence generation, not the
runtime CLI.

Run commands from the repository root. Most scripts require Node.js and some
also require npm, Git, Gradle projects, platform SDKs, or authenticated external
CLIs. Read the script and its linked protocol before launching any command that
can incur API cost or create live evaluation sessions.

## Repository gates

| Script | Purpose | Typical command |
|---|---|---|
| `check-bundle-size.mjs` | Run `npm pack --dry-run --json` and enforce packed/unpacked budgets | `node tools/check-bundle-size.mjs` |
| `check-line-endings.mjs` | Verify tracked files covered by `.gitattributes` `eol=lf` rules contain no CRLF | `node tools/check-line-endings.mjs` |
| `check-executable-fixtures.mjs` | Verify fake-Claude executable fixtures are tracked as mode `100755` | `node tools/check-executable-fixtures.mjs` |
| `decouple-audit.mjs` | Reject committed private identifiers, personal paths, and internal project names | `node tools/decouple-audit.mjs` |
| `validate-plugin.mjs` | Validate the Claude plugin manifest, version, license, and referenced skill paths | `node tools/validate-plugin.mjs` |
| `validate-required-checks.mjs` | Validate the required-check manifest or compare it with branch protection | `node tools/validate-required-checks.mjs --schema-only` |
| `sync-versions.js` | Keep package, Gradle plugin, README, Claude, and plugin-manifest pins aligned | `node tools/sync-versions.js --check` |
| `release-gate.mjs` | Validate a release tag or poll the required check set | `node tools/release-gate.mjs validate-tag v0.14.0` |

`validate-required-checks.mjs --check-drift` requires `GITHUB_REPOSITORY`, an
authenticated `gh` CLI, and permission to read branch protection/rulesets. It is
normally executed by CI on protected-branch pushes.

`sync-versions.js` without `--check` writes synchronized version pins. Review
that diff before committing it.

## Local CI

`tools/local-ci/` contains the cross-platform local gate used to reproduce the
hosted matrix more closely than a single test command:

- `run.ps1` coordinates the Windows path;
- `run-linux.sh` coordinates the Linux/container path;
- `windows-gate.ps1`, `linux-gate.sh`, and `node18-gate.sh` hold focused gates;
- `container/` and `Dockerfile` support isolated Linux validation;
- `environment-utils.ps1` and `path-utils.ps1` centralize host discovery;
- `prepare-source.sh` stages the source tree used by the container path.

These scripts are validation infrastructure, not installers. They can be
resource-intensive and should be used from a clean feature worktree.

## Public project sweeps

### `wide-smoke-pass-{7,8,9,10}.mjs`

Sequential matrices over a maintained set of public KMP projects. Each numbered
pass freezes a historical matrix so results can be compared without silently
changing the sample. Pass 10 is the current Windows driver.

```sh
node tools/wide-smoke-pass-10.mjs
node tools/wide-smoke-pass-10.mjs --reclassify
```

`--reclassify` rebuilds classification from saved artifacts rather than running
the projects again.

### `wide-smoke-pass-9-mac.mjs`

Manual macOS counterpart for the smaller reproducible Mac sample:

```sh
node tools/wide-smoke-pass-9-mac.mjs --test-type all
node tools/wide-smoke-pass-9-mac.mjs --test-type macos
node tools/wide-smoke-pass-9-mac.mjs --test-type ios
```

### `macos-validation-gate.mjs`

Manual pre-release matrix with `dry`, `probe`, `scoped`, and `full` modes. The
full mode deliberately requires the explicit disk-space acknowledgement:

```sh
node tools/macos-validation-gate.mjs --mode dry
node tools/macos-validation-gate.mjs --mode probe
node tools/macos-validation-gate.mjs --mode scoped
node tools/macos-validation-gate.mjs --mode full --i-have-20gb-free
```

It is not part of per-PR hosted CI because macOS runner minutes are intentionally
kept minimal.

### `wet-audit-v0.9.mjs` and `wet-evidence.mjs`

`wet-audit-v0.9.mjs` runs cross-project dry-run/envelope checks against the
schema-2 contract:

```sh
node tools/wet-audit-v0.9.mjs
```

`wet-evidence.mjs` converts an already-run validation into a sanitized evidence
row. It requires an alias, exact command, exit code, project kind, platform, and
an explicit output source or `--no-output`. Private projects also require a
private-pattern file. It refuses to emit evidence when redaction checks still
find a leak.

## Token-cost measurement

### `measure-token-cost.js`

Measures three same-feature read paths:

- A: raw Gradle output and generated reports;
- B: human `kmp-test` output;
- C: `kmp-test --json`.

```sh
node tools/measure-token-cost.js \
  --project-root /path/to/project \
  --feature parallel \
  --runs 3
```

Supported features are `parallel`, `coverage`, `changed`, `benchmark`, `info`,
and `describe`. Multi-project runs can use `--projects-config <path>` or the
newline-separated `KMP_MEASUREMENT_PROJECTS` environment variable.

Offline tokenization is suitable for reproducible public matrices. Optional
Anthropic retokenization reads `ANTHROPIC_API_KEY` or
`ANTHROPIC_API_KEY_FALLBACK`; never put keys on a command line or in committed
artifacts. Full methodology and publication rules are in
[`docs/token-cost-measurement.md`](../docs/token-cost-measurement.md).

### `measurement-registry.mjs`

Validates and summarizes the append-only measurement ledger:

```sh
node tools/measurement-registry.mjs validate
node tools/measurement-registry.mjs summarize
node tools/measurement-registry.mjs summarize --feature parallel
node tools/measurement-registry.mjs export-csv
```

`tools/runs/measurement-registry.jsonl` is intentionally tracked. Derived CSV
and raw captures remain local unless a protocol explicitly defines a sanitized,
reviewable evidence artifact.

## Agentic evaluation

`tools/agentic-eval/` is the reproducible multi-runtime evaluation harness. It
contains runtime adapters, scenarios, campaign designs, policy gates, schemas,
privacy checks, aggregation, and analysis. It has produced real campaigns; it
is not merely foundation scaffolding. Whether a particular record is eligible
as benchmark evidence is determined per record by protocol and integrity gates.

Start with its own reference:

```sh
node tools/agentic-eval/cli.mjs --help
node tools/agentic-eval/cli.mjs corpus validate
```

See [`agentic-eval/README.md`](agentic-eval/README.md) before running
`calibrate`, `smoke`, `run`, `aggregate`, or `analyze`. Live commands may create
paid external-agent sessions and are subject to explicit authorization,
registered campaign, budget, isolation, and privacy requirements. `--dry-run`
inspects plans without creating a live session.

## Workspace and temporary-directory overrides

Several historical sweep tools resolve neighboring projects from:

```text
KMP_WORKSPACE, otherwise the parent directory of this repository
```

Set `KMP_WORKSPACE` when projects are elsewhere. Scripts that honor it print the
resolved workspace before executing.

`macos-validation-gate.mjs` additionally honors `KMP_TMPDIR`, falling back to a
`.tmp` directory under the configured workspace.

Do not commit real home paths or private project names when configuring these
tools. Keep machine-specific configuration outside the repository and use safe
public aliases in evidence.

## Artifact policy

Generated working data normally lives under `tools/runs/`, `.smoke/`, or a
campaign-specific external custody directory. Do not assume the whole directory
is disposable or ignored: the repository intentionally tracks selected
sanitized evidence and the measurement registry.

Before adding any generated file:

1. identify the governing measurement/evaluation protocol;
2. validate its schema and integrity sidecar;
3. run privacy and decoupling checks;
4. confirm that the artifact is designated for publication rather than raw
   custody;
5. review the exact staged diff.

Raw Gradle output, raw agent transcripts, credentials, personal paths, private
project identifiers, and machine-specific custody material must not be committed.

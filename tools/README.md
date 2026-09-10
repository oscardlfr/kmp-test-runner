# Maintainer tools

These scripts validate releases, run cross-project checks, measure output cost, and maintain accepted evaluation evidence. They are repository-maintainer surfaces, not part of the installed `kmp-test` CLI.

## Required local gate

On Windows, run the Docker Linux plus native Windows gate before making a code-changing PR ready:

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
```

See [local CI](../docs/testing/local-ci.md) for prerequisites and focused lanes.

## Repository and release checks

| Tool | Purpose |
|---|---|
| `validate-required-checks.mjs` | Compare workflow/job state with `.github/required-checks.json`. |
| `validate-plugin.mjs` | Validate the bundled Claude plugin/skill shape. |
| `sync-versions.js` | Check or propagate the `package.json` version to published shapes/docs. |
| `release-gate.mjs` | Run release invariants before the release workflow. |
| `check-bundle-size.mjs` | Enforce package/archive size limits. |
| `check-line-endings.mjs` | Enforce platform-sensitive line endings. |
| `check-executable-fixtures.mjs` | Verify executable test fixtures. |
| `decouple-audit.mjs` | Reject private identifiers and paths from committed public text. |

Typical focused checks:

```sh
node tools/validate-required-checks.mjs
node tools/validate-plugin.mjs
node tools/sync-versions.js --check
node tools/decouple-audit.mjs
```

## Cross-project validation

`wide-smoke-pass-*.mjs`, `wet-audit-v0.9.mjs`, `wet-evidence.mjs`, and `macos-validation-gate.mjs` are dated/targeted maintainership programs. Read the selected file's arguments before running it and always use a pinned project checkout. Where supported, `--project-root` is the current public spelling; do not use the retired `--project` example.

macOS-heavy validation is manually dispatched because hosted macOS minutes are deliberately constrained.

## Token-cost measurement

`measure-token-cost.js` captures and counts selected output surfaces; `measurement-registry.mjs` maintains provenance in `tools/runs/measurement-registry.jsonl`.

```sh
node tools/measure-token-cost.js --help
```

Canonical interpretation and published claims live in [docs/metrics.md](../docs/metrics.md). Method details live in [docs/token-cost-measurement.md](../docs/token-cost-measurement.md).

## Agentic evaluation

The harness is implemented, includes accepted public records, and is no longer “foundation tooling only”. Start with:

- [operator documentation](../docs/evaluation/README.md);
- [technical harness reference](agentic-eval/README.md);
- [latest Evidence1 canary evidence](runs/agentic-eval-evidence1-product-vs-free-canary-2026-09-10/RESULTS.md).

Public `tools/runs/` content includes both historical reports and validated sanitized records. New live output is not automatically committable: validate, sanitize, attach the matching sidecar, and run the privacy gate first.

## Evidence retention

Treat dated markdown reports as historical snapshots. Do not rewrite a past campaign to match a newer schema; add a correction note or a new result instead. Never commit raw authenticated transcripts, credentials, VM images/state, custody bundles, or private measurement-scope files.

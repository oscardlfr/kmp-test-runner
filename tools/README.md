# `tools/` — maintainer scripts

Local-only tooling for the `kmp-test-runner` maintainer. **None of these scripts ship in the published npm artefact** — `tools/` is excluded from `package.json#files`. They exist to drive validation sweeps, token-cost measurement, and version sync against a workspace of real KMP projects sitting next to this repo on disk.

## Conventions

### `KMP_WORKSPACE` env var

Most scripts here iterate over a workspace directory containing N gradle roots side-by-side with `kmp-test-runner/`. Resolution rule:

```
WORKSPACE = process.env.KMP_WORKSPACE || path.resolve(<repo-root>, '..')
```

The fallback assumes the canonical layout:
```
<workspace>/
  ├── kmp-test-runner/        # this repo
  ├── PeopleInSpace/
  ├── KaMPKit/
  └── …
```

If you keep your KMP projects elsewhere, export `KMP_WORKSPACE=/path/to/your/workspace` before running. Each script logs `[NOTICE] WORKSPACE = …` to stderr at startup so you can confirm the resolved path before anything runs.

### `KMP_TMPDIR` env var

`tools/macos-validation-gate.mjs` additionally honours `KMP_TMPDIR` for the override that points gradle daemons at a non-default `TMPDIR` (used to fight tight disk situations on the macOS validation machine). Falls back to `${KMP_WORKSPACE}/.tmp`.

### Privacy

Never commit private project names, home-directory paths, or maintainer-specific volume paths into these scripts or the repo at large. The `decouple-audit.mjs` script enforces this — see below.

## Scripts

### `decouple-audit.mjs`
Privacy enforcement gate. Walks `git ls-files` and fails on any committed file containing one of the maintainer's private toolkit identifiers (private library composite project name, internal benchmark module names, home-directory paths, etc.). Run before push:
```
node tools/decouple-audit.mjs
```
Wired into CI as a required check; mirrors the `secrets-scan` job shape.

### `wide-smoke-pass-{7,8,9,10}.mjs`
Sequential matrix sweeps over ~30 KMP projects. Each pass freezes the matrix at a moment in time so subsequent passes can be diffed bucket-by-bucket. Pass-10 is the current Windows baseline.
```
node tools/wide-smoke-pass-10.mjs
node tools/wide-smoke-pass-10.mjs --reclassify   # re-bucket from saved artefacts
```
Per-project artefacts: `.smoke/pass-N/<safe>.{out,err,json,meta.json}` + `WIDE-SMOKE-PASS-N.md` summary.

### `wide-smoke-pass-9-mac.mjs`
macOS counterpart to `wide-smoke-pass-9.mjs`. Smaller project set (4 roots that reproduce on Mac). Produces parity-diffable envelopes against the Windows pass-9 baseline.
```
node tools/wide-smoke-pass-9-mac.mjs --test-type all
node tools/wide-smoke-pass-9-mac.mjs --test-type macos
node tools/wide-smoke-pass-9-mac.mjs --test-type ios
```

### `macos-validation-gate.mjs`
Pre-tag macOS validation matrix (45 cells: `{parallel, changed} × 7 --test-type values × 3 projects` + `android × 3 projects`). Four modes: `dry`, `probe`, `scoped`, `full`. Manual-only — not wired into CI per the macOS-cost rule.
```
node tools/macos-validation-gate.mjs --mode dry
node tools/macos-validation-gate.mjs --mode probe
node tools/macos-validation-gate.mjs --mode scoped
node tools/macos-validation-gate.mjs --mode full --i-have-20gb-free
```

### `wet-audit-v0.9.mjs`
Cross-project envelope-shape audit against schema 2. Spawns `kmp-test parallel --json --dry-run` per project and asserts the envelope shape matches the canonical contract.
```
node tools/wet-audit-v0.9.mjs
```

### `measure-token-cost.js`
Approach A/B/C token-cost matrix using Anthropic's `count_tokens` endpoint (or a fallback offline tokenizer). Used to keep the README's token-saving headline numbers honest.
```
node tools/measure-token-cost.js --project <path> --feature parallel
```
Honours `ANTHROPIC_API_KEY` + `ANTHROPIC_API_KEY_FALLBACK` + `--anthropic-api-key`.

### `measurement-registry.mjs`
Append-only token-cost measurement registry — `tools/runs/measurement-registry.jsonl` is the queryable, schema-checked ledger every `measure-token-cost.js` result (past and future) gets recorded into.
```
node tools/measurement-registry.mjs validate     # schema + privacy + A:C sanity checks
node tools/measurement-registry.mjs export-csv   # regenerates the derived, gitignored .csv
node tools/measurement-registry.mjs summarize    # totals, or --feature <name> for a pivoted table
```
See [`docs/token-cost-measurement.md`](../docs/token-cost-measurement.md#measurement-registry) for the schema.

### `sync-versions.js`
Keeps `package.json#version` in lockstep with the hardcoded version pins across `gradle-plugin/build.gradle.kts`, `README.md`, `CLAUDE.md`, and `.claude-plugin/plugin.json` (Claude Code plugin manifest). Wired into CI's `secrets-scan` job as a pre-flight.
```
node tools/sync-versions.js --check    # exit non-zero on mismatch
node tools/sync-versions.js            # write fix
```

### `validate-plugin.mjs`
Claude Code plugin manifest gate. Asserts `.claude-plugin/plugin.json` has the required shape (kebab-case name, semver version matching `package.json`, license matching `package.json`, no PR/bug refs in description, `skills[]` paths resolve to a `<name>/SKILL.md` on disk). Wired into CI's `skills-validate` job (shares the required-check name with `npx skills-ref validate`).
```
node tools/validate-plugin.mjs         # exit 0 on pass, 1 on validation failure
```

## Output directory

All scripts that emit per-project artefacts write under `tools/runs/` or `.smoke/<pass>/` in the repo root. Both are gitignored. Don't `git add` artefacts.

One deliberate exception: `tools/runs/measurement-registry.jsonl` IS tracked — it's the whole point of the registry, an append-only structured ledger, not a regenerable per-project capture. Its derived `.csv` (via `export-csv`) stays gitignored like everything else here.

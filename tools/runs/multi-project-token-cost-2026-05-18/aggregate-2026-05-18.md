# Multi-project token-cost aggregate (2026-05-18)

Token-cost reduction scales with project size. The table below shows median A→C ratio per bucket per feature, computed across the OSS sample. The v0.9 reference project `private-large-A` is reused as the canonical large-project ceiling for `coverage` (the only feature whose Approach-A baseline requires a Kover-configured project — all six OSS projects ship without Kover, see "Methodology notes" at the bottom).

## Sample roster (by actual Gradle module count)

Module counts reflect the recursive walker shipped in this run (`tools/measure-token-cost.js#filterModulesByGlob`, which now honours nested grouping dirs like NowInAndroid's `core/` / `feature/`). The v0.9 PR #13 aggregate undercounted Confetti (13→16) and NowInAndroid (5→36) because its walker was one-level-deep.

| Bucket | Sample (n) | Projects (module count) |
|--------|-----------:|--------|
| small (1–5) | 3 | KaMPKit (2), kotlinconf-app (5), kmp-production-sample (2) |
| medium (6–20) | 2 | PeopleInSpace (7), Confetti (16) |
| large (21+) | 1 | NowInAndroid (36) + `private-large-A` (~70, v0.9 reused for coverage A only) |

## Feature: parallel

cl100k_base only. Anthropic counts within ±20% per the v0.9 cross-model evidence (`tools/runs/cross-model-results-parallel.txt`).

| Bucket | A median | C median | A→C median | A→C range  | A→C spread | Sample |
|--------|---------:|---------:|-----------:|------------|-----------:|--------|
| small  |   24,454 |      338 |       56.6× |   1.3× – 102.2× |     7933% | 3      |
| medium |  427,586 |    4,499 |    **90.0×** |   84.4× – 95.6× |       13% | 2      |
| large  |  226,291 |    1,839 |   **123.1×** | 123.1× – 123.1× |        - | 1      |

### Per-project parallel — raw numbers

| Project              | Bucket  | A (cl100k)  | B       | C      | A:C     |
|----------------------|---------|------------:|--------:|-------:|--------:|
| KaMPKit              | small   |      34,536 |   1,479 |    338 |   102.2× |
| kotlinconf-app       | small   |      24,454 |   1,014 |    432 |    56.6× |
| kmp-production-sample| small   |         304 |     148 |    239 |     1.3× |
| PeopleInSpace        | medium  |      35,613 |     944 |    422 |    84.4× |
| Confetti             | medium  |     819,559 |   8,398 |  8,576 |    95.6× |
| NowInAndroid         | large   |     226,291 |   5,457 |  1,839 |   123.1× |

### Per-bucket spread observations

- **Small** spread is large (7933%) — driven by kmp-production-sample's near-zero test output (2 modules, only a placeholder `commonTest` directory). KaMPKit and kotlinconf-app both land in the 56–102× range.
- **Medium** spread is tight (13%) — PeopleInSpace (7 modules) and Confetti (16 modules) come in within 11% of each other (84× vs 95×). The 84–96× range is a solid medium-bucket estimate.
- **Large** is single-sample (NowInAndroid only) and lands at 123× — significantly higher than the v0.9 PR #13 measurement of 29× because the recursive walker now captures all 36 modules instead of 5. The v0.9 second large-bucket sample (`private-large-A`, 1,579×) is not re-measured in this run; it remains a private-toolkit reference.

## Feature: coverage

**Approach A baseline reused from v0.9 PR #13's `private-large-A` reference.** Reason: all six OSS projects in this run ship without the Kover plugin applied (`:<module>:koverXmlReport` does not exist as a task), so Approach A on the OSS sample captures only the gradle `task not found` error message (200–1,000 cl100k tokens). That is not a meaningful "cost an agent would pay to slurp coverage reports" baseline — the agent would never *get* coverage data. The v0.9 measurement on `private-large-A` (74 MB / 28.7 M cl100k tokens of kover XML) remains the canonical large-project ceiling for what coverage A actually costs when reports exist.

| Approach | cl100k_base | Source |
|----------|------------:|--------|
| A (`private-large-A` reference) | 28,686,309 | v0.9 PR #13 — `tools/runs/cross-model-results-coverage.txt` |
| B (small bucket median) | 153 | This run |
| B (medium bucket median) | 150 | This run |
| B (large bucket median, NowInAndroid) | 293 | This run |
| C (small bucket median) | 226 | This run |
| C (medium bucket median) | 225 | This run |
| C (large bucket median, NowInAndroid) | 336 | This run |
| **A:C (`private-large-A` → C-large)** | **85,376×** | Computed |

### Per-project coverage — B + C (OSS sample)

| Project              | Bucket  | A (error msg only) | B    | C    |
|----------------------|---------|-------------------:|-----:|-----:|
| KaMPKit              | small   |                206 |  153 |  226 |
| kotlinconf-app       | small   |                500 |  128 |  201 |
| kmp-production-sample| small   |                323 |  155 |  228 |
| PeopleInSpace        | medium  |                419 |  153 |  226 |
| Confetti             | medium  |                594 |  147 |  224 |
| NowInAndroid         | large   |              1,022 |  293 |  336 |

The OSS Approach-A column is published only as a curiosity: it captures the cost an agent pays to *discover* coverage is not configured. It is not a substitute for the `private-large-A` baseline above.

## Feature: info

`kmp-test info` is a global subcommand (no `--module-filter`). Output is dominated by the CLI scaffolding (banner, help text, project name), so cl100k counts are essentially constant across project sizes. Useful baseline: ~350 cl100k tokens for a structured project intel call, regardless of project bucket.

| Bucket | B median | C median | Sample |
|--------|---------:|---------:|--------|
| small  |      192 |      355 | 3      |
| medium |      190 |      354 | 2      |
| large  |      189 |      349 | 1      |

### Per-project info

| Project              | Bucket  | B    | C    |
|----------------------|---------|-----:|-----:|
| KaMPKit              | small   |  190 |  351 |
| kotlinconf-app       | small   |  192 |  355 |
| kmp-production-sample| small   |  192 |  355 |
| PeopleInSpace        | medium  |  190 |  351 |
| Confetti             | medium  |  193 |  357 |
| NowInAndroid         | large   |  189 |  349 |

## Feature: describe

`kmp-test describe` accepts `--module-filter` and emits per-module JSON. Output scales with module count (more modules → larger JSON). The C-column shows the agent-readable JSON cost; B is the human-readable markdown summary.

| Bucket | B median | C median | Sample |
|--------|---------:|---------:|--------|
| small  |      114 |      384 | 3      |
| medium |      245 |    1,083 | 2      |
| large  |      812 |    3,403 | 1      |

### Per-project describe

| Project              | Bucket  | Modules | B    | C     |
|----------------------|---------|--------:|-----:|------:|
| KaMPKit              | small   |       2 |  101 |   363 |
| kotlinconf-app       | small   |       5 |  220 |   679 |
| kmp-production-sample| small   |       2 |  114 |   384 |
| PeopleInSpace        | medium  |       7 |  198 |   819 |
| Confetti             | medium  |      16 |  291 | 1,347 |
| NowInAndroid         | large   |      36 |  812 | 3,403 |

C scales roughly linearly with module count (~90 cl100k per module).

## Skill loading cost (v0.10 #4)

`v0.10 #4` shipped the kmp-test-runner agent skill (`.skills/kmp-test-runner/`, conformant with the agentskills.io open standard) and the Claude Code Plugin packaging (`.claude-plugin/plugin.json`). The skill is the context-cost an agent pays *before* the first `kmp-test` invocation; the per-feature numbers above are what the agent pays *per call*.

| Component | cl100k_base | Load mode | Notes |
|-----------|------------:|-----------|-------|
| `SKILL.md` | 3,232 | **eager** (always on) | Entry-point auto-discovered by the host. Contains usage rules + flag overview + workflow index. |
| `references/cli/` (3 files) | 9,203 | lazy | Envelope schema (5,110) + exit codes + flags-reference matrix. |
| `references/workflows/` (7 files) | 22,570 | lazy | Deep-dives per subcommand (unit-tests, coverage, benchmarks, changed, instrumented dual-branch). |
| `references/troubleshooting/` (12 files) | 16,416 | lazy | One file per known failure code. |
| `scripts/` (4 files) | 2,174 | rarely loaded as text | `detect-env.{sh,ps1}` + `run-tests.{sh,ps1}`; executed, not read. |
| `.claude-plugin/plugin.json` | 255 | eager (Claude Code only) | Plugin manifest. Re-uses `.skills/` directly via `skills:[./.skills/]`. |
| **Total `.skills/` full load** (28 files) | **53,595** | worst-case | Agent reads everything; in practice agents read SKILL.md + 1-2 referenced deep-dives. |

### Comparison vs per-call savings

Once `SKILL.md` is loaded (one-time, 3,232 tokens), every subsequent `kmp-test` call dispatches via Approach C (JSON envelope), saving the per-call A:C ratio:

| Project (bucket) | First call: SKILL.md + C | First call: raw Approach A | Savings on call 1 | Break-even |
|------------------|-------------------------:|---------------------------:|-------------------:|------------|
| NowInAndroid (large) | 3,232 + 1,839 = 5,071 | 226,291 | 44.6× cheaper | immediate |
| Confetti (medium)    | 3,232 + 8,576 = 11,808 | 819,559 | 69.4× cheaper | immediate |
| KaMPKit (small)      | 3,232 + 338 = 3,570    |  34,536 |  9.7× cheaper | immediate |

The eager skill cost is amortized over the whole session — by the 2nd `kmp-test` call (and every call after) the agent is paying only the Approach-C envelope (300–9,000 cl100k depending on project size + feature) instead of the Approach-A baseline.

## Methodology notes

- **Recursive walker** (`tools/measure-token-cost.js#filterModulesByGlob`): introduced in this run. Walks the project root recursively, treating directories with `build.gradle.kts` as leaf modules and recursing into grouping dirs (no `build.gradle.kts`). Returns gradle-style colon-joined names (`app`, `core:analytics`). Max depth 6. Skips `build`, `node_modules`, `.gradle`, `.git`, `.idea`, `src`, `gradle`, `buildSrc`. Glob semantics: `*` matches within one path component; `**` matches across components. The v0.9 PR #13 walker was one-level-deep and undercounted Confetti (13 vs 16 actual) and NowInAndroid (5 vs 36 actual).
- **Per-project `moduleFilter` override**: `.measurement-projects.json` entries now accept an optional `moduleFilter` key that shadows the global `--module-filter` for that iteration only. Historical use case (no longer required after the recursive walker): force NowInAndroid to use `--module-filter "**"` to opt into the recursive enumeration.
- **Coverage A baseline**: not re-measured on the OSS sample (Kover plugin absent from all six). Reusing v0.9 PR #13's `private-large-A` capture (28.7 M cl100k → 77,114× A:C single-project) for the large-bucket A reference.
- **Skipped features**: `changed` and `benchmark` not re-measured in v0.10 — their envelopes did not change since v0.9 PR #13.

---

Generated by `tools/measure-token-cost.js --features parallel,coverage,info,describe` on 2026-05-18 (auto-numbers), then manually augmented with the per-project breakdown tables, the coverage A footnote, and the methodology section.

Per-project per-run captures (`per-project/<label>/<feature>/{A,B,C}-run-N.txt`) are gitignored (`.gitignore` line 26) — token counts above are reproducible from them but the raw captures stay on the measurement machine to keep the repo small.

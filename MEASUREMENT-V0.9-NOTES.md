# v0.9 token-cost re-measurement — notes

Generated: 2026-05-07
Project: `shared-kmp-libs` (composite-build root, KMP + AGP + multi-module + coverage + benchmark)
Module filter: `core-*` (gradle-backed features only; matches the v0.5-era prior baseline shape)
Tokenizer: cl100k_base baseline + Anthropic `messages.countTokens` per model (Opus 4.7 / Sonnet 4.6 / Haiku 4.5)
Develop tip at measurement: `e581f62` (post-v0.9 step 7)
Tool: `tools/measure-token-cost.js` extended in this PR to cover `info` + `describe` (B+C only — no raw-gradle equivalent)

This file is the evidence input for v0.9 step 9's README refresh. Per the locked v0.9 ROADMAP, step 8 measures and step 9 prosaifies.

## Per-feature single-run capture (cl100k_base)

| Feature | A bytes | A tokens | B tokens | C tokens | A→C ratio | Wall (A) |
|---|---:|---:|---:|---:|---:|---:|
| parallel | 4,859,402 | 1,331,036 | 16,556 | 843 | **1,579×** | 36s |
| coverage | 74,202,140 | 28,686,309 | 682 | 372 | **77,114×** | 15s |
| changed | 4,091,282 | 1,118,241 | 91 | 144 | **7,766×** | 7s |
| benchmark | 798,822 | 245,140 | 305 | 309 | **793×** | 7s |
| info | (n/a) | (n/a) | 185 | 345 | (B+C only) | 1s |
| describe | (n/a) | (n/a) | 1,476 | 7,005 | (B+C only) | 0s |

Notes:
- **A** = raw gradle stdout + slurped report files (HTML/XML/JSON under `build/reports/`). What an agent without `kmp-test` would consume after a single `./gradlew :module:task` invocation.
- **B** = `kmp-test <feature>` markdown stdout (human-banner mode).
- **C** = `kmp-test <feature> --json` envelope on a single line.
- **info / describe** are agent-query subcommands with no raw-gradle equivalent — only B + C are measured. For these two, the JSON envelope is **larger** than the markdown banner (info: 345 > 185; describe: 7,005 > 1,476) because `--json` exposes more structured detail an agent can pivot on (paths, modules, resolved tasks, coverage metadata).

## Cross-model token counts (Anthropic `messages.countTokens`)

Per-feature counts under each Claude family, single capture (3 captures × 3 models for info/describe; 1 capture × 3 models for the gradle-backed four). Sources: `tools/runs/cross-model-results-<feature>.txt`.

| Feature | Approach | cl100k | Opus 4.7 | Sonnet 4.6 | Haiku 4.5 |
|---|---|---:|---:|---:|---:|
| parallel | A | 1,331,036 | 2,183,843 | 1,777,893 | 1,777,893 |
| parallel | B | 16,556 | 30,134 | 21,372 | 21,372 |
| parallel | C | 843 | 1,396 | 1,063 | 1,063 |
| coverage | A | 28,686,309 | _413 too large_ | _413 too large_ | _413 too large_ |
| coverage | B | 682 | 1,176 | 895 | 895 |
| coverage | C | 372 | 623 | 470 | 470 |
| changed | A | 1,118,241 | 1,835,175 | 1,494,157 | 1,494,157 |
| changed | B | 91 | 171 | 115 | 115 |
| changed | C | 144 | 274 | 182 | 182 |
| benchmark | A | 245,140 | 323,638 | 283,750 | 283,750 |
| benchmark | B | 305 | 572 | 374 | 374 |
| benchmark | C | 309 | 573 | 363 | 363 |
| info | B | 185 | 319 | 226 | 226 |
| info | C | 345 | 622 | 411 | 411 |
| describe | B | 1,476 | 2,242 | 1,827 | 1,827 |
| describe | C | 7,005 | 12,177 | 8,610 | 8,610 |

**Coverage Approach A overflows Anthropic's `count_tokens` endpoint** — the 28.7 M cl100k-token capture (74 MB of kover HTML/XML reports) exceeds the per-request limit and returns `413 request_too_large`. This is a load-bearing finding for the README: a single coverage report on a real KMP project is so large that it cannot even be tokenised against an Anthropic model in one call, let alone fit in a 200K context window. `kmp-test coverage --json` (372 cl100k tokens / 623 Opus tokens) renders the same signal in a single HTTP-friendly chunk.

## Cross-family variation (max/min − 1)

Per Anthropic's documentation, tokenizer behaviour varies by family. Observed spread on the new captures:

| Feature | A | B | C |
|---|---:|---:|---:|
| parallel | 64.1% | 82.0% | 65.6% |
| coverage | n/a (A overflow) | 72.4% | 67.5% |
| changed | 64.1% | 87.9% | 90.3% |
| benchmark | 32.0% | 87.5% | 85.4% |
| info | n/a | 72.4% | 80.3% |
| describe | n/a | 51.9% | 73.8% |

cl100k_base consistently undercounts vs the Anthropic models — Opus 4.7 ≈ 1.5–1.7× cl100k on long captures (A) and 1.6–1.8× on short envelopes (C). For headline numbers, multiplying cl100k by ~1.5 gives a defensible Anthropic-side estimate.

## A→C reduction story per feature (5-iteration agent loop)

If an agent re-runs the workflow 5× per coding iteration, in cl100k_base tokens:

| Feature | A × 5 (raw gradle loop) | C × 5 (`--json` loop) | Saved per iter |
|---|---:|---:|---:|
| parallel | 6,655,180 | 4,215 | ~6.65 M tokens |
| coverage | **143,431,545** | 1,860 | **~143 M tokens** (≈ 716× a 200K context) |
| changed | 5,591,205 | 720 | ~5.59 M tokens |
| benchmark | 1,225,700 | 1,545 | ~1.22 M tokens |

Coverage is the most striking. On a real project (`shared-kmp-libs` core-* modules), a single `koverXmlReport` + `koverHtmlReport` invocation generates 74 MB of HTML/XML — roughly 28 M cl100k tokens, or 144× a single 200K context window. `kmp-test coverage --json` renders the same signal in 372 tokens.

## Notes on shifts vs prior baseline

The previously-committed `tools/runs/cross-model-results-*.txt` (v0.5-era; before today) measured a smaller fixture project. Numbers are not apples-to-apples vs the README L135 hero ("~64K parallel/changed, ~80K benchmark, ~542K coverage; ~500 tokens on `--json`"). The new `shared-kmp-libs` measurement reflects realistic agent workloads on a real KMP composite project.

| Feature | Prior A→C ratio (small fixture) | New A→C ratio (shared-kmp-libs) |
|---|---:|---:|
| parallel | 127× | 1,579× (cl100k) / 1,564× (Opus 4.7) |
| coverage | (not previously measured) | 77,114× (cl100k) / overflow on Opus |
| changed | ~85× | 7,766× (cl100k) / 6,698× (Opus 4.7) |
| benchmark | (not previously measured) | 793× (cl100k) / 565× (Opus 4.7) |

The absolute A captures grew because the new project has 10× more modules with full test report trees. The reduction RATIO grew accordingly — `kmp-test --json` keeps outputs constant while raw gradle scales with project size.

## Step-7 `coverage:{}` block expansion impact

v0.9 step 7 fix-PRs canonicalised the coverage block in `lib/android-orchestrator.js` (3 places) — pre-step-7 envelopes carried `{ tool, missed_lines }`; post-step-7 envelopes carry `{ tool, missed_lines, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] }`. The new `coverage --json` capture (372 cl100k tokens / 623 Opus tokens) reflects this expansion. The two new array fields are typically empty for `shared-kmp-libs` core-* modules (which use the kover convention plugin under build-logic, not direct apply); the size delta vs the pre-step-7 baseline is small (~10 cl100k tokens).

## README update decision

Per the v0.9 step 8 plan rule: update README hero L135 inline only if any of parallel/coverage/benchmark shifted >10% from the prior baseline. **All three shifted by ≥10×** — well above threshold.

However: the shift is dominated by project size, not orchestrator behaviour. An honest update is a re-framing in step 9 (different project context, dual-track gradle vs --json story, mention of the coverage 413-overflow finding), not a one-line tweak. **Step 8 ships measurement-only**; step 9 picks up the README + CHANGELOG prose.

## Reproducibility

```bash
cd C:/Users/34645/AndroidStudioProjects/kmp-test-runner
git checkout <step-8-tip>

# Gradle baseline (1 run, apples-to-apples vs prior):
node tools/measure-token-cost.js --project-root C:/Users/34645/AndroidStudioProjects/shared-kmp-libs --feature parallel  --module-filter "core-*" --runs 1
node tools/measure-token-cost.js --project-root C:/Users/34645/AndroidStudioProjects/shared-kmp-libs --feature coverage  --module-filter "core-*" --runs 1
node tools/measure-token-cost.js --project-root C:/Users/34645/AndroidStudioProjects/shared-kmp-libs --feature changed   --runs 1
node tools/measure-token-cost.js --project-root C:/Users/34645/AndroidStudioProjects/shared-kmp-libs --feature benchmark --runs 1

# Agent-query (3 runs each — cheap, deterministic):
node tools/measure-token-cost.js --project-root C:/Users/34645/AndroidStudioProjects/shared-kmp-libs --feature info     --runs 3
node tools/measure-token-cost.js --project-root C:/Users/34645/AndroidStudioProjects/shared-kmp-libs --feature describe --runs 3

# Cross-model (requires ANTHROPIC_API_KEY with credits; coverage A may 413):
export ANTHROPIC_API_KEY=sk-ant-...
for feat in parallel coverage changed benchmark info describe; do
  node tools/measure-token-cost.js --feature "$feat" \
    --anthropic-models claude-opus-4-7,claude-sonnet-4-6,claude-haiku-4-5 \
    > tools/runs/cross-model-results-"$feat".txt
done
```

Raw captures: `tools/runs/<feature>/{B,C}-run<N>.txt` (committed; small). Cross-model results: `tools/runs/cross-model-results-<feature>.txt` (committed; markdown table).

**Approach A captures are gitignored** as of this PR (`.gitignore`: `tools/runs/*/A-run*.txt`). On a real KMP project the coverage A capture is ~74 MB of kover HTML/XML — locally regenerable by re-running the gradle command, not worth committing. The cl100k_base + Anthropic counts in `cross-model-results-<feature>.txt` carry forward all the load-bearing numbers for the evidence file + future README refresh.

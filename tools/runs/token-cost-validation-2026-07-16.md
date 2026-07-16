# Token-cost evidence validation (2026-07-16)

Scope: command-output/token-cost evidence only. This validation did not run the
agentic end-to-end benchmark and did not perform final README/docs release
alignment.

## Inputs checked

- README headline table.
- `docs/token-cost-measurement.md`.
- `docs/agentic-usage-measurement.md`.
- `tools/measure-token-cost.js`.
- Committed evidence under `tools/runs/` referenced by README/docs.

## Trace results

| Published row | Evidence source | Result |
|---------------|-----------------|--------|
| `parallel`, small projects | `multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md`, "Feature: parallel" | README A median 24,454, C median 338, and 56.6x median A:C match the committed aggregate. |
| `parallel`, medium projects | Same aggregate, "Feature: parallel" | README A median 427,586, C median 4,499, and 90.0x median A:C match the committed aggregate. |
| `parallel`, large project | Same aggregate, NowInAndroid single-sample row | README A 226,291, C 1,839, and 123.1x A:C match the committed aggregate. |
| `coverage`, large configured composite | `cross-model-results-coverage.txt` | README/docs use the within-project `private-large-A` values: A 28,754,177, C 734, and 39,175x after rounding. |

The older `multi-project-token-cost-2026-05-18` aggregate contains a manually
augmented coverage note that mixes the `private-large-A` A value with the OSS
large-bucket C value. Current README/docs do not publish that cross-project
coverage ratio; they publish the same-project `private-large-A` ratio from
`cross-model-results-coverage.txt`.

## Current CLI smoke/refresh evidence

Fresh public-project measurements were also run with the current CLI/tooling on
2026-07-16. These are smoke/refresh checks, not a replacement for the historical
six-project matrix.

Tokenizer/API scope:

- Offline `cl100k_base` was used through `tools/measure-token-cost.js`.
- Anthropic `messages.countTokens` was approved and run on the fresh public
  NowInAndroid captures with `claude-opus-4-8`, `claude-sonnet-4-6`, and
  `claude-haiku-4-5`.
- OpenAI token-count API was not run because this repo has no OpenAI token-count
  API tooling; `cl100k_base` remains the OpenAI-compatible offline tokenizer.
- No private project capture was sent to any API.

### `parallel` large public smoke: NowInAndroid

Project: NowInAndroid public upstream clone, 36 modules detected by the current
recursive walker. Command shape:

```bash
node tools/measure-token-cost.js --project-root <public-nowinandroid-clone> \
  --feature parallel --module-filter "**" --test-task test --runs 1
```

Result selected for comparison: warm/report-populated rerun after Gradle and
Android SDK setup completed.

| Project | Scope | A raw Gradle + reports | B markdown | C JSON | A:C |
|---------|-------|-----------------------:|-----------:|-------:|----:|
| NowInAndroid | 36 modules, `parallel`, `--test-task test` | 234,046 | 1,383 | 2,013 | 116.3x |

Anthropic `messages.countTokens` was run on the same three public captures. No
chunking was needed; the largest capture was 811,849 bytes.

| Tokenizer/model | A raw Gradle + reports | B markdown | C JSON | A:C |
|-----------------|-----------------------:|-----------:|-------:|----:|
| `cl100k_base` | 234,046 | 1,383 | 2,013 | 116.3x |
| `claude-opus-4-8` | 409,813 | 2,271 | 3,325 | 123.3x |
| `claude-sonnet-4-6` | 319,579 | 1,741 | 2,402 | 133.0x |
| `claude-haiku-4-5` | 319,579 | 1,741 | 2,402 | 133.0x |

The first local run in the same temp clone produced A=131,842 / B=1,804 /
C=2,013, or 65.5x. That lower A value reflects local Gradle/report-state
sensitivity in Approach A: the helper reads generated report files under
`build/`, so the raw baseline changes as reports become populated. The warmed
rerun is closer to the historical committed NowInAndroid row
(A=226,291 / C=1,839 / 123.1x). Both fresh runs still show a large reduction,
and the warmed rerun supports keeping the README large-project headline
unchanged.

Raw public captures were retained only locally under the gitignored
`tools/runs/multi-project-token-cost-2026-07-16/per-project/NowInAndroid/parallel/`
shape.

### `parallel` small public smoke: KaMPKit app module

Project: KaMPKit public upstream clone. The current recursive walker detects
two modules (`app`, `shared`), but the shared KMP module does not expose the
generic `:shared:test` task shape that `tools/measure-token-cost.js` uses for
Approach A. The smoke therefore measures only the cheap `app` unit-test leg and
must not be treated as a replacement for the historical small-bucket median.

```bash
node tools/measure-token-cost.js --project-root <public-kampkit-clone> \
  --feature parallel --module-filter app --test-task test --runs 1
```

| Project | Scope | A raw Gradle + reports | B markdown | C JSON | A:C |
|---------|-------|-----------------------:|-----------:|-------:|----:|
| KaMPKit | `app` module only, `parallel`, `--test-task test` | 1,054 | 91 | 205 | 5.1x |

This validates that the current CLI/tooling still produces compact JSON on a
small public sample, but it is intentionally not used to update the README's
small-bucket headline.

Raw public captures were retained only locally under the gitignored
`tools/runs/multi-project-token-cost-2026-07-16/per-project/KaMPKit-app/parallel/`
shape.

## What was not run

- No fresh full multi-project Gradle matrix was run. The local gitignored
  `tools/.measurement-projects.json` config and per-project raw captures were
  not present in this checkout. The fresh smoke measurements above were run
  instead.
- No private raw captures were committed or regenerated.
- No OpenAI token-count API was called because the repo has no supported OpenAI
  token-count API path.
- No agentic end-to-end benchmark was run.

## Measurement decision

Existing evidence remains release-valid for the current README headline table.
The fresh NowInAndroid smoke supports keeping the large-project `parallel`
headline unchanged. Recent work on `develop` affects diagnostics, cache
invalidation, failure classification, dry-run behavior, and docs structure. It
does not materially change the successful `parallel` or `coverage`
command-output shapes used by the published ratios.

The next meaningful measurement expansion would be a wider public-project
sample or adding first-class OpenAI token-count support to the measurement
tool. Neither is required to keep the current release headline values
traceable.

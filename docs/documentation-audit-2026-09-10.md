# Documentation audit — 2026-09-10

## Scope

The audit reviewed the complete tracked documentation surface against `origin/develop` at `6056b81f`: root Markdown, `docs/`, `.github` templates, `.skills/kmp-test-runner`, `tools/README.md`, `tools/agentic-eval/README.md`, and dated reports under `tools/runs/`. The starting inventory contained **84 tracked Markdown files**. Executable `--help`, workflow/configuration files, schemas, and the six accepted Evidence1 records were also inspected as implementation sources of truth; they are not counted as documentation files.

The review used executable help, parser constants, Gradle plugin sources, schema registries, workflow files, required-check configuration, and the six accepted Evidence1 records as sources of truth.

## Coverage ledger

This is the complete Markdown inventory from the audited base, grouped so that unchanged files are visible rather than silently omitted from the report.

| Surface at `6056b81f` | Files | Audit treatment |
|---|---:|---|
| `.github/**/*.md` | 3 | PR template corrected; bug and feature templates retained after current-workflow review. |
| `.skills/kmp-test-runner/**/*.md` | 24 | Canonical workflow and references checked against parser/help contracts; two drifted references corrected. |
| Root `*.md` | 8 | README, BACKLOG, PRODUCT, CONTRIBUTING, and CLAUDE reworked; CHANGELOG updated; Code of Conduct and Security policy retained. |
| `docs/**/*.md` | 22 | Current references checked against code; audits classified; eight unrelated testing-pattern pages removed; local CI retained. |
| `tests/fixtures/**/README.md` | 2 | Checked against their fixture trees and retained unchanged. |
| `tools/README.md` and `tools/agentic-eval/README.md` | 2 | Rewritten against the current tools, commands, profiles, and schemas. |
| `tools/runs/**/*.md` | 23 | Classified as dated evidence; local links checked and seven broken targets corrected where required. |
| **Total** | **84** | Every tracked Markdown file is covered by one row above. |

Historical documents were not rewritten to pretend that old plans or measurements are current. Searches for the known stale claims were repeated with `CHANGELOG.md`, `docs/history/`, `docs/audits/`, and `tools/runs/` excluded; no live reference still presents those claims as current behavior.

## Line accounting and deletion review

Line count is not an acceptance criterion, but a large reduction deserves an explicit account. The complete diff is **8,763 additions and 9,736 deletions: net -973 lines**, not a net removal of the documentation added by this work.

| Apparent removal | Disposition |
|---|---|
| 3,715 deleted lines from root `BACKLOG.md` | The decision ledger is preserved as a 3,737-line dated archive in `docs/history/BACKLOG-through-2026-09-10.md`; the root file is now a 49-line active queue. |
| 1,408 deleted lines in eight `docs/testing/testing-*` pages | Removed after file-by-file review because they document ViewModels, StateFlow, coroutine dispatchers, and app-layer fakes that do not exist in this Node/Gradle product. Repository-specific `docs/testing/local-ci.md` remains. |
| 757 README deletions | Duplicate flag tables, plugin internals, detailed measurement methodology, and release-history prose were replaced by a 183-line entry point linking to canonical reference documents. |
| 843 deletions from `docs/agentic-usage-measurement.md` | The stale monolith is now a compatibility pointer. Current methodology, execution, Windows preparation, live operation, and results are separated under `docs/metrics.md` and `docs/evaluation/`. |
| 2,160 deletions from `tools/agentic-eval/README.md` | Chronological PR narratives, obsolete future-state claims, and duplicated schemas were removed. The remaining technical reference describes the implemented harness and links to the versioned operator assets. |
| 3,244 additions under the new Evidence1 run directory | Six sanitized records, six matching accepted-run sidecars, and their result manifest; raw transcripts and custody secrets are deliberately excluded. |

The old monolith text remains recoverable in Git history. It was not copied wholesale into `docs/history/` because doing so would preserve known-false operational instructions inside the searchable documentation tree. The backlog is the exception: it contains project decisions that remain useful as a dated ledger and was therefore archived intact.

## Classification

| Class | Policy | Examples |
|---|---|---|
| Current public reference | Must match implementation and pass link/drift checks | README, `docs/README.md`, CLI, installation, usage, plugin, envelope, metrics |
| Current maintainer/operator reference | Must match repository workflows and scripts | CONTRIBUTING, CLAUDE, `tools/README.md`, local CI, `docs/evaluation/` |
| Strategic/current queue | Concise, no released-history duplication | PRODUCT, BACKLOG |
| Historical audit/evidence | Point-in-time record; keep provenance and label status | `docs/audits/`, dated `tools/runs/`, archived backlog |
| Unrelated inherited material | Remove from this product repository | generic ViewModel/StateFlow/testing-pattern pages |

## Material findings and resolution

| Finding | Resolution |
|---|---|
| README was 843 lines and duplicated metrics, flags, plugin details, and agentic operations | Replaced with a short onboarding/command/platform/summary surface; details moved to canonical docs. |
| README documented JS/Wasm as model-only and omitted `clean` | Corrected platform and command surface; executable help updated too. |
| CLI `--max-workers`, coverage report path, benchmark config, and Gradle plugin behavior were described incorrectly | Canonical CLI/plugin/usage docs now state code-backed defaults and boundaries. |
| Parser parity forced every flag into README | Test now targets `docs/cli-reference.md`, allowing README to remain readable. |
| Evidence1 docs said one-cell live and `sandboxed-unrestricted-v1` were unimplemented | Current evaluation docs and CLI help now reflect the registered/implemented paths. |
| Schema docs stopped at run 6 / audit 3 or hard-coded schema 5 analysis | Current references state run latest 8/support 1–8, audit latest 10/support 1–10, analysis schema 9. |
| Six final live sessions had no public evidence package | Added sanitized records, matching sidecars, result manifest, and metrics report. |
| No public ISO-to-canary guide existed | Added Windows setup and live runbook, including official sources and the manual provisioning limitation. |
| CONTRIBUTING/template described the retired release PR and seven checks | Updated to release-bot fast-forward and `.github/required-checks.json` as canonical ten-check source. |
| PRODUCT embedded old metrics and per-PR macOS assumptions | Reduced to stable product/evidence principles with links to current measurements. |
| CLAUDE mixed dated release notes, old paths/counts, and current operating rules | Rewritten as a concise current repository guide while preserving version-sync anchors. |
| BACKLOG mixed thousands of lines of released history with live work | Historical ledger archived; root backlog now contains only active, unassigned, and parked work. |
| `docs/testing/` described ViewModels, StateFlow, use cases, and app-layer patterns unrelated to this Node/Gradle tool | Removed eight inherited pages; retained repository-specific local CI documentation. |
| Tools docs called the implemented eval harness “foundation only” and used an obsolete `--project` flag | Rewritten around current tools and `--project-root`. |
| Seven local links were broken | Corrected paths in dated reports; the unrelated broken coverage-pattern page was removed with that inherited set. |
| Independent reader testing found non-executable Evidence1 examples | Added the required isolation attestation, exact V2/V3 parameter names and unique report paths, bounded elevated-runner commands, and the current coverage help path. |
| Bucket A/C medians could be mistaken for a same-project pair | Current metrics now publish the median of per-project same-capture ratios and explicitly prohibit recombining independent A/C medians. |

## Evidence1 conclusion

The 2026-09-10 operational objective is closed: three consecutive product canaries and three consecutive free-baseline canaries produced six accepted, validated records. The prepared VM path is repeatable.

The stronger claim “a new maintainer can create Evidence1 automatically from an ISO” is not true yet. The repository lacks a VM/ISO provisioner and current scripts bind fixed environment details. That gap is now documented and tracked separately instead of being hidden in ambiguous runbook prose.

## Historical documents

Historical records can contain old versions, test counts, planned states, or rejected decisions that were correct in context. They were audited for classification and critical broken links, not rewritten to simulate present-day reference material. The historical Claude/Codex plan received a status banner because its original “implementation not started” statement was especially likely to mislead current readers.

## Ongoing guards

- CLI flag parity reads `docs/cli-reference.md`.
- Required checks come from `.github/required-checks.json`.
- Version sync checks README/CLAUDE/plugin/package surfaces.
- Evaluation records are validated with matching sidecars.
- Decouple/privacy and line-ending gates remain mandatory.
- Local links across root docs, `docs/` (including audits/history), the packaged skill, and versioned run reports are covered by a repository test.
- Executable help and Evidence1 copy/paste contracts have focused drift tests.

Future doc changes should update one canonical source and link to it. Dated evidence should remain immutable unless a correction note is required.

# Documentation-to-code audit — 2026-09-10

> Status: **complete for the current Claude-backed implementation**. This is the audit ledger for
> the documentation closure based on
> `origin/develop` commit `6056b81f674799eb4066caf7eb5acfc878737177`. A row is not complete
> until its replacement text, implementation source, links, and relevant executable examples
> have been verified. The Codex runtime is being validated separately and is intentionally not
> documented as available here until that work lands on `develop`.

## Objective

Bring every maintained documentation surface into agreement with the current implementation
without turning the root README into either a changelog or a link-only hub. Preserve useful
installation, usage, output, troubleshooting, platform, Gradle plugin, CI, agent, and contribution
material. Move depth only when the destination is a complete, discoverable reference.

## Acceptance rules

- The root README remains a self-contained professional entry point: value, defensible evidence,
  requirements, installation, first run, supported platforms, main commands, representative
  human/JSON output, core configuration, Gradle usage, CI, troubleshooting, and project links.
- Detailed flag tables, measurement methodology, Evidence1 operations, and full schema contracts
  may live in dedicated documents, but the README must summarize them meaningfully.
- Every present-tense behavior must trace to code, executable help, a schema/registry, a workflow,
  or accepted evidence.
- Historical plans and results remain historical. They must not be silently rewritten as current
  behavior, and current references must not treat them as implementation contracts.
- A documented but absent capability becomes either an explicit implementation-gap candidate or a
  corrected claim. It is never silently erased.
- Future distribution promises stay out of the README. Unimplemented work is tracked in
  `BACKLOG.md` without assigning a milestone on the maintainer's behalf.
- Metric ratios use the same project/capture for numerator and denominator, or clearly state that
  they are the median of per-project same-capture ratios.
- Evidence1/Codex/Claude results remain descriptive unless their records are benchmark-eligible.
- No credentials, private paths, raw authenticated output, prompts, responses, VM state, or custody
  bundles enter public documentation.

## Surface inventory and treatment

| Surface | Required treatment | Status |
|---|---|---|
| `README.md` | Rebuild from the restored full README; preserve reader-critical content and remove duplication only after complete destinations exist | Complete |
| `CHANGELOG.md` | Retain as the sole release-history narrative; add only shipped behavior/evidence | Complete for current code/evidence; Codex deferred |
| `BACKLOG.md` | Keep active/parked gaps discoverable; do not rewrite historical decisions during this pass | Complete |
| `CONTRIBUTING.md` | Verify gitflow, release automation, required checks, tests, and commands | Complete |
| `CLAUDE.md` | Separate current operational rules from old release-state narrative | Complete |
| `PRODUCT.md` | Keep stable product intent; remove stale measurements and workflow mechanics | Complete |
| `.github/*.md` | Verify templates against the current required-check and release contracts | Complete |
| `.skills/kmp-test-runner/**/*.md` | Verify packaged instructions against parser/help/runtime behavior | Complete |
| `docs/**/*.md` | Classify as current reference, operator runbook, historical audit, consumer example, or obsolete/unrelated | Complete |
| `tools/README.md` | Update the real tool inventory and public/private artifact boundaries | Complete |
| `tools/agentic-eval/README.md` | Preserve technical depth; reconcile current Claude profiles, schemas, analysis and canary operation; keep Codex unavailable until its implementation lands | Complete for current runtime; Codex deferred |
| `tools/runs/**/*.md` | Preserve dated evidence; fix broken links and add correction notes instead of rewriting results | Complete |
| `tests/fixtures/**/README.md` | Verify against fixture trees and supported target names | Complete |

### Removed imported testing-pattern documents

The following files were removed during this audit because they were imported generic/private
KMP testing guidance, not documentation for `kmp-test-runner`:

- `docs/testing/testing-hub.md`
- `docs/testing/testing-patterns.md`
- `docs/testing/testing-patterns-benchmarks.md`
- `docs/testing/testing-patterns-coroutines.md`
- `docs/testing/testing-patterns-coverage.md`
- `docs/testing/testing-patterns-dispatcher-scopes.md`
- `docs/testing/testing-patterns-fakes.md`
- `docs/testing/testing-patterns-schedulers.md`

They documented unrelated ViewModel, coroutine, scheduler, snapshot-repository, DAW-state, Koin,
and private convention-plugin examples. They contained no `kmp-test-runner`, Vitest, Bats,
Pester, fixture, or local-CI operating contract, and one linked to a nonexistent
`gradle-patterns.md`. This is removal of imported content outside the product's scope, not
editorial compaction of valid project documentation. The files remain recoverable from Git
history. `docs/testing/local-ci.md` is product-specific and is deliberately preserved.

## Confirmed documentation drift

### README and CLI

| Claim or omission | Implementation truth | Resolution |
|---|---|---|
| JS/Wasm described as model-only and dispatch deferred | `parallel --test-type js|wasm` is implemented and validated by the CLI contract | Update platform/usage sections |
| `--max-workers` default shown as `4` | CLI default is `0` (Gradle auto); `4` is the Gradle extension default | Separate CLI and Gradle defaults |
| Coverage default output shown as `coverage-full-report.md` | Default is `.kmp-test-runner/reports/coverage/<runId>.md` plus `latest.md` | Correct reference and examples |
| `--exclude-coverage` described as accepting globs | Current implementation accepts exact colonless module names | Correct claim; record glob support only if maintainer wants the feature |
| Benchmark test filtering described generically | Android benchmark supports it; unsupported JVM benchmark legs are skipped with `test_filter_unsupported` | State the real boundary |
| `clean` omitted from the main subcommand table/help list | `kmp-test clean` exists with dry-run/all/JSON behavior | Add it to discovery surfaces |
| JSON examples use old product versions and omit current schema fields | Current envelope schema is version 2 and examples must match producers | Regenerate sanitized examples from tests/current CLI |
| Multi-project measurement config advertises per-project `moduleFilter` | `resolveProjectOpts()` accepts it, but `validateProjectEntry()` drops it while parsing project-list JSON | Record as tooling debt; fix before refreshing the public matrix |
| Multi-project capture output is keyed only by date | Two captures on the same day can target the same output directory | Record collision-resistant/operator-selected capture identity as tooling debt |
| `benchmark` shares ADB ambiguity error codes with instrumented paths | Its parser does not accept `--device`, so a multi-device host cannot select the intended target | Record explicit benchmark device selection as implementation debt; do not document the flag as available |
| Runner said to configure consumer `maxParallelForks` and task-isolation defaults | The product coordinates concurrent invocations with a project lock; isolated Gradle caches are opt-in | Replace the false claim; assess desired product gap separately |
| Android CLI comparison tied to an old version and “no testing” | External command surface is version-dependent and has evolved | Keep only a dated, sourced comparison or remove it from the timeless README |
| Test-suite totals embedded in contributor-facing prose | Counts change frequently and are not contracts | Replace with test commands and required outcomes |
| Windows offline example uses `.\install.ps1` from the repository root | Repository path is `.\scripts\install.ps1` | Correct example |
| `update --force` documented as an equal-version reinstall | The global parser consumed the flag before `commands/update.js`, which failed to pass it to the update orchestrator | Repair the dispatch boundary and add a regression test |
| `update --dry-run` implied safe by the “global options” table | The command ignored the consumed flag and could continue into installation | Reject it with `unknown_flag` before network/install work; direct users to `update --check` |
| JDK resolution placed `--java-home` ahead of project `org.gradle.java.home` | A valid project property is authoritative to Gradle and short-circuits environment selection | Correct README and usage reference |
| Successful README envelope had two passed tasks but an empty `parallel.legs[]` and no `modules_contributing` | Schema-2 successful parallel runs report their leg and complete coverage accounting | Replace it with an internally coherent schema-2 example and executable drift guard |

### Gradle plugin

| Claim or omission | Implementation truth | Resolution |
|---|---|---|
| Tasks described as dispatching platform shell scripts | `RuntimeExtractor` extracts the bundled Node runtime and tasks invoke it | Rewrite architecture/task table |
| `CrossShapeParityTest` described as a current guard | That test no longer exists | Reference the actual parity/static tests |
| “No behavioral difference” between CLI and plugin | The plugin intentionally exposes a subset of CLI options | Document supported surface; audit missing options as deliberate vs gap |
| `captureOnFail` and `captureDir` omitted | Both extension properties are implemented | Add to DSL reference |
| `testType` list omits JVM/JS/Wasm values | CLI accepts the complete test-type enum; the plugin forwards its value | Publish the verified enum and boundary |
| Gradle 8+ stated as minimum | Plugin enforces Gradle 7.6+ and uses a JDK 17 toolchain | Correct requirements and distinguish consumer/toolchain requirements |
| Node omitted from plugin runtime requirements | Plugin tasks invoke the bundled JavaScript runner through Node | Document requirement |

### Agentic evaluation and Evidence1

| Claim or omission | Implementation truth | Resolution |
|---|---|---|
| Current docs call the harness “foundation only” and say no results exist | Scenario campaigns, accepted runs, aggregation, analysis, and dated evidence exist | Separate current reference from historical implementation narrative |
| `sandboxed-unrestricted-v1` described as proposed | Profile is registered and implemented for Claude, with mandatory external-isolation attestation | Correct after preserving the isolation limitation |
| One-cell canaries described as unsupported | Product/free-baseline canary paths are implemented | Correct runbook/help together |
| Run/audit/analysis schema versions copied as old constants | Code currently supports newer schema ranges | Generate/reference constants from code and add drift tests |
| No public ISO-to-canary guide | Evidence1 assumes an existing Windows Hyper-V VM and local authentication | Document reproducible manual preparation; track automation separately |
| Evidence1 implied to be generally portable | Harness is portable; Evidence1 orchestration depends on Windows Hyper-V and PowerShell Direct | State the two-layer platform matrix explicitly |
| Claude/Codex v1 plan reads as current unimplemented design | Claude side is implemented; Codex is being validated in a separate functional change | Add historical/partial status after Codex outcome is known |
| Latest six canary records are not published | Three product and three free-baseline accepted records exist locally | Publish only validated, sanitized records and sidecars after privacy gates |

### Metrics

| Metric | Evidence status | Publication rule |
|---|---|---|
| Small public `parallel`: 56.6x | Historical 2026-05-18, `n=3`, range 1.3x–102.2x | Keep dated in metrics reference; do not headline until refreshed |
| Medium public `parallel`: 90.0x | Historical 2026-05-18, `n=2`, range 84.4x–95.6x | Keep dated in metrics reference; do not headline until refreshed |
| Large public `parallel`: 123.1x | Historical point; July reruns produced 116.3x and 116.7x | README may state an explicitly dated approximate 116x–123x range |
| Configured composite `coverage`: 39,175x | Valid same-capture stress ceiling dominated by roughly 74 MB of Kover HTML/XML | Never present as typical; retain as dated anonymized stress case |
| Evidence1 product/free canaries | Accepted operational evidence, `benchmark_eligible:false` | Publish descriptive outcomes only; no causal or universal performance claim |
| Codex runtime/results | Separate validation is in progress | Do not add support or measurements until merged evidence exists |

## Confirmed implementation-gap candidates

These are not automatically approved features. They remain unassigned until the maintainer decides
whether the documented expectation should become product behavior.

| Candidate | Why it surfaced | Current disposition |
|---|---|---|
| Coverage exclusion globs | README promised globs; implementation accepts exact module names | Needs product-vs-doc decision |
| Consumer parallelism/isolation automation | README overstated automatic `maxParallelForks`/task isolation | Replace claim now; assess feature separately |
| Gradle plugin option parity | README implied full CLI parity; extension exposes a deliberate subset | Complete parity audit, then backlog only material omissions |
| Evidence1 clean-room provisioner | Current scripts operate an already-prepared VM and contain fixed local assumptions | Document manual path; parameterization/provider work remains functional scope |
| Evidence1 non-Hyper-V backend | macOS can run the harness but cannot run the current Evidence1 orchestration | Future provider abstraction; not part of this docs change |
| Maven Central publication | GitHub Packages is the only Gradle distribution | Parked in backlog; removed from README promises |
| Skill/plugin marketplace listing | Repository install works; marketplace distribution does not exist | Parked in backlog; removed from README promises |

## Verification plan

1. Cross-check every current reference against executable help, parsers, schemas, registries,
   Gradle extension/task code, workflows, and required-check configuration.
2. Run all documentation link and parity checks; add focused drift guards where a stable contract
   can be checked automatically.
3. Re-run the public token-cost matrix with pinned public project commits and three repetitions per
   A/B/C approach before promoting small/medium values to current README evidence.
4. Import Codex support/results only after its functional change is merged into `develop`.
5. Validate and privacy-audit every Evidence1 record/sidecar selected for publication.
6. Run the full repository suite required for a documentation-plus-contract change.
7. Ask fresh reader agents to answer installation, platform, command, JSON, metrics, Gradle, and
   Evidence1 questions using only the finished documentation; fix every ambiguity they expose.

## Completion record

The current-code documentation scope is complete. Codex runtime support and Codex measurements are
not part of this completion claim: they remain blocked from present-tense documentation until the
separate functional change and accepted evidence land on `develop`.

Delivered and independently reviewed:

- a self-contained root README with product value, defensible metrics, requirements, installation,
  first use, platform/command coverage, human and schema-2 output, configuration, Gradle plugin,
  CI, troubleshooting, agent skill, and Evidence1 boundaries;
- dedicated installation, usage, CLI, Gradle plugin, metrics, and evaluation/operator references;
- a full documentation-to-code pass across governance, packaged skill, tool, fixture, run, security,
  contribution, product, and historical measurement surfaces;
- six sanitized Evidence1 accepted-run records plus matching sidecars (three Product and three
  FreeBaseline), all explicitly `benchmark_eligible:false` and excluded from analyzer aggregates;
- backlog entries for genuine unimplemented distribution, portability, measurement, and command
  gaps rather than README promises;
- removal only of eight imported generic/private KMP testing-pattern documents outside this
  product's scope; product-specific local-CI guidance remains.

The audit also found two real CLI defects rather than papering over them: `update --force` lost its
meaning at the command boundary, and `update --dry-run` could be silently ignored. Both now have
regression coverage; `--force` is forwarded and the unsupported dry run is rejected before probing
or installing.

Verification completed from the committed tree:

- full Vitest suite with Windows-safe worker concurrency: **137 files passed; 7,491 tests passed;
  3 skipped; 0 failed**;
- Gradle plugin/TestKit task: `BUILD SUCCESSFUL` (subsequent confirmation was fully up to date);
- CLI/docs/skill parity, schema snapshots, documentation links, README-envelope coherence, and
  Evidence1 metric recomputation are included in that suite;
- all six Evidence1 records and accepted-run sidecars validate with zero errors/warnings; analysis
  schema 9 sees six files and excludes all six as `benchmark_eligible:false`, as intended;
- corpus definitions and trigger queries validate; version pins, required-check manifest (10
  contexts), LF policy (590 files), decouple/privacy scan (1,056 files), and plugin manifest all
  pass;
- two independent final readers rechecked user flows and recomputed the published Evidence1 table;
  every material discrepancy they found was corrected before this completion record.

Line-count reduction by itself was not used as an acceptance signal.

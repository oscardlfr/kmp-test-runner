# Backlog

> Current decision queue for `kmp-test-runner`, reviewed 2026-10-08. No item below is assigned to a future version until the maintainer decides. Completed work and the original planning record are preserved in [backlog history](backlog-history-through-evidence6.md). `AGENTS.md` owns development rules; [PRODUCT.md](PRODUCT.md) owns product principles.

## Verified campaign baseline

Evidence4, Evidence5 revised4 and Evidence6 completed their preregistered campaigns, independent controls and reports. Compile diagnostics, current-run per-module coverage, `changed --base` with dependents, block merge/custody and publication were delivered. Earlier failed or excluded attempts remain disclosed. See the [benchmark report](docs/agentic-benchmark.md) and the three records: [Evidence4](tools/runs/evidence4-agentic-benchmark-2026-10-07/README.md), [Evidence5](tools/runs/evidence5-agentic-benchmark-2026-10-08/README.md), [Evidence6](tools/runs/evidence6-agentic-benchmark-2026-10-08/README.md). Exact multi-module selection was delivered by [PR #576](https://github.com/oscardlfr/kmp-test-runner/pull/576): the Evidence6 fixture now dispatches exactly 11 requested modules, while the legacy glob selects 14. Configurable runner-owned output via `--output-dir` / `KMP_TEST_OUTPUT_DIR` is also implemented. The [original parked plan](backlog-history-through-evidence6.md) is historical, not open work.

## Product candidates

| Priority | Candidate | Completion criterion |
| --- | --- | --- |
| Unassigned | **Typed early failures** for an invalid `--java-home` and a thrown coverage project-model build. | Return distinct configuration/environment diagnostics before or instead of a misleading `module_failed` or `no_coverage_data`; preserve the JSON envelope and exit-code contract. |

The benchmark's **factual correctness and product-protocol success are separate measures**. Evidence4/5/6 suggest reviewing agent workflow clarity as well as CLI behavior; a strict protocol miss alone does not prove a production parser defect.

## Canary and evaluation-harness candidates

| Priority | Candidate | Completion criterion |
| --- | --- | --- |
| 1 | **Preflight clone-path and environment bounds.** Evidence5 lost an excluded canary before inference to a Windows path-length limit. | Compute the longest expected clone/work/output path before VM launch and fail with a specific reason when it exceeds the supported bound; test short and long roots without consuming a live cell. Keep the previously shipped long-path materializer fix separate. |
| 2 | **Unambiguous block verdict.** `Closed PASS` proves safe operational closure, while `EvidenceCopied.detail.eligibility` may still be `FAIL`. | Show both states in the top-level gate and prevent the next block or analysis merge unless the authoritative promotion receipt satisfies the frozen rule. Exercise accepted, pre-inference rejection, missing usage and transport-loss cases with fake runtimes before a live canary. |
| 3 | **Failure custody.** A rejected or interrupted cell can lack an after-session state listing or its in-flight raw journal. | Add the already proposed guest directory-listing and journal-copy capability; hash/verify raw stdout as well as record/audit pairs; explicitly mark unrecoverable evidence. Never replay a LiveRunning ID or infer a clean state from absent evidence. |
| 4 | **Cross-host reproducibility.** The broker install location and host/guest roots are literals, and the Codex provisioning pin trails the launch version. | Use admin-owned install configuration with separate host and guest resolved paths, audit the published scripts for host-specific literals, and add a deterministic approved-inputs builder/profile matching the launch-pinned Codex CLI. Preserve the broker's trust boundary. |

Additional harness work still open: batch-level mixed-profile rejection diagnostics, the macOS coverage-budget failure audit, file-read delivery of a product envelope to the grader, command-classifier basename handling, and the smaller receipt observability items. Their original evidence and constraints are in the [historical entries](backlog-history-through-evidence6.md). Cost estimation that fails closed on missing priced usage and fail-fast containment after transport loss were already implemented; they are regression contracts, not new tasks.

## Release, CI and measurement follow-ups

- **CI on `main` duplicates a full run after release.** Decide whether to remove the push trigger only after confirming the desired main-branch status-history and release-gate behavior. This is a maintainer policy choice.
- **Release-gate diagnostics/tests:** assert every caller's `--timeout-minutes`, including a future second call; list existing but still-waiting contexts in timeout errors; verify the `squash_merge_commit_title=PR_TITLE` setting only from a proven sufficiently privileged push context.
- **Entrypoint guards:** six Node tools still compare raw paths against `import.meta.url`; use a realpath-aware check and test symlinked entrypoints so required privacy/line-ending and release checks cannot silently skip their main function.
- **Measurement registry:** consider a row-level validity/status field before dashboards or automated aggregates, and a lightweight CI validator when registry traffic warrants it. A Sonnet 5 retokenization of private captures remains a separate explicitly approved privacy-sensitive session, not routine backlog cleanup.
- **Small maintenance:** decide whether to reuse or remove the unused per-evidence README block renderer. Keep historical campaign SVGs and their provenance intact.

## Parked or adoption-triggered

- **Native Journey integration:** the optional Windows workflow was exercised in [PR #577](https://github.com/oscardlfr/kmp-test-runner/pull/577) on two projects with separate Gradle and Journey verdicts; a later local physical-device `--device` smoke also passed. These runs showed no repeated APK-discovery or serial-handoff failure needing another runner command. Reopen product integration only for repeated project-independent friction or a supported unattended Android CLI/agent invocation that pins one serial, returns a documented machine-readable per-action verdict and evidence paths, and defines aggregate exit semantics. Keep Android CLI optional. Remote physical devices remain unverified and require a billed Google Cloud project; assess them only after explicit authorization for a real run.
- **Maven Central for the Gradle plugin:** revisit when the maintainer has the publishing account and signing setup. GitHub Packages remains the current distribution route.
- **Documentation structure:** a README split is distinct from a hosted VitePress/MkDocs site. Reassess the split against current content; consider a site when navigation justifies maintenance. The README is 865 lines at this review, below the previously proposed 1,500-line site trigger.
- **KotlinConf research ideas** (MCP/ACP adapter, Amper detection, new-project fixture and cross-tool patterns) and post-v1 agent integrations remain exploratory; validate user demand and platform contracts before assigning a release.
- **macOS/iOS TestKit coverage:** use the manual validation gate and minimal per-PR macOS CI budget. The historical proposal to add a heavy required macOS matrix was dropped and is not reopened here.

## Archive and upkeep

The [history](backlog-history-through-evidence6.md) contains completed releases, old queue snapshots, abandoned hypotheses and detailed evidence. Do not treat its historical "PARKED", "QUEUED" or "IN PROGRESS" labels as current status. Move an item into this current queue only after checking its code/docs state and stating a concrete remaining acceptance criterion. Remove completed items from this queue after verified delivery; retain their provenance in the release notes, PR or history.

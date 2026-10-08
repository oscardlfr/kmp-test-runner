# Evidence6: compile failure and unrun dependents in NowInAndroid

Evidence6 ran on 2026-10-08 under a protocol frozen before primary inference. A one-line repository edit breaks Kotlin compilation in `:core:data`. Agents were asked to run the in-scope host tests, identify the root compile task and diagnostic, and distinguish tests that ran from dependent modules that could not run. The product arm had `kmp-test` and its Agent Skill; the free arm used Gradle without them.

**Scope:** one pinned NowInAndroid checkout, one Windows VM, two agent runtimes and one scenario. These descriptive results do not establish a general or causal product effect.

## Result

| Runtime | Arm | Scheduled | Counted | Correct key facts | Product protocol success |
|---|---|---:|---:|---:|---:|
| Claude Code (`claude-sonnet-5`) | with kmp-test | 8 | 8 | 8/8 | 0/8 |
| Claude Code (`claude-sonnet-5`) | without | 8 | 8 | 6/8 | not applicable |
| Codex CLI (`gpt-5.6-terra`) | with kmp-test | 8 | 8 | 8/8 | 0/8 |
| Codex CLI (`gpt-5.6-terra`) | without | 8 | 8 | 8/8 | not applicable |

All **32 scheduled positions were accepted and counted**. The infra-only sensitivity analysis excludes zero cells and matches the primary result. Factual correctness is distinct from the frozen product protocol requirement: neither product runtime met that stricter requirement in any session. Codex product runs used the public substring `--module-filter`, which selected 14 modules instead of the prescribed exact 11; Claude product runs lacked or mismatched the required executed envelope. These are observed protocol failures, not grounds to change the grader or replay cells.

The pinned ground truth is `:core:data:compileDemoDebugKotlin` failing on line 47 with unresolved `asExternalModels`; 33 independent test methods passed, none failed, and five selected dependent modules could not run because compilation failed. The key-facts metric checks root attribution and the unrun distinction. Product protocol success additionally requires the exact current-run product workflow.

![Evidence6 scorecard](scorecard.svg)

![Evidence6 metrics grid](metrics-grid.svg)

![Evidence6 estimated API cost components](cost-breakdown.svg)

The [detailed benchmark document](../../../docs/agentic-benchmark.md#evidence6-2026-10-08-compile-failure-and-unrun-dependents) gives session-level and component results. Interpret medians within each runtime and this task.

## Design and provenance

- The operative protocol froze at 2026-10-08T01:20:57.277Z, SHA-256 `b38f2105a7c376569071cf8df15538d2666357904d02d08ced99c2a8bf9b294a`. The [public protocol summary](preregistration.md) states its scoring and stop controls. An excluded four-cell canary preceded the primary blocks.
- Four sequential eight-position blocks used IDs `b0d9cd76-e0a1-4092-8580-a4af9696a946`, `e6256e2f-fe01-4a88-8c19-6b9b79afabd4`, `614c33d1-b37f-4585-b265-e9dd260087a8`, and `6ff5d259-9a30-44b5-ba4e-6e0221af7f2d`. Their deterministic analysis-only merged ID is `83cf3b74-dca1-8dcb-81d4-9ac4d0a3036b`.
- Runtime/source pin: kmp-test-runner `0.17.0` and harness commit `727b2f3b9ca16e5435ea048efbc077b94167ee71`; skill source `39ea824e301022af57990cb6e30a2fb381ad6df2`; NowInAndroid `7d45eae4f8720a0c77f507712ba2437ff974b6ed`. Claude Code 2.1.238 and Codex CLI 0.154.0 used pinned Sonnet 5 and Terra models at high effort.

## Cost and controls

The [cost estimate](cost-estimate.json) prices all 32 sessions at its stated list rates for the charts. The separately checked [cost control](cost-control.json) uses refreshed conservative long-context rates: primary upper USD7.6612948, excluded canary USD1.4347988, known upper USD9.0960936. The hypothetical USD25 administrative reserve makes the frozen control total USD34.0960936, below its USD60 ceiling. Actual OAuth charges are unknown.

All four blocks ended Closed PASS with the exact VM off, VHD detached and network offline. Independent controls found 96/96 merged private record/audit/raw files byte- and SHA-identical to originals, 2,826,205 raw transcript bytes, no access hits and no suspected infra flakes in 32/32 positions. The [controls audit](controls-audit.md) records the scope and workflow limits. Raw transcripts, credentials and complete operational preregistration remain private.

## Limits

- One scenario, project, host and small unpowered groups limit generalization. The product arm changes CLI and Skill availability together, so it does not isolate either component.
- The Codex exact-module mismatch follows the frozen public substring filter; the extra modules mean those runs cannot be credited with protocol success even though their key facts were correct. Claude's executed-envelope failures are likewise counted as observed.
- Accepted Codex cells retain the declared narrow `config.toml` state change under `--ignore-user-config`. Codex JUnit XML capture and actual OAuth charges were not independently verified. Medians are descriptive and tasks across Evidence campaigns differ.

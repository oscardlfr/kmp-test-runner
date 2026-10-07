# Evidence4: module LINE coverage in NowInAndroid

The revised Evidence4 campaign ran on 2026-10-07. It asks Claude Code and Codex CLI to run the same 11-module host-test task, measure each module's current-run LINE coverage, and report the modules below a 26% threshold separately from modules without coverage data. The product arm has `kmp-test` and its skill; the free arm has neither. Both arms use the same agent runtime, model and execution profile within each comparison.

**Scope:** one pinned NowInAndroid checkout, one Windows VM, two agent runtimes and one scenario. The figures below describe these sessions; they do not establish a general advantage or statistical significance.

## Result

| Runtime | Arm | Scheduled | Counted | Correct key facts | Product protocol success |
|---|---|---:|---:|---:|---:|
| Claude Code (`claude-sonnet-5`) | with kmp-test | 8 | 7 | 7/7 | 0/7 |
| Claude Code (`claude-sonnet-5`) | without | 8 | 8 | 5/8 | not applicable |
| Codex CLI (`gpt-5.6-terra`) | with kmp-test | 8 | 8 | 8/8 | 2/8 |
| Codex CLI (`gpt-5.6-terra`) | without | 8 | 8 | 1/8 | not applicable |

There were 32 scheduled positions, 30 accepted records, one **counted** Codex free-arm protocol failure (index 8, frozen D3 rule), and one structurally missing Claude product-arm cell (index 10). The missing cell is excluded from the score denominator; its measured usage is included in the all-attempt cost. No cell was replayed or replaced. The predeclared infra-only sensitivity analysis excludes zero cells and has the same scores.

The ground truth was 93 passing test methods in 11 modules. Seven modules had fresh LINE coverage reports; `:feature:search:impl`, `:feature:settings:impl` and `:feature:topic:impl` measured below 26%. `:core:common`, `:core:navigation`, `:feature:bookmarks:impl` and `:lint` had no coverage plugin and were not scored as 0%. The per-session key-facts metric requires the correct outcome, below-threshold modules, no-data modules and measured percentages under the frozen grader. Product protocol success additionally requires the prescribed product-assisted test-and-coverage workflow; it is not the cross-arm metric.

![Evidence4 scorecard](scorecard.svg)

![Evidence4 metrics grid](metrics-grid.svg)

![Evidence4 estimated API cost breakdown](cost-breakdown.svg)

The [detailed benchmark document](../../../docs/agentic-benchmark.md#evidence4-2026-10-07-line-coverage-by-module) lists every counted session and the component medians. Tool calls, turns and tool output have different semantics across the two agents; comparisons are within each runtime and arm.

## Design and provenance

- The first Evidence4 campaign was **aborted after a worker timeout** caused by an insufficient worker-to-provider timeout margin. Its observed cells and cost are excluded from this revised campaign. The revised protocol was frozen before revised primary inference at `2026-10-07T06:50:28.580Z`; its private frozen document has SHA-256 `11dae3aad07abae1ce59686d4ce71595e9d5a2a7128e2299214325c07ffff6ad`. The public [protocol and custody summary](preregistration.md) states its publishable rules and historical exclusions.
- Four separate, strictly sequential eight-cell blocks used fresh IDs: `29536aa1-ef3b-4de5-a996-019b06a7f905`, `e7489c68-1452-4880-9453-4d29b32f0bc8`, `08fcfe1f-b590-422d-bfee-cce08bb9c225`, `0f7f2533-3e7d-49c9-82dd-8e4f490391a4`. Their analysis-only merged ID is `2ed4f19d-eb4e-8d89-bdfd-a45b2727e600`. The four-cell canary and all earlier pilots remain outside the primary sample.
- Runtime/source pin: kmp-test-runner `0.17.0` and harness commit `83986d2a3ef705a0db95aebed58254b79a3b0049`; skill source commit `39ea824e301022af57990cb6e30a2fb381ad6df2`; NowInAndroid commit `7d45eae4f8720a0c77f507712ba2437ff974b6ed`. Claude Code 2.1.238 and Codex CLI 0.154.0 requested `high` effort through their respective mechanisms. The fixed scenario and grader are in this repository.
- A post-measurement, CI-reviewed merger correction at develop commit `411c5983d178a9d81650529ecc58c6a96ff98fef` accepted the intended distinct private roots for each block. Independent comparison found zero cell-byte changes. The later cost-estimator hardening at `f06f8ea68a71a49ca710eb0f186d09adea799638` does not change the measured source or records.

## Cost and controls

The generated [cost estimate](cost-estimate.json) prices the **31 counted** cells from recorded token usage. Their conservative long-context upper amount is **USD 12.309109**. The omitted structurally missing cell has recorded usage and adds **USD 0.2809846**, making the **32-attempt upper list-price estimate USD 12.5900936**, below the frozen USD 50 ceiling. The machine-readable [cost control](cost-control.json) reconciles both parts. These are price equivalents, not OAuth invoices. The cost estimate's `retrieved` metadata records the generator's 2026-09-29 price-table retrieval; the frozen revised protocol separately rechecked the same published prices on 2026-10-06. See the [controls audit](controls-audit.md) for the price assumptions.

All four blocks ended `Closed PASS` with the exact VM Off, VHD detached and network offline. Public/private record and audit digests, raw transcript SHA/byte counts, source/treatment/model/seed/order pins and every block boundary passed an independent read-only audit. Access scan found zero hits across all 32 raw transcripts; the frozen infra classifier flagged zero cells. Raw transcripts, login material and the complete operational preregistration remain private. Their hashes and decisions are summarized publicly.

## Limits

- One scenario, one project, a small unpowered sample and one host preclude generalization. A product-arm condition changes both the CLI and skill availability, so the design does not isolate either part.
- The two rejected-cell diagnostics do not expose independently verifiable after-session agent-state listings. Accepted Codex cells used the frozen narrow `config.toml` path exception under `--ignore-user-config`; the raw `agent_state_clean:false` values remain, and no after-size or byte-identity claim is made.
- Six accepted block-3 cells retain `benchmark_eligible:false` because its broker refused whole-block promotion after two rejections. The preregistered merger counts the six valid individual records; their original eligibility flags are unchanged. The Codex JUnit XML capture and actual OAuth charges were not independently verified.
- The counted Codex free-arm D3 negative has no tool-call or output-byte measurement. Its key-fact score, duration and token usage remain counted; tool-call medians use the seven recorded cells in that arm, and the cross-campaign table leaves Codex tool output unreported for Evidence4.
- Medians are descriptive; no ratio, significance test or cross-campaign causal comparison is claimed. Earlier Evidence2 and Evidence3 measured different tasks and must be interpreted separately.

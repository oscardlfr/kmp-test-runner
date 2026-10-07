# Evidence4 revised campaign: controls and custody audit

This is the public account of the independent read-only audits of the four frozen primary blocks and their analysis-only merge. Original receipts, raw transcripts, agent homes and the full preregistration are privately retained. The public [protocol summary](preregistration.md) identifies their frozen hashes. The complete [record](README.md) separates outcomes from controls.

## Campaign and exclusions

| Attempt | Decision | Basis |
|---|---|---|
| Original Evidence4 primary | Excluded in full | Worker watchdog reached its bound; later timing audit proved that the 60-second margin was shorter than observed setup overhead. No original cell enters this result. |
| Revised Evidence4 canary | Excluded | Four-cell preflight of the final 1800/2400/2700-second containment ladder, the 11-module/93-test current-run coverage path and custody. |
| Revised blocks 1–4 | Included under frozen cell rules | Exactly 32 scheduled global positions: 30 accepted records, one counted Codex free-arm D3 negative at index 8, and one missing Claude product-arm structural rejection at index 10. No replay or block replacement. |

The frozen document SHA-256 `11dae3aad07abae1ce59686d4ce71595e9d5a2a7128e2299214325c07ffff6ad` predates every revised primary cell. The design inventory SHA-256 `435c2cf60bce1fd37ebeb0cacc25c104511edc197f604fffddf8c6c1328c6c8e` binds the four fresh UUIDs and the balanced 32-position order. Original campaign cells, two obsolete prepared manifest sets and earlier canaries were not pooled with them.

## Block and source chain

| Block | Global indices per runtime | Campaign ID | Manifest SHA-256 | Closed receipt SHA-256 | Result |
|---|---|---|---|---|---|
| 1 | 0–3 | `29536aa1-ef3b-4de5-a996-019b06a7f905` | `15225f0ae14d87617a353019eb0b8a87ce8b5e9b165db06cd6e5af92c735d1f0` | `f441dc7052d65975e6e75502f9bbbd11ed0d18b8b5384ddd4ad6faa2205c8255` | 8 accepted |
| 2 | 4–7 | `e7489c68-1452-4880-9453-4d29b32f0bc8` | `a55f7d9e016a6d46823e303f1200711de1711d57c190ccb3a9ef129257338f62` | `edd81641dc2a68b1bd0fa92e0cf04bdd6d1c6cd5843eb9ab7044fa05baec0c50` | 8 accepted |
| 3 | 8–11 | `08fcfe1f-b590-422d-bfee-cce08bb9c225` | `01dabc14f1f8386d18d82b223dbca418b9ae3b1b21067c72bc95df0bcb6d1fb7` | `090cd43c7cfc1e74015a9ab7d58e6c6c2e50332696229bbc5cf6ddc1da591cea` | 6 accepted, 1 counted D3, 1 missing |
| 4 | 12–15 | `0f7f2533-3e7d-49c9-82dd-8e4f490391a4` | `d07581f9e180b1b96552db02b71a9b25fabe93615d764e7d5c173fa4a5d16590` | `674b6b2a19002ded9183bcce38a25edfad6ccf1346c06d892469415d71e5082a` | 8 accepted |

Every block ended `Closed PASS`. Its receipt attests the exact allowlisted VM Off, VHD detached, network offline/adapter disconnected, outbound firewall Block and watchdog disarmed. Before each next launch, the earlier marker had been archived and a fresh Off/VHD-detached inspection, AC 99% cap, disk and manifest/source/broker checks passed. The independent auditor verified all four source closures and that the analysis-only merge `2ed4f19d-eb4e-8d89-bdfd-a45b2727e600` preserves cell bytes and global-to-local index mapping. Separate private roots per block were intentional; the post-measurement merger correction changed the analysis tool, not the frozen run source, grader or records.

The source commit for all live cells was `83986d2a3ef705a0db95aebed58254b79a3b0049`, with a verified full 1,352-file inventory. The same NowInAndroid commit, skill snapshot, scenario, expected answer, grader, models, requested effort, seed, treatment and order were checked at each block. All four canary/primary readiness stages passed before live inference, including a fresh 11-module/93-test dry run whose exit code 1 came only from the intended coverage threshold. The guest held ground-truth corpus files; the transcript-access scan is a **detection** control, not proof that the agent was technically unable to read them.

## Records, scans and state

The original readiness receipts and public/private record/audit pairs were copied byte-identically. The approved powered-off-guest copy collected each raw transcript; the offline verifier matched campaign ID, run ID, order, treatment and source pins, record-to-audit digest, and raw SHA-256/byte count. Block raw byte totals were 1,307,461; 1,167,911; 1,435,204; and 1,144,136. Block 3's total includes the two rejected diagnostics and their raw transcripts. A scan over all **32** available raw transcripts found zero matches for ground truth, preregistration and private-evidence paths. The frozen infra classifier flagged **zero** of 32 positions; the predeclared infra-only sensitivity summary therefore equals the primary summary.

The six accepted records in block 3 have `benchmark_eligible:false` because the broker's block-level `EvidenceCopied` eligibility was `FAIL/runtime_ineligible` after two rejections. The frozen merge rule uses each valid individual record and audit pair. Their raw flags remain unchanged. The Codex free-arm index 8 rejection is counted as a protocol negative under D3; the Claude product-arm index 10 transcript-structure rejection is missing data, with no answer score. Both rejected diagnostics lack an independently verifiable after-session agent-state listing. Accepted Claude state listings showed no context-relevant change. Accepted Codex listings showed only the previously disclosed `config.toml` path under `--ignore-user-config --ignore-rules --ephemeral`; raw `agent_state_clean:false` was retained. The recorded before size was 1,369 bytes, but no after size or byte-identity proof exists.

The counted Codex D3 cell has measured duration and token usage but no tool-call count or output-byte measurement. Tool-call medians exclude that unavailable value while retaining its negative key-fact score in the 1/8 denominator; no zero is imputed. Codex's Evidence4 tool-output median is left unreported in the comparative table.

## Cost reconciliation

The committed [cost-estimate.json](cost-estimate.json) covers the **31 counted** cells. Repricing all measured Claude cache writes at the one-hour list rate and all Terra input/cache/output tokens at the conservative possible long-context multipliers yields USD **12.309109** for those cells. The structurally missing Claude index 10 has measured usage in its retained rejection and adds USD **0.2809846** at the same upper pricing. The machine-readable [cost-control.json](cost-control.json) preserves that usage and reconciliation. The full 32-attempt upper estimate is therefore USD **12.5900936**, below the frozen USD **50** primary-attempt ceiling. The missing cell is never assigned zero cost and never enters a score denominator. There was no transport-loss reserve charge in this revised campaign. Prices are public list-price equivalents, not observed OAuth charges or a vendor invoice; the generator records its price-table retrieval date and the frozen protocol documents the subsequent pre-freeze recheck.

## Verdict and limits

The frozen publication gates passed: 32 unique balanced positions, at most one missing and one counted D3 negative, at least seven counted cells in every runtime/arm, zero access hits, zero suspected infra flakes, complete usage for every attempt, valid raw/receipt/record custody and upper cost below the ceiling. The independent controls audit passed with the rejected-cell state-listing, block-3 promotion and Codex config caveats above. Actual OAuth billing and Codex JUnit XML capture were not independently verified. This audit supports reporting this one campaign's descriptive observations and the predeclared sensitivity; it does not support generalization, a causal product effect or claims that every agent state byte was unchanged.

# Evidence5 revised4: controls and custody audit

The four primary blocks and their analysis-only merge passed independent controls review. Original receipts, diagnostics, raw transcripts, agent homes and the full operational preregistration remain private. See the [protocol summary](preregistration.md), [result](README.md) and [attempt ledger](attempt-ledger.md).

| Block | Campaign ID | Scheduled | Counted | Missing | Disposition |
|---|---|---:|---:|---:|---|
| 1 | `515470b6-6c23-49e6-a867-cde7fd37383c` | 8 | 8 | 0 | Closed PASS |
| 2 | `769ffa55-b582-4743-adb3-a433061c5a8b` | 8 | 8 | 0 | Closed PASS |
| 3 | `4bbbe8a2-e345-43db-bedc-324b07970bee` | 8 | 8 | 0 | Closed PASS |
| 4 | `e5992aea-7010-4d0a-af97-c7af965fa1fa` | 8 | 5 | 3 | Closed PASS; nested eligibility FAIL/runtime_ineligible |

The fourth block's original broker verdict promoted only four Codex records because three Claude positions were rejected. The accepted Claude product index 12 has an authentic individual record/audit pair and was retained under the frozen structural gate; its original matrix-level `benchmark_eligible:false` flag was preserved. Claude free indices 13 and 14 and Claude product index 15 were rejected before inference. Each has an original diagnostic and raw terminal stream with a rate-limit event, zero tools and explicit zero runtime-reported tokens. They are missing, excluded from score denominators, and were not replayed. There was no D3 cell or qualifying whole-block replacement trigger.

All four blocks reached exact VM Off, VHD detached and network offline after exit. The fourth block received a fresh post-close VM inspection and separate broker network-state verification before its active marker was archived. Original receipt and record/audit files and all eight raw transcript copies in that block had SHA-256 and byte-count parity; across the merge, **93/93** private files matched originals, covering **4,186,544** raw transcript bytes. The deterministic analysis-only merged campaign ID is `830d4337-800f-8735-95cd-d51460a231cc`. No measured source, original receipt or raw record was changed by merging.

The private-root access scan found **0/32** hits and the prespecified infrastructure classifier found **0/32** suspected flakes, so the sensitivity estimate equals the primary estimate. Accepted Codex state listings retained the declared `config.toml` modification under `--ignore-user-config`; no byte-identity claim is made. Rejected-cell after-session state listings are unavailable. Actual OAuth charges and Codex JUnit XML capture were not independently verified.

Conservative long-context pricing of all 32 primary attempts, including the three explicitly zero-use rejections, is **USD12.2237994**. The excluded revised4 canary adds USD1.7364388; known revised4 attempts total USD13.9602382. Adding the hypothetical USD25 unknown-use administrative reserve yields USD38.9602382, below the frozen USD70 ceiling. These are list-price equivalents, not invoices; earlier Evidence5 attempts and their two unknown-use cells are disclosed separately. The [cost control](cost-control.json) preserves the arithmetic. The frozen publication gates passed with 29 counted sessions, at least six per runtime/arm and no access or infra flags. These results describe this one task and do not support a causal product-effect claim.

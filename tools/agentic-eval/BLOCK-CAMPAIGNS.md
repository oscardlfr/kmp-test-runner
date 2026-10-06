# Block campaigns

Use blocks only for a pre-registered campaign whose full design contains the same cells as the union of the blocks. A block is a separate `evidence1-run.ps1` invocation with its own UUID and a subset of the design's global `campaign_cell_indices`. Each runtime must receive the same subset. Use complete adjacent pairs, such as `[0,1,2,3]`, `[4,5,6,7]`, `[8,9,10,11]`, and `[12,13,14,15]`; the order within each block comes from `derive-round-order-cli.mjs`.

## Run and closure contract

1. Freeze the scenario, product commit, pinned skill, models, prices, execution profile, seed, timeouts, and full round order before the first live block. Change none of them between blocks.
2. Assign a new campaign UUID to each block. The guest may name its temporary cell directory by local `round_index`; `evidence1-run.ps1` copies the final evidence to `<runtime_id>-<global campaign_cell_index>`. Each schema-9 record carries its block `campaign_id`, bound by its accepted audit digest.
3. A block is usable only after `EvidenceCopied` and `Closed` pass. Stage its `manifest.json`, `Closed.receipt.json`, and `private/` evidence in one immutable block closure directory. The receipt is copied from that run's state directory without editing it. Keep the original run state and closure.
4. If a run fails before `Closed PASS`, retain its evidence as a failed attempt and discard that UUID from the analysis set. A rerun uses a **new** UUID and the same pre-registered cell indices. Never resume or overwrite the failed attempt. Record the excluded attempt and reason in the campaign controls audit. Stop if the pre-registered retry limit is exhausted.
5. After every block, verify the declared global indices and arm balance, accepted audit hashes, record `campaign_id`, and the Closed receipt. Keep semantic rejections as rejection evidence; never replace a wrong answer with a rerun.

## Merge and publication

Run `node tools/agentic-eval/merge-campaign-blocks.mjs --out <empty-merged-dir> <block-closure-1> <block-closure-2> [<block-closure-3> <block-closure-4>]` after all blocks close. The merger refuses mismatched manifests, incomplete or overlapping index sets, missing evidence, failed closures, changed audit bytes, and mixed harness/product revisions. It gives the merged campaign a deterministic UUID and records the source block UUIDs. The merged directory is for Node analysis; its `kind` and `block_campaign_ids` fields are not accepted by the live PowerShell manifest validator.

Run `campaign-summary.mjs`, `infra-flake-classifier.mjs`, the transcript access scan, and the cost estimator against the merged directory. Publication requires their ordinary gates plus a controls audit naming every included and discarded block. Do not interpret the merged `campaign_id` as an ID of any live run.

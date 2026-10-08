# Evidence5 revised4 protocol: public summary

This summarizes the private preregistration frozen on 2026-10-08 at 08:05:23.477Z, before primary inference. Its SHA-256 is `4a48a721307c06de3e2d4a5255676d0565299808e219bd009f89941a27c1c768`; the full tracked-source inventory SHA-256 is `f394f69bdf61ce7bf97fb4001fc9b000f867b44f178e78f3649fb0d8660392fc`. The full operational document remains private.

## Locked design

- One changed-dependents scenario on NowInAndroid `7d45eae4f8720a0c77f507712ba2437ff974b6ed`: compare against the pinned base, include transitive dependents of `:core:network`, and identify the failing downstream test. The product arm includes the pinned `kmp-test` 0.17.0 and Agent Skill; the free arm includes neither.
- Claude Code 2.1.238 / `claude-sonnet-5` and Codex CLI 0.154.0 / `gpt-5.6-terra`, high requested effort. Each runtime has eight positions per arm in a counterbalanced 16-position sequence. Four sequential eight-cell blocks cover the 32 unique positions. Source commit `3e309437b726c32c84cc306e6c8a924a03492284` and seed `20261006` were pinned.
- Provider, worker and guest-transport bounds were 1800, 2400 and 2700 seconds. The per-Gradle-task limit was 600 seconds. There was no automatic provider retry. An excluded four-cell canary preceded the primary blocks; earlier Evidence5 attempts are separate in the [attempt ledger](attempt-ledger.md).

## Frozen scoring and controls

The primary metric is exact agreement on the key facts in the final answer. Product protocol success additionally requires current-run authoritative product evidence and is separate. Valid accepted semantic negatives remain counted. A narrowly specified rejected Codex missing-shell-result pattern could count as a D3 negative only when the raw terminal stream satisfied every frozen condition. Other rejected cells remain missing without score imputation. The infra-only sensitivity excludes only prespecified suspected infrastructure flakes. No score-based replay or individual-cell replacement is allowed.

The original `EvidenceCopied` receipt and its nested eligibility verdict must remain intact. A mixed block may retain independently valid accepted record/audit pairs even if its matrix-level promotion fails solely because of disclosed structural rejections. Every scheduled position must have an authentic accepted pair or original rejection diagnostic, and the block must close safely with all evidence in custody.

Public performance claims stop at four or more rejected/missing/provider-error positions, six or more suspected infrastructure flakes, fewer than six counted cells in any runtime/arm, an access hit, unexplained context-relevant agent-state change, broken identity/custody/merge/audit, or a breached **USD70** conservative revised4 all-attempt ceiling. Missing usage is unknown, never zero. A USD25 administrative reserve for one unknown-use cell is a planning assumption, not observed spend. Whole-block replacement is allowed only for independently documented uncertain post-dispatch Hyper-V transport loss or provider-capacity `turn.failed` with missing usage, after exact safe closure and custody, with a new ID. Neither trigger occurred.

Every block required fresh pinned-source, identity, manifest, exact-VM Off/VHD-detached and offline-network preflight. Before another block, the predecessor had to reach `Closed PASS`, with raw/receipt custody, access/infra/cost review and independent controls audit. The [controls audit](controls-audit.md) reports the observed disposition.

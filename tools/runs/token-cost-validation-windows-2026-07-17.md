# Token-cost registry integrity — Windows follow-up (2026-07-17)

Scope: registry completeness backfill (already-committed evidence, zero new API
calls) plus a data-integrity fix for one mischaracterized row found while
auditing the 2026-07-16 wave. This document is a companion to
[`token-cost-validation-windows-2026-07-16.md`](token-cost-validation-windows-2026-07-16.md),
which it corrects in two places (see that document's "Correction (2026-07-17)"
section).

## Environment

- Platform: Windows 11 Pro 10.0.22631 (64-bit)
- Node: v24.12.0
- npm: 11.6.2
- Java: OpenJDK Temurin 23.0.2
- Repo: `feature/measurement-registry-kampkit-fix`, branched from `develop` at
  the commit that merged PR #364 (`cc0233c`)

## Anthropic API key — session auth-scope incident

Mid-session, the maintainer found `ANTHROPIC_API_KEY` set as a **User-scope
Windows environment variable**, present in every new shell (confirmed via
`[Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY','User')`). Per
Claude Code's documented auth precedence, an `ANTHROPIC_API_KEY` env var is
checked *before* subscription OAuth — so Claude Code's own conversational
requests for this session had very likely been running against that key
instead of the maintainer's subscription, corroborated by a billing error the
maintainer saw independently ("Credit balance too low"). This is an
operational/billing finding about the *session*, not about any measurement
script — no measurement command in this repo sets a persistent key; the
established convention (private key read from a gitignored local file,
injected inline for one command) was not the cause.

**Resolution**: the maintainer removed the User-scope variable, restarted
Claude Code, and confirmed via `/status` that the session now runs on a Claude
Max subscription login with no API-key row. All work in this document after
that point made **zero Anthropic API calls** — the registry backfill below is
pure transcription of already-committed evidence, and the KaMPKit re-run used
only the offline `cl100k_base` tokenizer.

## Registry backfill — `info`, `describe`, `changed`, `benchmark` (zero new API calls)

40 new rows appended to `tools/runs/measurement-registry.jsonl`, sourced
entirely from evidence already committed to this repository — no Gradle runs,
no API calls:

| Feature | Rows | Source | Original session |
|---|---:|---|---|
| `info` | 8 (B+C × 4 tokenizers) | [`cross-model-results-info.txt`](../cross-model-results-info.txt) | PR #156, 2026-05-07, v0.9.0 |
| `describe` | 8 (B+C × 4 tokenizers) | [`cross-model-results-describe.txt`](../cross-model-results-describe.txt) | PR #156, 2026-05-07, v0.9.0 |
| `changed` | 12 (A+B+C × 4 tokenizers) | [`cross-model-results-changed.txt`](../cross-model-results-changed.txt) | cl100k: PR #156 (2026-05-07); Anthropic: PR #289 opus-4-8 refresh (2026-06-07, v0.13.0) |
| `benchmark` | 12 (A+B+C × 4 tokenizers) | [`cross-model-results-benchmark.txt`](../cross-model-results-benchmark.txt) | same as `changed` |

All four features' underlying project is the anonymized `private-large-A`
reference (confirmed via the PR #156 commit message, which is not quoted here
— alias only, per this repo's decouple rule). `info`/`describe` retain their
original `claude-opus-4-7` tokenizer label honestly; they were never
re-tokenized during the later opus-4-8 refresh (PR #289 covered `parallel`/
`coverage`/`changed`/`benchmark` only). `bytes` is `null` on all 40 rows — the
original per-run capture files no longer exist locally 2+ months later, and
the source `cross-model-results-*.txt` files record only token counts, not
byte sizes. This backfill closes the registry-completeness follow-up
BACKLOG.md already named for `changed`/`benchmark`, and extends the same fix
to the previously-unnoticed `info`/`describe` gap.

Validated: `node tools/measurement-registry.mjs validate` — 0 violations (4
non-blocking warnings, all the expected `claude-opus-4-7` stale-tokenizer
flag on the `info`/`describe` rows).

## KaMPKit data-integrity fix

### Root cause

Auditing the 2026-07-16 wave's raw evidence (not just its registry rows and
narrative) found that `2026-07-16-parallel-kampkit-windows-smoke-cold-01`
actually recorded a **Gradle Android-SDK-configuration failure**, not a real
measurement:

- The `kmp-test parallel --json` envelope for that run shows `exit_code: 2`,
  `tests.total: 0`, `errors: [{code: "no_test_modules", message: "No modules
  found matching filter: app"}]`.
- The local KaMPKit clone used for that session had no `local.properties` and
  no `ANDROID_HOME`/`ANDROID_SDK_ROOT` environment variable, so Gradle had no
  way to locate the Android SDK.
- The 2026-07-16 document and the registry `notes` field both attributed the
  resulting low token counts to "cold build" and "recent dependency updates"
  — a plausible-sounding but incorrect explanation. Both are corrected by this
  document (see the 07-16 doc's "Correction" section) and by an edit to the
  affected registry rows' `notes` field (the interpretive text only — the
  `token_count`/`bytes` values are untouched, since they accurately reflect
  what that failed invocation actually output).

### Fix and re-run

Added a local-only `local.properties` (`sdk.dir` pointing at the machine's
Android SDK install) to the local KaMPKit clone — this file is gitignored by
KaMPKit's own `.gitignore` and lives in a different repository entirely; it
never touches this repo's history.

Re-ran `kmp-test parallel` against the clone. The `app` module has **no test
source in this commit** (`b3a7784`, "Bump the minor group with 14 updates
(#358)") — a change from whenever the historical `--module-filter app`
convention was established — so the retry targeted the `shared` module
instead, which does have real tests. `:shared`'s generic `test` task name is
ambiguous in this KMP-Android-library setup (Gradle reports candidates
`testAndroid`/`testAndroidHostTest`), so the retry used the explicit task
`testAndroidHostTest`.

Result: a genuine measurement — `tests.total: 1` (`individual_total: 24`, all
passed), `errors: []`.

| Tokenizer | A raw Gradle | B markdown | C JSON | A:C |
|---|---:|---:|---:|---:|
| `cl100k_base` | 34,273 | 262 | 375 | 91.4x |

Anthropic cross-model counts were **not** computed for this capture — kept
out of scope this session per the post-incident instruction to avoid any
Anthropic API call not explicitly needed for the fix at hand. The `cl100k_base`
number alone is sufficient to confirm the data-integrity point: `kmp-test`
produces compact JSON on a real small public measurement. This is not a
README input either way (same "never used for any README headline" precedent
as every other KaMPKit smoke in this registry).

Registry: the pre-existing 12-row `2026-07-16-parallel-kampkit-windows-smoke-cold-01`
group's `notes` field was corrected in place (measured values unchanged); a
new 3-row run_id `2026-07-17-parallel-kampkit-windows-smoke-cold-02` records
the real measurement.

### Incident — shared private-capture path overwritten (acknowledged, not reconstructed)

While re-running the measurement, an initial attempt used
`--project-root` directly instead of the required `--projects-config`
isolation. This is the exact hazard the 2026-07-16 document already documents
in its "Safety note — shared-path collision avoided" section — and it was hit
anyway. The bare `--project-root` invocation wrote to the shared
`tools/runs/parallel/{A,B,C}-run1.txt` path, overwriting the `private-large-A`
reference captures for the `parallel` feature that the 07-16 document confirms
were present there (~5.3 MB/70 KB/15 KB) before this session began.

**Impact assessment:**
- These files are gitignored and were never committed — git history and every
  already-published number (registry rows, `cross-model-results-parallel.txt`,
  README, docs) are completely unaffected.
- The loss is local only: a future `private-large-A` cross-model refresh (e.g.
  the deferred `claude-sonnet-5` retokenization — see BACKLOG.md) will need to
  regenerate the `parallel` captures from a fresh measurement pass rather than
  cheaply re-tokenizing the existing files.
- Per explicit maintainer instruction, this document acknowledges the loss
  and does **not** attempt to reconstruct or fabricate replacement captures in
  this PR.
- The corrected KaMPKit captures were subsequently relocated to
  `tools/runs/multi-project-token-cost-2026-07-17/per-project/KaMPKit/parallel/`
  (the collision-safe, per-project path), freeing `tools/runs/parallel/` again
  for its intended `private-large-A` purpose.

## Private-reference wave — still a deliberate NO-GO

No `private-large-A` capture was sent to any API this session. The
`claude-sonnet-5` cross-model refresh remains explicitly deferred to a
separate, future, explicitly-approved session with its own privacy checklist
— see BACKLOG.md.

## What was not run

- No Anthropic or OpenAI API call of any kind this session.
- No fresh measurement of `private-large-A` (any feature).
- No fresh OSS bucket matrix beyond the single KaMPKit `parallel` re-run.
- No agentic end-to-end benchmark.

## Measurement decision

No README headline values changed. This session's evidence is registry
completeness (info/describe/changed/benchmark backfill, zero new API calls)
and a data-integrity correction (KaMPKit), not new headline evidence.

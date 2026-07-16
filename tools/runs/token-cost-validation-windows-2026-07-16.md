# Token-cost evidence validation — Windows wave (2026-07-16/17)

Scope: command-output/token-cost evidence only, plus a structured registry
backfill. This wave did not run the agentic end-to-end benchmark and did not
perform final README/docs release alignment.

## Environment

- Platform: Windows 11 Pro 10.0.22631 (64-bit)
- Node: v24.12.0
- npm: 11.6.2
- Java: OpenJDK Temurin 23.0.2
- Repo: `feature/token-cost-measurement-registry`, branched from `develop` at
  the commit that merged PR #362 + PR #363
- Wall-clock: measurements ran just after local midnight on 2026-07-17; the
  measurement tool's own date-stamped output directories use UTC, which was
  still 2026-07-16 at that moment. Registry rows and this document use
  `2026-07-16` throughout for consistency with those directory/file names,
  not as a claim about local wall-clock date.

## What this wave did

1. Added `tools/measurement-registry.mjs` and `tools/runs/measurement-registry.jsonl` — see [`docs/token-cost-measurement.md`](../../docs/token-cost-measurement.md#measurement-registry).
2. Backfilled 48 registry rows from the four pre-existing evidence sources (2026-05-18 OSS `parallel` aggregate, 2026-05-19 `private-large-A` `coverage` cross-model evidence, and PR #363's 2026-07-16 NowInAndroid + KaMPKit smokes). No numbers were changed — this is a structured re-statement of already-committed evidence.
3. Ran fresh Windows measurements against the same two public projects PR #363 used, plus a live Anthropic API key validation.

## Anthropic API key validation

The configured `ANTHROPIC_API_KEY` was initially invalid (`401 invalid x-api-key`) across two separate terminal sessions (the value only updates for terminals opened *after* the Windows environment-variable change — closing just the Claude Code process while reusing the same terminal window does not pick it up). After the user regenerated the key on `console.anthropic.com` and opened a genuinely fresh terminal, a trivial content-free ping succeeded:

```js
await client.messages.countTokens({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'ping' }] });
// -> input_tokens: 8
```

No private capture was ever sent during key validation — the ping content was the literal string `"ping"`, never a project capture. This intentionally avoided `measure-token-cost.js`'s own cross-model mode for key validation, since that mode reads and transmits the private `tools/runs/parallel/*.txt` / `tools/runs/coverage/*.txt` captures (the `private-large-A` reference evidence) — using it just to test a key would have sent private data to Anthropic for no reason.

## Safety note — shared-path collision avoided

`tools/runs/parallel/{A,B,C}-run1.txt` held the irreplaceable, gitignored `private-large-A` reference captures for this feature (confirmed present, ~5.3 MB/70 KB/15 KB) before this wave began. `measure-token-cost.js`'s bare single-project "gradle mode" (`--project-root` without `--projects-config`) always writes to that same shared path regardless of which project is being measured — its own source comments confirm this already happened once before ("v0.10.1 re-measure overwrote the OSS aggregate"). Every command below therefore used `--projects-config` (multi-project mode, which writes to a per-project-namespaced path) instead of the literal single-project command shape shown in earlier planning notes. The `private-large-A` captures were never touched or overwritten by this wave.

## Public project state

Both projects were freshly `git pull`-ed before measurement (per explicit request, to avoid measuring against stale upstream state):

| Project | Clone | Commit | Notes |
|---|---|---|---|
| NowInAndroid | pre-existing local clone | `7d45eae4f8720a0c77f507712ba2437ff974b6ed` | `git fetch` + `git pull --ff-only` confirmed 0 commits behind `origin/main` — upstream genuinely has not moved since 2026-04-30. Clone had residual `build/`/report artifacts from an unrelated 2026-04-30 local session (untracked, harmless to the measurement, but meant this wasn't a truly cold build). |
| KaMPKit | fresh `git clone --depth 1` | `b3a7784fb969a8558b88c80674c8b596944cdab7` | Replaces the historical PR #363 KaMPKit smoke's source, which was a non-git ZIP extract with no recorded commit. `git pull` confirmed already current (just cloned). Genuinely cold build — no prior state. |

## `parallel` — NowInAndroid (public, large)

Command shape (redacted local path):
```bash
node tools/measure-token-cost.js --projects-config <local-projects-config> --features parallel
```
Run twice back-to-back to check stability, since the clone's pre-existing build artifacts meant a genuine cold/warm contrast (like PR #363's session) wasn't available this time:

| Run | Tokenizer | A raw Gradle + reports | B markdown | C JSON | A:C |
|---|---|---:|---:|---:|---:|
| 1 | `cl100k_base` | 235,097 | 1,421 | 2,015 | 116.7x |
| 2 | `cl100k_base` | 235,084 | 1,421 | 2,015 | 116.7x |
| 2 | `claude-opus-4-8` | 411,319 | 2,382 | 3,340 | 123.1x |
| 2 | `claude-sonnet-4-6` | 319,022 | 1,785 | 2,402 | 132.8x |
| 2 | `claude-haiku-4-5` | 319,022 | 1,785 | 2,402 | 132.8x |

Runs 1 and 2 agree to within 13 tokens on A and are identical on B/C — both labeled `cache_state: warm` honestly (neither is a true cold baseline; see clone-state note above), demonstrating measurement stability rather than a cold/warm contrast. Anthropic counts were computed by calling the already-exported `countTokensAnthropic()` directly against run 2's per-project capture files (not the CLI's `--anthropic-models` flag, which targets the shared `tools/runs/parallel/` path — see the safety note above). No chunking was needed; the largest capture was 838,219 bytes.

**Comparison with PR #363's 2026-07-16 session** (different machine/platform): cl100k_base 116.7x here vs. 116.3x there; opus 123.1x vs. 123.3x; sonnet/haiku 132.8x vs. 133.0x. These are effectively identical within measurement noise — **this Windows wave supports keeping the README large-project `parallel` headline unchanged.**

## `parallel` — KaMPKit app module (public, small smoke)

Same scope limitation as PR #363's smoke: the shared KMP module still doesn't expose a generic `:shared:test` task, so this measures only the `app` module leg.

Command shape:
```bash
node tools/measure-token-cost.js --projects-config <local-projects-config> --features parallel --module-filter app
```

| Tokenizer | A raw Gradle + reports | B markdown | C JSON | A:C |
|---|---:|---:|---:|---:|
| `cl100k_base` | 304 | 132 | 209 | 1.5x |
| `claude-opus-4-8` | 521 | 243 | 369 | 1.4x |
| `claude-sonnet-4-6` | 369 | 165 | 257 | 1.4x |
| `claude-haiku-4-5` | 369 | 165 | 257 | 1.4x |

Materially different from PR #363's KaMPKit smoke (cl100k_base A=1,054/B=91/C=205, 5.1x) — expected, since this is a different commit (`b3a7784`, "Bump the minor group with 14 updates (#358)") measured on a genuinely cold build, versus PR #363's undocumented clone/commit/cache state. **Neither smoke was ever used for the README's small-bucket headline — this confirms the current CLI/tooling still produces compact JSON on a small public sample; it is intentionally not used to update any headline.**

## Private-reference wave — deliberate NO-GO

`private-large-A` was fully re-measured 2 months ago (2026-05-19, v0.10.1) with complete cross-tokenizer coverage across `parallel`, `coverage`, `changed`, and `benchmark` — already captured in the registry backfill. Re-running the `coverage` drill-down specifically would mean regenerating a ~74 MB private capture and sending chunked pieces of it to Anthropic again. Nothing in this wave (a registry tool, two public smokes) changes `kmp-test coverage`'s output shape, so that renewed privacy exposure and API cost would buy zero new signal. **This is a deliberate privacy/cost decision, not an oversight or an unavailability.** Re-trigger only when `coverage`'s envelope actually changes.

## What was not run

- No fresh full six-project OSS Gradle matrix (only the two projects PR #363 also used).
- No private raw captures were regenerated, committed, or sent to any API.
- No OpenAI token-count API was called — this repo has no supported OpenAI token-count API path; `cl100k_base` remains the offline OpenAI-compatible tokenizer.
- No agentic end-to-end benchmark was run.

## Measurement decision

Existing evidence remains release-valid for the current README headline table. The fresh Windows NowInAndroid measurements land within noise of PR #363's own session on different hardware/platform, supporting cross-platform consistency of the current CLI/tooling. **No README headline values changed.**

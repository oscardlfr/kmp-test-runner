# Evidence2 controls audit (read-only)

Date: 2026-09-30. Harness commit: `c15aae3` (full SHA
`c15aae3daf1ff9428c3d88e336047d3baf042717`), read via `git show c15aae3:<path>` from the
`agentic-eval-codex-runtime` checkout (branch `codex/agentic-eval-codex-runtime`). No repository
file was modified by this audit; this document and the `README.md` link update are the only
changes this pass makes.

This is the full backing detail for the "Threats to validity" section of the main evidence document
(`README.md` in this directory): read this file for every citation and the complete per-parameter
breakdown; read the main document for the summary a reader needs to correctly bound this benchmark's
claims. Structure and method mirror
[Evidence1's own controls audit](../evidence1-agentic-benchmark-2026-09-28/controls-audit.md).

## 0. Provenance and scope

- **Code read = code executed.** All 16 campaign records carry `repo_commit` and
  `kmp_test_cli_source_sha` = `c15aae3daf1ff9428c3d88e336047d3baf042717` — verified across every
  one of `private/{claude-code,codex-cli}-{0..7}/record.json`, not sampled. This is also the exact
  commit this audit reads code from, and (unlike Evidence1, where the harness and product lived at
  different commits pre-merge) the product-under-test's own source sha (`kmp_test_cli_source_sha`)
  and the harness's own commit (`repo_commit`) are the same field value in this monorepo, so no
  separate harness-vs-product drift check is needed.
- **Records checked.** All 16 real campaign cells (not a canary sample):
  `private/claude-code-{0..7}/{record,audit}.json` and `private/codex-cli-{0..7}/{record,audit}.json`,
  cross-checked against the campaign's `manifest.json`. Every value below that is asserted "identical
  across N cells" was computed by parsing all N files, not by eyeballing 1-2 examples.
- **Scope of code verification.** This audit re-read, at `c15aae3`: `condition-launcher.mjs`,
  `runtimes/codex-cli.mjs`, `models/registry.json`, `scenario-campaign-plan.mjs`,
  `corpus/scenarios/coverage-threshold-failure-v2.json`, `execution-profiles/registry.json`,
  `materialize.mjs`, `infra-flake-classifier.mjs`, `campaign-summary.mjs` (`loadCell` only),
  `cli.mjs` (`cache_state` line only), `docs/audits/evidence2-preregistration.md` in full, and the
  version-pin lines of `docs/audits/evidence1-dual-condition-canary-launch.ps1` and
  `tools/evidence1/provisioning/{README.md,evidence1-windows-hyperv-e2e-v1.json}`. It does **not**
  re-trace the PowerShell dispatch chain (`evidence1-run.ps1` → `...manifest-contract.psm1` →
  `...canary-launch.ps1` → `cli.mjs`) line-by-line the way Evidence1's own audit did; where this
  document states something about that chain, it is quoting the preregistration document's own
  account (§1, D7) plus this campaign's own observed timestamps, not an independent re-read of the
  `.psm1`/`.ps1` sources.
- **Verified by execution (not just by reading code), per the same discipline Evidence1's audit
  used:**
  - `tools/agentic-eval/infra-flake-classifier.mjs` was run directly against this campaign's real
    private evidence root (read-only; it only reads `manifest.json`, `record.json`/`rejection.json`,
    and `transcript.jsonl` per cell, and prints JSON to stdout). Result in full in §I1 below.
  - Its `logic_sha256` (the D9 freeze value) was independently recomputed from the checked-out
    module and compared byte-for-byte against the value the preregistration document records.
  - The campaign's real dispatch order (D7) was reconstructed by sorting all 16 cells'
    `started_at` timestamps and is reproduced in full in §H3.
  - The env-key-name diffs in §F7 were computed by set-diffing the real `env_keys` arrays across
    all 16 records, not inferred from the allowlist code alone.
- **Arm labels**, matching the preregistration's own convention: A = product (`current-skill`,
  `product-assisted`). B = free (`no-skill`, `free-baseline-no-product`).
- **Publication status.** `manifest.json` is not part of the publication set: the pre-publication
  `public/` staging directory and `public.publication.ready.json` (schema 1, an artifact manifest of
  32 file hashes) contain only per-cell `record.json`/`audit.json` pairs, no campaign manifest, no
  `transcript.jsonl`, matching Evidence1's own finding. A value recoverable only from `manifest.json`
  is marked `[manifest]` below, same convention as Evidence1's audit. Separately, and out of scope
  for a *controls* audit but worth flagging once: at this staging snapshot, `public/claude-code-0/
  record.json` is byte-identical to its `private/` counterpart, including the
  `resolved_kmp_test_executable_path` field, which is an absolute host path. D10's own sanitization
  pass ("machine-specific paths genericized") does not appear to have run yet on this field as of
  this snapshot — flagged for whoever runs the actual publication step, not fixed here (out of this
  audit's scope, and this document does not reproduce the path itself, per the privacy constraint
  on this audit).

### Classification legend

Same four classes the assignment specifies:
- **controlled** — set by harness/design and verified identical (or identically *and intentionally*
  asymmetric, e.g. a treatment) across the cells it should hold across.
- **set-not-recorded** — set deliberately, but no per-cell field carries the value; recoverable only
  from code (`[code]`) or the unpublished manifest (`[manifest]`).
- **uncontrolled-constant** — not set by the harness; fixed by CLI/model/VM-image default, same for
  every cell as far as this audit can tell.
- **uncontrolled-variable** — not set, and free to vary cell-to-cell.

---

## 1. Controls table

### A. Model and inference

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Model id, requested / resolved | `claude-sonnet-5` / `claude-sonnet-5` | `gpt-5.6-terra` / `gpt-5.6-terra` | `models/registry.json:6` (Claude default), `:46` (Codex default); `condition-launcher.mjs:127` (`--model`); `codex-cli.mjs:301` (`--model`) | `model_requested`, `model_resolved`, `agent_runtime.model_requested/model_resolved` | Yes (16/16). Claude's `model_resolved` is observed from the runtime; Codex's is an echo of the configured value (`codex-cli.mjs:393-395`, `modelResolved: ... delivery.modelConfigured`) — same echo caveat as Evidence1 | controlled (Codex `model_resolved` is an echo, not an independent observation) |
| Served model snapshot (per-turn) | `served_model_snapshot.value = "claude-sonnet-5"`, `.reason = null` | `served_model_snapshot.value = null`, `.reason = "runtime-does-not-report-per-turn-model"` | n/a — no snapshot pin exists in either runtime's argv | `served_model_snapshot.{value,reason}` (schema v9 — new vs Evidence1, which did not capture this at all) | Same pattern for all 8 cells per runtime | uncontrolled-variable (an alias, not a dated snapshot; the actual served weights could change mid-campaign and Codex cannot report it at all) |
| Reasoning effort — value | `high` | `high` | `condition-launcher.mjs:128` (`'--effort', 'high'`, inside `buildBaseInvocation`); `models/registry.json:50` (`gpt-5.6-terra` → `"default_reasoning_mode": "high"`), consumed at `codex-cli.mjs:302` | `reasoning_effort_requested` | Yes — **16/16, both runtimes, both arms** (Amendment A7 equalized Codex from `low` to `high`; Claude was already `high`) | controlled |
| Reasoning effort — source (how it was set) | `harness-pinned-cli-flag` | `model-registry-default-reasoning-mode` | Same two sites as above | `reasoning_effort_source` | Mechanism differs by runtime, constant within each (8/8 Claude, 8/8 Codex) | controlled, by two different mechanisms — see Asymmetries |
| Sampling (temperature, top_p, provider seed) | Defaults | Defaults | Not set by either invocation (`buildBaseInvocation`, `codex-cli.mjs:298-307` expose no such flags) | Not recorded | Presumed yes (code path identical); not independently observable from these records | uncontrolled-constant (stochastic) |
| Auth mode | OAuth credentials in the Claude runtime-state dir | Codex CLI login (ChatGPT or API key both accepted, `codex-cli.mjs:23` `LOGIN_OK_RE`) | Directory path only; mode itself not asserted | Not recorded. Inferred only indirectly: `total_cost_usd.reason = "not present on this runtime's result event schema"` for Claude is the OAuth signature the preregistration itself uses (A9 §6) | Not verifiable per cell | uncontrolled-constant |

### B. Runtime binary and invocation

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| CLI version | `2.1.238` | `0.154.0` | Toolchain pin: `docs/audits/evidence1-dual-condition-canary-launch.ps1:21-22` (`$script:E1ClaudeCommand`/`E1CodexCommand`) and `:329-330` (`$ExpectedClaudeVersion`/`$ExpectedCodexVersion`) | `claude_code_version`, `agent_runtime.cli_version` (Claude, observed from the session); `agent_runtime.cli_version` (Codex, from a `codex --version` probe, `codex-cli.mjs:67-75`) | Yes — `2.1.238` on all 8 Claude cells, `0.154.0` on all 8 Codex cells | controlled — **but see the Codex base-image gap below, flagged prominently** |
| **Codex CLI version — base image vs. launch pin (flagged; not identical to what was provisioned)** | n/a | Provisioned/checkpointed base image: `0.153.4`. Launch-pinned and actually observed: `0.154.0` | Base: `tools/evidence1/provisioning/README.md:26` ("Codex CLI `0.153.4`") and the same repo's `provisioning/evidence1-windows-hyperv-e2e-v1.json` toolchain entry (`version: "0.153.4"`). Launch pin: `evidence1-dual-condition-canary-launch.ps1:22,330` (`0.154.0`) | `agent_runtime.cli_version = "0.154.0"` on all 8 Codex cells | All 8 Codex cells match the **launch pin** (`0.154.0`), none match the provisioning README's stated base (`0.153.4`) | **uncontrolled-constant, and a real gap between two documents that both claim to be authoritative** — see Asymmetries |
| Argv content (flags) | `-p --output-format stream-json --verbose --include-hook-events --model M --effort high --setting-sources '' --strict-mcp-config --no-chrome --no-session-persistence --settings <tmp> --tools Bash,Skill --permission-mode bypassPermissions --max-budget-usd 2`. A adds `--plugin-dir <snapshot>` | `exec --json --ephemeral --color never --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --enable hooks --model M -c model_reasoning_effort="high" -` | `condition-launcher.mjs:120-136` (`buildBaseInvocation`); `codex-cli.mjs:298-307` (`buildInvocation`) | Not recorded verbatim; hashed as `argv_sha256` (schema v9, new vs Evidence1, which had no such field at all) | See next row — **no**, for a structural reason, not a behavioral one | set-not-recorded [code] for the logical flags; see next row for the hash itself |
| `argv_sha256` (hash of the argv actually used) | **Varies on every one of the 8 cells** (8 distinct values) | **Constant across all 8 cells**, both arms: `8b3e41352d10d8ab8cf5a48c623e0c493d0fc3b8d85ec211d998e9be1afaa116` | n/a (see Note B1 below) | `argv_sha256` | No for Claude (0/8 pairwise matches); yes for Codex (8/8) | **Claude: uncontrolled-variable, but only cosmetically — see Note B1. Codex: controlled, genuinely identical argv on all 8 cells** |
| Prompt transport | stdin | stdin | `condition-launcher.mjs:134` (`stdinText: prompt`); `codex-cli.mjs:304` (`stdinText: prompt`) | Not recorded as a field; implied by the delivered-prompt hashes below | Yes | set-not-recorded [code] |

**Note B1 (argv_sha256).** Claude's argv embeds `--settings <tmp>` (`condition-launcher.mjs:130`),
where `<tmp>` is a fresh directory from `mkdtempLongPathSafe('kmp-agentic-eval-settings-')`
(`condition-launcher.mjs:63`), minted once per `buildPolicySettingsFile` call — i.e. once per cell.
Product cells additionally append `--plugin-dir <snapshotDir>`, itself a fresh per-invocation
temp path. Because a random, per-invocation path is baked directly into the hashed argv string,
`argv_sha256` **cannot be identical across two different Claude invocations even when every logical
flag is byte-identical** — the field is not a usable "did the invocation change" signal for Claude,
by construction, not because anything actually varied. Codex's argv contains no such path (its hooks
file path travels out-of-band via `runtimeContext.hooksSourcePath`, never through argv —
`codex-cli.mjs:305`), so its `argv_sha256` is a genuine, meaningful, verified-identical value across
all 8 cells and both arms.

### C. Stopping rules, budgets, timeouts

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Per-session spend cap (`max_budget_usd`) | `2` (USD) | `null`, reason `"no_budget_cap_mechanism"` | `manifest.json` field `runtimes[0].max_budget_usd = 2.0` / `runtimes[1].max_budget_usd = null` [manifest]; `condition-launcher.mjs:132` (`--max-budget-usd`, Claude only — no equivalent Codex flag exists) | `max_budget_usd.{value,reason}` (schema v9 — new vs Evidence1, which had no per-cell field for this at all) | Yes within each runtime — `2` on all 8 Claude cells, `null` on all 8 Codex cells | controlled for Claude; uncontrolled-constant for Codex (no cap mechanism exists) |
| Max turns | None | None | Not set by either invocation | Not recorded | Yes (absent everywhere) | uncontrolled-constant (unbounded) |
| Provider (session) timeout | 1800 s | 1800 s | `manifest.json` field `provider_timeout_seconds = 1800` [manifest] | `timeout_ms = 1800000` per cell (both runtimes) | Yes — `1800000` on all 16 cells | controlled |
| Worker timeout | 1860 s | 1860 s | `manifest.json` field `worker_timeout_seconds = 1860` [manifest] | Not a per-cell field; only a breach (no record written) would reveal it | Not independently observable per cell, but the manifest states one shared value for both runtimes | set-not-recorded [manifest] |
| Guest transport timeout | 1920 s | 1920 s | `manifest.json` field `guest_transport_timeout_seconds = 1920` [manifest] | Not a per-cell field | Same as above | set-not-recorded [manifest] |
| `no_automatic_provider_retry` | `true` | `true` | `manifest.json` field `no_automatic_provider_retry = true` [manifest] | Not a per-cell field (campaign-level only) | One shared campaign-level value | set-not-recorded [manifest] |
| **Truncation, checked post hoc against this campaign's real data** | n/a | n/a | n/a | `terminated = false`, `termination_reason = null`, `exit_code = 0` on **all 16 cells**; longest session 415433 ms (`codex-cli-3`) against the 1800000 ms cap | Yes — zero truncation events of any kind occurred | n/a (empirical finding, not a control) |

### D. Tools, permissions, sandbox

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Tool surface | `Bash`, `Skill` only | Codex's own default tool set for this model; not restricted by the harness | `condition-launcher.mjs:96,131` (`'--tools', 'Bash,Skill'`); gate-verified via the session's own init event (`mcp_servers`/`tools` check, `stream-parser.mjs:460-461` — confirmed present at `c15aae3`) | `tool_calls_total`, `shell_commands_total`, audit `tool_calls[].tool_kind` (Codex counts only `command_execution` items, `codex-cli.mjs:349-378`) | Mechanism constant across all 16 cells | Claude: controlled (gate). Codex: uncontrolled-constant, partly unobserved (non-shell tool use, if any, is invisible) |
| Permission / approval mode | `--permission-mode bypassPermissions` (`condition-launcher.mjs:132`) | `--dangerously-bypass-approvals-and-sandbox` (`codex-cli.mjs:301`) | Same lines | `permission_mode_used` | Yes — `"bypassPermissions"` string on **all 16 cells**, both runtimes, both arms | Claude: controlled. Codex: same string is a LABEL, not an independent observation (Codex never receives a "permission mode" concept) — same caveat as Evidence1 |
| Execution profile (id / isolation kind / network mode / policy mode) | `sandboxed-unrestricted-v1` / `external-sandbox` / `restricted` / `not_applicable` | Same | `execution-profiles/registry.json:15-29`; `scenario-campaign-plan.mjs:29-30,46-47` (`PRODUCT_CONTROL_CELLS`, both cells pinned to this profile id) | `execution_profile.{id,sha256,isolation_kind,network_mode,policy_mode}`; audit `execution_profile_id`, `policy_mode` | Yes — all four sub-fields identical across **all 16 cells** (`sha256 = f5ed5ed9be6fdf7f03998c366e3cee3ab06e61783ae7fe510feecf487cb21292` on every one) | controlled |
| Isolation attestation | `8f706cafa2f33cafc10d2707c43da81bd0d10ed9092c64b7ef6a711faa71d3fc` | `7f426f539b1b93cf38c95798435f6ad60b5114e0a3202084a89bdb34a9aa4aaf` | `execution-profiles/isolation-attestation.mjs` (self-declared attestation file per runtime) | `execution_profile.isolation_attestation_sha256`; audit `isolation_attestation_sha256` | Identical *within* each runtime across all 8 of its cells; differs *between* runtimes (expected — separate attestation files) | controlled (per runtime) |
| PreToolUse policy hook | None fires for this profile | n/a | `condition-launcher.mjs:54-60` (`policyHookEnabled` gate: "a `policy_mode:'not_applicable'` profile compiles settings with NO PreToolUse hook at all") | `policy_sha256 = null`, `hook_call_count = null`, `hook_deny_count = null` on all 16 cells | Yes (null everywhere, consistent with `policy_mode = not_applicable` on every cell) | controlled (absence is intentional, verified by the profile's own `policy_mode` on all 16 cells) |

### E. Prompt, treatment, isolation guarantee

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Scenario prompt (pre-treatment) hash | `20d8ca3cb253915641efee31f5f8305e338aeede43938b63df69015b9aba6ab5` (1762 bytes) | Same | `corpus/scenarios/coverage-threshold-failure-v2.json:8` (the `prompt` field, D5-renamed `total`→`test_count`) | `skill_observation.treatment_size.{prompt_sha256,prompt_bytes}` | **Yes — identical across all 16 cells, both runtimes, both arms** (same scenario, same pre-treatment text regardless of condition) | controlled |
| Delivered (post-treatment) prompt hash, per condition | Product: `1271d996038a544e79d0613738e41e4916cefe437c25a411ed4bedce87f36ff6` (constant, 4/4). Free: `20d8ca3cb253915641efee31f5f8305e338aeede43938b63df69015b9aba6ab5` (constant, 4/4 — equals the pre-treatment hash, correctly, since free adds no wrapper) | Product: `fdf8159debbe0d548764d70a694a977d29424fb4813ccaf501dcdc64b357f7c9` (constant, 4/4). Free: same value as Claude's free hash (constant, 4/4) | `product-treatment.mjs` (`applyExplicitProductTreatment`), invoked from `matrix-runner.mjs` | `delivered_prompt_sha256` (schema v9 — **new vs Evidence1, which only ever hashed the pre-treatment prompt**) | Within each (runtime, condition) cell: yes, 4/4. Free-arm hash matches **across runtimes** too (both reduce to the untouched scenario prompt) | controlled |
| Treatment wrapper text | Prepends a fixed 273-byte-class directive (`"Before any Bash call, invoke the Skill tool with skill ..."`) | Prepends `$kmp-test-runner` then a blank line | `product-treatment.mjs` | Not the wrapper text itself; see `treatment_delivery_sha256` below | Text differs by design between runtimes (this is the treatment, not a control) | controlled (intentionally runtime-specific) |
| `treatment_delivery_sha256` (hash of the delivered skill/plugin content) | Product: `76cad6804fbb3e67e5e0602edef5b1c97d3cc1f29772b12d99daae8b73403d02` (constant, 4/4). Free: `null`, reason `"condition-no-skill"` | Product: **same value as Claude's**, `76cad680...` (constant, 4/4). Free: `null`, reason `"condition-no-skill"` | Preregistration §5 (new vs Evidence1) | `treatment_delivery_sha256.{value,reason}` | Product-arm value identical **across both runtimes** (both deliver the same underlying skill snapshot); free arm null with a stated reason on all 8 free cells | controlled |
| Isolation guarantee (D4) — is the ground truth ever on the guest? | No, for any cell, either arm | No, for any cell, either arm | `docs/audits/evidence2-preregistration.md:78-99` (D4): `corpus/expected/<id>.json` stays host-side only; `isolation-probe.mjs` blocks dispatch on a leak, pre-session, per cell | Not a per-cell record field (a probe failure would block dispatch entirely, producing no cell at all) | All 16 cells exist and are accepted, which is consistent with (but not, by itself, positive proof of) the probe having passed 16/16 times — this audit did not re-run `isolation-probe.mjs` | controlled by design; **new vs Evidence1**, which had no equivalent guarantee at all (that gap was Evidence1's own audit's HIGH-severity item 1) |

### F. Skills, plugins, MCP, hooks, environment

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Skill pin (`skill_source_sha`) | Product: `27c943dc392675f78209a78ce09adb4f79283e3e` (constant, 4/4). Free: `null` (constant, 4/4) | Same pattern, same sha, same runtime-shared skill snapshot | Skill snapshot materialized once per cell from the pinned tag; delivered via `--plugin-dir` (Claude, `condition-launcher.mjs:144-157`) or copied into `.agents/skills/` (Codex, `codex-cli.mjs:250-260`) | `skill_source_sha`; `skill_observation.source_sha`; `skill_observation.treatment_size.{snapshot_sha256,snapshot_bytes,snapshot_file_count}` = `e9c3973a.../242311/28` on every product cell, both runtimes | Product-arm value identical across **both runtimes**, all 8 product cells; free arm null on all 8 free cells | controlled |
| Ambient (non-target) skills — count | 16 (constant, 8/8) | 5 (constant, 8/8) | Whatever the runtime/state dir exposes; not set by the harness | `ambient_skill_profile.count` | Yes, within each runtime, both arms | uncontrolled-constant (same counts Evidence1 observed on the same host images) |
| Ambient skills — identity | 16 distinct `scope_id`s across the 8 Claude cells | 5 distinct `scope_id`s across the 8 Codex cells | `ambient_skill_profile.scope_id` is minted fresh per invocation | `ambient_skill_profile.{scope_id,fingerprint_hmac}` | **No** — a fresh scope/HMAC key per cell makes cross-cell identity unverifiable, even though the count matches. Same gap Evidence1's audit flagged (F2), unchanged in Evidence2 | uncontrolled-constant (count verified; identity unverifiable) |
| Plugins (Claude) | Exactly one, bound to the skill snapshot, product cells only | n/a | `condition-launcher.mjs:144-157` (`buildConditionArgv`, appends `--plugin-dir` iff `condition === 'current-skill'`); `--setting-sources ''` excludes any ambient enabled plugin | Implied by `skill_available`/`skill_observation`; not a distinct field | No: this is the treatment (by design) | controlled |
| MCP servers | Zero (`--strict-mcp-config`, no `--mcp-config`) | None configured (`--ignore-user-config`) | `condition-launcher.mjs:129`; `codex-cli.mjs:300` | No per-cell field. Claude is gate-verified via the init event (`stream-parser.mjs:460`: rejects if `mcp_servers.length !== 0`, confirmed present at `c15aae3`). Codex has no equivalent check | Consistent mechanism across all 16 cells | Claude: controlled (gate). Codex: set-not-recorded (unverified) |
| Hooks | `PostToolUse`/`PostToolUseFailure` → `junit-evidence-hook.mjs` (scenario's outcome kind counts as JUnit evidence); no `PreToolUse` (per D row above) | `.codex/hooks.json`, `PostToolUse` matcher `^Bash$` → same hook script, 10 s timeout | `condition-launcher.mjs:62-76`; `codex-cli.mjs:134-143` | `hook_call_count`/`hook_deny_count` stay `null` on all 16 cells (these track *policy*-hook accounting, not the JUnit-evidence hook, which is a different mechanism) | Mechanism constant | set-not-recorded [code] |
| Env allowlist — profile label | `"narrow"` | `"narrow"` | Hard-coded label, `cli.mjs:1322`-class constant (not independently re-verified line-by-line this pass) | `env_allowlist_profile` | Yes, all 16 cells | set-not-recorded (a label, not a verification — same caveat Evidence1 raised) |
| Env allowlist — actual key **names** | Product: 29 names (constant, 4/4). Free: 24 names (constant, 4/4) | Product: 24 names (constant, 4/4). Free: 19 names (constant, 4/4) | `env-builder.mjs`'s `buildEvalEnv`; `condition-launcher.mjs:178-195` (`buildSharedEnv`) | `env_keys` (schema v9 array — **new vs Evidence1, which had no key-name field at all, only the "narrow" label**) | Within each (runtime, condition) group: yes, byte-identical sorted sets, 4/4. See Note F7 for the exact diff | **controlled — this closes Evidence1's own G1 gap** (env key set is now a real, directly comparable field, not just a label) |

**Note F7 (env key names, verified by set-diff over all 16 `env_keys` arrays).** Free cells lose
exactly the same 5 keys relative to their runtime's product cells, both runtimes:
`KMP_EVAL_EXPECTED_FIXTURE_ROOT`, `KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS`,
`KMP_EVAL_JUNIT_EVIDENCE_DIR`, `KMP_EVAL_JUNIT_EVIDENCE_TASK`, `KMP_EVAL_TEMP_HOME` — matching the
`/^KMP_(EVAL|TEST)_/i` stripping rule Evidence1's audit already documented (its Note 5/G1),
confirmed unchanged in Evidence2. `AGENTIC_EVAL_*` keys are **not** stripped in the free arm (present
in both conditions, both runtimes). Claude carries 5 Claude-only keys Codex never has
(`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`, `CLAUDE_CODE_GIT_BASH_PATH`,
`CLAUDE_CODE_USE_POWERSHELL_TOOL`, `CLAUDE_CONFIG_DIR`) plus the Claude-only live-spawn-preflight
variable `KMP_AGENTIC_EVAL_LIVE_SPAWN_PREFLIGHT` (present in **both** Claude arms, same as Evidence1
found); Codex carries `CODEX_HOME`, which Claude never has. All of this is runtime-appropriate and
symmetric by design, not a gap — recorded here because Evidence1 could not verify any of it directly.

### G. Product, scenario, and Gradle/host environment

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Product version and source sha | `0.16.0` / `c15aae3daf1ff9428c3d88e336047d3baf042717` | Same | `docs/audits/evidence2-preregistration.md:109-114` (D1); confirmed against the real merged binary per that same passage | `kmp_test_cli_version`, `kmp_test_cli_source_sha` | Yes — identical on **all 16 cells** | controlled |
| Scenario and its source commit | `coverage-threshold-failure-v2`; NowInAndroid `7d45eae4f8720a0c77f507712ba2437ff974b6ed` | Same | `corpus/scenarios/coverage-threshold-failure-v2.json:3-7` | `scenario_id`, `project_alias`, `project_commit`, `project_url` | Yes — identical on **all 16 cells** | controlled |
| Gradle user-home properties SHA-256 | `4d8794cd187e680485b0e9abfa2f41c58b61b7e45a478450a4c84342947bc8f7` | Same | `materialize.mjs:438-449` (`GRADLE_USER_HOME_CANONICAL_PROPERTIES`, a **fixed 5-key constant**: `org.gradle.daemon=false`, `org.gradle.java.installations.auto-download=false`, `org.gradle.configuration-cache=false`, `org.gradle.jvmargs=...-Xmx3g`, `kotlin.daemon.jvmargs=...-Xmx2g`); hashed and written at `materialize.mjs:486,493`; fail-closed guard against an unexpected key at `materialize.mjs:458-464` | `gradle_memory_override_sha256` | **Yes — byte-identical on all 16 cells**, and independently confirmed in `docs/audits/evidence2-preregistration.md:774-782` (Amendment A5 §5) as byte-exact to the pre-incident round-2 value | controlled. Note: because the hashed content is a hard-coded constant (not a hash of the seed's actual dependency cache), this control necessarily *cannot* vary across cells — a strong but narrow guarantee: it proves the daemon/memory *override* was applied identically, not that the underlying seeded cache itself was byte-identical every time (that remains set-not-recorded, same gap as Evidence1's H2) |
| Gradle cache state label | `"cold"` | `"cold"` | `cli.mjs:1335` (`cache_state: isScenario ? 'cold' : 'unknown'` — a hard-coded literal, confirmed at `c15aae3`, unchanged from the mechanism Evidence1's audit already flagged as mislabelled) | `cache_state` | Yes, all 16 cells | set-not-recorded (mislabelled) — the seed is reused/warm in practice, same caveat Evidence1 raised, not re-litigated in depth here |
| Host/VM profile | 4 vCPU, 12 GiB static RAM, no dynamic memory | Same (shared VM) | `tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json:7,10-14` — `"name": "Evidence1-Runner-E2E"`, `"processor_count": 4`, `"startup_memory_bytes": 12884901888`, `"dynamic_memory": false` | `vm_name` [manifest]; the VM spec itself is not a per-cell field | One shared VM, so trivially identical across all 16 cells | controlled — **but see the memory history below, flagged prominently** |
| **Host/VM memory — history (flagged; the figure changed twice during setup, before any live session)** | n/a | n/a | `docs/audits/evidence2-preregistration.md:649` (Amendment A4, finds the VM was `8589934592` bytes / 8 GiB, fixed, non-dynamic, causing repeated "Gradle build daemon disappeared unexpectedly" faults against NiA's own 8 GiB of committed daemon heap); `:707` (Amendment A5 round 3, tried 16 GiB, VM then failed to start — "No se pudo inicializar la memoria" — reverted); `:774` (Amendment A5 §5, final validated value: 12 GiB, `12884901888`, committed to the JSON file at `07e5d1f`) | n/a | n/a — this is a pre-campaign provisioning history, not a per-cell value | uncontrolled-constant; **the 8 GiB figure is still what `infra-flake-classifier.mjs`'s own source comments cite** (lines 51-56 of that file) even though the provisioning file and the actual campaign both correctly used 12 GiB — a stale comment, not a live discrepancy (see Asymmetries) |

### H. Design, order, and seed

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Seed | `20260929` | `20260929` | `manifest.json` field `seed` [manifest]; passed through to `matrix-runner.mjs` | `seed` | Yes, all 16 cells | **recorded but inert** — `scenario-campaign-plan.mjs:61-67,90-101` defines the cell order as a hard-coded literal array (`[[A,B],[B,A],[B,A],[A,B]]`) for both `claude-product-vs-free-baseline-v1` and `codex-product-vs-free-baseline-v2`; no seed ever reaches a shuffle or a provider |
| Arm order (within each runtime) | `[[A,B],[B,A],[B,A],[A,B]]`, order_index 0,3,5,6 = product; 1,2,4,7 = free | Same literal order and same index/condition mapping | `scenario-campaign-plan.mjs:61-67` (Claude design), `:90-101` (Codex design) | `order_index`, `repetition_index`, `condition` | **Verified over all 16 cells**: `order_index` sets for "product" and "free" are identical between the two runtimes, and match `manifest.json`'s `round_order` array position-for-position (`round_order[i]` = `"product"`/`"free"` exactly matches which condition ran at `order_index=i` in both runtimes, for all `i` in 0..7) | controlled |
| **D7 — runtime dispatch alternation (new vs Evidence1, verified against this campaign's real timestamps, not the design doc's own worked example)** | See timeline in Note H3 | See timeline in Note H3 | `docs/audits/evidence2-preregistration.md:21-29` (D7); mechanism described as `evidence1-run.ps1`'s `Invoke-E1RunLiveRunningState` via `evidence1-run-manifest-contract.psm1`'s `Get-E1RunManifestExpectedCells` (not independently re-traced by this audit — see §0) | Reconstructed from `started_at` across all 16 records, not from any single "dispatch order" field | **Confirmed alternating on all 8 order_index pairs of this campaign** (see Note H3) — Evidence1 ran Claude first every round without exception; this campaign alternates first-mover every single pair | controlled — genuinely new and genuinely verified working, not just designed |

**Note H3 (D7, the real dispatch timeline for campaign `48458826-...`, sorted by `started_at`).**
Every row pairs one Claude cell with the Codex cell at the same `order_index` (same arm, by
design — see the Arm-order row above); the **first-mover alternates on every single pair**:

| order_index | condition | 1st to start | 2nd to start |
|---|---|---|---|
| 0 | product | claude-code-0 | codex-cli-0 |
| 1 | free | codex-cli-1 | claude-code-1 |
| 2 | free | claude-code-2 | codex-cli-2 |
| 3 | product | codex-cli-3 | claude-code-3 |
| 4 | free | claude-code-4 | codex-cli-4 |
| 5 | product | codex-cli-5 | claude-code-5 |
| 6 | product | claude-code-6 | codex-cli-6 |
| 7 | free | codex-cli-7 | claude-code-7 |

Claude leads on the even-numbered pairs (0,2,4,6), Codex leads on the odd-numbered ones (1,3,5,7) —
a clean, complete alternation across all 8 pairs of this specific campaign, independently confirmed
from the records themselves rather than taken on the design document's word. The campaign's own
observed `LiveRunning` window (min `started_at` to max `ended_at` across all 16 cells) is
`2026-09-29T23:51:47.578Z` to `2026-09-30T01:22:48.816Z`, about 1 h 31 min.

### I. Measurement instruments and host discipline

| Control | Claude Code value | Codex CLI value | Where set (file:line) | Recorded in (field) | Identical across arms? (verified over N cells) | Class |
|---|---|---|---|---|---|---|
| Infra-flake classifier — version and D9 logic hash | n/a (campaign-level tool, not per-runtime) | n/a | `infra-flake-classifier.mjs:32` (`INFRA_FLAKE_CLASSIFIER_SCHEMA = 1`), `:37` (`INFRA_FLAKE_CLASSIFIER_VERSION = 1`); frozen values recorded in `docs/audits/evidence2-preregistration.md:1054-1062` (Amendment A9 §3): `logic_sha256 = f91985672fcc1df147f2b3e56c11ca104f870502dac8bba4e8ed524235590b0f` | Not written into any per-cell record (a separate, standalone script — see its own header comment, lines 4-9) | **Independently recomputed this pass** from the checked-out module: `classifier_version = 1`, `logic_sha256 = f91985672fcc1df147f2b3e56c11ca104f870502dac8bba4e8ed524235590b0f` — **matches the frozen D9 value exactly** | controlled, and verified by execution, not just by reading the preregistration's claim |
| Infra-flake classifier — result for **this** campaign (verified by execution this pass, not assumed from the canary) | n/a | n/a | Ran `node tools/agentic-eval/infra-flake-classifier.mjs <campaign-dir>` read-only against the real 16-cell private evidence root | Not part of `record.json`/`audit.json`; this audit's own run is the only record of it having been executed against campaign `48458826-...` specifically (the preregistration's own A9 §3 only reports canary 2's result, a different, 4-cell run) | **16/16 cells: `infra_flake_suspected: false, reason: "clean"`. Rollup: 0 flagged / 0 absorbed / 0 unrecovered / 0 unknown, for all 4 (runtime × arm) groups** | controlled — clean, and now directly verified against the actual campaign rather than only against the canary |
| `num_turns` — value | Varies per session (assistant-turn count: e.g. 5,8,12,16,17 observed across the 16 cells) | Exactly `1` on **all 8 cells**, both arms | Claude: the runtime's own result event. Codex: `codex-cli.mjs:415` (`turnCount: ... events.filter(e => e.type === 'turn.started').length`) — one non-interactive `exec` call is one turn, by construction | `num_turns.value` | Codex: yes, trivially (always 1). Claude: no, varies per cell | Codex: controlled but degenerate (not a capability signal). Claude: uncontrolled-variable (real behavior) — **see Asymmetries: this is not a cross-runtime metric (Amendment A9 §5)** |
| Cost accounting method | `total_cost_usd.value = null` on all 8 cells, reason `"not present on this runtime's result event schema"` | `total_cost_usd.value = null` on all 8 cells, reason `"no_cost_reporting"` | `docs/audits/evidence2-preregistration.md:189-211` (D12); confirmed as the campaign's real (not fallback) path at `:1087-1094` (Amendment A9 §6) | `total_cost_usd.{value,reason}` | **Yes — `null` on all 16 cells**, confirming D12's token-based estimate (`cost-estimate.mjs`) is the only cost figure that exists for either runtime | controlled — **see Asymmetries: this is a token-based estimate for both runtimes, not billed spend for either** |
| Tool/effort accounting | Every tool use counted | Only `command_execution` items counted (`codex-jsonl-parser.mjs`-class logic, unchanged mechanism from Evidence1's J2) | `codex-cli.mjs:349-378` (`toolAttempts` built only from `commandAttempts`) | `tool_calls_total`, `shell_commands_total`; audit `tool_calls[].tool_kind` | Mechanism constant across all 16 cells | Partial/biased if a session uses non-shell items (file edits, web search) more in one arm — same caveat Evidence1 raised (J2), unchanged |
| `result_subtype` vs. semantic `success` (clarification, not a control per se) | `"success"` on all 8 cells regardless of `success`/`task_outcome_matched` | Same | `codex-cli.mjs:386` (`resultSubtype: ... 'turn.completed' ? 'success' : ...`) | `result_subtype.value` | Yes, `"success"` on **all 16 cells**, including the 8 free-arm cells where `task_outcome_matched = false` | n/a — documented here only to head off a misread: `result_subtype` reports whether the CLI process completed normally, not whether the agent's answer was graded correct |
| **Host quiescence during the campaign's own `LiveRunning` window** | n/a (campaign-level) | n/a | `docs/audits/evidence2-preregistration.md:1096-1103` (Amendment A9 §7) — a **process commitment**: "the campaign's own LiveRunning window will be held to the same discipline" the canary used | Not a record field of any kind | **Not recorded.** A9 §7 states this session's own action log confirmed quiescence *for canary 2's* window (`2026-09-29T23:01:17Z`–`23:23:47Z`); no equivalent action-log artifact for the **campaign's own** window (`23:51:47.578Z`–`01:22:48.816Z`, Note H3) was available to this audit | **set-not-recorded, classed honestly as a preregistered operational commitment, not a verified-for-this-campaign fact** — the only independently-checkable proxy this audit has is that all 16 sessions completed with `terminated: false` and no timeout-adjacent durations (max 415433 ms against an 1,800,000 ms cap), which is consistent with an unconstrained host but does not itself prove quiescence |

---

## 2. Asymmetries and caveats

These are true by design or by platform difference, not defects — listed so a reader never mistakes
one for a capability finding. Several were also called out inline in §1; gathered here per the
assignment.

1. **Equal effort label, not equal compute.** Both runtimes now request reasoning effort `"high"`
   (Amendment A7, §A above) — but `high` is a provider-defined label, set through two different
   mechanisms (a literal harness-pinned CLI flag for Claude, `condition-launcher.mjs:128`, vs. a
   model-registry default for Codex, `models/registry.json:50`), calibrated independently by two
   different vendors. Equal labels do not imply equal effective reasoning compute, latency, or
   quality between the two products. The preregistration itself is explicit on this point
   (`evidence2-preregistration.md:130-131`, D2's closing sentence).
2. **`num_turns` is not a cross-runtime metric (Amendment A9 §5, `evidence2-preregistration.md:1076-1086`).**
   Codex CLI reports exactly `1` on every cell, by construction of how its `exec` mode counts turns
   (one non-interactive session, one `turn.started` event, `codex-cli.mjs:415`); Claude Code counts
   real assistant turns within the session (this campaign observed values from 5 to 17). This is two
   runtimes defining "turn" differently at the CLI level, not a capability or efficiency difference —
   never compare it across runtimes, only report it per runtime (§I above).
3. **Cost is a token-based estimate for both runtimes; Claude's own provider cost is absent under
   OAuth.** `total_cost_usd` came back `null` on all 16 cells, both runtimes (§I above) — Claude's
   reason string is explicitly schema-absence "under OAuth" (`evidence2-preregistration.md:1090-1092`,
   Amendment A9 §6); Codex's is `"no_cost_reporting"`. `cost-estimate.mjs`'s published per-token
   pricing (D12, `evidence2-preregistration.md:189-211`) is therefore the *only* cost figure either
   runtime has, not a fallback for one used alongside real billing for the other. D12 also records
   that Codex's own uncached-input rate is genuinely ambiguous at the API level (OpenAI's own pricing
   tooltip: input tokens are either plain input, cached input, or a cache write, and Codex's usage
   event never reports which) — so any Codex cost figure is a *range* (input-rate to cache-write-rate
   bound), never a single point estimate, while Claude's is a single figure.
4. **The Codex base-vs-launch version-pin gap is a real, currently-unreconciled discrepancy between
   two documents, not a live control failure.** `tools/evidence1/provisioning/README.md:26` and that
   same directory's `evidence1-windows-hyperv-e2e-v1.json` toolchain entry both state the
   provisioned/checkpointed base image ships Codex CLI `0.153.4`. The harness's own launch script
   (`evidence1-dual-condition-canary-launch.ps1:21-22,329-330`) pins and expects `0.154.0`, and all 8
   Codex cells in this campaign in fact ran `0.154.0` (`agent_runtime.cli_version`, §B above) —
   consistent with the launch pin, not the provisioning README. Nothing in the campaign itself is
   uncontrolled by this (all 8 Codex cells agree on `0.154.0`), but the two documents disagree about
   what "the" pinned Codex version is, and this audit found no third file reconciling them (e.g. an
   in-VM upgrade record). Flagged for whoever next touches the provisioning docs.
5. **The `test_count` construct caveat (ground truth is `individual_total`, 2 methods × 2 build
   variants = 4 executions).** The scenario's target module has exactly 2 `@Test` methods, each run
   under 2 Gradle build variants (`testDemoDebugUnitTest`, `testProdDebugUnitTest`), for 4 total test
   executions — kmp-test's own `individual_total` field, which is what D5's grader actually checks
   (`evidence2-preregistration.md:161-172`, and `corpus/scenarios/coverage-threshold-failure-v2.json:8`'s
   own prompt text, which asks for "the number of individual test methods that ran, not a build
   tool's own task-dispatch count"). All 8 free-arm cells (both runtimes) instead reported `2` — the
   count of distinct `@Test` methods, a differently-scoped but internally defensible reading of the
   prompt's own wording. This is a construct gap in what the prompt asks vs. what the grader checks,
   not a free-arm capability failure; see this directory's `README.md`, "Full-answer match: why the
   gap is definitional," for the full per-field breakdown.
6. **A stale source comment, not a live discrepancy.** `infra-flake-classifier.mjs` (lines 51-56)
   documents the Gradle daemon-disappeared root cause using an **8 GiB** VM figure
   (`startup_memory_bytes: 8589934592`) from Amendment A4's own finding
   (`evidence2-preregistration.md:649`). The VM was subsequently moved to 16 GiB (failed to boot,
   `:707`) and finally locked at **12 GiB** (`evidence2-preregistration.md:774`,
   `tools/evidence1/provisioning/evidence1-windows-hyperv-e2e-v1.json:11`,
   `startup_memory_bytes: 12884901888`) before any canary or campaign session ran. The classifier's
   own two regexes are unaffected by this (they match transcript text, not VM specs), and this
   audit's live re-run against the real campaign (§I above) found zero daemon-disappeared or jarfs
   signatures — but the comment itself is stale relative to the config it describes and should be
   updated if that file is touched again.
7. **Publication-staging path leak (out of scope for this audit's own fix, noted once).** As stated
   in §0, the pre-publication `public/` copy of at least one cell's `record.json` still carries an
   absolute host path in `resolved_kmp_test_executable_path`, unsanitized, at the snapshot this audit
   read. Not reproduced here; flagged for the actual publication step (D10).
8. **Inherited, not re-audited in depth here.** Evidence1's own controls audit raised several items
   this campaign's design does not specifically target: Codex's `model_resolved` being an echo
   rather than an independent observation (§A above); no dated model-snapshot pin for either runtime
   (§A above); the `cache_state:"cold"` label being a hard-coded literal rather than a real
   cold/warm observation (§G above, confirmed unchanged at `cli.mjs:1335`); and the free arm's
   skill-snapshot-and-shim still existing as filesystem siblings of its own workspace on every
   invocation (this audit did not re-verify `matrix-runner.mjs`'s exact mechanism for this pass —
   see the main `README.md`'s own "Threats to validity" section, which states the D4 change does not
   close this specific, softer exposure). None of these are re-litigated at the same depth here; they
   are carried over, not silently dropped.

---

## 3. Method

- Read every code file cited above at `c15aae3` via `git show c15aae3:<path>`, not from a working
  tree that might have moved on.
- Parsed all 16 cells' `record.json` and `audit.json` (32 files) programmatically to compute every
  "identical across N cells" claim in §1 — no claim above rests on fewer than the stated N.
- Cross-checked every `order_index`/`condition` pairing against `manifest.json`'s `round_order` array
  and against `scenario-campaign-plan.mjs`'s hard-coded design tables — full agreement, position for
  position, both runtimes.
- Reconstructed the real dispatch timeline (Note H3) from `started_at` across all 16 records, rather
  than relying on the preregistration document's own worked example (which verifies the D7 mechanism
  against a *different* campaign id, `583a708d-...`, not this one).
- Ran `tools/agentic-eval/infra-flake-classifier.mjs` directly against the real campaign directory
  (read-only: it only reads `manifest.json`, `record.json`, and `transcript.jsonl` per cell, and
  writes only to stdout) and independently recomputed its `logic_sha256` from the checked-out module,
  confirming both the campaign result (16/16 clean) and the frozen D9 hash the preregistration cites.
- Did not open or grep any cell's raw `transcript.jsonl` beyond what the classifier itself reads
  programmatically — this audit is a controls/provenance audit, not a transcript review.
- Did not re-run `isolation-probe.mjs`, `campaign-summary.mjs`, or `cost-estimate.mjs`; where this
  document cites their behavior it is from reading their source at `c15aae3` plus the preregistration
  document's own account of running them.

# Evidence1 controls audit (read-only)

Date: 2026-09-28. Checkout: `agentic-eval-codex-runtime` @ `15ad0dd` (branch
`codex/agentic-eval-codex-runtime`). No repository file was modified.

This is the full backing detail for the "Experimental controls and threats to validity" section of
the main evidence document (`evidence1-agentic-benchmark-2026-09-28.md`), which distills this into a
compact table and a ranked list. Read this file for every citation and the complete per-parameter
breakdown; read the main document for the summary a reader needs to correctly bound this benchmark's
claims.

## 0. Provenance and scope

- **Code read = code executed.** All four canary records carry `repo_commit` /
  `kmp_test_cli_source_sha` = `bbefc600`. `git diff --stat bbefc600 15ad0dd` touches only
  `docs/audits/evidence1-preregistration.md`. None of the records carries a `dirty_measured_code`
  or `dirty_harness_tooling` error.
- **The live path** that produced campaign `7867b2bc` runs as follows:
  1. The host runs `evidence1-run.ps1`, which calls `docs/audits/evidence1-provider-runtime-real.psm1:282`.
  2. That calls the guest bundle `run-agentic-eval-session` (`docs/audits/evidence1-guest-bundle-contract.psm1:429-452`).
  3. The bundle dot-sources `docs/audits/evidence1-dual-condition-canary-launch.ps1 -InternalLibrary` and calls
     `Invoke-E1DualConditionCanarySession` (launch.ps1:186-304).
  4. The launcher runs `node tools/agentic-eval/cli.mjs run --campaign-design … --campaign-cell-index … --timeout-ms …` (launch.ps1:207).
  5. That reaches `cmdRunCampaign` (cli.mjs:3763), then `runScenarioCampaign` (matrix-runner.mjs:771).

  Each cell is its own `cli.mjs` invocation.
- **Not the live path.** The top-level `Live` mode of launch.ps1 is disabled (launch.ps1:320-322).
  Its legacy code (`Get-E1SlotArguments`, the compact Gradle seed and the private `TEMP` at
  launch.ps1:563-592) did **not** run. The live session path uses the full donor `.gradle` and the
  inherited `TEMP`.
- **Records checked:** campaign `7867b2bc`'s private evidence root, `{claude-code-0,
  claude-code-1,codex-cli-0,codex-cli-1}\{record,audit}.json` plus `manifest.json`. The public set
  (`public.publication.ready.json`) contains only the 8 record and audit files. `manifest.json`
  is **not** published, so values that exist only in the manifest are not in the published data.
- **Arm labels.** A = product (`current-skill`, `product-assisted`). B = free baseline
  (`no-skill`, `free-baseline-no-product`).

### Classification legend

- **CONTROLLED**: set by harness or launcher, and present as an explicit per-cell field in
  record.json or audit.json. "(gate)" means verified per cell by the acceptance gate: an accepted
  cell proves it, but no value is stored.
- **SET-NOT-RECORDED**: set explicitly, but there is no per-cell field. The value is recoverable
  only from:
  - `repo_commit`, for code constants (marked [code]); or
  - the unpublished `manifest.json` (marked [manifest]).
- **UNCONTROLLED-CONSTANT**: not set. The value is fixed by CLI version, project commit or VM
  image.
- **UNCONTROLLED-VARIABLE**: not set, and can vary between cells or arms.
- Extra flags:
  - **NOT-DELIVERED**: set by the launcher but stripped before the session.
  - **ECHO / LABEL**: the recorded field restates configuration or a hard-coded constant. It is
    not an observation.

### Observed canary values (from the 4 records)

| field | claude A (`claude-code-0`) | claude B (`claude-code-1`) | codex A (`codex-cli-0`) | codex B (`codex-cli-1`) |
|---|---|---|---|---|
| model requested / resolved | claude-sonnet-5 / claude-sonnet-5 | same | gpt-5.6-terra / gpt-5.6-terra (echo) | same |
| cli_version | 2.1.238 | 2.1.238 | 0.154.0 | 0.154.0 |
| execution_profile.sha256 | f5ed5ed9… | f5ed5ed9… | f5ed5ed9… | f5ed5ed9… |
| isolation_attestation_sha256 | ea3077fd… | ea3077fd… | ae1d01e7… | ae1d01e7… |
| prompt_sha256 (pre-treatment) | b0a7f797… (1636 B) | same | same | same |
| snapshot_sha256 | e9c3973a… / 242,311 B / 28 files | null | e9c3973a… | null |
| ambient skills count / scope_id | 16 / 26c13140… | 16 / b753d80c… | 5 / 45a9a4a8… | 5 / 9a0ae605… |
| seed / order_index / repetition_index | 20260928 / 0 / 0 | 20260928 / 1 / 0 | 20260928 / 0 / 0 | 20260928 / 1 / 0 |
| started_at (UTC) | 15:39:08 | 15:48:51 | 15:43:50 | 15:54:23 |
| wall_clock_ms | 186,930 | 242,911 | 215,001 | 245,898 |
| usage in / cached / cache_write / out / reasoning | 8 / 68,205 / 31,129 / 971 / null | 34 / 472,225 / 43,518 / 5,800 / null | 185,724 / 150,528 / null / 1,516 / 662 | 330,913 / 299,520 / null / 2,994 / 707 |
| tool_calls / shell_commands | 3 / 2 | 16 / 16 | 5 / 5 | 10 / 10 |
| terminated / exit_code | false / 0 | false / 0 | false / 0 | false / 0 |
| permission_mode_used | bypassPermissions | bypassPermissions | bypassPermissions (label) | bypassPermissions (label) |
| cache_state / daemon_policy / env_allowlist_profile | cold / disabled-via-gradle-user-home-properties / narrow | same | same | same |

---

## 1. Controls table

In each section:
- The two value columns are "A / B"; "=" means B equals A.
- "A=B?" means identical across arms within the runtime.
- Line references are to `tools/agentic-eval/` unless another path is given.
- `launch.ps1` means `docs/audits/evidence1-dual-condition-canary-launch.ps1`.

### A. Model and inference

| # | Parameter | Claude (A / B) | Codex (A / B) | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| A1 | Model id | `claude-sonnet-5` / = | `gpt-5.6-terra` / = | Yes. Registry default (`models/registry.json:6,46`), then manifest `runtimes[].model_id`, then `--model` (launch.ps1:207; `condition-launcher.mjs:114`; `runtimes/codex-cli.mjs:302`) | `model_requested`, `agent_runtime.model_requested`, `model_resolved`. Claude's value comes from the init event (`claude-code.mjs:319`). Codex's is an ECHO of the configured value (`codex-cli.mjs:393-395`); Codex JSONL carries no model id | Yes | CONTROLLED (Codex `model_resolved` is an echo) |
| A2 | Alias vs pinned snapshot | Undated alias form. The same registry uses a dated id only for `claude-haiku-4-5-20251001` (:36) | Undated alias form | No snapshot pin exists | The served snapshot is not captured. Claude's per-turn `assistant.message.model` and result `modelUsage` are not extracted; for Codex it is unobservable | Same alias; the served snapshot could change during a multi-hour campaign | UNCONTROLLED-VARIABLE |
| A3 | Reasoning effort / thinking | **Not set.** The CLI 2.1.238 default applies (value not established) / = | `model_reasoning_effort="low"` / = | Claude: **no**. Registry `default_reasoning_mode: null` (`models/registry.json:10`); the adapter rejects any non-null value (`claude-code.mjs:224-229`); the argv has no effort or thinking flag (`condition-launcher.mjs:111-119`); a thinking-budget env var could not pass the allowlist (G1). Codex: **yes** (`codex-cli.mjs:302`, from `matrix-runner.mjs:831`, from `models/registry.json:50`) | No field. Proxy: `usage.reasoning_output` (Codex 662 / 707; Claude always null, `claude-code.mjs:337`). Claude thinking blocks are not counted | Yes | Claude: UNCONTROLLED-CONSTANT. Codex: SET-NOT-RECORDED [code] |
| A4 | Codex reasoning summary / verbosity | n/a | Defaults | No | No | Yes | UNCONTROLLED-CONSTANT |
| A5 | Sampling (temperature, top_p, provider seed) | Defaults | Defaults | No; neither CLI invocation exposes them | No. The recorded `seed` never reaches a provider | Yes | UNCONTROLLED-CONSTANT (stochastic) |
| A6 | Output-token cap, context window, auto-compaction | Defaults | Defaults | No (an output-token env var would be stripped) | No (`num_turns` is observed but not recorded) | Yes. Longer B sessions are more likely to hit compaction | UNCONTROLLED-CONSTANT |
| A7 | Auth mode / service tier | OAuth credentials in `CLAUDE_CONFIG_DIR` | Login in `CODEX_HOME`; ChatGPT and API-key logins are both accepted (`codex-cli.mjs:23`) | Directory yes (launch.ps1:86-91,104; `codex-cli.mjs:120-128,155-156`); mode no | No (Claude init `apiKeySource` is not extracted) | Yes | UNCONTROLLED-CONSTANT |

### B. Runtime binary and invocation

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| B1 | CLI version and pin | 2.1.238 | 0.154.0 | Yes. Pinned toolchain dirs precede the ambient PATH (launch.ps1:21-22,92-97); `claude.cmd` is resolved via PATH (`condition-launcher.mjs:32-34`). The live session path does **not** assert versions; only the disabled legacy path does (launch.ps1:305-306,422-425) | `claude_code_version`, `agent_runtime.cli_version`. Claude's is observed in the session's init event (`claude-code.mjs:321`). Codex's comes from a `codex --version` probe run once per invocation, not from the session (`codex-cli.mjs:67-75,397`) | Yes | CONTROLLED |
| B2 | Telemetry / nonessential traffic / error reporting / artifact feature | Launcher sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `CLAUDE_CODE_DISABLE_ARTIFACT=1` (launch.ps1:106-107). **All are stripped**, so CLI defaults apply | n/a | NOT-DELIVERED: the allowlist drops them (`env-builder.mjs:33-48,66-78`), verified by executing `buildEvalEnv` | No | Yes | NOT-DELIVERED, so effectively UNCONTROLLED-CONSTANT |
| B3 | CLI flags (argv) | `-p --output-format stream-json --verbose --include-hook-events --model M --setting-sources '' --strict-mcp-config --no-chrome --no-session-persistence --settings <tmp> --tools Bash,Skill --permission-mode bypassPermissions --max-budget-usd 2`. A adds `--plugin-dir <snapshot>` | `exec --json --ephemeral --color never --ignore-user-config --ignore-rules --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --enable hooks --model M -c model_reasoning_effort="low" -`. Both arms add `-c skills.config=[…enabled=false]` if an ambient kmp-test-runner skill exists on the host | Yes (`condition-launcher.mjs:111-119,137`; `claude-code.mjs:255-258`; `codex-cli.mjs:262-267,299-303`) | The argv is neither recorded nor hashed. Claude's tools, MCP and permission mode are gate-verified (D1, D2, F4) | Yes, except `--plugin-dir` (treatment) | SET-NOT-RECORDED [code] |
| B4 | Prompt transport | stdin | stdin | Yes (`condition-launcher.mjs:107-122`; `codex-cli.mjs:304`) | No | Yes | SET-NOT-RECORDED [code] |

### C. Stopping rules, budgets, timeouts

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| C1 | Spend cap | `--max-budget-usd 2` / = | **None** | Claude: manifest `max_budget_usd: 2.0`, then launch.ps1:208, then `cli.mjs:386-407,3886`, then `matrix-runner.mjs:832`, then `condition-launcher.mjs:118` (the harness default would be 0.60, `cli.mjs:380`). Codex: the flag is rejected (`cli.mjs:387-391`); manifest `null` | **No per-cell field** (manifest and dry-run JSON only, `cli.mjs:3945`). A budget-cut session is also undetectable in the record: `resultSubtype` (e.g. `error_max_budget_usd`) is not written; the scenario gate does not check it (only calibrate/smoke do, `cli.mjs:2694,3255`); cost is not recorded (`campaign-summary.mjs:406`) | Same value, but the chance of hitting it differs: canary Claude B used 6.9× A's cached input and 6.0× A's output tokens | Claude: SET-NOT-RECORDED [manifest]. Codex: UNCONTROLLED (no cap) |
| C2 | Max turns | None | None | No | No | Yes | UNCONTROLLED-CONSTANT (unbounded) |
| C3 | Provider (session) timeout | 1800 s | 1800 s | Yes. Manifest `provider_timeout_seconds`, then `--timeout-ms 1800000` (launch.ps1:207; `cli.mjs:3778-3787`), then a timer that kills the process tree (`condition-launcher.mjs:281-286`) | The limit is not recorded (manifest only). A hit is recorded: `terminated`, `termination_reason`, `exit_code` | Yes | SET-NOT-RECORDED [manifest] |
| C4 | Worker timeout | 1860 s | 1860 s | Yes. Manifest, then launch.ps1:245, then `Invoke-E1BoundedProcess` (`docs/audits/evidence1-dual-condition-canary-contract.psm1:1225-1305`). The clock covers the **whole** `cli.mjs` process (see note 1). On expiry the cell becomes `transport-failed` and no record is written (launch.ps1:244-268) | Manifest only | Yes | SET-NOT-RECORDED [manifest] |
| C5 | Guest transport timeout | 1920 s | 1920 s | Yes (`docs/audits/evidence1-provider-runtime-real.psm1:273,282-288`). The order provider < worker < transport is enforced (`docs/audits/evidence1-run-manifest-contract.psm1:142-145`) | Manifest only | Yes | SET-NOT-RECORDED [manifest] |
| C6 | Per-command (tool) timeout | Bash default and max 600,000 ms (`claude-code.mjs:162`) | Runtime default, possibly set per call by the model (value not established) | Claude yes; Codex no | No | Yes | Claude: SET-NOT-RECORDED [code]. Codex: UNCONTROLLED-CONSTANT |
| C7 | Hook timeout | CLI default | 10 s (`codex-cli.mjs:139`) | Codex yes | No | Yes | Codex: SET-NOT-RECORDED [code]. Claude: UNCONTROLLED-CONSTANT |
| C8 | Provider-client request/stream timeout and internal API retry | Defaults | Defaults | No (the related env vars would be stripped) | No retry or latency record. These inflate `wall_clock_ms` and `first_useful_signal_ms` | Not guaranteed | UNCONTROLLED-VARIABLE |
| C9 | Harness retry / cell replacement | None | None | Yes: `no_automatic_provider_retry: true` (`docs/audits/evidence1-run-manifest-contract.psm1:160`); slot-replay guard (launch.ps1:203-205); preregistration §7 | Campaign level only | Yes | SET-NOT-RECORDED (campaign level) |

**Note 1 (C4).** The worker clock covers source verification, the skill `git archive` and
validation, and three full copies of the Gradle seed (`materialize.mjs:386,395,409`). It also
covers the worktree creation, the auth preflight, the Codex catalog probe (up to 30 s,
`codex-cli.mjs:216`), the session itself, grading and cleanup.

### D. Tools, permissions, sandbox

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| D1 | Tool surface | Bash + Skill / = | Codex's built-in tools for this model (not restricted; tool set not established here) / = | Claude: `--tools Bash,Skill` (`condition-launcher.mjs:117`), gate-verified: init `tools` must equal {Bash, Skill} (`stream-parser.mjs:438-449`; `cell-integrity.mjs:206-208`). Codex: no restriction and no verification (`toolProfileMatchesExpected` is hard-wired true, `codex-cli.mjs:398`) | `tool_calls_total`, `shell_commands_total`, audit `tool_calls[]`. **Codex counts only `command_execution` items** (`codex-jsonl-parser.mjs:4,67-117`). Other item types (e.g. file-change, web-search, MCP-call) are silently ignored | Yes | Claude: CONTROLLED (gate). Codex: UNCONTROLLED-CONSTANT, partly unobserved |
| D2 | Permission / approval / sandbox | `--permission-mode bypassPermissions`; no PreToolUse policy hook | `--dangerously-bypass-approvals-and-sandbox` | Yes (`claude-code.mjs:256`; `condition-launcher.mjs:66-68`, skipped via `claude-code.mjs:140-141`; `codex-cli.mjs:301`). Claude's mode is gate-verified via init `permissionMode` (`stream-parser.mjs:447`) | `permission_mode_used` (`cli.mjs:1418`). For Codex this is a LABEL derived from `policy_mode`; Codex never received a "permission mode" | Yes | Claude: CONTROLLED. Codex: SET, recorded as a label |
| D3 | Shell that executes commands | Git Bash 2.55.0.windows.5 via `CLAUDE_CODE_GIT_BASH_PATH` (launch.ps1:105; allowlisted at `claude-code.mjs:149`); PowerShell tool off (launch.ps1:105; `claude-code.mjs:150`) | The runtime's own Windows shell choice | Claude yes; Codex no | No | Yes | Claude: SET-NOT-RECORDED. Codex: UNCONTROLLED-CONSTANT |
| D4 | Execution profile and isolation attestation | `sandboxed-unrestricted-v1`; attestation ea3077fd… | Same profile; attestation ae1d01e7… | Yes (`scenario-campaign-plan.mjs:28-31`; `execution-profiles/registry.json:15-29`; `cli.mjs:441-467`) | `execution_profile.{id, sha256, isolation_kind, network_mode, policy_mode, required_capabilities, isolation_attestation_sha256}`; audit `execution_profile_id`, `policy_mode`, `isolation_attestation_sha256` | Yes | CONTROLLED |

### E. Instructions and context

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| E1 | Scenario prompt | `coverage-threshold-failure-v2` prompt | Same | Yes (scenario JSON, then `buildInvocation({prompt})`, `matrix-runner.mjs:828-833`) | `scenario_id`; `skill_observation.treatment_size.prompt_sha256` = b0a7f797… (1636 B) in all 4 cells (`cli.mjs:4022`) | Yes | CONTROLLED |
| E2 | Treatment text (actual stdin) | A: a 273-byte instruction is prepended: "Before any Bash call, invoke the Skill tool with skill … If the Skill tool cannot load that exact skill, stop without running tests …" (`product-treatment.mjs:21`). Delivered stdin sha256 = **e7187b90…** (1909 B). B: none | A: `$kmp-test-runner` plus a blank line (`product-treatment.mjs:31`). Delivered stdin sha256 = **54bba238…** (1654 B). B: none | Yes (`matrix-runner.mjs:376-385`) | **No.** `prompt_sha256` hashes the pre-treatment prompt. Only `skill_observation.delivery_mode` is recorded; `runtimeContext.productTreatmentDelivery` is not persisted | No: this is the treatment | SET-NOT-RECORDED [code] |
| E3 | System prompt / appended instructions | CLI default (includes date and environment facts) | CLI/model base instructions plus environment context | No override in either runtime | No | Yes (the date part varies by day) | UNCONTROLLED-CONSTANT |
| E4 | Project instruction files in the fixture | The repo has no CLAUDE.md. Whether Claude 2.1.238 reads AGENTS.md is not established | NowInAndroid@7d45eae ships **AGENTS.md** (3021 B, sha256 94939757…). It includes "Commands to Build & Test … `./gradlew {variant}Test`". Codex's project-doc loading picks it up by default; the harness does not disable it | No | No; bound only through `project_commit` | Yes | UNCONTROLLED-CONSTANT (differs across runtimes) |
| E5 | Global memory/instructions inside runtime state dirs | Whatever `CLAUDE_CONFIG_DIR` holds, under `--setting-sources ''` (not established) | Whatever `CODEX_HOME` holds, under `--ignore-user-config` (not established) | No | No | Shared by both arms | UNCONTROLLED-VARIABLE (the dirs persist and can change) |

### F. Skills, plugins, MCP, hooks, settings, state

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| F1 | Target skill and version pin | A: plugin via `--plugin-dir <snapshot>`. B: absent | A: copied to `<fixture>/.agents/skills/kmp-test-runner`. B: absent, and a catalog count of 0 is enforced | Yes (note 2) | `skill_source_sha`, `skill_observation.{source_sha, delivery_mode, availability, treatment_size.snapshot_*}`, `skill_available`. Claude activation: `skill_invoked`=true, event 3. Codex activation: `not-observable` | No: this is the treatment | CONTROLLED |
| F2 | Ambient (non-target) skills | 16 / 16 | 5 / 5 | No; whatever the runtime and state dir expose | `ambient_skill_profile.count` only. The `fingerprint_hmac` is keyed per invocation (four different `scope_id`s), so identity cannot be compared across cells. The cross-cell consensus check (`cli.mjs:2973-2977`) is vacuous with one cell per invocation, and no shared `--measurement-scope-file` is passed (launch.ps1:207) | Counts equal; identity unverifiable | UNCONTROLLED-CONSTANT |
| F3 | Plugins (Claude) | A: exactly one, bound by inode to the snapshot. B: zero | n/a | Yes. `--setting-sources ''` excludes enabled plugins. Gate: `stream-parser.mjs:466-470`; `claude-code.mjs:44-62`; `cell-integrity.mjs:201-202`. The plugin manifest declares only `skills` (no hooks, commands, agents or MCP) | Implied by acceptance, plus `skill_available` | No: this is the treatment | CONTROLLED (gate) |
| F4 | MCP servers | Zero | None configured | Claude: `--strict-mcp-config` with no `--mcp-config`; gate-verified `mcp_servers == []` (`stream-parser.mjs:446`). The launcher's `ENABLE_CLAUDEAI_MCP_SERVERS=false` is stripped (harmless, given the gate). Codex: `--ignore-user-config`; not verified, and MCP items would not be parsed | No field | Yes | Claude: CONTROLLED (gate). Codex: SET-NOT-RECORDED (unverified) |
| F5 | Hooks | PostToolUse and PostToolUseFailure run `junit-evidence-hook.mjs`; no PreToolUse | `--enable hooks --dangerously-bypass-hook-trust`; `<fixture>/.codex/hooks.json` has a PostToolUse `^Bash$` hook to the same script | Yes (note 3) | `hook_call_count` and `hook_deny_count` are null (policy not applicable). Codex `hookStats` are hard-wired zeros (`codex-cli.mjs:428-435`) | Yes | SET-NOT-RECORDED [code] |
| F6 | Settings files | Only the temporary `--settings` file. User, project and local settings are excluded. Managed (enterprise) settings, if any exist on the image, cannot be excluded and are not recorded | `config.toml` and rules are ignored; the only project file is `.codex/hooks.json` | Yes (flags in B3) | No | Yes | SET-NOT-RECORDED. Managed settings: UNCONTROLLED-CONSTANT |
| F7 | Runtime state dirs | `CLAUDE_CONFIG_DIR=<harness runtime-state root>\claude` | `CODEX_HOME=<harness runtime-state root>\codex` | Path yes (launch.ps1:29,86-91,101,104; `codex-cli.mjs:155-156`); contents no | No | Shared; they persist across all cells and are never reset | UNCONTROLLED-VARIABLE |

**Note 2 (F1).** The pin is `PINNED_SKILL_SHA` = `27c943d`, which is tag v0.15.0 (`cli.mjs:98`).
The snapshot comes from `git archive .claude-plugin .skills` (`materialize.mjs:171-195`), with
sha256 e9c3973a…, 242,311 B, 28 files. Delivery is at `condition-launcher.mjs:130-143` for Claude,
and at `codex-cli.mjs:243-293` for Codex, with a fail-closed `codex debug prompt-input` catalog
probe. The CLI under test is `bbefc600`; `git diff 27c943d bbefc600 -- bin lib scripts .skills
.claude-plugin package.json` is **empty**.

**Note 3 (F5).** Claude's hooks are built at `condition-launcher.mjs:62-76`. They are enabled
because this scenario's outcome kind (`coverage_threshold_exceeded`) counts as JUnit evidence
(`matrix-runner.mjs:537-542,778`). Codex's hooks are built at `codex-cli.mjs:134-143,246-248,301-302`.
The hook writes nothing to stdout (`junit-evidence-hook.mjs:124-131`).

### G. Environment, PATH, network, product surface

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| G1 | Env allowlist | A and B: OS basics, PATH, LANG/LC_*, TEMP/TMP, JAVA_HOME, ANDROID_*, GRADLE_USER_HOME, Claude extras, BASH_*_TIMEOUT_MS | A and B: the same minus the Claude extras, plus CODEX_HOME | Yes (note 4) | `env_allowlist_profile: "narrow"` is a hard-coded LABEL (`cli.mjs:1322`); the key set and values are not recorded | **No** (note 5) | SET-NOT-RECORDED |
| G2 | Launcher env that never arrives | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, `ENABLE_CLAUDEAI_MCP_SERVERS`, `CLAUDE_CODE_DISABLE_ARTIFACT`, `GRADLE_OPTS`; also USERPROFILE, HOME, APPDATA and LOCALAPPDATA on Windows | Same: `GRADLE_OPTS` and the others | Set at launch.ps1:98-108; stripped by `buildEvalEnv` (verified by execution) | No | Yes | NOT-DELIVERED |
| G3 | PATH | A: shim first, then the base PATH. B: the base PATH minus the shim, and minus every entry that holds any kmp-test executable | Same pattern | Yes (note 6) | No (the preflight result is not persisted) | **No** (by design). Side effect: B also loses any other executable that shares a directory with a kmp-test executable on the ambient PATH | SET-NOT-RECORDED |
| G4 | Network | "restricted" (VM firewall) | "restricted"; any provider-hosted tools would run on the provider's side | Profile claim (`execution-profiles/registry.json:21`), a self-declared attestation (`execution-profiles/isolation-attestation.mjs:152`) and a campaign-level RestrictedReady check (`evidence1-run.ps1:546`). **Not re-verified per cell** | `execution_profile.network_mode` (LABEL) plus the attestation hash | Yes | CONTROLLED as a label; the per-cell egress state is unverified |
| G5 | Product-access mode | A: product-assisted. B: free-baseline-no-product | Same | Yes. Design label (`scenario-campaign-plan.mjs:29-30`); B has a fail-closed preflight over the workspace, PATH and env (`matrix-runner.mjs:116-127`; `product-access-preflight.mjs:119-160`) | `product_access_mode` (the label). The preflight checks are not persisted | No: this is the treatment | CONTROLLED (as label) |
| G6 | Filesystem neighbourhood of the workspace | The cwd is a per-cell scenario workspace directory. Its **siblings in the same temp root**: the skill snapshot (SKILL.md plus 27 reference and script files); a **runnable kmp-test shim** pointing at the harness's own `bin/kmp-test.js`; the settings and hook files; GRADLE_USER_HOME | Same, plus **`<fixture>/.codex/hooks.json` holding the absolute path of the harness checkout (i.e. the product repo)** | Created by the harness in **every** invocation, including free-baseline-only ones (note 7) | No | Present in both arms; it only matters for B | UNCONTROLLED-VARIABLE (depends on how far the agent explores) |
| G7 | Evaluation-awareness cues | Scenario-workspace-shaped paths; `AGENTIC_EVAL_*` env (A and B); a live-spawn-preflight env var (A and B); `KMP_EVAL_*` (A only) | The same, without the Claude-only variable; `hooks.json` description "agentic-eval runtime observation hooks" | Side effect of the harness | No | Mostly | UNCONTROLLED-CONSTANT |

**Note 4 (G1).** The allowlist is built from `env-builder.mjs:33-48,66-78`, the Claude extras at
`claude-code.mjs:148-152`, and explicit keys at `condition-launcher.mjs:173-180`,
`claude-code.mjs:162`, `codex-cli.mjs:156` and `matrix-runner.mjs:349-367`.

**Note 5 (G1).** A additionally gets `KMP_EVAL_TEMP_HOME`, `KMP_EVAL_EXPECTED_FIXTURE_ROOT`,
`KMP_EVAL_JUNIT_EVIDENCE_{DIR,TASK}` and `KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS`. B strips every key
matching `/^KMP_(EVAL|TEST)_/i` (`matrix-runner.mjs:102-104`), but it keeps the Claude-only
live-spawn-preflight variable.

**Note 6 (G3).** The base PATH is set at launch.ps1:92-97: toolchain dirs first, then the ambient
`$env:Path`. The shim is prepended at `condition-launcher.mjs:175`; it is defined in
`path-shim.mjs:33-62` and also redirects HOME and USERPROFILE for kmp-test. B's removals happen at
`matrix-runner.mjs:91-100,111` and at launch.ps1:179-185,212-214. B's preflight check is at
`product-access-preflight.mjs:146-147`.

**Note 7 (G6).** The snapshot and shim are created at `matrix-runner.mjs:160-163`, with paths from
`materialize.mjs:172,340` and `path-shim.mjs:34`. The agent inherits the same `TEMP`/`TMP`
(`env-builder.mjs:43`). `.codex/hooks.json` is written **after** the free-baseline preflight
(`matrix-runner.mjs:369` runs the preflight; line 370, reaching `codex-cli.mjs:246-248`, writes the
file). The preflight scans only the workspace, PATH and env (`product-access-preflight.mjs:119-160`).

### H. Build and project state

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| H1 | Project fixture | NowInAndroid `7d45eae` | Same | Yes. A fresh `git worktree add --detach` per invocation from the source template (`materialize.mjs:334-360`); origin rewritten (launch.ps1:166-178); template cleanliness checked (`cli.mjs:3608-3644`) | `project_alias`, `project_commit`, `project_url` | Yes. The worktree shares the template's refs and objects, which `git` can show | CONTROLLED |
| H2 | Gradle user home (seed / cache state) | Seeded from the donor `.gradle` | Same | Yes (note 8) | **`cache_state: "cold"` is hard-coded (`cli.mjs:1320`) and inaccurate here:** the dependency, wrapper and transform caches are warm. The seed's identity and hash are not recorded | Yes, as long as the donor does not change between invocations | SET-NOT-RECORDED (mislabelled) |
| H3 | Gradle daemon | Disabled | Disabled | Yes (`materialize.mjs:390`) | `daemon_policy` (`materialize.mjs:412`; `cli.mjs:1321`) | Yes | CONTROLLED |
| H4 | Gradle configuration cache | Disabled | Disabled | Yes (`materialize.mjs:390`; preregistration §5). The launcher's `GRADLE_OPTS` is stripped, which is redundant anyway | No | Yes | SET-NOT-RECORDED [code] |
| H5 | Project Gradle properties | Set by the project: build cache on, parallel on, `-Xms4g/-Xmx4g` for both the Gradle and Kotlin daemons | Same | No; they come from `gradle.properties` at 7d45eae. The harness overrides only daemon and config-cache, and its `gradle.properties` drops the donor's `org.gradle.java.installations.auto-download=false` | No; only through `project_commit` | Yes. A also gets kmp-test's own `--parallel --continue` (`lib/orchestrators/parallel/dispatch.js:731`), which is product behaviour | UNCONTROLLED-CONSTANT |
| H6 | Kotlin daemon and leftover processes | Started per build; killed at the end of the cell | Same | Yes. Each cell runs in a kill-on-close job object; `TerminateJobObject` must leave zero active processes (`docs/audits/evidence1-dual-condition-canary-contract.psm1:1205-1223,1265-1283`) | No | Yes | SET-NOT-RECORDED |
| H7 | JDK / Android SDK / Node / Git | JDK 21.0.12.1+1; Android platform-36 / build-tools 36.0.0; Node 24.19.0; Git 2.55.0.windows.5 | Same | Yes (launch.ps1:20-27,92-99) | No | Yes. In A, kmp-test's own JDK auto-select could pick differently (product behaviour) | SET-NOT-RECORDED |
| H8 | PowerShell host / execution policy | Affects only A (kmp-test's Windows wrappers and the skill's `scripts/*.ps1`) | Same | No | No (preregistration lines 16-18 already say PS7 presence is unrecorded) | Interacts with the treatment | UNCONTROLLED-CONSTANT |
| H9 | VM resources / host load | VM `Evidence1-Runner-E2E` | Same | The VM is fixed (manifest `vm_name`) | No | Host load can vary | UNCONTROLLED-CONSTANT |

**Note 8 (H2).** The seed dir is set at launch.ps1:30,102 and read at `cli.mjs:3685-3699`. The
harness makes a full copy, overwrites `gradle.properties`, and snapshots/resets
(`materialize.mjs:381-410`). Prewarm is skipped when a seed is supplied (`cli.mjs:3982-3984`). The
donor was warmed with `:core:domain:test` plus both coverage-report tasks, with `--no-build-cache`
(`docs/audits/evidence1-gradle-cache-provision.psm1:302-306`).

### I. Design and order

| # | Parameter | Claude | Codex | Set by harness? where | Recorded? field | A=B? | Class |
|---|---|---|---|---|---|---|---|
| I1 | Seed | 20260928 | 20260928 | Yes (manifest, then launch.ps1:207) | `seed` | Yes | RECORDED **but inert**. The campaign order is a fixed literal plan (`scenario-campaign-plan.mjs:181-237`; `matrix-runner.mjs:748-750`), and no seed reaches a provider |
| I2 | Cell order | Canary: Claude-A 15:39:08, then Codex-A 15:43:50, then Claude-B 15:48:51, then Codex-B 15:54:23 | (same sequence) | Yes. Manifest `round_order` × `runtimes` (`docs/audits/evidence1-run-manifest-contract.psm1:262-279`). The full design is AB/BA/BA/AB (`scenario-campaign-plan.mjs:61-66,95-100`) | `order_index` is the position within the per-runtime design, **not** the global sequence; `repetition_index`; `started_at`/`ended_at` | Canary: A ran first in both runtimes (one pair, not counterbalanced), and Claude runs first in every round | SET-NOT-RECORDED (global order recoverable only from timestamps and the manifest) |
| I3 | Cell selection | `claude-product-vs-free-baseline-v1`, cell index 0 or 1 | `codex-product-vs-free-baseline-v2`, cell index 0 or 1 | Yes (launch.ps1:207; plan preflight at launch.ps1:147-165,220-221) | `condition`, `product_access_mode`, `order_index`. The design id is not a record field | Yes | CONTROLLED |

### J. Measurement instruments that shape the outcome

| # | Parameter | Claude | Codex | Where | Recorded? | A=B? | Class |
|---|---|---|---|---|---|---|---|
| J1 | Evidence-credit rules | For coverage-threshold outcomes, only kmp-test evidence can count as authoritative | Same | `graders.mjs:832-846,2469-2474` | `success`, `expected_outcome_matched`, `first_useful_signal_ms`, `post_signal_*` are **unreachable for B**; `product_e2e_success` is null for B; `test_invocations_total` and `retries` count only recognised command forms (preregistration §6 amendment) | No, by design (preregistered) | DESIGN-ASYMMETRIC. Compare arms only on the `outcome_assessment` key facts |
| J2 | Tool / effort accounting | Every tool use is counted | Only `command_execution` items are counted | `codex-jsonl-parser.mjs:67-117` | `tool_calls_total` | Biased if B uses non-shell items more often (e.g. editing build files) | Partial |
| J3 | Skill activation observability | Observed (`skill_invoked`) | Not observable | Adapters | `skill_invoked`, `skill_observation.activation` | n/a | n/a |
| J4 | Usage semantics | `input` excludes cache reads; no reasoning dimension | `input` includes cached tokens; `reasoning_output` present; no cache-write figure | `claude-code.mjs:332-338`; `codex-cli.mjs:328-338` | `usage.*`, `tokens.*` | Yes within each runtime | Controlled within a runtime; not comparable across runtimes |
| J5 | Cost and turn count | Not recorded | Not recorded | `campaign-summary.mjs:406` | None | n/a | Not recorded |

---

## 2. Gaps ranked by threat to validity

### 2a. Threats to the within-runtime product-vs-free comparison (primary)

0. **HIGH: the scenario's own ground truth is on the guest filesystem, unverifiable (new, added after
   the campaign).** The harness checkout carries `tools/agentic-eval/corpus/scenarios/
   coverage-threshold-failure-v2.json` (the scenario's expected module, outcome kind, missed lines
   and threshold, in plain JSON) and this preregistration's own stated ground truth, and both must be
   present on the guest for grading to function at all. Codex additionally has `.codex/hooks.json`
   carrying that checkout's absolute path. Whether any agent, in either arm, ever read outside its
   own workspace is unverifiable — commands are not recorded. See the main evidence document's
   "Experimental controls and threats to validity" section, item 1, for the post-campaign evidence
   bearing on this (kmp-test evidence matched in 8/8 product cells; free-arm Gradle-invocation
   counts).

1. **HIGH: the free baseline can reach the product outside the preflight's scope (G6, D1).**
   - The skill snapshot (SKILL.md plus references) and a runnable kmp-test shim are created in every
     invocation, including free-only ones.
   - They sit as siblings of the free agent's cwd, in the agent's own temp workspace root.
   - Codex B additionally has `.codex/hooks.json` inside the workspace. It is written after the
     preflight and contains the absolute path of the product repo.
   - Codex's non-shell and provider-hosted tool use is not observed at all.
   - Direction: this can only inflate B, which shrinks the measured product benefit.
   - Detectability: reading SKILL.md is recorded as `other-bash`. Neither canary B cell shows a
     `kmp-test` tool call, but reading the product docs cannot be ruled out without the raw
     transcripts.
   - Fix:
     - Create the snapshot and shim only when an A cell is planned, and outside the agent-visible
       temp workspace root.
     - Give each session a private `TEMP`.
     - Write the Codex hooks file outside the workspace.
     - Extend the preflight to cover `TEMP` siblings and hook files.
     - Grep B transcripts for the skill/shim path fragments, `bin/kmp-test.js`,
       `SKILL.md` and `.codex/hooks.json`.

2. **HIGH: truncation that differs by arm and is invisible (C1, C4).**
   - (a) Claude's $2 cap is not in any record. A budget-cut session is accepted and looks identical
     to a normal one: `resultSubtype`, cost and turn count are not recorded, and the scenario gate
     ignores `error_max_budget_usd`. B consumes far more (6–7× tokens in the canary), so this cap
     is more likely to bind in B.
   - (b) Only 60 s separate the provider timeout (1800 s, counted from spawn) and the worker
     timeout (1860 s, counted from `cli.mjs` start).
     - That margin must absorb the pre-spawn setup, which includes three full Gradle-seed copies and
       the Codex probe (up to 30 s), plus grading and cleanup.
     - Evidence: canary gaps between cells were 86–95 s end to end.
     - A session nearing 1800 s therefore probably overruns the worker. The job is killed, no record
       is written, and the cell becomes "missing data" under preregistration §7 instead of a negative
       observation.
     - This systematically drops the longest sessions, which are more likely to be B.
   - Fix:
     - Record `max_budget_usd`, `timeout_ms`, `result_subtype`, `num_turns` and `total_cost_usd` per
       cell.
     - Widen the worker margin, or exclude setup time from the worker clock.
     - Preregister budget cuts and worker kills as negative observations.
   - Post-campaign update: neither form of truncation occurred in the 16-session campaign (longest
     session 476.9 s against the 1800 s cap; highest Claude estimated cost $0.218 against the $2
     cap) — see the main document. The standing design gap (neither is recorded per cell) remains.

3. **MEDIUM (known, preregistered): the measurement instrument is asymmetric (J1, J2).**
   - Strict success and first-signal metrics are unreachable for B.
   - Retries and test invocations are undercounted for B.
   - Codex tool counts exclude non-command items, which may make B look more efficient.
   - Fix: keep arm comparisons on the key facts and `task_outcome_matched`. Measure efficiency with
     `wall_clock_ms` and tokens. Add per-item-type counts for Codex.

4. **MEDIUM: arm parity is true in code but not evidenced per cell (A3, B3, C1, C3, E2, G1, H2).**
   - Reasoning effort, argv, env key set, delivered prompt hash, Gradle-seed hash, budget and timeout
     are all unrecorded.
   - The launcher (docs/audits/*.ps1), which decides budget, timeout, PATH filtering, env and seed,
     sits outside the per-cell dirty-tree scope (`cli.mjs:549-550`).
   - A dirty `tools/agentic-eval` tree is only disclosed, not blocked, under the `KMP_EVAL_RUNS_ROOT`
     override (`cli.mjs:1656-1659`).
   - Generalisation limit: the within-runtime effect holds only at Codex effort=low and at Claude's
     unknown default effort.
   - Fix: add a per-cell `session_config` block (normalised-argv sha256, reasoning_effort,
     max_budget_usd, timeout_ms, delivered_prompt_sha256, env-key list, gradle_seed_sha256), and
     extend the provenance scope to cover the launcher.

5. **MEDIUM-LOW: order and carryover (A2, F7, I2).**
   - In the canary, A ran first in both runtimes.
   - Mutable runtime state dirs are shared across cells.
   - Model ids are alias-form, and the served snapshot is not observed (the Codex value is an echo).
   - The full campaign's ABBA order cancels only linear drift.
   - Fix: record the served model id (Claude `assistant.message.model` / `modelUsage`), and hash the
     state dirs before each cell.

6. **LOW: parity of the ambient environment cannot be verified (F2).**
   - Ambient-skill fingerprints are keyed per invocation, and the consensus check is vacuous. Counts
     are equal (16/16, 5/5).
   - Fix: use one shared `--measurement-scope-file` for the whole campaign.

7. **LOW (within Codex): AGENTS.md is auto-loaded (E4).**
   - It gives Codex B a Gradle recipe and may compete with the skill in A.
   - It is symmetric within Codex, but unrecorded. Disclose it and record its hash.

8. **LOW bias, but a publication-accuracy risk: several recorded labels or stated settings are not
   true observations.**
   - `cache_state:"cold"`.
   - `env_allowlist_profile:"narrow"`.
   - Codex `permission_mode_used` and `model_resolved`.
   - The launcher's telemetry, nonessential-traffic, MCP-off and GRADLE_OPTS settings, which never
     reach sessions.
   - Preregistration §9 says "sealed network", but provider-hosted tool use is not observed.

### 2b. Threats to cross-runtime comparison (already disallowed; listed so the publication does not imply parity)

- **Reasoning effort**: Codex runs at low; Claude runs at the CLI default.
- **Stopping rules**: Claude has a $2 cap plus 1800 s; Codex has only 1800 s.
- **Tool surface**: Claude is restricted to Bash and Skill and gate-verified. Codex runs its default
  tools, partly unobserved.
- **Shell**: Git Bash for Claude; Codex's own Windows shell.
- **Treatment wording**:
  - Claude gets a 273-byte directive preamble; Codex gets only the `$kmp-test-runner` token.
  - Claude's plugin sits outside the workspace; Codex's project skill sits inside it.
  - Skill activation is observable only for Claude.
- **Instructions**: the Codex-only AGENTS.md project doc.
- **Usage accounting**: the semantics differ (J4).
- **Provenance**: Claude's model id and version come from the session; Codex's are an echo and a
  probe.
- **Ambient skills**: 16 for Claude versus 5 for Codex.
- **Order**: Claude always runs first in each round.
- **Hooks**: hook correlation is verified only for Claude (preregistration §9).
- **Acceptance**: the rejection-reclassification rule applies only to Codex (preregistration §7).
- **Auth**: mode and service tier are unrecorded.

---

## 3. Not established from repo evidence (needs a transcript or runtime-doc check before publication)

- Claude Code 2.1.238's default effort or thinking setting for `claude-sonnet-5`, and whether it
  depends on remote configuration. (Partially addressed post-campaign: Claude Code's own
  documentation, `code.claude.com/docs/en/model-config`, describes a three-step resolution order
  whose model-default step resolves to `high` for `claude-sonnet-5` — but this is still not verified
  against CLI 2.1.238 specifically, and whether any saved per-model setting exists in the guest's
  `CLAUDE_CONFIG_DIR` — which would resolve first, ahead of the model default — remains unestablished.
  See the main document's Models section.)
- Codex 0.154.0's default tool set for `gpt-5.6-terra`, including any provider-hosted web search, and
  its default per-command timeout.
- Whether `--setting-sources ''` suppresses `$CLAUDE_CONFIG_DIR/CLAUDE.md`, and whether Claude reads
  AGENTS.md.
- Whether `--ignore-user-config` suppresses `$CODEX_HOME/AGENTS.md`.
- The contents of both runtime state dirs; whether managed settings exist on the image.
- The per-cell firewall state; whether the donor `.gradle` was byte-stable across the four
  invocations.
- Whether any B transcript touched the `TEMP` siblings or `.codex/hooks.json`.

## 4. Method

- Read every file cited above at `15ad0dd` and confirmed that nothing relevant differs from the
  executed commit `bbefc600`.
- Cross-checked all values against the four canary records, their audits and `manifest.json`, then
  against the 16-session campaign's own records via `campaign-summary.mjs` and each cell's raw
  `record.json`.
- Verified by execution:
  - (a) The env allowlist: `buildEvalEnv` was run on the launcher's variable set.
  - (b) The prompt hashes: the pre-treatment prompt hash b0a7f797… matches the recorded
    `prompt_sha256`, and the delivered-stdin hashes were computed from the treatment text.
  - (c) Commit and skill identity: `git diff 27c943d bbefc600` over bin, lib, scripts, `.skills`,
    `.claude-plugin` and package.json is empty; the snapshot file count is 28.
  - (d) The contents of AGENTS.md and `gradle.properties` at 7d45eae, read from local NowInAndroid
    clones.

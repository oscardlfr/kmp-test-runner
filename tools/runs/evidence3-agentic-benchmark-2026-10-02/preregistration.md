# Evidence3 preregistration: Claude Code and Codex CLI, with and without kmp-test, on a multi-module test-failure scenario

Written on 2026-10-01, before any live session of this campaign (the canary and the 32-session campaign). This file freezes when the pre-run review passes. After that it changes only by dated amendments appended under "Amendments", never by editing earlier text. Where this document and the code disagree once live sessions start, the code is the record of what ran and this document is the record of what was promised; a mismatch is itself a finding to report, not something to reconcile quietly.

Numbers come from this repository's code and data files, from the commands quoted next to them, from the recorded results of the preparation runs (the host discovery, the guest smoke and the Gradle seed warm) described where they are used, and from two vendor pricing pages cited by address. Decisions are numbered D1, D2, ... in this document's own sequence. Where a section says what the harness does, it describes the code at the deployed commit named in section 4, not an intention.

## 1. Design

**D1. Runtimes, arms and scenario.** Two agent runtimes, two arms, one scenario.

- Runtime `claude-code`: Claude Code with model `claude-sonnet-5`. Runtime `codex-cli`: Codex CLI with model `gpt-5.6-terra`.
- Arm A, "product": the session has the `kmp-test` command and the kmp-test-runner skill (`condition: current-skill`, `product_access_mode: product-assisted`). Arm B, "free": it has neither (`condition: no-skill`, `product_access_mode: free-baseline-no-product`). Both arms run under the same execution profile, `sandboxed-unrestricted-v1`.
- One scenario, `multi-module-test-failures` (section 2).

**D2. Sample size and counterbalancing.** n=8 per runtime and arm: 16 cells per runtime and 32 sessions in all.

- Each runtime has its own design, `claude-product-vs-free-n8-v1` and `codex-product-vs-free-n8-v1` (`tools/agentic-eval/scenario-campaign-plan.mjs`). Each has 8 pairs of cells in the order `[A,B],[B,A],[B,A],[A,B],[B,A],[A,B],[A,B],[B,A]`, which is ABBA BAAB BAAB ABBA over 16 cells.
- The run manifest carries a 16-entry round order. Before any live session the run derives it again from the design with `tools/agentic-eval/derive-round-order-cli.mjs` and refuses to continue if the manifest differs. For cell indices 0 to 15 and the profile above, both designs give:

  ```
  product, free, free, product, free, product, product, free, free, product, product, free, product, free, free, product
  ```

  The command, run once per design id:

  ```
  echo '{"designId":"claude-product-vs-free-n8-v1","campaignCellIndices":[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"executionProfiles":["sandboxed-unrestricted-v1"]}' | node tools/agentic-eval/derive-round-order-cli.mjs
  ```

- Every round runs the same arm in both runtimes, one session after the other. The runtime that goes first alternates: Claude Code first in rounds 0, 2, 4 and so on, Codex CLI first in rounds 1, 3, 5 and so on (rounds are counted from 0, the manifest lists `claude-code` first, and an odd round reverses the manifest's runtime order; `Get-E1RunManifestExpectedCells` in `docs/audits/evidence1-run-manifest-contract.psm1`). Sessions run strictly one at a time; no two sessions use the guest at the same moment.

**D3. Canary and campaign.**

- The canary is 4 sessions: cells 0 and 1 of each design, that is one product session and one free session per runtime, run as two rounds. It checks the pipeline, the controls and the timeouts with real agents. It is reported separately and is never counted in n.
- The campaign is 32 sessions: cells 0 to 15 of each design, 16 rounds.
- No retries and no cell replacement, in the canary or in the campaign. The canary may be repeated once, only after a deterministic fix of the harness, and the repeat is not counted either.

## 2. Scenario

**D4. Project, scenario and ground truth.**

- Project: NowInAndroid (`https://github.com/android/nowinandroid`) at commit `7d45eae4f8720a0c77f507712ba2437ff974b6ed`.
- Scenario `multi-module-test-failures`, family `multi-module-tests`, tagged `held-out` in the corpus: the skill and the product were not tuned against it, and neither is changed for this campaign.
- The prompt. It is identical for every session and is the whole task text of the free arm (the product arm adds a wrapper before it, section 5):

  ~~~
  This is a large, multi-module Android project. I changed some production code and I think I broke some tests. Run the unit tests of every module except `:app`, `:core:designsystem`, `:feature:foryou:impl` and `:feature:interests:impl` (their Robolectric tests need network access this machine doesn't have); where a module has build variants, use the demoDebug variant. Then tell me which tests fail. Once you know the result, end your reply with a block in exactly this format (keep the two marker lines exactly as shown, with valid JSON in between):

  KMP_EVAL_RESULT
  {"outcome_kind": "tests_failed", "failing_modules": ["<Gradle project path>", ...], "failed_test_classes": ["<test class simple name>", ...], "failed_count": <integer>}
  KMP_EVAL_RESULT_END

  failing_modules lists every module with at least one failing test, as Gradle project paths (for example ":some:module"). failed_test_classes lists the simple name, without package, of every test class with at least one failing test. failed_count is the number of distinct failing test methods. If no test fails, use {"outcome_kind": "tests_passed", "failing_modules": [], "failed_test_classes": [], "failed_count": 0}.
  ~~~

- The excluded modules are `:app`, `:core:designsystem`, `:feature:foryou:impl` and `:feature:interests:impl`. They are the four modules whose tests use Robolectric, which downloads its Android jars from Maven Central at test time; the evaluation guest has no such network access. Fifteen modules have unit tests; the other 11 are the scope: `:core:common`, `:core:data`, `:core:datastore`, `:core:domain`, `:core:navigation`, `:core:network`, `:feature:bookmarks:impl`, `:feature:search:impl`, `:feature:settings:impl`, `:feature:topic:impl` and `:lint`, with 93 tests in all (1, 34, 14, 2, 12, 2, 5, 9, 2, 8 and 4 in that order).
- The injected failure is a committed patch, `tools/agentic-eval/corpus/fixtures/multi-module-test-failures.patch` (sha256 `5574b995a1f9fc62c5b1460461c2a59fccba1061619262a5489e89899c42147d`). It changes one line in each of two production files:
  - `core/data/src/main/kotlin/com/google/samples/apps/nowinandroid/core/data/repository/CompositeUserNewsResourceRepository.kt` (`isEmpty()` becomes `isNotEmpty()`);
  - `core/domain/src/main/kotlin/com/google/samples/apps/nowinandroid/core/domain/GetFollowableTopicsUseCase.kt` (`in` becomes `!in`).

  The harness applies it, uncommitted, to the session's fresh worktree: the worktree must be clean, `git apply --check` and `git apply` run, and `git status --porcelain` must then show exactly one modified file for each expected path and nothing else.
- Ground truth, the four answer fields:
  - `outcome_kind`: `tests_failed`
  - `failing_modules`: `:core:data`, `:core:domain`, `:feature:bookmarks:impl`
  - `failed_test_classes`: `BookmarksViewModelTest`, `CompositeUserNewsResourceRepositoryTest`, `GetFollowableTopicsUseCaseTest`
  - `failed_count`: 6

  The six failing methods are `CompositeUserNewsResourceRepositoryTest.whenFilteredByBookmarkedResources_matchingNewsResourcesAreReturned` (`:core:data`), `GetFollowableTopicsUseCaseTest.whenNoParams_followableTopicsAreReturnedWithNoSorting` and `GetFollowableTopicsUseCaseTest.whenSortOrderIsByName_topicsSortedByNameAreReturned` (`:core:domain`), and `BookmarksViewModelTest.feedUiState_resourceIsViewed_setResourcesViewed`, `BookmarksViewModelTest.feedUiState_undoneBookmarkRemoval_bookmarkIsRestored` and `BookmarksViewModelTest.oneBookmark_showsInFeed` (`:feature:bookmarks:impl`).
- How the ground truth was established, in this order:
  1. Gradle on the host, twice on the unpatched project (93 tests, 0 failures, identical) and twice on a fresh clone with the patch applied (93 tests, 6 failures, identical). The command was `./gradlew <the 11 test tasks> --continue --console=plain`, once as is and once with `--rerun-tasks`. A third run with the network cut (`--offline`, JVM HTTP(S) sent to a dead proxy) produced the same JUnit results.
  2. `kmp-test parallel --flavor demo --exclude-modules app,core:designsystem,feature:foryou:impl,feature:interests:impl --json` on the same patched project: its JSON envelope names the same three modules, the same three test classes and the same six methods, and counts 93 tests.
  3. In the evaluation guest, before any live session, a provider-free smoke runs that same `kmp-test` command on a disposable clone of the patched project and asserts the failing modules, the failing test classes and the failing-test count against the ground truth, and that the exit code is the one `tests_failed` implies. Its observed values were `failing_modules` `:core:data`, `:core:domain`, `:feature:bookmarks:impl`; `failed_test_classes` `BookmarksViewModelTest`, `CompositeUserNewsResourceRepositoryTest`, `GetFollowableTopicsUseCaseTest`; `failed_count` 6; `individual_total` 93; exit code 1. They equal the ground truth.
- Known behaviors of the product on this scenario, found while establishing the ground truth and not changed:
  - `kmp-test` dispatches test tasks for 27 modules (the 11 in scope plus 16 modules that have no unit tests), not only the 11 modules the prompt asks for. Its own count of dispatched tasks (27, of which 24 passed and 3 failed in the patched runs) is not the number of tests (93).
  - In a direct Gradle run on the unpatched project, the coverage tasks of `:core:database`, `:core:ui` and `:sync:work` (modules without unit tests) fail with "no tests were run". `kmp-test` dispatches coverage tasks after the tests, and in the patched runs its envelope reports `coverage_report_dispatch_failed`.
  - When `ANDROID_HOME` is set, `ANDROID_SDK_ROOT` is not, and `platform-tools` is not on `PATH`, `kmp-test` 0.16.0 passes the string `undefined` as `ANDROID_SDK_ROOT` to Gradle, and `:lint:test` then fails under `kmp-test` (4 more failing methods) while Gradle alone passes it. The harness sets both variables for every session (section 3), so this does not affect the scenario; it was reproduced on the host with only `ANDROID_HOME` set.

## 3. Isolation guarantee

**D5.** Exactly and only the following. Each item says what the code does.

Fresh for every session (one session is one `node tools/agentic-eval/cli.mjs run` process; the launcher refuses to start a session whose runs directory already exists):

- A git worktree of the project at the pinned commit (`git worktree add --detach`), removed when the session ends (the harness checks the removal and prints a warning if it fails; a leftover worktree does not fail the session), with the patch of section 2 applied to it.
- A copy of the Gradle seed: the guest user's Gradle home, warmed once online and then certified offline (the scenario's 96 Gradle tasks ran with `--offline` and exited 0). The copy is made into a new directory, its `gradle.properties` is replaced by a constant of five settings, and it is restored from a snapshot before the session. The constant:

  ```
  org.gradle.daemon=false
  org.gradle.java.installations.auto-download=false
  org.gradle.configuration-cache=false
  org.gradle.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=256m -XX:+HeapDumpOnOutOfMemoryError -Xmx3g
  kotlin.daemon.jvmargs=-Dfile.encoding=UTF-8 -XX:+UseG1GC -XX:SoftRefLRUPolicyMSPerMB=1 -XX:ReservedCodeCacheSize=320m -XX:+HeapDumpOnOutOfMemoryError -Xmx2g
  ```

- A home directory for the `kmp-test` command's process (emptied before the session), and other temporary directories with random names (the skill snapshot, the Gradle copy and its snapshot, the settings and hook files, the JUnit output). They are created under the guest's shared temporary directory. The harness does not set a separate `TEMP`.
- A Windows job object with kill-on-close. The launcher puts the wrapper process that starts the harness into the job before releasing it, so the harness, the agent and every child they start are inside the job. When the session ends the job is terminated and the harness waits up to 10 seconds for its processes to be gone; if it cannot prove that, the session is failed.
- No provider session persistence: `--no-session-persistence` for Claude Code, `--ephemeral` for Codex CLI.

Controls on the agent's own state:

- Claude Code: auto memory is requested off with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in both arms (the harness does not verify that Claude Code honors it; the agent-state listing below would show a change under `projects/<project>/memory`); setting sources are empty (`--setting-sources ''`); the harness passes its own settings file, which registers one observer hook on `Bash` (PostToolUse and PostToolUseFailure) that only records JUnit evidence and makes no permission decision, in both arms; `--strict-mcp-config` is on with no MCP server configured, Chrome is off (`--no-chrome`), and the tools are `Bash` and `Skill` only (`--tools Bash,Skill`; a gate in the stream parser requires the session's init event to list exactly those and no MCP server). The five launcher variables pass through the environment allowlist: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_CODE_DISABLE_ARTIFACT=1`. Codex CLI is started with `exec --ephemeral --ignore-user-config --ignore-rules`, receives none of those variables, and gets the same JUnit observer through a project hooks file.
- The Bash tool timeouts of Claude Code are `BASH_DEFAULT_TIMEOUT_MS=1800000` and `BASH_MAX_TIMEOUT_MS=1800000`, set by the harness for every Claude session.
- Environment: the agent's environment is built from an allowlist of names: `SystemRoot`, `ComSpec`, `PATHEXT`, `windir`, `OS`, `PROCESSOR_ARCHITECTURE`, `SHELL`, `PATH`, `Path`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TEMP`, `TMP`, `TMPDIR`, `JAVA_HOME`, `ANDROID_HOME` and `ANDROID_SDK_ROOT`; for Claude Code also `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_CODE_USE_POWERSHELL_TOOL`, the five launcher variables above, `CLAUDE_CONFIG_DIR` and `KMP_AGENTIC_EVAL_LIVE_SPAWN_PREFLIGHT`; for Codex CLI also `CODEX_HOME`. The launcher sets `ANDROID_HOME` and `ANDROID_SDK_ROOT` to the same guest Android SDK directory, so both reach every session. The harness then adds variables of its own: `GRADLE_USER_HOME`; in the product arm, a `PATH` that starts with the directory holding the `kmp-test` shim, `KMP_EVAL_TEMP_HOME` and `KMP_EVAL_EXPECTED_FIXTURE_ROOT`; the JUnit-evidence observer variables `AGENTIC_EVAL_JUNIT_EVIDENCE_DIR`, `AGENTIC_EVAL_JUNIT_EVIDENCE_TASK`, `AGENTIC_EVAL_JUNIT_ALLOWED_INVOCATIONS` and `AGENTIC_EVAL_EXPECTED_FIXTURE_ROOT` (both arms), and `KMP_EVAL_JUNIT_EVIDENCE_DIR`, `KMP_EVAL_JUNIT_EVIDENCE_TASK` and `KMP_EVAL_JUNIT_ALLOWED_INVOCATIONS` (product arm); for Claude Code also the two Bash timeout variables and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` above. Names ending in `_TOKEN`, `_KEY`, `_SECRET`, `_PASSWORD` or `_CREDENTIAL`, and a list of cloud credential names (including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`), are dropped even if allowlisted. In the free arm every `KMP_EVAL_*` and `KMP_TEST_*` name is dropped and the `kmp-test` directory is removed from `PATH`, and a preflight demands zero product executables and markers.
- The agent-state listing. Before and after every session the harness lists, without opening any file, every file under the agent's configuration directory (Claude Code: its configuration directory; Codex CLI: its home directory) as relative path, size and modification time. A change to a file that a later session would load into its context is recorded. Those files are, for Claude Code: `CLAUDE.md`, `settings.json` and `settings.local.json` at the top level, anything under `rules/`, `skills/`, `agents/` and `commands/`, and anything under `projects/<project>/memory/`; for Codex CLI: `AGENTS.md`, `AGENTS.override.md` and `config.toml` at the top level, and anything under `memories/` and `skills/` (names compared without case). Each accepted cell of the campaign summary carries `agent_state_clean`: `true` if the listing worked and none of those files changed, `false` if one did, `null` if there was no listing and for every rejected or missing cell. The harness does not reject or exclude a cell because of it; the stop rules in section 10 do.
- The transcript access scan, a closing step run by the operator after the campaign (section 8). It counts matches, in each cell's raw transcript, of four patterns: `corpus[\\/]+(?:expected|scenarios|fixtures)`, `preregistration`, the harness's private-evidence directory name, and the manifest's private root path. A cell with at least one match is excluded from the summaries and the exclusion is stated in the summary's limitations. The harness checkout directory is deliberately not a pattern. The scan runs after the sessions; it is not a gate during the run.
- Each cell's provider session id is recorded (`session_id_observed`; for Codex CLI the thread id) and the campaign summary lists it for every accepted cell.

Shared between sessions (not recreated):

- The agents' login directories (one for Claude Code, one for Codex CLI, used by every session of that runtime), the guest user's Gradle seed (the harness only reads it; nothing prevents the agent, which runs as the same user, from writing to it), the project's template repository, the harness checkout on the guest, the toolchains, the guest VM itself, and the providers' server-side prompt caches. The run starts and stops the VM and never restores a checkpoint between sessions. Earlier sessions' output directories stay on the guest. Before every Codex CLI session, in both arms, its home holds a `config.toml` and the files of six bundled system skills under `skills/.system` (61 context-relevant files in the pre-run check, unchanged by the sessions of that check); Claude Code's configuration directory held none.

What the guest holds, and what that means:

- The harness reaches the guest as a full checkout of the deployed commit. Nothing in the delivery excludes the scenario files or the ground-truth files, so they are on the guest, and harness code on the guest reads the ground-truth file during a session. The previous campaign's preregistration is in that checkout too; this document is not part of the deployed commit. The agent runs as the same guest user, with permission checks bypassed (`--permission-mode bypassPermissions` for Claude Code, `--dangerously-bypass-approvals-and-sandbox` for Codex CLI), under the profile `sandboxed-unrestricted-v1` (isolation kind `external-sandbox`, network mode `restricted`, policy mode `not_applicable`: no run-time command policy is enforced; the scenario's allowed-command lists feed only an audit check).
- During sessions the guest's firewall blocks outbound traffic by default and allows only HTTPS (TCP 443) to the resolved addresses of seven pinned provider hosts (`api.anthropic.com`, `platform.claude.com`, `claude.ai`, `claude.com`, `auth.openai.com`, `chatgpt.com`, `ab.chatgpt.com`); the guest's hosts file pins those addresses. When it seals the network the harness probes each of those seven hosts over HTTPS, before and after switching the default outbound action to block; it does not probe a host that should be unreachable.
- So nothing prevents an agent from reading the ground truth. The control is detection by the transcript access scan after the fact, not prevention. A pre-session isolation probe exists in the repository (`tools/agentic-eval/isolation-probe.mjs`) but no code calls it, and this campaign claims no such probe.
- What the harness records is what it asked for (flags, variables), not what a provider honored: it does not verify that Claude Code applies `--effort high` or that `--setting-sources ''` stops every file from being loaded.

## 4. Models

**D6. Models, effort, versions, budget.**

- Claude Code `2.1.238`, model `claude-sonnet-5`, reasoning effort `high`, passed as `--effort high`. The record stores `reasoning_effort_requested: high` with source `harness-pinned-cli-flag`.
- Codex CLI `0.154.0`, model `gpt-5.6-terra`, reasoning effort `high`, passed as `-c model_reasoning_effort="high"` from the model registry's default reasoning mode (`tools/agentic-eval/models/registry.json`). The record stores `high` with source `model-registry-default-reasoning-mode`. The two efforts are labels of two different products and are not claimed to mean the same effective thing.
- Claude Code's model is read from its init event; Codex CLI's `model_resolved` is the configured model string, not an observation (Codex does not report a per-turn model).
- CLI versions are pinned in the launch scripts (`2.1.238` and `0.154.0`), and the pre-run check in the guest observed exactly those. The harness has no equality gate on them: each cell records the observed version (`agent_runtime.cli_version`) and the campaign summary marks a runtime `mixed` if the values differ.
- Deployed harness commit: `c2712fb1a912f7f10a7a90f3c51c64ede28983a5`. The guest checks out exactly the deployed commit; each session records `kmp_test_cli_version` and `kmp_test_cli_source_sha`, and the guest smoke fails if the guest's `HEAD`, `lib`, `bin` and `.skills` trees differ from that commit's.
- The product arm runs `kmp-test` from that checkout (`bin/kmp-test.js` through a shim on `PATH`): version `0.16.0`, envelope schema `3`. The guest smoke recorded `node bin/kmp-test.js --version --json` as `{"tool":"kmp-test","version":"0.16.0","schema_version":3,"contracts":{"coverage_evidence":1}}` and observed product commit `c2712fb1a912f7f10a7a90f3c51c64ede28983a5`.
- Environment: a Windows 11 Pro guest with 4 vCPU and 12 GiB of memory, Eclipse Temurin JDK 21.0.12.1+1, Android SDK platform 36 with build-tools 36.0.0, Node 24.19.0, Git 2.55.0, and Gradle 9.4.0 from the project's wrapper. The operator logged both agents in with their provider accounts' OAuth sessions inside the guest; the harness does not record the login mode (its Codex login check accepts a ChatGPT or an API-key login), and no API-key environment variable reaches either agent: the allowlist drops them and the guest profile forbids them.
- Claude Code session budget ceiling: `--max-budget-usd 6` for every Claude session; Codex CLI has no budget flag. The harness accepts at most 6.00. Under OAuth the figure is a ceiling on plan usage, computed with the CLI's own price table, not money. That table priced `claude-sonnet-5` at the list rates of an earlier model (3 USD input and 15 USD output per million tokens), 1.5 times the published rates, as the Evidence2 record documents; so 6 USD of CLI-priced usage is about 4 USD at list price. The ceiling is raised from the earlier 2 USD because a multi-module session must not stop at the ceiling before it answers. A session that hits it ends with `error_max_budget_usd`.

## 5. Treatment texts

**D7. What each arm receives.**

- Free arm, both runtimes: the scenario prompt of section 2, unchanged, on the agent's standard input. No wrapper, no skill.
- Product arm, Claude Code: the prompt is preceded by this wrapper, then a blank line (`applyExplicitProductTreatment` in `tools/agentic-eval/product-treatment.mjs`):

  > Before any Bash call, invoke the Skill tool with skill "kmp-test-runner:kmp-test-runner". Wait for its result and apply its decision protocol to the task below. If the Skill tool cannot load that exact skill, stop without running tests; do not reconstruct it from memory.

- Product arm, Codex CLI: the prompt is preceded by `$kmp-test-runner` and a blank line.
- How the skill is delivered. Claude Code: `--plugin-dir` points at a snapshot extracted with `git archive` of `.claude-plugin` and `.skills` at the pinned skill commit; the harness binds that directory to the single plugin of the init event. Codex CLI: the harness copies `.skills/kmp-test-runner` from the same snapshot to `.agents/skills/kmp-test-runner` in the worktree, and a catalog probe must find exactly one `kmp-test-runner` skill in the product arm and none in the free arm. Neither runtime receives the skill in the free arm.
- Skill identity, from `node tools/agentic-eval/print-skill-snapshot.mjs --repo-root <deployed checkout>`:

  ```
  {"schema":1,"skill_source_sha":"27c943dc392675f78209a78ce09adb4f79283e3e","snapshot_sha256":"e9c3973a156dcee32d61b221eab74098134c3ab3e13de18a768d776617333cb8","snapshot_bytes":242311,"snapshot_file_count":28}
  ```

- The agents receive the skill from that pinned commit (`PINNED_SKILL_SHA` in `tools/agentic-eval/cli.mjs`, the commit tagged `v0.15.0`), while the `kmp-test` command comes from the deployed commit (version 0.16.0). The skill text is therefore older than the command it describes. Both are fixed for the whole campaign.
- Each cell records the hash of the prompt actually delivered (`delivered_prompt_sha256`) and of the delivered skill content (`treatment_delivery_sha256`, null with a reason in the free arm).

## 6. Metric definitions

**D8. Primary metric and success.**

- Key facts. The agent's final answer must contain exactly one block between the lines `KMP_EVAL_RESULT` and `KMP_EVAL_RESULT_END` holding a JSON object with exactly the four keys. The final answer is the result text of Claude Code's terminal event, and for Codex CLI the text of the last completed agent message (a block in an earlier message is not seen). Two blocks, invalid JSON, a missing or extra key, an `outcome_kind` other than `tests_failed` or `tests_passed`, or a wrong type make the answer malformed, and a missing block makes it missing; in both cases all four fields count as not observed and key facts is false. For a well-formed answer, key facts is true only if all four fields match:
  - `outcome_kind`: exact string equality;
  - `failing_modules`: set equality, order-insensitive, after adding a missing leading colon (no trimming, no case folding);
  - `failed_test_classes`: set equality, exact case, simple names only (a package-qualified name does not match);
  - `failed_count`: an integer equal to the ground truth (a string never matches).
- `success` is key facts AND at least one test command ran. A test command is a `kmp-test parallel` or `kmp-test changed` call that is not plan-only, or a Gradle call with a task whose last segment matches `^test[A-Za-z]*$` and that is not `--dry-run`, and its tool result must exist (a command killed by a timeout without a result does not count). The record carries `success` for both arms. The campaign summary reports it for the product arm only, labeled a product protocol result and not a cross-arm comparison. Key facts is the metric that is compared across arms.
- The evidence-binding checks of the other families (authoritative evidence well formed, target matches, outcome matches, final answer consistent with evidence) are reported as not applicable for this family, and the first useful signal time is null.

**D9. Secondary metrics.**

- Tokens, as each runtime reports them and stored raw. Claude Code: `input_tokens` (which excludes cache), `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`. Codex CLI: `input_tokens` (which includes the cached part), `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`; it reports no cache-write counter. The cost estimate and the displays subtract Codex CLI's cached part from its input; the stored values are not adjusted.
- Turns: Claude Code's `num_turns` from its result event; for Codex CLI the number of `turn.started` events, normally one per session. They are not the same quantity.
- Wall-clock: `duration_ms`, from just after the worktree, Gradle copy and environment are prepared (and just before the harness records its claim on the cell and takes the before-listing) to the close of the agent process, including the kill on a timeout.
- Tool calls: for Claude Code every `tool_use` (`Bash` and `Skill`; in the product arm the Skill call that the wrapper forces is counted here and not as a shell command); for Codex CLI only `command_execution` items. They are not the same quantity.
- Command kinds, from the frozen classifier of section 7: `kmp_test`, `gradle` and `other` counts of the shell commands.
- Tool output bytes. Claude Code: the UTF-8 bytes of every tool result returned to the model, all tools included, labeled `tool_results`. Codex CLI: the UTF-8 bytes of the output of each completed command execution as logged, labeled `command_output`. The harness sets no output limit for Codex CLI, so its own default applies; Codex CLI may shorten what the model reads, so the two values are not the same quantity and are labeled per runtime wherever they are shown.

**D10. Cost.**

- The agents run on OAuth logins, not API keys (section 4), so no per-session invoice exists. The cost is an estimate from the recorded token usage at official list prices (`tools/agentic-eval/cost-estimate.mjs`, schema 2). The CLI's own `total_cost_usd` is documented but not used (see D6).
- Prices in USD per million tokens, from the two pricing pages fetched raw on 2026-10-01 and identical to the rates recorded for the previous campaign:
  - `claude-sonnet-5` (`https://platform.claude.com/docs/en/about-claude/pricing`): input 2, five-minute cache write 2.5, one-hour cache write 4, cache read 0.2, output 10.
  - `gpt-5.6-terra` (`https://developers.openai.com/api/docs/pricing`, standard table): input 2, cached input 0.2, cache write 2.5, output 12.
- The estimate keeps the previous campaign's recorded retrieval date, 2026-09-29, because the rates are unchanged. A session's cost is the sum of each token class times its rate. The record does not separate five-minute from one-hour cache writes, and Codex CLI does not report cache writes at all, so each session is priced as a range: the low end uses the five-minute rate and the plain input rate, the high end the one-hour rate and, for Codex CLI, the cache-write rate for its uncached input (OpenAI's pricing page says input tokens "are either Input, Cached Input, or Cache Write"). The point value is the midpoint. An arm's range runs from its lowest low to its highest high. Any number of sessions per arm is accepted, including unequal arms after rejected cells.

**D11. Timeouts.**

- The guest smoke measured the `kmp-test` call for this scenario at 209,944 ms, so T = 210 s (rounded up). The session timeouts are: provider (agent) timeout = clamp(3T + 600, 1800, 3600) = 1800 s; worker timeout = 1860 s; guest transport timeout = 1920 s. The run manifest checks only that each is a positive integer and that provider < worker < transport.
- On expiry of the provider timeout the agent process is terminated and the cell is recorded with `termination_reason: timeout`; a timeout alone is not a rejection. The worker timeout bounds the guest process that runs the session; exceeding it is recorded as a transport failure and fails the run. The guest transport timeout bounds the guest call that carries the session.
- The smoke's own limits for this scenario are 3300 s for the `kmp-test` call and 3600 s for the guest bundle call. `kmp-test`'s own per-leg timeout stays at its default of 600 s.
- Claude Code's Bash tool timeouts are 1,800,000 ms (section 3).

## 7. Cell treatment rules

**D12.**

- Accepted cells count in their arm's denominator, including when the answer is wrong or missing.
- A cell is rejected when one of the harness's named integrity checks fails. Rejected cells are not replaced; they are missing data: the summary lists them as `rejected_not_reclassifiable`, and the failed checks of each stay in the cell's private rejection record. They are counted as declared and not as counted. Among the checks, a provider failure before any inference (an authentication failure, a usage limit or a rate limit that ends the session as an error with at most one turn, no token usage and no tool call) rejects the cell. A provider error that comes later, after the session has used tokens or tools, does not reject it: the cell is accepted and counted, normally without an answer block.
- A Codex CLI cell whose only failed integrity checks are the hook accounting and the tool-results-complete check, because the agent closed its turn with a command still in progress, counts as a valid negative observation and not as missing data. This is the rule of the earlier campaigns, unchanged.
- A session process that fails with neither a record nor a rejection ends as a transport failure. It fails the run's `LiveRunning` state and is not a cell outcome (section 10).
- Infra-flake exclusion uses `tools/agentic-eval/infra-flake-classifier.mjs`. It flags a cell whose transcript contains one of two environment-fault signatures: a Kotlin compiler `jarfs` class-cast error, or the text "Gradle build daemon disappeared unexpectedly" (also inside a `gradle_probe_failed` warning). The primary summary includes every cell regardless of the flag; the sensitivity summary excludes only the cells flagged `true`, not those marked `unknown`. Frozen values:
  - classifier version `1`; file sha256 at the deployed commit `c927e8654c6fdfcb28b1004f38159065cd45e54a118f521a6e6d40df0a8b78fc`;
  - logic hash `f91985672fcc1df147f2b3e56c11ca104f870502dac8bba4e8ed524235590b0f`, the sha256 of the source of the first signature, a line feed, the source of the second signature, a line feed, and the text of the function `classifyTranscriptText`. Recomputed on the deployed commit with this command, run from the repository root, which prints exactly that value:

    ```
    node --input-type=module -e "import {createHash} from 'node:crypto'; import {INFRA_FLAKE_SIGNATURE_RE as a, INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE as b, classifyTranscriptText as f} from './tools/agentic-eval/infra-flake-classifier.mjs'; console.log(createHash('sha256').update(a.source+'\n'+b.source+'\n'+f.toString()).digest('hex'))"
    ```

- The command classifier `tools/agentic-eval/command-classify.mjs` has sha256 `374eeef8e4f0d56b8e1890b7e0c0f73eee266b711d583a90ae6527a8c61a0dff` at the deployed commit and is frozen for the campaign. It also imports `tools/agentic-eval/policy-hook.mjs` and `lib/orchestrators/module-filter.js`; those files are part of the same deployed commit, which does not change between the canary and the end of the campaign.
- Access-scan hits are excluded from both summaries. An accepted cell whose `agent_state_clean` is not `true` is reported and stays in the summaries. Both trigger the stop rules in section 10.

## 8. Analysis command

Run from the repository root of the deployed checkout, after the raw transcripts have been copied from the guest into `<campaign dir>/private/<cell>/transcript.jsonl` (the run does not copy them), and in a shell whose redirection writes UTF-8 (Windows PowerShell 5.1's `>` writes UTF-16, which Node cannot parse). `<campaign dir>` is the campaign's closure directory:

```
node tools/agentic-eval/infra-flake-classifier.mjs "<campaign dir>" > "<campaign dir>/infra-flake.json"
node tools/agentic-eval/transcript-access-scan.mjs "<campaign dir>" > "<campaign dir>/access-scan.json"
node tools/agentic-eval/campaign-summary.mjs "<campaign dir>" --access-scan "<campaign dir>/access-scan.json" > "<campaign dir>/summary-primary.json"
node tools/agentic-eval/campaign-summary.mjs "<campaign dir>" --access-scan "<campaign dir>/access-scan.json" --exclude-cells "<campaign dir>/infra-flake.json" > "<campaign dir>/summary-sensitivity.json"
node tools/agentic-eval/cost-estimate.mjs "<campaign dir>" --out "<campaign dir>/cost-estimate.json"
```

The record's results tables are generated from the same files:

```
node tools/agentic-eval/evidence2-tables.mjs "<campaign dir>" "<record README>" --date=<yyyy-mm-dd> --cost-estimate "<campaign dir>/cost-estimate.json" --infra-flake "<campaign dir>/infra-flake.json" --write
```

Then the two document generators, with the published directory's `campaign-summary.json` (the primary summary) and `cost-estimate.json`:

```
node tools/agentic-eval/readme-evidence.mjs --write --evidence=3 --date=<yyyy-mm-dd>
node tools/agentic-eval/benchmark-doc.mjs --write --evidence=3 --date=<yyyy-mm-dd>
```

These two run on the publication branch, where the Evidence3 markers and the README evidence number are added; at the deployed commit `readme-evidence.mjs --evidence=3` writes only the two SVG figures and `benchmark-doc.mjs --evidence=3` stops for lack of Evidence3 markers in the detailed document.

`campaign-summary.mjs` refuses a manifest whose `provider_mode` is not `live`. `cost-estimate.mjs` prices every counted cell and has no option to exclude any.

## 9. What gets published

The record's README, this preregistration, the controls audit, the campaign summary (`campaign-summary.json`, the primary summary), the cost estimate (`cost-estimate.json`) and the figures (the scorecard, the metrics grid and the cost breakdown). Raw transcripts are not published. `node tools/decouple-audit.mjs` is clean before anything is published.

Limitations stated in advance:

- One scenario, tagged held-out; n=8 per runtime and arm; Windows only.
- The ground truth sits on the guest and agents run with permission checks bypassed; the control is detection by the transcript access scan after the campaign.
- Turns, tool calls, tool output bytes, and reasoning effort are not the same quantity across the two agents (sections 4 and 6).
- Cost is a list-price estimate for OAuth sessions, with Codex CLI's uncached input priced as a range.
- The skill is the `v0.15.0` snapshot; the command is the deployed `0.16.0` checkout.
- `success` is reported for the product arm only; key facts is the cross-arm metric.
- The harness records what it requested from the providers, not what they honored.

## 10. Stop rules

Stop and publish nothing if any of these holds after the campaign (the operator applies them; the code does not):

- 3 or more infra-flake cells (`infra_flake_suspected: true`);
- any access-scan hit;
- any accepted cell whose `agent_state_clean` is not `true`;
- 4 or more rejected or missing cells;
- any run state that ends FAIL, including a transport failure of a session.

## 11. Amendments

Appended below this heading, dated, each with its reason. Allowed only before the campaign starts, or for a documented incident. A metric definition never changes after a campaign session has run.

### A1 (2026-10-01, before any live session; from the pre-run review)

- Deployed harness commit: c3da7bec808f0e43c91ddbf90f7e4bfc3ab7665a, which replaces c2712fb1a912f7f10a7a90f3c51c64ede28983a5 in sections 4 and 7. The pre-run review found that the audit sidecar of each cell was validated without the scenario family when the cell was promoted, so any imperfect answer would have stopped the run instead of being recorded as a failed cell. Fixed in PR #554; a fresh provider-free run passed every state at the new commit (campaign 490d12dd-3a10-4786-9667-e8676b342a70). The frozen values of section 7 are unchanged at the new commit; recomputed: command classifier sha256 374eeef8e4f0d56b8e1890b7e0c0f73eee266b711d583a90ae6527a8c61a0dff, infra-flake classifier file sha256 c927e8654c6fdfcb28b1004f38159065cd45e54a118f521a6e6d40df0a8b78fc, logic hash f91985672fcc1df147f2b3e56c11ca104f870502dac8bba4e8ed524235590b0f.
- The transcript access scan gains two patterns: paths under the harness's tests/fixtures, tests/pester or tests/vitest directories, and the names of this scenario's answer fixtures (agentic-eval-multi-module, kmp-test-envelope-failing). Copies of the answer also sit in test fixtures of the harness checkout on the guest.
- Added stop-rule input: an accepted cell whose result subtype is not success (a provider or runtime error ended the session after it had started work) is listed in the controls audit and counts toward the rule "4 or more rejected or missing cells". Such a cell is counted as a failed answer although the agent did not finish.

### A2 (2026-10-01, before the campaign; after the canary)

- The infra-flake stop rule becomes "6 or more infra-flake cells" (it was "3 or more"). Reason: during the pre-run checks the guest's Gradle daemon died once in about 11 heavy Gradle runs (two provider-free runs and one smoke), which predicts about 3 flagged cells in 32 sessions from the environment alone. 6 of 32 keeps the tolerance the threshold had relative to a 16-session campaign (3 of 16). Flagged cells stay in the primary summary; the sensitivity summary, which excludes them, is published next to it.
- In the canary, a cell flagged by the infra-flake classifier does not fail the canary when its record was promoted and graded; it is reported.

### A3 (2026-10-01, before the campaign; after the canary)

- Codex CLI's `config.toml` is not context-relevant in this campaign: the harness starts Codex CLI with `--ignore-user-config`, which, per Codex's documentation, skips `$CODEX_HOME/config.toml`. The canary showed Codex CLI rewriting that file at the start of every session (size unchanged at 1369 bytes; only its modification time changes). The stop rule on `agent_state_clean` therefore treats a Codex CLI cell whose only context-relevant change is `config.toml` as clean. The summaries keep the raw `agent_state_clean` value the harness computes; the record names the cells this rule applied to, and the controls audit lists the size of `config.toml` before each Codex CLI session.
- Codex CLI also updates `memories_1.sqlite` and other SQLite state files in its home in every session. They are outside the agent-state listing's context-relevant set. Codex's documentation says local memories are off by default; the harness ignores the user configuration that could enable them and passes `--ephemeral`. The harness does not open these files, so their contents are not verified; this is a stated limitation.

### A4 (2026-10-01, after a documented incident; before the second campaign attempt)

- The first campaign attempt (campaign 4e228608-ec59-44f5-9ddc-a40a33186ca4, started at 17:41Z) ended with the run state LiveRunning = FAIL at 20:48:53Z. One Codex CLI session ended in a transport failure (process timeout), and the last six rounds of both runtimes could not start because the host's elevated orchestration runner crashed (access violations in the .NET runtime of Windows PowerShell). In the same window the host logged crashes of unrelated processes and corrected hardware errors, while another workload compiled native code on the same host. Under section 10 nothing from that attempt is analyzed or published, and its records stay private. To diagnose the failure, only the run receipt's per-session statuses, exit codes, failure reasons, start and end times and process-output sizes were read; no key fact, answer, token count, cost or tool-call count of it was looked at before this amendment.
- The campaign is run once more, unchanged (same deployed commit, design, scenario, prompts, timeouts and stop rules), under a new campaign id, with no other heavy workload on the host. This is the only re-run: if the second attempt also ends with a run state FAIL, nothing is published.
- The record of this campaign states that the first attempt existed, why it failed, and how many provider sessions it consumed (19 completed, 1 timed out).

### A5 (2026-10-02, after the second attempt; decided before any of its results was read)

- The second attempt (campaign 2e96747d-ebb4-4642-b51f-9c1ec1bc1bba) ran all 32 sessions between 21:30:31Z and 00:59:14Z. Thirty were accepted; one (claude-code, round 8) was rejected by the harness's integrity checks; one (codex-cli, round 7) was lost because its guest call failed after six minutes when the Hyper-V socket target process in the guest terminated (reason code provider_runtime_real_worker_failed). That single loss set the run state LiveRunning to FAIL.
- Rule change, made before any key fact, answer, token count, cost or tool-call count of the attempt was read: a session lost to a failed guest call (reason codes provider_runtime_real_worker_failed, guest_bundle_failed or provider_runtime_real_guest_bundle_call_failed) is missing data and is treated like a rejected cell: declared, not counted, not replaced. A run-state FAIL caused only by such losses does not void the campaign. Every other stop rule stands, including "4 or more rejected or missing cells". The second attempt is therefore the registered campaign; the first attempt stays unanalyzed.
- Reason: the rule on run states was written for systemic failures. On this host, about one guest call in thirty failed for reasons outside the agents during the two attempts, while corrected hardware errors and crashes of unrelated processes were logged. Under that rule any long campaign on this machine would be void, and the other 31 sessions of the attempt completed normally.
- To diagnose the loss, only the following were read: the run receipt's per-session statuses, exit codes, failure reasons, start and end times and process-output sizes; the broker's response to the failed guest call; and the host's event logs.
- Disclosure: both missing cells fall in the free arm under the design's order, so Claude Code's and Codex CLI's free arms have at most 7 counted sessions each. The record names both cells and their causes.

# Product principles — kmp-test-runner

> Strategic charter. Operational rules live in `CLAUDE.md`, current and queued work in `BACKLOG.md`, released history in `CHANGELOG.md`, and user-facing instructions in `README.md`.

## What this is

`kmp-test-runner` is a command-line test runner for Kotlin Multiplatform and Android Gradle projects. It discovers and dispatches the project's existing Gradle tasks, interprets their outputs and reports, and emits a compact human summary or structured `--json` envelope.

It is distributed as an npm CLI, a Gradle plugin that invokes the bundled Node runner, and release archives installed through PowerShell or POSIX shell scripts.

## Target user

Open-source contributors and maintainers working on KMP or Android projects on Windows, Linux, or macOS. Human-driven, CI-driven, and AI-agent-driven workflows are all first-class.

The product must adapt to ordinary Gradle project shapes rather than require a repository-specific convention. It should work out of the box on representative public projects while producing actionable typed diagnostics when the host lacks a platform toolchain, simulator, device, task, or fresh report.

Consumers still need the toolchains required by their own project: a compatible JDK and Gradle wrapper, plus Android or Apple tooling for those targets. Installing `kmp-test-runner` must not add unrelated shell requirements such as Cygwin or a Homebrew Bash upgrade.

## Value proposition

Raw Gradle output, test logs, JUnit XML, and coverage reports are expensive for humans and especially for coding agents to inspect repeatedly. `kmp-test-runner` turns that material into a bounded result containing the outcome, affected modules, counts, coverage, skips, and typed failures needed for the next decision.

Output reduction is an evidence-backed product property, not a universal fixed multiplier. The result varies by project, command, cache state, report volume, tokenizer, and output mode. Current and historical measurements, provenance, and caveats belong in [`docs/token-cost-measurement.md`](docs/token-cost-measurement.md) and its linked captures; selected current results may appear in the README only when they are traceable to same-capture data. Historical measurement tables remain valuable evidence but are not timeless performance guarantees.

The durable product promise is therefore:

- preserve enough structured evidence to make the same test decision;
- omit raw output that does not change that decision;
- retain paths to detailed local artifacts for human investigation;
- never trade correctness, failure visibility, or provenance for a larger reduction claim.

## Success criteria

1. **Representative compatibility.** Core commands work without consumer-specific configuration across a maintained matrix of public KMP and Android projects. Genuine project failures remain distinguishable from runner failures.
2. **Platform honesty.** Windows, Linux, and macOS share the same contracts where the underlying platform allows it. Host-specific limitations return typed diagnostics instead of silent passes.
3. **Compact, stable output.** The human summary is readable and the JSON envelope stays bounded and machine-consumable even when Gradle produces very large logs or reports.
4. **Backward-compatible contracts.** Additive JSON fields are preferred. Renames or removals require an explicit compatibility decision, release note, and migration guidance.
5. **Reliable defaults.** The default path favors correct, reproducible results. Riskier concurrency, cache isolation, recovery, and platform-specific behavior remain explicit and observable.
6. **Reproducible evidence.** Published metrics and agentic-eval claims identify their exact capture, method, date, eligibility, and limitations.
7. **First-run diagnostics.** Missing JDKs, Android SDKs/devices, Apple hosts, coverage reports, Gradle tasks, or authentication must fail clearly and suggest the next safe action.

## Supported host matrix

| Host | Product runtime | Platform-specific responsibility |
|---|---|---|
| Windows | Node CLI; PowerShell installer and compatibility launchers | JVM/Desktop and Android; user-level PATH changes only |
| Linux | Node CLI; POSIX installer and compatibility launchers | JVM/Desktop, Android, JS, and Wasm where the project supports them |
| macOS | Node CLI; Bash-3.2-compatible installer and launchers | JVM/Desktop, Android, JS/Wasm, macOS, and iOS/simulator tasks |

The npm package currently declares Node `>=18`; CI uses Node 24 as the primary runtime and retains an explicit Node 18 compatibility smoke. Gradle and platform-toolchain compatibility are separate from the Node runtime floor.

Platform-aware behavior the product owes its users:

- iOS and macOS test types on non-macOS hosts return `platform_unsupported` and a non-zero environment/setup exit.
- Android instrumented work reports the absence of a usable `adb` device rather than claiming tests passed.
- Gradle resolution or execution failures cannot be inferred as successful merely because a JUnit report is missing or stale.
- Coverage budgets fail closed when the requested fresh coverage evidence is unavailable.
- POSIX release scripts remain compatible with the system Bash shipped by macOS; product orchestration itself lives in Node.

## Architecture principle: logic in Node, compatibility at the edges

Module discovery, parallel dispatch, output parsing, envelope construction, JDK/Android SDK selection, and coverage aggregation live in `lib/`. The scripts under `scripts/sh/` and `scripts/ps1/` are compatibility launchers that translate arguments and invoke the Node runner. New product behavior must not be implemented twice in shell dialects.

The Gradle plugin follows the same principle: it extracts the packaged runtime and invokes the Node runner through its task actions. Its five public tasks are an integration surface over the same implementation, not a separate behavioral engine.

Concrete consequences:

- New behavior lands in a focused Node module with Vitest coverage.
- Shell changes are limited to installation or compatibility plumbing and preserve sibling parity.
- Typed error codes and exit-code classification are shared instead of reconstructed per shell.
- The direct-wrapper and plugin paths keep contract tests so compatibility does not silently drift.
- Platform-specific integration is tested at the narrowest real boundary, with manual macOS validation where hosted cost or Apple tooling makes per-PR execution inappropriate.

The reasoning and completed migration history are preserved in the v0.8 sections of [`BACKLOG.md`](BACKLOG.md) and [`CHANGELOG.md`](CHANGELOG.md). Those records explain the decision; this document states the current architecture.

## Product integrity principles

### No false passes

A green result requires affirmative evidence appropriate to the command. Missing tasks, aborted Gradle configuration, stale reports, unavailable coverage data, absent devices, and unsupported hosts must not collapse into success.

### Bounded output with drill-down

The default output should contain what a reader needs to decide the next action. Detailed logs, screenshots, hierarchy dumps, and reports remain local artifacts referenced by path; they are not dumped into the JSON envelope.

### Concurrency without shared-state surprises

Parallel execution is the product's core, but Gradle project caches and multiple agents can contend. Default coordination must be observable, and stronger cache isolation remains available explicitly for concurrent runs.

### Privacy by construction

Committed source and public evidence do not contain real device serials, credentials, user-home paths, private project identifiers, or raw agent transcripts. Public shape scanning is always available; maintainer-only private patterns stay outside the repository and fail closed when explicitly required.

### Honest measurements

Numerator and denominator in a reduction ratio come from the same project and capture unless the comparison is explicitly labelled cross-project. Operational canaries are not promoted to benchmarks unless they meet the declared eligibility contract. Missing provider telemetry is reported as unavailable, never estimated silently.

### Controlled release

`develop` is the validated integration trunk. `main` advances only through the release-bot fast-forward workflow after the exact SHA passes the required-check manifest. Package publication, tag creation, archive construction, and release notes remain guarded and traceable to that commit.

## Out of scope

The following are not product directions:

- consumer-project-specific behavior or embedded private toolkit conventions;
- requiring Bash 4+ or Cygwin as a prerequisite for ordinary installation;
- a zsh-specific runtime migration;
- duplicating the Node orchestrators in Bash and PowerShell;
- weakening tests, error typing, privacy gates, or evidence provenance to improve a headline metric;
- silently provisioning, authenticating, or publishing third-party services on behalf of a user.

Distribution improvements such as Maven Central or a skill/plugin marketplace are roadmap candidates, not permanent product exclusions. Their current status belongs in [`BACKLOG.md`](BACKLOG.md) and they must not be presented as available before release.

## Document hierarchy

| Document | Purpose | Update cadence |
|---|---|---|
| `PRODUCT.md` | Durable product principles and scope | When strategy or architecture changes |
| `CLAUDE.md` | Repository workflow, invariants, and agent rules | When implementation or operations change |
| `CONTRIBUTING.md` | Contributor onboarding and verification | When contributor workflow changes |
| `BACKLOG.md` | Current gaps, queued work, and completed decision history | As work is discovered or closed |
| `CHANGELOG.md` | Released behavior and historical implementation record | Every release |
| `README.md` | Professional user onboarding, benefits, installation, and core usage | Every user-visible change |
| `docs/` | Detailed guides, metrics, audits, and operational evidence | With the relevant feature or validation |
| PR descriptions | Reviewable rationale and verification for one change | Every PR |

When work cannot be traced to a principle here, either its scope is misaligned or this charter is missing a deliberate product decision. Do not change strategy implicitly inside an unrelated implementation or documentation PR.

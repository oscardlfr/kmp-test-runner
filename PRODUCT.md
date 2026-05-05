# Product principles — kmp-test-runner

> Strategic charter. Every PR justifies itself against this document.
> Updated when strategy changes (rare). Operational rules live in `CLAUDE.md`;
> current and queued work in `BACKLOG.md`; the decision log lives in PR
> descriptions, BACKLOG entries, and commit messages.

## What this is

`kmp-test-runner` is a command-line test runner for Kotlin Multiplatform and
Android Gradle projects. It dispatches the project's existing gradle test
tasks in parallel, parses their output, and emits a compact `--json`
envelope that AI coding agents and humans can consume without paying for
raw gradle log output.

## Target user

Open-source contributors working on any KMP or Android Gradle project, on
any host OS (Windows / Linux / macOS). Both human-driven and AI-agent-driven
workflows are first-class.

The product does not assume any specific consumer project structure beyond
"a Gradle project with KMP or Android plugins applied". It must work
out-of-the-box on representative open-source projects (`Confetti`,
`KaMPKit`, `PeopleInSpace`, `nowinandroid`, `nav3-recipes`, etc.).
Brand-new contributors with default OS toolchains (no `brew install bash`,
no Cygwin, no extra installs beyond the runtime) must succeed on first run.

## Value proposition

The product reduces the token cost of an agent's test-run iteration by
100×–1200× depending on the feature. Real `messages.countTokens` API
measurements (see `README.md` §1-123 for full A/B/C tables across 4
features × 3 approaches × 4 tokenizers):

| Feature      | Raw `./gradlew` | `kmp-test --json` | Reduction (opus-4-7) |
|--------------|----------------:|------------------:|---------------------:|
| `parallel`   |          25,780 |               187 |                 138× |
| `coverage`   |         123,845 |               162 |                 765× |
| `changed`    |          25,580 |               186 |                 138× |
| `benchmark`  |          23,527 |               163 |                 144× |

A 5-iteration agent loop on `coverage` reading raw gradle output burns
~542 K tokens (more than two full 200 K contexts). The same loop on `--json`
burns ~500 tokens. This savings is the entire reason for the product.
Every architectural decision serves it.

## Success criteria

1. **Universal compatibility.** `kmp-test parallel` succeeds on every
   reasonable open-source KMP/Android project on first invocation, with no
   consumer-side configuration. Validation surface: cross-project wide-smoke
   against `Confetti` / `KaMPKit` / `PeopleInSpace` minimum.
2. **OS parity.** Windows / Linux / macOS all behave identically modulo
   platform constraints. iOS tests don't run on Windows, and the CLI must
   say so clearly (typed `errors[].code`), not silently pass.
3. **Default Bash 3.2 on macOS.** Mac users without `brew install bash` run
   the product successfully. The CI matrix must validate this (informational
   `bats-macos` job today; promoted to required when stable).
4. **`--json` envelope is the contract.** AI agents parsing it must not
   break on minor releases. Schema additions are non-breaking; renames or
   removals require a major version bump and a CHANGELOG migration note.
5. **Defaults are rock-solid.** Producto, no tooling — flaky defaults erode
   trust. Edge-case features can ship behind flags; the default path can
   never. "Works on the maintainer's machine" is not a passing grade.

## Supported OS matrix

| OS      | Default shell        | Bash version assumed       | Notes                                              |
|---------|----------------------|----------------------------|----------------------------------------------------|
| Windows | PowerShell 5.1 / 7+  | n/a (ps1 path)             | HKCU PATH only; never machine-wide.                |
| Linux   | bash                 | 4+ on common distros       | bats; primary CI matrix runner.                    |
| macOS   | bash                 | **3.2.57** (default)       | `bats-macos` informational job; no `brew` assumed. |

Platform-aware behavior the product owes its users:

- iOS / macOS test-types invoked on Windows or Linux fail with a typed
  error (e.g. `errors[].code = "platform_unsupported"`) — never a silent
  pass. Bug WS-1 (false-positive PASS on task-not-found) is the canonical
  example of what this contract forbids.
- Android instrumented tests fail with a typed error when no `adb` device
  is connected.
- Bash-only features (`declare -A`, named-reference variables, etc.) do
  not appear in any `scripts/sh/*.sh` that ships in a release artifact.

## Architecture principle: logic in Node, plumbing in shell

**The orchestration logic — module discovery, parallel dispatch, output
parsing, envelope construction, JDK selection — lives in Node (`lib/`).
The shell wrappers (`scripts/sh/run-*.sh`, `scripts/ps1/run-*.ps1`) are
thin invokers that call into Node and pass through args and exit codes.
Target: ≤100 LOC each, no associative arrays, no parallel loops, no
output parsing.**

Justification: the product's value-add (the `--json` envelope shaping, the
project-model fast path, the multi-JDK catalogue) lives entirely in Node.
The shell scripts are plumbing that invokes gradle and prints lines that
Node then parses back. The plumbing has no value the user pays for, and
maintaining it twice (bash + ps1, with subtly different gotchas in each
dialect) doubles the bug surface for every feature shipped.

Concrete consequences:

- New features land in `lib/`, with `tests/vitest/` coverage that runs on
  Linux + macOS + Windows CI runners (the existing matrix).
- Shell-side changes in feature PRs are limited to passing new args
  through. Behavioral logic changes in shell are a code smell.
- Bash-3.2-specific bug classes (`declare -A`, empty-array `[@]` under
  `set -u`, BSD vs GNU shell tooling drift) cease to be product bugs once
  migration completes — they can't surface in code that does not exist.
- shellcheck remains required CI; its responsibility shrinks to "validate
  the thin wrappers don't regress into plumbing".

This principle is not negotiable. It is the conclusion of the 2026-05-02
strategic review. See `BACKLOG.md` v0.8 — STRATEGIC PIVOT entry for the
full reasoning and the rejected alternatives (Bash 4+ gate, custom
shellcheck rules, zsh migration, greenfield Node rewrite, status quo).

## Origin

The repo began as a Windows-primary POC to reduce agent token costs against
the repo owner's personal KMP project. It decoupled from that origin
(see `CLAUDE.md` "Decouple from L0" rules: 8 audit patterns must remain
0-hits in scripts) and now ships as an independent open-source product.

The repo owner develops primarily on Windows; the macOS testing surface
is a separate physical machine. This shapes a workflow constraint:
bash-side fixes require physical access to a Mac to validate, which made
the bash + ps1 duplication a high-friction iteration loop. The 2026-05-02
strategic pivot to Node-centered orchestration explicitly addresses this
constraint.

## Out of scope

The following are explicitly NOT part of this product. PRs proposing them
should be redirected to a more appropriate venue:

- **L0 / consumer-project-specific behavior.** The 8 audit patterns
  enumerated in `CLAUDE.md` "Decouple from L0" must remain 0-hits in
  `scripts/`. The shipped consumer-config env vars (`SKIP_DESKTOP_MODULES`,
  `SKIP_ANDROID_MODULES`, `PARENT_ONLY_MODULES`) are the documented API
  surface and do not violate this rule.
- **Bash 4+ feature gating.** Requiring `brew install bash` before first
  run is the wrong UX for an OSS contributor on-ramp.
- **zsh runtime migration.** ~2000 LOC rewrite, no shellcheck, breaks
  installer; rejected on cost-benefit grounds.
- **Custom shellcheck rules to catch `declare -A` and friends.** Doesn't
  address the triple-maintenance root cause.
- **Greenfield Node rewrite.** Months of work; breaks user contracts.
  Migration is incremental and contract-preserving.
- **Maven Central publish.** Deferred (currently GitHub Packages only).
- **iOS / macOS targets in the Gradle plugin TestKit.** Needs Mac CI;
  the informational `gradle-plugin-test-ios` job is the placeholder.

## Document hierarchy

| Document        | Purpose                                                  | Update cadence                |
|-----------------|----------------------------------------------------------|-------------------------------|
| `PRODUCT.md`    | Strategic charter (this file)                            | Rare (when strategy changes)  |
| `CLAUDE.md`     | Operational rules: gitflow, CI checks, commit conventions| When those rules change       |
| `BACKLOG.md`    | Current and queued work                                  | Each PR                       |
| `CHANGELOG.md`  | Released versions                                        | Each release (append-only)    |
| `README.md`     | User-facing onboarding + value-prop measurements         | Each user-visible feature     |
| PR descriptions | Decision log — why a specific change was made            | Permanent record per change   |

When a PR's justification cannot be traced to a principle in `PRODUCT.md`,
that PR should be questioned: either the work is misaligned with the
product, or `PRODUCT.md` is missing a principle that should be added.
Updates to `PRODUCT.md` itself ship as standalone `docs(product): ...` PRs
so the conversation around principle changes stays separate from feature
work.

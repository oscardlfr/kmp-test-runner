# Backlog

Active and parked work only. Released behavior belongs in [CHANGELOG.md](CHANGELOG.md); the previous long-form ledger is preserved as [historical backlog through 2026-09-10](docs/history/BACKLOG-through-2026-09-10.md).

Milestone assignment, reprioritization, and dropping work require explicit maintainer direction.

## Active

### Documentation and Evidence1 closure

- Audit the current documentation corpus against implementation.
- Replace the oversized README with a short onboarding surface.
- Publish the six sanitized 2026-09-10 Evidence1 canary records and sidecars.
- Add current eval, Windows setup, live canary, and metrics documentation.
- Add documentation drift/link regression checks.

This item closes when its single consolidated PR passes the required checks.

## Unassigned

### Configurable runner output root

Add one resolver for runner-owned artifacts with a public `--output-dir`, `KMP_TEST_OUTPUT_DIR`, project/user config, and Gradle DSL property. Preserve the concurrency semantics of the root lock and the precedence of more-specific paths such as `--output-file`, `--capture-dir`, and `--isolated-cache-dir`.

Open design decision: whether the cross-invocation lock remains anchored to the project root when output is redirected. This needs an explicit maintainer decision before implementation.

### Evidence1 clean-room provisioning

The prepared `Evidence1-Runner` VM is repeatable, but provisioning from a Windows ISO is still manual. A future functional PR may parameterize VM name, storage root, ISO/hash, dependency versions, source/harness pins, attestation location, and replace fixed `C:\kmp-eval` assumptions. It must preserve authentication isolation and one-use custody semantics and include tests that do not require publishing VM media or credentials.

### Additional agent runtime

The harness has a runtime abstraction and a Claude Code implementation. A Codex runtime remains design work, not an implemented feature. Do not describe the historical Claude/Codex plan as current support.

## Parked

### Maven Central publication

The Gradle plugin remains on GitHub Packages. Revisit when the required publishing account/signing setup is available and the maintainer explicitly promotes the work.

### Documentation site

The repository now uses a compact README plus structured Markdown docs. Consider a generated docs site only if navigation or discoverability becomes a demonstrated problem.

## Standing constraints

- Do not expand hosted macOS CI without an explicit cost decision; use the manual macOS gate for heavy validation.
- Do not publish private names, machine paths, credentials, raw authenticated transcripts, VM images/state, private measurement scopes, or Evidence1 custody bundles.
- Do not promote canary evidence to a benchmark without satisfying the registered acceptance contract.

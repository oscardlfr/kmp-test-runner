# Documentation

Reference documentation for `kmp-test-runner`.

## Index

| Document | Topic |
|---|---|
| [envelope-contract.md](envelope-contract.md) | `--json` envelope schema (`schema_version: 2`) — top-level keys, error codes, exit codes, breaking-change history |
| [concurrency.md](concurrency.md) | Lockfile + `--isolated` semantics — when concurrent invocations conflict and how to opt out of shared state |
| [token-cost-measurement.md](token-cost-measurement.md) | Methodology for measuring agent-context cost across coverage / module-info / leg-status read paths |
| [testing/](testing/) | Internal testing patterns (dispatcher scopes for ViewModel-style coroutine flows, etc.) |

## Conventions

- **No personal or environment-specific content.** Examples use placeholder names (`projectA`, `moduleB`, `<device-serial>`) and anonymous paths. Wet-audit evidence files (matrix runs against real workspace projects) are local-only artefacts and gitignored — they belong on the runner machine, not in version control.
- **Pre-v1 surface.** The envelope contract is stable from `v0.9.0` onward (`schema_version: 2`); breaking changes bump the schema version and are documented in [envelope-contract.md](envelope-contract.md).
- **Source of truth.** When the docs and the code disagree, the code wins. File a contract bug if you spot a divergence.

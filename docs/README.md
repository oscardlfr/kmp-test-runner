# Documentation

User, integration, evaluation, and maintainer documentation for
`kmp-test-runner`. Start with installation and usage; use the CLI and envelope
references when building automation.

## Index

| Document | Topic |
|---|---|
| [installation.md](installation.md) | npm, release installer, offline checksum verification, upgrades, uninstall, and host requirements |
| [usage.md](usage.md) | Platform selection, test workflows, coverage, JDKs, Android capture, configuration, concurrency, and CI |
| [cli-reference.md](cli-reference.md) | Complete subcommand and flag reference, test-type values, defaults, JSON, and exit codes |
| [gradle-plugin.md](gradle-plugin.md) | GitHub Packages setup, authentication, extension properties, task mapping, and CI |
| [envelope-contract.md](envelope-contract.md) | `--json` envelope schema (`schema_version: 2`) — top-level keys, error codes, exit codes, breaking-change history |
| [concurrency.md](concurrency.md) | Lockfile + `--isolated` semantics — when concurrent invocations conflict and how to opt out of shared state |
| [token-cost-measurement.md](token-cost-measurement.md) | Methodology for measuring agent-context cost across coverage / module-info / leg-status read paths |
| [metrics.md](metrics.md) | Current measurement status, provenance, public-matrix refresh, agentic metrics, and publication rules |
| [agentic-usage-measurement.md](agentic-usage-measurement.md) | Agentic evaluation protocol, evidence boundaries, and interpretation |
| [evaluation/](evaluation/) | Operator-facing agentic harness and Evidence1 setup/runbooks |
| [troubleshooting-windows.md](troubleshooting-windows.md) | Windows-specific gotchas — corporate TLS interception (`--use-system-ca`), shell-script line endings |
| [testing/local-ci.md](testing/local-ci.md) | Maintainer local CI gate and Windows hermeticity notes |
| [audits/](audits/) | Historical audit plans, reports, and implementation evidence; status labels determine whether a document is current or historical |

Maintainer scripts are documented separately in [`tools/README.md`](../tools/README.md).

## Conventions

- **No personal or environment-specific content.** Examples use placeholder names (`projectA`, `moduleB`, `<device-serial>`) and anonymous paths. Raw wet-audit captures remain in local or protected custody. Only protocol-designated, sanitized evidence and registries may be committed after privacy and integrity validation.
- **Pre-v1 surface.** The envelope contract is stable from `v0.9.0` onward (`schema_version: 2`); breaking changes bump the schema version and are documented in [envelope-contract.md](envelope-contract.md).
- **Source of truth.** When the docs and the code disagree, the code wins. File a contract bug if you spot a divergence.
- **Current behavior versus history.** Release history belongs in [`CHANGELOG.md`](../CHANGELOG.md). Audit and measurement pages retain dates and provenance; undated user guides describe the current implementation.

# Product principles — kmp-test-runner

`kmp-test-runner` is a command-line test runner for Kotlin Multiplatform and Android Gradle projects. It discovers the project's existing test tasks, executes them with safe parallelism, and turns noisy Gradle output into a compact, typed result.

## Users

Human and agent contributors working on KMP or Android projects across Windows, Linux, and macOS. Adoption should not require reshaping the consumer project around this tool.

## Value

The product optimizes two scarce resources:

- feedback time, by dispatching independent work concurrently;
- agent context, by emitting a small JSON envelope instead of requiring raw Gradle/report ingestion.

Measurements and their limits are maintained in [docs/metrics.md](docs/metrics.md). Product principles must not freeze a dated ratio or tokenizer result.

## Success criteria

1. Representative public KMP/Android projects work without project-specific patches.
2. Platform constraints produce explicit typed errors, never silent false passes.
3. Windows, Linux, and macOS share behavior where the underlying target permits it.
4. `--json` remains a stable, additive automation contract within the pre-1.0 line.
5. Defaults favor correctness and diagnosability; advanced concurrency and device behavior remain explicit.
6. Public claims are traceable to sanitized evidence and do not mix measurement populations.

## Architecture principles

Orchestration, discovery, parsing, envelope construction, JDK selection, and most policy live in Node under `lib/`. Shell and PowerShell files are platform entry points and installation glue. The Gradle plugin extracts and invokes the bundled Node runtime; it exposes a deliberate subset of the CLI surface.

New behavior should land once in shared Node logic when possible. Platform wrappers stay thin, and cross-platform tests protect the boundaries.

## Platform commitments

| Platform | Commitment |
|---|---|
| Windows | Native PowerShell installer/runtime glue; user-level PATH changes; Windows-specific locking tested. |
| Linux | Primary POSIX validation surface. |
| macOS | Bash-compatible installer/glue; Apple target execution only on capable macOS hosts. |
| Android device | Explicit ADB/device readiness and typed setup failures. |
| iOS/macOS targets | Explicit opt-in and clear host restrictions. |

Hosted macOS validation is intentionally selective because its CI cost is materially higher. Heavy Apple-target checks are manual gates, not implied per-PR coverage.

## Evidence principles

- Process exit zero is not automatically task success.
- Missing measurements remain missing.
- Operational canaries are not labelled benchmarks unless the acceptance contract says so.
- Raw authentication/custody material remains private; only sanitized, validated records are public.
- Dated audits remain historical snapshots and do not override current reference docs.

## Out of scope

- Consumer-specific private toolkit behavior or identifiers.
- Requiring a non-default shell as an adoption prerequisite.
- Replacing Gradle or the project's own test framework.
- Claiming full platform equivalence where Apple or Android device infrastructure is inherently required.
- Maven Central publication until implemented and released.
- Automated Evidence1 VM provisioning from a Windows ISO until a separate tested functional change delivers it.

## Documentation hierarchy

| Document | Purpose |
|---|---|
| `README.md` | Short public onboarding and product overview. |
| `docs/README.md` | Canonical documentation map. |
| `docs/cli-reference.md` | Public CLI flags/defaults, guarded against parser drift. |
| `docs/metrics.md` | Quantitative evidence and interpretation. |
| `docs/evaluation/` | Current evaluation/operator guides. |
| `CONTRIBUTING.md` | Contributor and PR workflow. |
| `CLAUDE.md` | Repository-specific agent/maintainer operating rules. |
| `BACKLOG.md` | Active work only; milestone choices belong to the maintainer. |
| `CHANGELOG.md` | Released behavior and unreleased user-visible changes. |
| `docs/audits/`, `tools/runs/` | Dated historical audits and evidence. |

Update this charter when strategy changes, not for every feature.

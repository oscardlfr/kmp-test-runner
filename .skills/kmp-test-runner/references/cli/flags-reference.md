# CLI flag reference

> **Status**: PLACEHOLDER. The full flag-reference table is shipped in a follow-up release of this skill. For the authoritative current list, see the [`README.md`](https://github.com/oscardlfr/kmp-test-runner#readme) in the source repo or run `kmp-test --help` / `kmp-test <subcommand> --help`.

Common flags an agent will need most often:

- `--json` — emit structured envelope to stdout (mandatory for agent consumption)
- `--module-filter <glob>` — narrow dispatch to modules matching the glob (e.g. `"core-*"`)
- `--test-filter <FQN>#<method>` — narrow dispatch to a single test class or method
- `--dry-run` — emit a plan envelope (`dry_run: true`) without spawning gradle
- `--no-coverage` — skip coverage aggregation
- `--isolated` — isolate runtime keys (one-at-a-time dispatch for shared-resource scenarios)
- `--java-home <path>` — override JDK selection
- `--gradle-args "<args>"` — pass-through args to gradle
- `--device <serial>` — restrict instrumented dispatch to a specific adb device
- `--flavor <name>` — restrict instrumented dispatch to a specific Android product flavor
- `--list-only` — emit the discovered module set without gradle dispatch
- `--force` — bypass the project lock when another `kmp-test` process holds it

The full per-subcommand flag matrix arrives in a follow-up release.

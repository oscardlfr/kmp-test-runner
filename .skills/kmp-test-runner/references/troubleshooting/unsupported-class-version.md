# `unsupported_class_version` — JDK toolchain mismatch

The project's compiled class files target a newer JDK than the gradle daemon's JVM is running. Test classes throw `UnsupportedClassVersionError` at load time before any test runs.

## Symptom

```json
{
  "exit_code": 3,
  "errors": [{
    "code": "unsupported_class_version",
    "class_file_version": 65,
    "runtime_version": 61,
    "message": "UnsupportedClassVersionError: com/example/Foo has been compiled by a more recent version of the Java Runtime (class file version 65.0), this version of the Java Runtime only recognizes class file versions up to 61.0"
  }]
}
```

`class_file_version: 65` = JDK 21, `runtime_version: 61` = JDK 17. Both fields are integers; map via `class_file_version - 44 = JDK major`.

Applies to every subcommand. Most common with `benchmark` (kotlinx-benchmark's JMH bytecode generator requires JDK 21+ even for projects targeting older JVMs).

## Root causes

1. **Project requires JDK 21+ but host default is JDK 17**: gradle daemon picked the host JDK because no toolchain was configured. Modern Compose / KMP / kotlinx-benchmark code routinely requires JDK 21.
2. **`jvmToolchain(N)` in `build.gradle.kts` not honored**: the daemon honors `org.gradle.java.installations.paths` / `org.gradle.java.installations.auto-download`. When neither is set, gradle uses the daemon's runtime JVM.
3. **kotlinx-benchmark JMH worker (Bug F)**: `JmhBytecodeGeneratorWorker` is compiled against JDK 21. Even if the project's `kotlin.jvmToolchain(17)`, this worker fails on a JDK 17 runtime.
4. **JDK catalogue empty**: `kmp-test`'s catalogue auto-select (`Adoptium / Zulu / Microsoft / Semeru / BellSoft` on Windows, `/Library/Java/JavaVirtualMachines/` on macOS, `/usr/lib/jvm` + `/opt/{java,jdk}` on Linux) finds no JDK 21 install → gate fires.
5. **`--ignore-jdk-mismatch` bypass + actual compatibility issue**: the user passed `--ignore-jdk-mismatch`, the gate downgraded to WARN, and the test then hit the same error at execution time.

## Recovery path

Resolution chain (highest precedence wins):

1. **`~/.kmp-test/config.json` `java_home`** — per-project, persistent, machine-specific. Recommended for user-globals:
   ```json
   {
     "projects": {
       "https://github.com/me/my-kmp.git": {
         "java_home": "/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home"
       }
     }
   }
   ```
2. **`--java-home <path>`** — one-shot override. Wins over user config and catalogue.
3. **`gradle.properties` `org.gradle.java.home=<path>`** — project-level, checked-in. Bypasses kmp-test's gate entirely.
4. **JDK catalogue auto-select** — install a matching JDK in a known location; kmp-test injects `JAVA_HOME` + prepended `PATH` automatically.

## Recovery commands

```bash
# One-shot with explicit JDK
kmp-test benchmark --java-home "/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home" --json

# Check what kmp-test sees as installed JDKs
kmp-test doctor --json | jq '.checks[] | select(.name == "JDK catalogue")'

# Persistent user-global config (Windows)
# Edit %USERPROFILE%\.kmp-test\config.json:
# {
#   "projects": {
#     "<git-remote-url-or-rootProject-name>": {
#       "java_home": "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.4.7-hotspot"
#     }
#   }
# }

# Confirm the gate resolved
kmp-test info --json | jq '.info.jdk'
```

## AGP / JDK quirks

- **kotlinx-benchmark + JDK 17 projects**: a known case — the JMH bytecode generator targets JDK 21. Even projects with `kotlin.jvmToolchain(17)` hit this. The workaround is a JDK 21 install + `--java-home` or user-global config.
- **gradle 8.x daemon under JDK 21**: works for most plugins, but very old AGP versions (< 7.4) reject JDK 21. If the project's AGP is ancient, bumping AGP is required first.
- **CI JDK matrix**: GitHub Actions's `setup-java@v4` action is the canonical way to install a specific JDK before invoking `kmp-test`. Setting `java-version: '21'` puts it in `JAVA_HOME` automatically — kmp-test then uses it without needing `--java-home`.
- **Multiple JDKs installed but catalogue can't see them**: check the install location matches kmp-test's catalogue search paths. Unusual install paths (e.g. `~/jdks/`, `D:\jdks\`) won't be found — pass `--java-home` explicitly or symlink.

## See also

- [`../cli/envelope-schema.md#errors-discriminated-codes`](../cli/envelope-schema.md#errors-discriminated-codes) — full code table (including `class_file_version` + `runtime_version` extras)
- [`../cli/exit-codes.md`](../cli/exit-codes.md) — exit-code → code mapping
- [`overview.md`](overview.md) — troubleshooting hub
- [`../workflows/benchmarks.md`](../workflows/benchmarks.md) — the workflow where this code most commonly fires

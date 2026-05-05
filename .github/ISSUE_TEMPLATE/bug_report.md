---
name: Bug report
about: Report a defect in kmp-test-runner (CLI, Gradle plugin, installers, or shell scripts)
title: "[bug] "
labels: bug
assignees: ''
---

## Summary

<!-- One sentence: what went wrong? -->

## Reproduction steps

<!-- Numbered steps, copy-pasteable commands. Include the project you ran against if possible. -->

1.
2.
3.

## Expected behaviour

<!-- What did you expect to happen? -->

## Actual behaviour

<!-- What actually happened? Include exit codes, error messages. -->

## Environment

| | Value |
|---|---|
| `kmp-test --version` | <!-- e.g. 0.8.0 -->  |
| OS | <!-- e.g. Windows 11 / Ubuntu 24.04 / macOS 14 --> |
| Node | <!-- `node --version` --> |
| Gradle (project) | <!-- `./gradlew --version` Gradle line --> |
| AGP (project) | <!-- if Android: AGP version from settings.gradle / libs.versions.toml --> |
| JDK | <!-- `java -version` --> |
| Shape | <!-- npm CLI / Gradle plugin / shell installer (linux.tar.gz / windows.zip) --> |

## Logs / output

<!--
Preferred: paste the `--json` envelope from `kmp-test <subcommand> --json`. It includes
the full diagnostic state we need for triage. Trim any secrets first.

If --json is not available for your case, paste the human banner output + the gradle log
fragment that surrounds the failure.
-->

```json
```

## Additional context

<!-- Anything else: prior workarounds tried, related issues, screenshots. -->

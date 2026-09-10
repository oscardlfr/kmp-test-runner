# Installation

## Requirements

- Node.js 18 or newer.
- A Gradle project with `gradlew` / `gradlew.bat`.
- A JDK compatible with that project. The CLI can select among common installed JDKs; use `--java-home` to pin one.
- PowerShell 5.1+ on Windows, or bash on Linux/macOS.
- Android SDK/ADB only for Android device work; Xcode only for Apple targets.

The Gradle plugin enforces Gradle 7.6 or newer. A consumer project may require a newer Gradle or JDK independently.

## Release installer

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1 | iex
```

The installers resolve the current GitHub Release, verify its published SHA-256 checksum, and install to a user-writable prefix. They do not require administrator rights; Windows PATH changes are user-level only.

Offline installation accepts a previously downloaded archive:

```sh
bash scripts/install.sh --archive ./kmp-test-runner-0.14.0-linux.tar.gz \
  --archive-sha256 ./kmp-test-runner-0.14.0-linux.tar.gz.sha256
```

```powershell
.\scripts\install.ps1 -LocalArchive .\kmp-test-runner-0.14.0-windows.zip `
  -LocalArchiveSha256 .\kmp-test-runner-0.14.0-windows.zip.sha256
```

## npm

```sh
npm install -g kmp-test-runner
kmp-test --version
```

A project-local dev dependency also works through `npx kmp-test`.

## Update and uninstall

```sh
kmp-test update --check --json
kmp-test update
```

Linux/macOS uninstall:

```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/uninstall.sh | bash
```

Windows uninstall:

```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/uninstall.ps1 | iex
```

## Gradle plugin package access

The plugin currently lives in GitHub Packages. Add this to `settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven {
            url = uri("https://maven.pkg.github.com/oscardlfr/kmp-test-runner")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull
                    ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
```

Store a token with `read:packages` in user-level `~/.gradle/gradle.properties`, never in the repository:

```properties
gpr.user=<github-user>
gpr.key=<token-with-read-packages>
```

Continue with the [Gradle plugin guide](gradle-plugin.md). For Windows-specific failures, see [Windows troubleshooting](troubleshooting-windows.md).

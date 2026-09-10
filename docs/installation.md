# Installation and upgrades

`kmp-test-runner` is distributed as an npm CLI, as platform archives with
installers, and as a Gradle plugin. All three distributions use the same version
from `package.json`; choose the integration that fits how the project is run.

## Requirements

### CLI and archive installer

- Node.js 18 or newer.
- A Gradle project with `gradlew` or `gradlew.bat` at its root when running tests.
- `bash` on Linux and macOS; PowerShell 5.1 or newer on Windows.
- A compatible JDK for the target project. JDK 17 or newer is recommended for
  current Gradle and Android Gradle Plugin releases.
- Android SDK platform tools and a connected device or emulator only for
  instrumented Android tests.
- macOS and Xcode for iOS simulator and macOS native tests.

Run `kmp-test doctor --project-root <project>` after installation to verify the
host. `doctor` treats a missing Gradle wrapper and missing ADB as warnings because
they are not required for every command.

### Gradle plugin

The Gradle plugin enforces Gradle 7.6 or newer. It is built with a JDK 17
toolchain and executes the bundled runner with an external `node` process, so
Node.js 18 or newer must also be on `PATH` (or selected with
`KMP_NODE_LAUNCHER`).

## npm

Install globally when `kmp-test` should be available from every project:

```sh
npm install --global kmp-test-runner
kmp-test --version
```

For a repository-pinned development dependency:

```sh
npm install --save-dev kmp-test-runner
npx kmp-test parallel --json
```

Pin an exact version in CI and committed lockfiles for reproducible runs:

```sh
npm install --save-dev --save-exact kmp-test-runner@0.14.0
```

Upgrade or remove a global npm installation with npm itself:

```sh
npm install --global kmp-test-runner@latest
npm uninstall --global kmp-test-runner
```

## Release installer

The release installers place the runtime under a user-owned prefix and add its
`bin` directory to the user's `PATH`. They do not require administrator access.
Remote archives are verified against the `.sha256` asset published with the
GitHub release before installation. An interrupted upgrade restores the previous
runtime where possible.

### Linux and macOS

Install the latest release:

```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash
```

The default prefix is `$XDG_DATA_HOME/kmp-test-runner`, falling back to
`~/.local/share/kmp-test-runner`. The installer creates
`<prefix>/bin/kmp-test` and updates the appropriate shell startup file for bash,
zsh, fish, or a generic POSIX shell.

To select a version or custom prefix, download the script first so arguments can
be passed explicitly:

```sh
curl -fsSLo /tmp/kmp-test-install.sh \
  https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh
bash /tmp/kmp-test-install.sh --version 0.14.0 --prefix "$HOME/.local/share/kmp-test-runner"
```

After installation, either open a new terminal or reload the startup file named
by the installer, then verify:

```sh
kmp-test --version
kmp-test doctor
```

### Windows

Install the latest release from PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1 | iex
kmp-test --version
```

The default prefix is `$env:LOCALAPPDATA\kmp-test-runner`. The installer creates
`<prefix>\bin\kmp-test.cmd`, updates only the current user's `PATH` in HKCU, and
also updates the current PowerShell session. It never changes the machine-wide
`PATH`.

To select a version or prefix, download and invoke the script:

```powershell
$installer = Join-Path $env:TEMP 'kmp-test-install.ps1'
Invoke-WebRequest `
  -Uri 'https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1' `
  -OutFile $installer
& $installer -Version '0.14.0' -Prefix "$env:LOCALAPPDATA\kmp-test-runner"
```

PowerShell 5.1 is supported. TLS 1.2 is enabled by the installer without
disabling other protocols already configured on the host.

## Offline installation and checksum verification

Download the release archive and its matching `.sha256` file on a connected
machine, transfer both across the trust boundary, and invoke the repository
script from a checkout.

Linux or macOS:

```sh
bash scripts/install.sh \
  --archive /media/releases/kmp-test-runner-0.14.0-linux.tar.gz \
  --archive-sha256 /media/releases/kmp-test-runner-0.14.0-linux.tar.gz.sha256
```

Windows:

```powershell
.\scripts\install.ps1 `
  -LocalArchive 'D:\releases\kmp-test-runner-0.14.0-windows.zip' `
  -LocalArchiveSha256 'D:\releases\kmp-test-runner-0.14.0-windows.zip.sha256'
```

Supplying a local archive without its checksum file deliberately skips checksum
verification. Use that mode only when integrity is guaranteed by another
mechanism. The installers still validate the extracted package layout and
package name before replacing an existing installation.

## Updating a release-installer installation

`kmp-test update` probes the latest GitHub release and reuses the platform
installer. It is idempotent when the installed version is current.

```sh
kmp-test update --check --json
kmp-test update
kmp-test update --force
```

`--check` never installs. `--prerelease` allows prerelease tags, and
`--prefix <path>` forwards a non-default prefix to the installer. Update errors
are machine-readable as `release_resolve_failed`,
`current_version_unresolvable`, or `install_failed`.

This command is intended for release-installer installations. Use npm or the
Gradle dependency declaration to update those distribution shapes.

## Uninstalling a release-installer installation

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/uninstall.sh | bash
```

For a custom prefix, download the script and pass `--prefix <path>`.

Windows:

```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/uninstall.ps1 | iex
```

For a custom prefix, run the downloaded script with `-Prefix <path>`.

Both uninstallers verify that the target looks like an owned
`kmp-test-runner` installation before removing it. They refuse filesystem roots,
the user's home/profile directory, and unrecognized layouts. The POSIX
uninstaller leaves removal of the startup-file `PATH` line as an explicit manual
step; the Windows uninstaller removes the matching entry from the user `PATH`.

## Gradle plugin installation

The Gradle plugin is currently published to GitHub Packages. It therefore needs
package-read credentials during dependency resolution. See
[Gradle plugin](gradle-plugin.md) for repository configuration, credentials,
tasks, and the exact extension surface.

## Troubleshooting installation

- Run `kmp-test --version` to confirm which executable is on `PATH`.
- Run `kmp-test doctor --project-root <project>` to inspect Node, shell, wrapper,
  JDK, Android SDK, ADB, and configuration discovery.
- On Windows hosts with corporate TLS interception, see
  [Windows TLS troubleshooting](troubleshooting-windows.md#tls-interception-errors).
- If a checkout's shell scripts acquired CRLF endings, see
  [Windows line-ending troubleshooting](troubleshooting-windows.md#bundled-shell-script-line-endings).
- A specific JDK can be selected per invocation with `--java-home <path>` or per
  project in the user-global configuration described in [Usage](usage.md#jdk-selection).

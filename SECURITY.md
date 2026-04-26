# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest on `main` | ✅ |
| Older releases | ❌ |

`kmp-test-runner` follows a rolling release model. Only the latest version on `main` (published to npm + GitHub Packages + GitHub Releases) receives security updates. Pin to the latest minor in your own builds and update promptly when a security advisory lands.

## Reporting a Vulnerability

**Do not open a public issue for security vulnerabilities.**

Instead, please report security issues by emailing **oscardlfr@gmail.com** with:

1. Description of the vulnerability
2. Steps to reproduce (a minimal repro is most helpful — tag a fork or paste a PR diff)
3. Impact assessment (what could an attacker do? remote code execution, arbitrary file write, secret exfiltration, etc.)
4. Suggested fix (if you have one)

Encrypt with PGP if your report contains exploit details — public key on request.

### What qualifies as a security issue?

- **Secrets or credentials** committed to the repo (CI tokens, API keys, signing keys). The `secrets-scan` CI job runs TruffleHog on every PR; a bypass or false-negative is in scope.
- **Command injection** in `scripts/sh/*.sh`, `scripts/ps1/*.ps1`, or `bin/kmp-test.js` (e.g. unsanitised `--module-filter`, `--test-filter`, or `--project-root` argv reaching `eval`/`Invoke-Expression`/`exec` unquoted).
- **Path traversal** in the install/uninstall scripts (`scripts/install.{sh,ps1}`, `scripts/uninstall.{sh,ps1}`) — e.g. a crafted `--archive` value that escapes the install prefix.
- **Arbitrary code execution** via the npm post-install or the Gradle plugin's `apply()` block.
- **CI workflow exploits** — any path where a malicious PR can read repository secrets, escalate to write access, or trigger publishing of an unreviewed release.
- **Supply-chain risks** — typosquat-prone npm package names, missing integrity checks on downloaded artefacts (`linux.tar.gz` / `windows.zip` checksums), or compromised dependencies surfaced by `npm audit`.
- **PowerShell-specific** — `Invoke-Expression` with user input, `-NoExit` left in production scripts, or `ExecutionPolicy` bypasses the installer doesn't warn about.
- **Lockfile poisoning** — `package-lock.json` integrity hashes that don't resolve to the published artefact.

### Out of scope

- Issues in upstream dependencies that have not been triggered by `kmp-test-runner` code (please report to the upstream project; we'll backport mitigations if applicable).
- Vulnerabilities in `gradle-plugin/gradlew` or `gradlew.bat` — these are unmodified files from the Gradle wrapper distribution (Apache-2.0); report to Gradle directly.
- DoS via deliberately malicious test fixtures fed to `kmp-test` from a checkout the user controls.

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgment | Within 48 hours |
| Assessment | Within 1 week |
| Fix (if confirmed) | Within 2 weeks for high-severity; 4 weeks for medium-severity |
| Public disclosure | After a fix is published to npm + GitHub Packages |

## Security-Oriented Features Already in the Project

- **`secrets-scan` CI job** (TruffleHog on every PR + push) — required-status check on `main` and `develop`.
- **Trusted Publisher OIDC** for npm publishing (no static `NPM_TOKEN` secret in the repo).
- **Step-level `GITHUB_TOKEN` scoping** in publish workflows — minimum permissions per job.
- **Lockfile audit** (`npm audit` runs in CI) — known CVEs surface as warnings.
- **Branch protection** with `enforce_admins: true` on `main` and `develop` — owner cannot bypass CI checks.
- **Squash-merge enforcement** — only PR-validated commits land on protected branches; merge graph stays linear.
- **Conventional Commits gate** — PR titles validated by `commit-lint` workflow before squash; commit messages auditable.
- **Multi-agent concurrency safety** (v0.3.8+) — advisory lockfile at `<project>/.kmp-test-runner.lock` prevents two `kmp-test` runs from clobbering each other's reports/temp files.

---
paths:
  - "scripts/**/*.sh"
  - "scripts/**/*.ps1"
  - "tests/bats/**/*"
  - "tests/pester/**/*"
  - "tests/installer/**/*"
  - "tests/skill-scripts/**/*"
---

# Platform script rules

- Keep POSIX and PowerShell public flags, argument forwarding, and observable
  behavior in parity. Documented configuration/environment variable names and
  semantics are also public API. Update the sibling implementation and tests
  together.
- Keep wrappers thin: dispatch to Node and pass through stdout, stderr, args,
  and exit codes. New behavioral logic belongs in `lib/`.
- POSIX scripts must run on the default Bash 3.2 shipped with macOS. Do not use
  associative arrays, namerefs, or GNU-only utilities without a portable path.
- Preserve LF endings and executable bits on shipped shell scripts.
- Installer changes require archive round-trip regression coverage in both
  Bats and Pester when the bug class is cross-platform.
- Preserve the installer/release contract: one top-level
  `kmp-test-runner-${VER}/` directory, architecture-agnostic Linux and Windows
  archive names, packaged `package.json`, and redirect-first latest-version
  lookup with GitHub API fallback.
- Never write machine-wide Windows PATH state; installers use the current user.

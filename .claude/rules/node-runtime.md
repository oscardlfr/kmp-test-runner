---
paths:
  - "bin/**/*.js"
  - "lib/**/*.js"
  - "tools/**/*.{js,mjs}"
  - "tests/vitest/**/*.js"
---

# Node runtime rules

- Use ESM and APIs available on the declared `engines.node` floor.
- Put orchestration, parsing, discovery, envelope shaping, and cross-platform
  behavior in Node rather than shell wrappers.
- Treat the JSON envelope, semantic exit codes, and documented CLI flags and
  configuration/environment variables as public API. Keep
  `docs/envelope-contract.md`, the consumer skill, and focused regressions in
  sync with observable changes; incompatible envelope changes require an
  intentional breaking release and migration guidance.
- Prefer pure helpers and dependency injection for process, filesystem, clock,
  and environment behavior so tests remain deterministic.
- Treat Windows, Linux, and macOS as first-class. Avoid shell-dependent quoting
  or path assumptions in Node code.

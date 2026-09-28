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
- Preserve the JSON envelope and semantic exit-code contracts. Add a focused
  Vitest regression for every new branch or bug class.
- Prefer pure helpers and dependency injection for process, filesystem, clock,
  and environment behavior so tests remain deterministic.
- Treat Windows, Linux, and macOS as first-class. Avoid shell-dependent quoting
  or path assumptions in Node code.

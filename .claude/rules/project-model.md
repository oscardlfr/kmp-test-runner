---
paths:
  - "lib/project-model.js"
  - "lib/project/**/*.js"
  - "lib/orchestrators/android-orchestrator.js"
  - "lib/orchestrators/benchmark-orchestrator.js"
  - "lib/orchestrators/describe-orchestrator.js"
  - "lib/orchestrators/parallel-orchestrator.js"
  - "lib/orchestrators/parallel/dispatch.js"
  - "scripts/sh/lib/project-model.sh"
  - "scripts/sh/lib/script-utils.sh"
  - "scripts/ps1/lib/ProjectModel.ps1"
  - "scripts/ps1/lib/Script-Utils.ps1"
  - "tests/vitest/android-orchestrator.test.js"
  - "tests/vitest/benchmark-orchestrator.test.js"
  - "tests/vitest/project-model.test.js"
  - "tests/vitest/describe-orchestrator.test.js"
  - "tests/vitest/parallel-orchestrator.test.js"
  - "tests/vitest/cross-platform-fixture.test.js"
---

# Project model rules

- The Node project model owns module, source-set, plugin, and per-module Gradle
  task discovery. Shell and PowerShell readers consume its JSON and may use
  only documented compatibility fallbacks when the model is unavailable.
- Keep `unitTestTask`, `deviceTestTask`, `webTestTask`, `iosTestTask`, and
  `macosTestTask` independent. One target family must not silently populate or
  override another family's field.
- Candidate order, probe precedence, and fallback behavior are observable
  dispatch contracts. Preserve per-module resolution and update the matching
  readers, focused tests, and user documentation whenever they change.

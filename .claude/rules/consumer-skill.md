---
paths:
  - ".skills/**/*"
  - ".claude-plugin/**/*"
  - "tests/skill-scripts/**/*"
  - "tests/vitest/skill-canonical-workflow.test.js"
  - "tests/vitest/validate-plugin.test.js"
---

# Consumer skill and plugin rules

- `.skills/kmp-test-runner/` is a shipped consumer artifact, not repository
  maintainer memory. Keep its instructions focused on using the public CLI.
- Preserve progressive disclosure: `SKILL.md` routes workflows and references;
  detailed contracts stay in the smallest relevant reference file.
- The Claude Code plugin must reuse `.skills/` rather than copy it into a
  vendor-specific tree.
- Changes to trigger wording or workflow behavior require the canonical skill
  tests and, when behavior could affect invocation rates, the agentic evals.
- Run both `skills-ref validate` and `tools/validate-plugin.mjs` after edits.

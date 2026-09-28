---
paths:
  - "gradle-plugin/**/*"
  - "tests/fixtures/**/*.gradle.kts"
  - "tests/fixtures/**/*.gradle"
  - "tests/fixtures/**/gradle.properties"
---

# Gradle plugin rules

- Gradle tasks must dispatch the same runtime and argument shapes as the npm
  CLI; extend cross-shape parity coverage when the public surface changes.
- Use the local Maven repository fixture approach for TestKit. Do not switch to
  `withPluginClasspath()`; it is not reliable for this plugin shape.
- Keep the plugin version sourced from `package.json` through
  `tools/sync-versions.js`; do not hand-maintain another version source.
- Avoid adding Apple-hosted TestKit work to normal pull-request CI. Use the
  manually dispatched macOS validation workflow for heavy Apple coverage.

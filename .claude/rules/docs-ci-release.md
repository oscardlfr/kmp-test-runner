---
paths:
  - "*.md"
  - "docs/**/*.md"
  - ".github/**/*"
  - "package.json"
  - "package-lock.json"
  - "tools/sync-versions.js"
  - "tools/validate-*.mjs"
---

# Documentation, CI, and release rules

- Keep `README.md` user-facing and timeless. Put chronology and migration notes
  in `CHANGELOG.md`, prioritization in `BACKLOG.md`, and stable strategy in
  `PRODUCT.md`.
- Published metric ratios must use one project/capture for both sides unless a
  deliberate cross-project comparison is labelled inline.
- Do not autonomously create, move, rename, or drop milestones.
- Do not add new required status checks without updating the required-checks
  manifest and branch-protection process. Prefer extending an existing cheap
  gate when the concern belongs there.
- `package.json` is the version source of truth. Follow
  `docs/maintainers/release-process.md` for release work; never open a release
  pull request to `main` or push `main` manually.
- Keep per-PR macOS usage minimal; heavy Apple validation stays manual.

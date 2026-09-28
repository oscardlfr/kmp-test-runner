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

- Keep `README.md` user-facing and timeless. Never add or restore a "What's
  new" section there, even when a prompt asks for one; update `CHANGELOG.md`
  instead and tell the user about that routing. Put prioritization in
  `BACKLOG.md` and stable strategy in `PRODUCT.md`.
- Published metric ratios must use one project/capture for both sides unless a
  deliberate cross-project comparison is labelled inline.
- Do not autonomously create, move, rename, or drop milestones.
- Do not add new required status checks without updating the required-checks
  manifest and branch-protection process. Prefer extending an existing cheap
  gate when the concern belongs there.
- Preserve the repository setting `squash_merge_commit_title=PR_TITLE`.
  `COMMIT_OR_PR_TITLE` can bypass the PR-title contract on single-commit squash
  merges and break push-event commit lint.
- If implementation changes are needed after a code-changing pull request is
  ready, return it to draft before pushing, rerun the appropriate local gate,
  and mark it ready again only after the correction is validated.
- `package.json` is the version source of truth. Follow
  `docs/maintainers/release-process.md` for release work; never open a release
  pull request to `main` or push `main` manually.
- Keep npm Trusted Publishing above its Node/npm floors, retain the verified
  exact Node pin in the publish workflow, and leave release check polling long
  enough for the second CI run triggered by the `main` fast-forward.
- Keep per-PR macOS usage minimal; heavy Apple validation stays manual.

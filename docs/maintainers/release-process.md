# Release process

`develop` is the integration branch. `main` contains released commits only and
every push to it starts the publishing cascade. Humans and ordinary automation
must not push `main` directly.

## Prepare the release on `develop`

1. Create a normal branch from current `origin/develop`.
2. Update `package.json#version`, the source of truth.
3. Run `rtk node tools/sync-versions.js` to update the Gradle plugin, README
   sample, and Claude Code plugin manifest.
4. Rename the `CHANGELOG.md` Unreleased content to the new version and date,
   then leave a fresh Unreleased section.
5. Open a pull request to `develop` titled
   `chore(release): prepare vX.Y.Z` and merge only after required checks pass.

## Fast-forward `main`

After the preparation pull request lands, dispatch the `Release` workflow with
the version as input. The workflow verifies that:

- the input matches `develop`'s `package.json`;
- `main` is an ancestor of `develop`;
- the matching tag does not already exist.

The workflow mints a short-lived release-bot GitHub App token and performs a
true `develop:main` fast-forward. There is no `develop` to `main` pull request
and no `release/*` branch.

## Publishing cascade

The fast-forward push triggers the tag/release artifact workflow, npm publish,
and Gradle plugin publish. Each publisher is idempotent and skips a version that
already exists in its target registry. Manual workflow dispatch remains a
recovery path for registry outages; it is not the normal release flow.

When the cascade finishes, `main` and `develop` point at the same commit. No
sync-back merge is required.

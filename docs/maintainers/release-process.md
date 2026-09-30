# Release process

`develop` is the integration branch. `main` contains released commits only and
every push to it starts the publishing cascade. Humans and ordinary automation
must not push `main` directly.

## Prepare the release on `develop`

1. Create a normal branch from current `origin/develop`.
2. Update `package.json#version`, the source of truth.
3. Run `node tools/sync-versions.js` to update the Gradle plugin, README
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
- the matching tag does not already exist;
- every context in `.github/required-checks.json` is green on the exact
  `develop` SHA that will be pushed.

The workflow mints a short-lived release-bot GitHub App token and performs a
true `develop:main` fast-forward. There is no `develop` to `main` pull request
and no `release/*` branch.

The release-bot GitHub App is the sole bypass actor on the `main` ruleset. Its
short-lived token is minted from `RELEASE_APP_ID` and
`RELEASE_APP_PRIVATE_KEY`. A `GITHUB_TOKEN` push cannot replace it: GitHub's
anti-recursion guard would suppress the downstream publish workflows.

## Distribution invariants

- Release archives contain one top-level `kmp-test-runner-${VER}/` directory;
  both installers strip that directory during extraction.
- The runtime is architecture-agnostic. Publish exactly one
  `kmp-test-runner-${VER}-linux.tar.gz` and one
  `kmp-test-runner-${VER}-windows.zip`, with no architecture suffix.
- Include `package.json` inside both archives because the installed CLI reads
  it to report its version.
- Latest-version resolution uses the GitHub redirect first and the API as a
  fallback, avoiding the unauthenticated API rate limit on the normal path.

## Publishing cascade

The fast-forward push triggers the tag/release artifact workflow, npm publish,
and Gradle plugin publish. Each publisher is idempotent and skips a version that
already exists in its target registry. Manual workflow dispatch remains a
recovery path for registry outages; it is not the normal release flow.

The `gh` CLI receives credentials through the `GH_TOKEN` environment variable,
not the `GITHUB_TOKEN` environment variable. The GitHub Release step may map
the built-in `${{ secrets.GITHUB_TOKEN }}` secret into `GH_TOKEN`; the release
fast-forward uses the App token instead.

npm Trusted Publishing requires npm 11.5.1 or newer and Node 22.14.0 or newer.
The publish workflow deliberately pins Node 24.18.0, whose bundled npm clears
both floors. Re-verify the bundled npm before changing that exact pin. All
`release-gate.mjs poll-checks` callers retain a 60-minute timeout because the
fast-forward to `main` starts a second CI run on the same SHA, and the Windows
build job alone may take up to its 45-minute cap.

When the cascade finishes, `main` and `develop` point at the same commit. No
sync-back merge is required.

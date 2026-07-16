# kmp-test-runner — Full-Repo Audit & Improvement Plan v3.2 (v0.14.0, `develop`)

> v3.2 — v3.1 preserved, with the GPT-5.6 SOL + Fable 5 final operational amendments
> integrated in place.
> v3.1 — v3 preserved, with the round-3 amendment applied in place (10 adjustments).
> Every round-2 claim checkable from this session was verified in source and confirmed.

## v3.2 amendment log (final execution hardening)

1. **Fork-safe privacy mechanism is selected, not left as an option**: PR-02 uses a trusted
   `workflow_dispatch`/privileged check path from `develop`, keyed by PR number + exact head
   SHA. Scanner code comes from trusted base; PR contents are fetched as data only and never
   executed. Private patterns come from CI secrets/local git-ignored state; public generic
   shape rules still run in unprivileged fork CI. PR-00 and PR-02 share one redaction core.
2. **CI cost and dev-tool risk move earlier**: PR-19, PR-20b and PR-20c now run after PR-06
   and before the Gradle/plugin/behavior waves.
3. **PR-07 test contract expanded**: TestKit must cover declared minimum Gradle and current
   supported Gradle via `withGradleVersion`, add configuration-cache store/reuse regression
   coverage, and include a lasting Windows TaskAction smoke because the original failure mode
   is Windows-sensitive.
4. **Node floor validation made real**: `engine-strict` alone is not accepted as a substitute
   for testing on the declared Node floor. CI must run Node 18 plus a current supported Node
   version, or the package must explicitly raise its floor.
5. **Quality gate command fixes**: use `npm ci` + `npm run test:coverage`; avoid `npx` in
   validation. Gradle plugin checks run from `gradle-plugin/` (`./gradlew test` or
   `.\gradlew.bat test` on Windows), because there is no root wrapper.
6. **Execution wording fixed**: dependencies are explicit and every PR must leave `develop`
   green; the plan no longer claims all PRs are independently mergeable.
7. **PR-28 split rule**: the verify-first trio becomes separate PRs if more than one issue
   reproduces, because the cache fingerprint, JDK scanner and Android XML paths have different
   contracts.

## v3.1 amendment log (round 3)

1. **Exit codes (PR-27) — recommendation inverted, now DECIDED**: code follows the published
   contract. `unsupported_class_version` → exit 3 (environment/JDK), `task_not_found` →
   exit 3 (not a test assertion), `gradle_timeout` → exit 3. Observable behavior change →
   ships with a migration note. Removed from open decisions.
2. **TestKit repo (PR-07)**: isolated temporary Maven repository ONLY — never `mavenLocal`,
   never `flatDir` (doesn't resolve plugin markers), never `withPluginClasspath` (broken in
   this project).
3. **PR-05**: `detect-env.ps1` executes `exit 0` (line 32) — dot-sourcing would kill the
   caller; detection must be refactored into an exit-free function. `npx kmp-test`
   (run-tests.ps1:106) replaced by direct `kmp-test` resolution (npx may download an
   arbitrary package).
4. **PR-04**: install marker must not strand existing installs — validated legacy-layout
   adoption path + tests proving arbitrary delete can never be enabled.
5. **Privacy bootstrap + forks**: evidence generator moves to PR-00 (PR-01/PR-02 need it);
   private scanner must work without repo secrets on fork PRs (locally-maintained state /
   GitHub App / privileged workflow that treats the diff as data and never executes
   untrusted code).
6. **PR-25 ordered before PR-10** (or combined): both touch argument transport. No
   prescribed `^`-escape until proven — requirement is byte-for-byte transport, `cmd /v:off`,
   real round-trip tests.
7. **macOS jobs → `workflow_dispatch` ONLY** (no nightly — recurring spend). Concurrency
   cancellation applies to PRs only, never to develop/main/release pushes. DECIDED, removed
   from open decisions.
8. **Python (PR-17)**: preferred fix is porting the coverage-XML parser to Node (zero new
   deps); fallback minimum is doctor check + timeout + discriminated error — never silent
   "no coverage".
9. **PR-20 split into three** (commit-lint-safe titles): `test:` hermetic snapshots /
   `ci:` Node-floor + line-endings validation / `build(deps):` dev-vulnerability remediation.
10. **Release guard (PR-06) drift-resistant**: validate the exact required-check names +
    `success` conclusion + exact SHA with wait-and-timeout; contexts sourced from the
    ruleset or a canonical manifest that CI itself validates.
    Quality-gate wording: `--dry-run` never *counts as wet evidence* (PR-18 may still test
    dry-run in addition to its real wet runs).

## v3 delta log (what changed vs v2)

1. **Quality gate**: wet smoke (official + private project) is mandatory on **every PR**, not
   just behavior-touching ones; platform scope expands per change (§4 rewritten).
2. **Ordering fixed**: release hardening + checksum emission (now PR-06) moved to Phase 1,
   *before* installer checksum verification (PR-06b) — the v2 PR-06→PR-13 dependency was
   phase-inverted.
3. **Windows quoting is NOT clean** (v2 error): cmd.exe route expands `%VARIABLE%` inside
   args (reproduced) — new PR-25 with tests for `%`, `!`, `^`, quotes, metacharacters.
4. **`update --json` broken** (new): `stdio:'inherit'` lets the installer contaminate stdout
   before the JSON — new PR-26; verified at update-orchestrator.js:~320.
5. **PR-10 redesigned**: no blanket rejection of `--`-prefixed values (breaks
   `--gradle-args --no-parallel`); contextual per-flag schema + opaque-value preservation +
   separator parity across ALL ps1 wrappers.
6. **Release guard is mandatory, not optional**: release.yml fast-forwards `main` via a
   bypass bot without verifying the develop SHA's 10 required checks are green (verified —
   only version/ancestor/tag guards exist). Folded into PR-06 as a required item; removed
   from user decisions.
7. **Exit-code docs NOT in sync** (v2 "audited-clean" error): docs give exit 3 to
   `task_not_found`/`unsupported_class_version` but result-rollup.js:356-364 returns exit 1
   (verified); `gradle_timeout` absent from the doc — new PR-27.
8. **PR-07 scope completed**: full runtime-tree extraction invoking the real runner,
   clean/incremental JAR content tests, no `publishToMavenLocal` in TestKit, drop
   `CleanupMode.NEVER`, replace the tautological CrossShapeParityTest (two hand-written maps
   compared to each other — verified), add `CoverageTask.testType`, real `projectRoot`
   default, remove unused `koverDetected`.
9. **Privacy mechanism decided**: NO salted hashes (poor for paths/partials, CI-hostile).
   Private patterns load from a CI secret + git-ignored local file, generic shape rules stay
   public, evidence generator is fail-closed. This plan file no longer reproduces the real
   serial.
10. **Additional findings absorbed**: hardcoded `python3` (verified,
    coverage-orchestrator.js:276), incomplete model fingerprint, JDK scanner reading
    comments/strings, potentially stale Android XML in results, 7 dev-dep vulnerabilities now
    assigned to a PR, heavy macOS jobs (`bats-macos`, `gradle-plugin-test-ios`) verified to
    run on every heavy PR contrary to the documented mac-minutes rule. **Factual fix**:
    package.json already declares `engines.node >=18` — PR-20 now validates the floor in CI
    and forces the Node-18-vs-LTS decision instead of "declaring" engines.

## Context

Exhaustive audit across 11 dimensions producing a prioritized, PR-grouped plan executable in
successive sessions against `develop` (gitflow, Conventional Commits titles, 10 required CI
checks, squash merge). Sources: three deep audit passes + the Codex 5.6 counter-audit
(two rounds, with Windows/PS 5.1 and gradle-plugin wet reproductions) + hand-verification of
every load-bearing claim.

Constraints: no milestones/v0.15+ assignment; no breaking envelope changes without migration
path; no new prod deps; no new *recurring* macOS CI load; dependencies explicit; every PR
leaves `develop` green; tests never weakened.

Excluded (already fixed PRs #293–#311 or queued in BACKLOG): maxBuffer/spawn_error, atomic
lock *acquisition*, dangling-flag rejection, junit-xml size guard, cascade-retry bounds, toml
cache-key, artifact sweep/clean, `~` java.home doctor row; queued: `--output-dir` output
root, measure-token-cost sharp edges.

## 1. Corrections accepted from the counter-audit (rounds 1+2)

- **Gradle plugin: ALL 5 tasks broken.** Three overlapping `Sync` roots
  (`build.gradle.kts:77-94`) mutually delete bundle content (`Sync` removes destination files
  absent from source; `syncPackageJson` targets `resources/main` root) → JAR
  nondeterministically lacks `lib/runner.js`, orchestrators, coverage parser;
  `scripts/lib/` never synced at all. Reproduced on `androidTests`/`parallelTests`.
- **TestKit**: gradle `--dry-run` skips all actions — task smokes must execute for real
  against a fake `node` shim on PATH that records argv.
- **Downgraded/removed from v1**: analyze-module suite (99.31% covered), Bash-3.2 colon fix
  (LOW quick-win; consider deleting the legacy path), `Property<T>` (non-blocking), XXE claim
  (unproven — removed), legacy `modules[]` shape (schema decision), cli.js shim (retain).
- **Vitest**: 3.x not latest; Vitest 4 needs Node 20 → explicit user decision (3.2.x vs
  coordinated Node 20/Vitest 4).
- **dry-run**: strictly side-effect-free (no probe, no cache writes) — docs already promise it.

## 2. Findings (consolidated, verified, prioritized)

### P0 — Privacy (treat as exposed NOW)

| # | File | Finding |
|---|------|---------|
| P1 | `.skills/kmp-test-runner/SKILL.md:132`, `references/cli/flags-reference.md:158`, 8+ more skill docs | **A real Samsung device serial** (11-char alphanumeric, `R3C…` prefix — deliberately not reproduced here; grep the skill docs for it) committed and published to GitHub + npm + plugin marketplace. Replace with `<DEVICE_SERIAL>` or another obviously-non-real placeholder; treat as already exposed. |
| P2 | `tools/decouple-audit.mjs:44-57,63-65` | **The privacy gate publishes what it protects**: private identifiers in committed plaintext; matches echoed to CI logs; case-sensitive patterns; `SKIP_PREFIXES` excludes tracked `tools/runs/`. Redesign per §v3-9. |
| P3 | (process) | No fail-closed sanitizer for wet evidence (logs, serials, private-project names) before commit — required by the §4 gate. |

### CRITICAL

| # | File | Finding |
|---|------|---------|
| C1 | `gradle-plugin/build.gradle.kts:77-99` + `tasks/*.kt` | All 5 plugin tasks broken: overlapping `Sync` roots + `scripts/lib` never bundled + hard-error extractors. Reproduced. |
| C2 | `gradle-plugin/src/test/kotlin/**` (14 tests) | False green: only `tasks --all` runs; no `@TaskAction` executes; `CrossShapeParityTest.kt:15` is tautological (compares two hand-written maps, not production code). |
| C3 | `scripts/uninstall.sh:39`, `scripts/uninstall.ps1:41` | Unguarded `rm -rf "$PREFIX"` / `Remove-Item -Recurse -Force` — existence check only; typo'd `--prefix` deletes an arbitrary tree. |
| C4 | `.github/workflows/publish-release.yml:41-48` | Shell injection: `${{ inputs.tag }}` interpolated into `run:`; no format/existence/package.json validation. |
| C5 | `scripts/install.ps1` | Fails to parse on Windows PowerShell 5.1 (UTF-8 no-BOM + non-ASCII; reproduced); missing TLS 1.2, atomic install, checksums, true offline install. |
| C6 | `.github/workflows/release.yml:77-82` | `main` fast-forwarded by a bypass bot with **no verification that the exact develop SHA has the 10 required checks green** (only version-match/ancestor/tag-exists guards — verified). Mandatory fix. |

### HIGH

| # | File | Finding |
|---|------|---------|
| H1 | `lib/runners/lockfile.js:149` + `script-dispatcher.js:418` | Lock ownership race: unconditional unlink on cleanup; after `--force` takeover the original process deletes the new owner's lock. |
| H2 | `lib/orchestrators/changed-orchestrator.js:335-343` | Git failure masked as success: `gitProbe.status !== 0` → `no_changed_modules` → exit 0. |
| H3 | `.github/workflows/*` | Supply chain unpinned: `trufflehog@main`, tag-pinned actions, unpinned `npx -y skills-ref` (ci.yml:173), `npm install -g npm@latest` (publish-npm.yml:50); no actions Dependabot. Plus 7 known dev-dep vulnerabilities assigned to early PR-20c after the Node-floor decision. |
| H4 | `lib/orchestrators/orchestrator-utils.js:~73` | Multiline `include(...)` invisible to discovery (`/\binclude\b([^\n;]*)/g` stops at newline — verified). |
| H5 | (reproduced set) | False-green cluster: `wasm`/`android` test-type can silently execute JVM; unknown flags ignored; `--max-failures` parsed-but-unconsumed in `changed` (verified: lines 50,97-99 only); explicit `--java-home` can be lost; ADB accepts `offline`/`unauthorized` devices. |
| H6 | (reproduced set) | Results integrity: leg timeout reclassified as `module_failed` (dispatch.js:711-720 reads only `status` — verified) AND can trigger the retry cascade; android retry preserves failed-attempt counts; benchmark grading differs with/without `--json`; coverage drops aggregation warnings. |
| H7 | `lib/orchestrators/coverage-orchestrator.js:285-322,677-752` | `--min-missed-lines` suppresses report + emits false `no_coverage_data` (row-filter feeds `modulesContributing`; gate correctly unfiltered — verified). |
| H8 | `lib/parsers/script-output.js:346` + docs | dry-run spawns gradle + writes cache on cold cache while docs promise side-effect-free (verified bare `buildProjectModel` call). Make strictly side-effect-free. |
| H9 | `lib/orchestrators/orchestrator-utils.js:157-177` | **Windows cmd.exe route expands `%VARIABLE%` inside quoted args** (reproduced) — filters/`-P` properties containing `%` are silently rewritten; `!`/`^` risky under delayed expansion. v2's "quoting clean" verdict retracted. |
| H10 | `lib/orchestrators/update-orchestrator.js:~320` | `update --json` contaminated: install script spawned with `stdio:'inherit'` (verified) — installer output precedes the envelope on stdout. `--json` must emit exactly one object. |
| H11 | `docs/…exit-codes` vs `result-rollup.js:356-364` | Docs assign exit 3 to `task_not_found`/`unsupported_class_version`; code returns exit 1 (verified: both in the TEST_FAIL set); `gradle_timeout` missing from the doc. Contract decision + sync needed. |

### MEDIUM

| # | File | Finding |
|---|------|---------|
| M1 | `scripts/ps1/run-parallel-coverage-suite.ps1:18-89` + siblings | No remaining-args catch-all; brittle `ValidateSet`; **only this wrapper (line 69) splits the internal `--gradle-args` separator — the other ps1 wrappers don't** (parity gap); `expandPosixEqualsForm` can alter opaque values. |
| M2 | `.skills/.../run-tests.ps1:96` | `& pwsh` spawn crashes on PS-5.1-only hosts; sh/ps1 CLI-resolution mismatch. |
| M3 | `.github/workflows/ci.yml` | No `concurrency` group; most jobs missing `timeout-minutes`; no npm/gradle caches. **Verified: `bats-macos` (l.229) + `gradle-plugin-test-ios` (l.262) run on macos-latest for every heavy PR**, contrary to the documented mac-minutes rule (informational-only ≠ free). |
| M4 | `lib/orchestrators/coverage-orchestrator.js:276` | Hardcoded `python3` spawn (verified) — plain `python`/py-launcher Windows hosts fail the parser path. Resolve interpreter (python3 → python → py) once, reuse. |
| M5 | `lib/cli.js:1015-1069` | Enum allowlists re-typed inline vs `argv-constants.js`. |
| M6 | `lib/cli.js` | ~532/1218 LOC help table; live-binding import-cycle hub (5 upward importers). Extract help + leaf imports, **shim retained**. |
| M7 | 4 discovery walkers + 3 `buildFilterArgs` | Real duplication; unify after contracts pinned. |
| M8 | `script-dispatcher.js` (15 tests) + 6 bats scenarios without Pester twins | Thin error-path + Windows integration coverage. |
| M9 | tests | One snapshot depends on `JAVA_HOME` (1922/1923 locally); bats invalidated by CRLF on Windows checkouts. |
| M10 | (verify-first trio) | Incomplete project-model fingerprint (some model-affecting inputs not hashed); JDK signal scanner matches inside comments/strings; android results may read stale XML from a prior run. Each needs a pinned repro before fixing. |
| M11 | gradle-plugin | No declared minimum Gradle version; `CoverageTask.testType` missing; `projectRoot` default not real; `koverDetected` unused. (Folded into PR-07.) |

### LOW (quick-win pool — §5)

junit-xml attr/multi-failure edges; double JUnit-XML walk; dead `SCHEMA_VERSION_CONST`;
test-only `resolveScript`; uncached `readVersion`; Bash-3.2 colon substitution (or delete the
legacy fs-walk path); word-split over find; sh/ps1 jdk-check exclude divergence;
audit-append.sh python interpolation; SKILL.md `current: 0.10.0+` drift + sync-versions
non-global replace; check-bundle-size untested; doctor disk-space row; `decide` log
char-count; shellcheck scope gaps; `filterGradleNoise` extraction seam; depth-cap constants.

### Audited-clean (no action) — corrected

Envelope shape across lib exit paths (update's stdio bug is H10, not an envelope-shape gap);
project-local `java_home` supply-chain guard; flags-reference docs; vitest coverage gate
honest (91%, `all:true`); bundle-size gate calibrated; `.gitattributes` LF pinning;
lock *acquisition* (release is H1). ~~Windows arg quoting~~ (→ H9). ~~Exit-code docs in
sync~~ (→ H11).

---

## 3. PR plan — corrected execution order

Phases are strict priority order. Every PR: Conventional-Commits title, 10 checks green,
squash to `develop`, **§4 quality gate applies to ALL PRs**.

### Phase 0 — Privacy

**PR-00 `feat(tools): fail-closed wet-evidence generator`** *(was PR-03; first — PR-01/02's
own §4 evidence needs it)*
Generates the §4 evidence artifact (anonymized matrix, sanitized commands, exit code,
PASS/FAIL) and refuses to emit if any redaction class (serial, private name, user path) still
matches. *Tests:* unit per redaction class. *S/M*
*(Acceptable alternative at execution time: combine PR-00/01/02 into one privacy PR.)*

**PR-01 `fix(privacy): replace the real device serial with a synthetic placeholder`**
Replace the R3C-prefixed serial across the ~10 skill/doc occurrences with an
obviously-synthetic one; sweep for other real identifiers in tracked text. History
scrub/npm deprecation = user decision (§6). *Tests:* skills-validate green; PR-02 pattern
locks the class. *S*

**PR-02 `refactor(tools): decouple-audit v2 — external private patterns, fail-closed, fork-safe`**
Private patterns load from a git-ignored local file + CI-side source (**no salted hashes** —
poor for paths/partials); generic shape rules stay public (device-serial shape,
`C:\Users\<*>`, volume paths); **fail-closed** when the private source is absent where it is
expected; report `file:line` without echoing content; case-insensitive; remove tracked
`tools/runs/` from `SKIP_PREFIXES`; NUL-sniff. **Selected fork-PR mechanism**: the private
scan runs from trusted base code via `workflow_dispatch` or an equivalent privileged check,
with inputs `{ pr_number, head_sha }`; it validates the PR's current head SHA, fetches the
PR diff/tree as data only, never checks out or executes untrusted PR code, loads private
patterns from CI secrets or local git-ignored state, and publishes only an anonymized
PASS/FAIL check. Public generic shape-rules still run in normal unprivileged fork CI. PR-00
and PR-02 must share the same redaction core to prevent evidence/scan drift. *Tests:* vitest
suite with synthetic fixtures; repo self-scan green after PR-01; privileged path test proves
SHA mismatch refuses to scan. *M*

### Phase 1 — Destructive safety, release trust, installers

**PR-04 `fix(installer): guarded uninstall (install marker, canonicalization, root/home guards)`**
Marker file written by installers; uninstallers canonicalize + require marker + hard-refuse
`/`, `$HOME`, `%USERPROFILE%`, drive roots. **Legacy compatibility**: existing installs
predate the marker — uninstall validates the legacy layout (expected `bin/<name>` symlink +
package files under a path ending in the package name; Windows may use `.cmd`/`.ps1`
launchers rather than Unix symlinks) and adopts it (writes the marker) before deleting;
validation failure = refuse with guidance, never a bypass flag that re-enables arbitrary
delete. *Tests:* bats+Pester: refuse-without-marker-or-valid-layout, refuse-root/home,
platform-specific legacy-layout adoption paths, and negative tests proving no input
combination reaches recursive delete on an unvalidated path. *M*

**PR-05 `fix(installer): PowerShell 5.1 compatibility (encoding, TLS 1.2) + skill-script hardening`**
ASCII-only or UTF-8-with-BOM ps1 files + CI parse check under PS 5.1 rules; `Tls12` before
web calls. **detect-env.ps1 cannot be dot-sourced as-is** — it `exit 0`s (line 32) and would
terminate the caller: refactor detection into an exit-free function (script keeps a thin
`exit` wrapper for standalone use), then call the function from run-tests.ps1 (with
`pwsh`→`powershell.exe` fallback only for genuinely separate processes). Replace
`npx kmp-test` (run-tests.ps1:106) with direct `kmp-test` resolution
(`Get-Command`/known install paths) — npx can fetch an arbitrary registry package; align sh/ps1
CLI resolution on the same mechanism. *Tests:* Pester (5.1-compatible) incl.
dot-source-does-not-exit and no-npx assertions + encoding lint. *M*

**PR-06 `ci(security): trusted release path — validated inputs, checks-green guard, SHA pins, checksums`**
(was v2 PR-13, moved before installer checksum consumption)
(a) publish-release.yml: env-route `inputs.tag`, validate `^v[0-9]+\.[0-9]+\.[0-9]+$`, tag
exists + matches package.json; (b) **release.yml MUST verify before `git push origin
HEAD:main`** (mandatory — the bot bypasses branch protection) that the **exact develop SHA**
has **every required check by exact name** with conclusion `success`, waiting with a bounded
timeout for in-flight checks — the required-context list is read from the branch-protection
ruleset via API, or from a canonical manifest file that CI itself validates against the
ruleset (never a hardcoded "10 checks" count that drifts); (c) pin all actions to full
commit SHAs; pin `skills-ref`; drop `npm@latest`; (d) emit `.sha256` per artifact;
(e) Dependabot for github-actions; (f) gate publish-npm/gradle on CI success. *Tests:* dry
`workflow_dispatch` with malformed tag fails; red-check or missing-check develop SHA refuses
to release; manifest↔ruleset drift fails CI. *M/L*

**PR-19 `ci: concurrency, timeouts, caches, lint scope + macOS jobs to manual-only`**
*(moved earlier from Phase 5 so subsequent PRs stop paying heavy macOS cost)*
Concurrency group **scoped to PRs only** (`cancel-in-progress` must never cancel
develop/main/release pushes — key the group on `github.event.pull_request.number` or guard
with `github.event_name == 'pull_request'`); `timeout-minutes` everywhere; npm/gradle
caches; `${#CHANGED}` fix; shellcheck scope; **move `bats-macos` +
`gradle-plugin-test-ios` to `workflow_dispatch` ONLY** (no nightly — that keeps recurring
spend; DECIDED). Do not rename required jobs. *S/M* *(M3)*

**PR-20b `ci: validate supported Node versions and line endings`**
CI must actually test the declared `engines.node >=18` floor on Node 18 plus a current
supported Node version, or explicitly raise the package floor in the same PR. `engine-strict`
alone is metadata validation and does **not** replace runtime tests. Add a bats preflight
that detects CRLF-corrupted scripts on Windows checkouts and fails with guidance; surface the
Node-18-drop vs current-LTS decision (§6, ties to Vitest). *S* *(M9-part, M10-node)*

**PR-20c `build(deps): remediate development vulnerabilities`**
Resolve the 7 dev-dep audit findings (bump/replace; no prod deps exist) after the Node/Vitest
decision from PR-20b, so the chosen toolchain is the one that gets remediated. *S/M*
*(H3-part)*

**PR-06b `feat(installer): checksum verification + atomic install`**
Installers verify `.sha256` (from PR-06), extract to temp dir, atomic swap; documented
offline `--from-file` install. *Tests:* installer-e2e: mismatch → abort; partial download →
no half-installed tree. *M* *(strictly after PR-06)*

### Phase 2 — Gradle plugin P0

**PR-07 `fix(gradle-plugin): deterministic bundle, full runtime extraction, real TaskAction tests`**
Replace the 3 overlapping `Sync`s with `processResources { from(...){into(...)} }` including
`../scripts/lib`; **JAR content tests on clean AND incremental builds** (contains
`lib/runner.js`, orchestrators, `scripts/sh/`, `scripts/lib/parse-coverage-xml.py`,
`package.json`); single shared extractor that **extracts the complete runtime tree and
invokes the real runner**; 5 TestKit tests executing each `@TaskAction` with a fake `node`
shim recording argv (NOT gradle `--dry-run`); TestKit hygiene: publish the plugin under test
to an **isolated temporary Maven repository** (per-build temp dir wired via
`repositories { maven { url = <tmp> } }` + `pluginManagement`) — **never `mavenLocal`, never
`flatDir` (doesn't resolve plugin markers), never `withPluginClasspath` (broken in this
project)**; test against the declared minimum Gradle version and the current supported Gradle
version via `withGradleVersion`; add configuration-cache store/reuse regression coverage
after the extractor/task refactor; remove `CleanupMode.NEVER`; **replace tautological
CrossShapeParityTest** with assertions against the production task classes/resources; add
`CoverageTask.testType`, real `projectRoot` default, drop unused `koverDetected`; declare
minimum Gradle version; keep a lightweight Windows CI TaskAction smoke because argument
transport and launcher behavior are Windows-sensitive. *Effort:* L. *Fixes C1+C2+M11.
ubuntu + Windows smoke jobs; manual mac validation per §4.*

### Phase 3 — False-green core

**PR-08 `fix(runners): lock release verifies ownership`** — re-read + compare PID/token
before unlink; `--force` semantics documented. *Tests:* takeover races. *M* *(H1)*

**PR-09 `fix(changed): git failures are errors, not "no changes"` + wire-or-remove `--max-failures`**
`git_error` (additive) + exit 3 on failed git; `no_changed_modules` only on successful empty
diff. *Tests:* both paths + max-failures semantics pinned. *S/M* *(H2, H5-part)*

**PR-25 `fix(runners): Windows cmd metacharacter safety`** *(ordered BEFORE PR-10 — both
touch argument transport, and PR-10's tests depend on this contract; combining them into one
PR is acceptable at execution time)*
The cmd.exe route must deliver arguments **byte-for-byte** — `%VAR%` must not expand
(reproduced today), and `!` under delayed expansion must be inert (`cmd /v:off` explicitly).
Do NOT prescribe a mechanism (e.g. `^`-escaping) until proven on real Windows; candidate
approaches (avoid cmd for arg transport where possible, env-var indirection, escaping) are
evaluated against the round-trip suite. *Tests:* Windows-CI vitest matrix of metacharacter
round-trips through `spawnGradle` (filters + `-P` props containing `% ! ^ " =` and
combinations); wet check on Windows. *M* *(H9)*

**PR-10 `fix(parsers): contextual argument schema — unknown flags, flag-values, lossless --gradle-args`**
**Contextual, not blanket**: per-flag metadata in `VALUE_BEARING_FLAGS` declares whether a
flag takes an opaque value (`--gradle-args --no-parallel` stays valid; opaque values are
never rejected for a `--` prefix and never rewritten by `expandPosixEqualsForm`); non-opaque
flags reject a following flag-token as missing-value; unknown-flag detection at the cli.js
pre-spawn gate (`unknown_flag`, exit 2; rollout hard vs warn-first = user decision §6);
**separator-split parity across ALL ps1 wrappers** (today only
run-parallel-coverage-suite.ps1:69 splits) + `ValueFromRemainingArguments` catch-all +
`ValidateSet` removal. *Tests:* vitest schema cases incl. `--gradle-args --no-parallel`
round-trip; Pester round-trips (spaces, quotes, `=`-forms, `%`-holding values — on the
PR-25 transport contract) on every wrapper; bats twins. *M/L* *(H5-part, M1; after PR-25)*

**PR-11 `fix(project): parse multiline include(...)`** — balanced-paren scan. *Tests:*
multiline Kotlin/Groovy, comments, nested parens. *S* *(H4)*

**PR-12 `fix(dispatch): no silent JVM fallback + ADB device-state validation + --java-home propagation`**
Each pinned by a failing test first; may split at execution time. *Tests:* vitest per leg +
S22 wet per §4. *M/L* *(H5 rest)*

**PR-26 `fix(update): --json emits exactly one JSON object`** *(new in v3)*
Capture installer stdout/stderr (`pipe`) in `--json` mode; stream to stderr or buffer into
the envelope; keep `inherit` for interactive mode. *Tests:* vitest: `--json` stdout parses
as a single object with installer noise simulated. *S/M* *(H10)*

### Phase 4 — Results integrity

**PR-14 `fix(parallel): leg timeouts discriminated and never cascaded`** — detect
`signal SIGTERM + status null` / `ETIMEDOUT` → additive `gradle_timeout` `{module,
timeout_ms}`; timed-out legs are non-retryable. *Tests:* simulated timeout → discriminator +
no retry. *M* *(H6-part)*

**PR-15 `fix(android): retry replaces failed-attempt counts`**. *S/M* *(H6-part)*

**PR-16 `fix(benchmark): identical grading with and without --json`** — parity test first.
*M* *(H6-part)*

**PR-17 `fix(coverage): decouple --min-missed-lines + preserve aggregation warnings + drop the Python dependency`**
Unfiltered summaries/`modulesContributing`; threshold filters only detailed section;
aggregation warnings → `warnings[]`. Python: **preferred fix is porting
`parse-coverage-xml.py` to Node** (zero new deps — the repo already parses XML with regex/
string scanning in junit-xml.js; sh/ps1 legacy callers and the gradle-plugin bundle follow
the same parser). If the port proves too risky in-PR, minimum acceptable fallback:
interpreter resolution `python3`→`python`→`py -3` (cached) + doctor row + spawn timeout +
discriminated `errors[].code` when no interpreter exists — **never silently degrade to
"no coverage data"**. *Tests:* threshold cases, warning propagation, parser parity suite
(Node port vs committed fixture outputs of the Python parser), no-interpreter path. *M/L*
*(H7, H6-part, M4)*

**PR-18 `fix(parallel): strictly side-effect-free --dry-run`** — no probe, no cache writes;
docs/tests aligned to the strict contract. *Tests:* cold-cache dry-run → zero spawns AND
zero writes under `.kmp-test-runner/`. *M* *(H8)*

**PR-27 `fix(envelope): code honors the published exit-code contract (task_not_found / unsupported_class_version / gradle_timeout → exit 3)`**
*(new in v3; recommendation inverted in v3.1 — DECIDED: code follows the published
contract.)* `unsupported_class_version` is an environment/JDK problem and `task_not_found`
is not a test assertion failure — both move from the TEST_FAIL set to the ENV set in
`result-rollup.js#computeExitCode`; `gradle_timeout` (emitted by PR-14) also maps to exit 3,
consistent with the sibling `gradle_timeout` dispatcher path. **Ships with a migration note
in CHANGELOG** (observable behavior change: exit 1 → 3 for these codes) and updates
`exit-codes.md` + envelope-contract + skill catalogue. *Tests:* contract test asserting the
doc table == `computeExitCode` behavior (generated from one source); rewrite the existing
tests that pinned the old exit-1 behavior (that flip IS this PR's purpose). *S/M* *(H11;
after PR-14 so `gradle_timeout` exists)*

**PR-28 `fix(project): verify-first trio — model fingerprint completeness, JDK scanner comment/string false-positives, stale android XML`**
*(new in v3)* Each starts with a pinned repro; fix only what reproduces (per M10). If more
than one reproduces, split into PR-28a/28b/28c because cache fingerprinting, JDK signal
parsing and Android XML result freshness touch different contracts and test surfaces. *M*

### Phase 5 — Compatibility cleanup

*(v3.1: former PR-20 split into three commit-lint-safe PRs:)*

**PR-20a `test: make environment snapshots hermetic`** — fix the JAVA_HOME-dependent
snapshot (1922/1923 locally); audit sibling snapshots for env leakage. *S* *(M9-part)*

**PR-21 `test(runners+pester): script-dispatcher error paths + 6 ps1 integration twins`**. *M* *(M8)*

### Phase 6 — Refactors (after contracts pinned)

**PR-22 `refactor(cli): extract help + leaf imports (compat shim retained)`**. *M* *(M5+M6)*
**PR-23 `refactor(orchestrators): unify module discovery + instrumented filter args`** —
after PR-12/14/25 (same files). *M/L* *(M7)*
**PR-24 `refactor(parallel): extract gradle-noise classifier`**. *M*

## 4. Quality gate (MANDATORY — every PR, no exceptions)

- **Every PR** runs a real wet smoke on at least one official workspace project AND at least
  one private project. `--dry-run` never counts as wet evidence (PRs like PR-18 may test
  dry-run *in addition to* their real wet runs). Platform scope expands with the change: Windows
  always (primary platform); Android-relevant changes additionally on the connected S22
  Ultra; Bash-3.2 / installers / gradle-plugin / macOS-native / iOS-simulator changes get a
  manual macOS pass. No new recurring macOS CI jobs.
- **Private projects stay local**: anonymous aliases, alias↔path map outside the repo; no
  logs, captures, serials, or raw artifacts on GitHub. PR evidence = the PR-00 generator's
  output only (anonymized matrix, sanitized commands, exit code, PASS/FAIL). decouple-audit
  alone is NOT sufficient evidence.
- Standard checks: `npm ci` then `npm run test:coverage` (thresholds never lowered; avoid
  `npx` fetching tools during validation), bats/Pester for script changes,
  `cd gradle-plugin && ./gradlew test` on Unix/macOS or
  `cd gradle-plugin; .\gradlew.bat test` on Windows for plugin changes, decouple-audit v2
  before every push, docs/envelope-contract + skill catalogue updated in-PR for any
  envelope-visible change (additive; `schema_version` stays 2).

### Manual macOS validation closure - 2026-07-16

Completed on `develop` at `ce3b7e614e68252c3be97d724018c1c84cdfd1ca` after the
Matrix A fixes had landed. Evidence was recorded with public/private aliases only: no
private project names, private module names, local paths, device identifiers, serials, or
raw logs.

- **Only fix required during resumed validation:** PR #360, a test-helper-only fix for
  `isStopCall()` so the Vitest helper recognizes `gradlew --stop --console=plain` as the
  daemon-stop call produced by non-TTY `spawnGradle()` execution.
- **Sanity gates after PR #360 merge:** `npm run test:coverage`, decouple audit, line
  endings check, focused Bats task-not-found suite, and Gradle plugin tests all passed.
- **Matrix B:** system `/bin/bash` 3.2 syntax checks passed; scratch installer/uninstaller
  cycles passed for zsh/bash/fish rc-file behavior; JDK discovery and `doctor`/`describe`
  JSON paths passed; tiny real-wrapper iOS and macOS legs passed.
- **Matrix C:** public KMP alias and private KMP alias both passed doctor, cold/warm
  describe, dry-run, wet `parallel --json --no-coverage`, changed dry-run, coverage
  skip-tests, and supported iOS/macOS legs. Selected Android instrumented surfaces were
  legitimate no-op skips rather than runnable instrumented test modules.
- **Matrix D:** controlled JSON error paths all emitted exactly one parseable JSON object
  on stdout. Validated discriminators included `no_test_modules`, `unknown_flag`,
  `invalid_flag_value`, `no_gradlew`, and `gradle_timeout`.
- **Classification:** blocker regressions = none; pre-existing project failures = none.
  Environment limitations: `pwsh` unavailable, `shellcheck` unavailable, no runnable
  selected Android instrumented surface.
- **Backlog candidate:** invalid `--java-home` on real execution exits nonzero and keeps
  stdout JSON clean, but currently surfaces as generic `module_failed`; it should fail
  earlier with a typed config/env error in a future PR.

## 5. Quick wins (<30 min each, batchable)

- `chore(lib)`: drop `SCHEMA_VERSION_CONST`; resolve test-only `resolveScript`; memoize
  `readVersion`.
- `fix(parsers)`: junit-xml attr/multi-failure edges + single XML walk in result-rollup.
- `fix(scripts)`: Bash-3.2 colon substitution (or delete the legacy fs-walk path — check
  consumers first), space-safe find loop, jdk-check exclude parity, audit-append argv-pass.
- `chore(tools)`: SKILL.md version drift (sync-versions target or drop from prose);
  sync-versions `/g`/assert-single; check-bundle-size unit tests.
- `feat(doctor)`: disk-space WARN row.

## 6. Decisions reserved for the user

1. **Serial exposure response**: replace-forward only vs also scrub git history (npm tarballs
   immutable either way); deprecate affected published versions?
2. **Unknown-flag strictness rollout** (PR-10): hard-reject vs one release of
   `warnings[].code:"unknown_flag"` first.
3. **Node floor + Vitest path** (PR-20b): keep Node 18 + latest Vitest 3.2.x, vs drop to
   Node 20 + Vitest 4 in one coordinated PR.
4. **L3 legacy `modules[]` shape**: schema decision (align degraded path to objects vs
   document the string shape).
5. **`Property<T>` extension migration**: non-blocking; future plugin-focused release.

*(Resolved in v3.1, no longer open: exit-code authority → code follows the published
contract, PR-27; macOS informational jobs → `workflow_dispatch` only, PR-19.)*

## 7. Deferred technical debt (valid, deliberately unscheduled)

- analyze-module dedicated suite (99.31% covered — opportunistic only).
- script-dispatcher.js split (cohesive, contract-locked by 17 Pester tests).
- `doctor.js#runDoctorChecks` length (flat sequential checks).
- Path containment for `--output-file`/`--capture-dir` (not a local privilege boundary;
  revisit with the queued `--output-dir` work).
- `@anthropic-ai/sdk`/`js-tiktoken` devDep relocation (tools-only, loaded once).
- `project-config.js:142-144` stray `java_home` passthrough (stripped downstream).
- `report-skipped-as-success` hardcoded context list (needs branch-protection API reads;
  partially mitigated by PR-06's checks-green guard).

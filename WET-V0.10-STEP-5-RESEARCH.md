# v0.10 ramp #5 — research verdict: `android describe` JSON as module-discovery source

## Recommendation: **DROP** (user authorization confirmed)

## Context

BACKLOG.md line 79:

> **Research direction B — `android describe` JSON discovery** — verify it enumerates KMP-non-AGP modules against the reference KMP composite project. ~2h research. If positive → ship the opt-in fallback in `lib/project-model.js` (~3-4h). If negative → drop with user authorization.

The proposal was to replace or augment `lib/project-model.js`'s bash filesystem walk with an `android describe --json` invocation when the Google `android` CLI is on PATH — the working hypothesis being that the official Google schema would be faster on Windows and more reliable than our own walker.

## Why this research is short

BACKLOG.md line 78 (v0.10 ramp item **#4.5**, SHIPPED 2026-05-17, the day before this research note) already executed the relevant cross-tool comparison against three projects (the CLI repo itself, a pure-Android app, and a KMP composite) and produced four findings that are dispositive for item #5. Reproducing them here verbatim from the BACKLOG entry for the record:

> (a) `android describe` is non-functional on Windows at `android` CLI 0.7.15222914 — invokes POSIX `gradlew` shell script instead of `gradlew.bat`, crashes with `CreateProcess error=193`;
>
> (b) `android info` is plain text key:value (3 lines: `sdk`, `version`, `launcher_version`), not JSON;
>
> (c) different design philosophy — `android describe` is a paths-to-JSON-files pointer tool, `kmp-test parallel --dry-run` inlines all module data;
>
> (d) different abstraction layer — `kmp-test` answers "what modules can I run tests on?", `android` CLI answers "where are the build artifacts / SDK?".

The #4.5 entry concludes: "Schema convergence is **not viable** (Windows blocker + plain-text shape + different abstractions)."

## Why those findings answer item #5

The #5 hypothesis was that `android describe` could **replace or augment** `lib/project-model.js`'s module discovery. The #4.5 findings invalidate that hypothesis on every premise individually:

| #4.5 finding                               | Effect on #5                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Windows blocker (`CreateProcess 193`)  | The original motivation for #5 (in BACKLOG line 2310) was specifically *Windows* performance — the suspected slow filesystem walk against a 43-module project. `android describe` *cannot run* on Windows today, so it cannot accelerate Windows discovery. Premise destroyed. |
| (c) `describe` is a paths-to-files pointer | `lib/project-model.js`'s `resolveTasksFor` needs structured module + task data (`unitTestTask`, `iosTestTask`, `macosTestTask`, `webTestTask`, source-set names). `describe` points at build-artifact + APK paths — different shape, no module-task graph.                  |
| (d) Different abstraction layer            | `kmp-test` lives at "what tests can I run?"; `android describe` lives at "where are the build artifacts?". Even on Linux/macOS where `describe` works, the output doesn't carry the data `project-model.js` consumes. A fallback would be a translation layer with no source.  |

There is no version of the #5 implementation that survives these constraints: on Windows it can't run (and Windows was the motivating use case), on macOS/Linux it doesn't carry the right data, and the schema convergence path (proposed Paths B and C in #4.5) was already deferred.

## Empirical reproduction on this host

The `android` CLI is not installed on the Mac executing this research (verified: `which android` → `android not found`; no binary under `/opt/homebrew`, `/usr/local`, `$ANDROID_HOME/cmdline-tools/*/bin`, or the Android Studio bundle's `Contents/bin`). #4.5's evidence was gathered on the primary maintainer machine where the CLI is installed; that evidence stands and is referenced verbatim above. Re-running the comparison here would only confirm "tool not installed" — it cannot strengthen or weaken #4.5's conclusions.

## Decision

**DROP item #5 from the v0.10 ramp.** User authorization is the standing pre-authorization in BACKLOG.md line 79 ("If negative → drop with user authorization"); the case for negative is now documented as #4.5's findings applied to the #5 hypothesis.

This brings the v0.10 ramp from 9 active items to 8 (one of which, #4.5, was a mid-ramp addition that already shipped). Items #1–#4 + #4.5 are SHIPPED; #6 is in flight (PR #248, see related entry); #7 (token-cost re-measurement) → #8 (README/CHANGELOG) → #9 (tag) remain.

## Follow-up filed in BACKLOG

- Mark #5 as `❌ DROPPED 2026-05-18` directly under the BACKLOG entry with cross-reference to this file and to #4.5.
- No code change. No `lib/project-model.js` impl PR is queued — the conditional implementation in BACKLOG line 79 ("If positive → ship ... ~3-4h") never enters the queue because the antecedent is false.
- The BACKLOG line 2307–2313 ("Use `android describe` JSON as module-discovery source (pending review)") subsection in the ideas-and-research zone is moved to the dropped-with-rationale list rather than the pending-review list. (The entry is duplicated between the v0.10 ramp at line 79 and the long-tail ideas at line 2307; both references are updated.)

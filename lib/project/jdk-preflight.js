// SPDX-License-Identifier: MIT
// lib/project/jdk-preflight.js — pre-flight JDK gate + gradle.properties parser.
//
// cli.js re-exports through the `export {}` block at the bottom (live
// bindings) so existing consumers (cli.test.js, doctor.js, orchestrators)
// keep importing from './cli.js' unchanged.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { aggregateJdkSignals } from '../project-model.js';

// Walk projectRoot for build scripts (`*.gradle.kts`, `*.kt` in `build-logic`)
// and detect signals that declare the JDK version this project produces or
// expects to run on. Returns the maximum version found across all signals,
// or null when nothing matches.
//
// Three signals are recognized — modern Kotlin Gradle DSL forms only:
//   1. `jvmToolchain(N)`           — gradle compiles + runs tests on JDK N
//   2. `JvmTarget.JVM_N`           — kotlin emits bytecode v(44+N) (e.g. 65 for JDK 21)
//   3. `JavaVersion.VERSION_N`     — Android source/target compatibility
//
// `*.kt` files are scanned too because convention plugins (e.g.
// `KmpBenchmarkConventionPlugin`) often declare `jvmTarget` in
// `build-logic/src/main/kotlin/` rather than in module-level `*.gradle.kts`.
//
// Returning the MAX is conservative: any signal pinned to JDK N means at
// least one part of the build will fail to load on a JVM older than N.
// Phase 4 step 3 (v0.5.1): delegates to lib/project-model.js#aggregateJdkSignals.
// The pure-Node walker that previously lived here is now the canonical
// implementation in project-model.js (same exclusion list, same depth=12 cap,
// same regex patterns). The function signature is preserved — `maxDepth`
// is accepted but ignored — so existing callers + the 7 vitest cases at
// tests/vitest/cli.test.js continue to pass byte-identically.
function findRequiredJdkVersion(projectRoot, _maxDepth = 12) {
  return aggregateJdkSignals(projectRoot).min;
}

// Pre-flight JDK check. Returns null if OK, { required, current, agpVersion } if mismatch.
// `agpVersion` is null when the project doesn't apply AGP; non-null when the
// AGP runtime requirement contributed to the JDK floor (used by the auto-select
// notice to explain WHY the JDK was bumped).
//
// Returns one of:
//   - `null` — no signal, no JDK detected, or host already matches (silent no-op)
//   - `{ kind: 'preserved', required, current, agpVersion }` — host EXCEEDS the
//     AGP-binding floor; preserves host (no JAVA_HOME override) but caller may
//     emit a [NOTICE] for observability. v0.8.0 follow-up (a now-removed coercer used to coerce
//     down to the floor; that breaks bytecode-65 Compose deps on Confetti-style
//     projects whose AGP floor is JDK 17 but whose host is JDK 23).
//   - `{ kind: 'mismatch', required, current, agpVersion }` — host BELOW floor;
//     caller fires auto-select / gate.
//
// Skips (returns null) when:
//   - gradle.properties has `org.gradle.java.home` pointing to an existing dir
//     (user explicitly told gradle which JDK to use; JAVA_HOME is moot)
//   - no JDK requirement signal (jvmToolchain / JvmTarget / JavaVersion / AGP runtime)
//     found in any build script (can't determine required)
//   - `java -version` fails (handled by `kmp-test doctor`)
function preflightJdkCheck(projectRoot) {
  const gradleProps = path.join(projectRoot, 'gradle.properties');
  if (existsSync(gradleProps)) {
    try {
      const txt = readFileSync(gradleProps, 'utf8');
      const m = txt.match(/^[ \t]*org\.gradle\.java\.home[ \t]*=[ \t]*(.+?)[ \t\r]*$/m);
      if (m && existsSync(m[1])) return null;
    } catch { /* fall through to JDK requirement detection */ }
  }

  const sig = aggregateJdkSignals(projectRoot);
  const required = sig.min;
  if (!required) return null;

  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (java.error || java.status === null) return null;
  const out = (java.stderr || '') + (java.stdout || '');
  const m = out.match(/version "([^"]+)"/);
  if (!m) return null;
  const head = m[1].split('.')[0];
  const current = head === '1' ? parseInt(m[1].split('.')[1] || '0', 10) : parseInt(head, 10);
  if (!current || current === required) return null;

  if (current > required) {
    // Host meets/exceeds the floor — preserve. Surface observability only when
    // AGP is the BINDING signal: that's the case where the floor came from an
    // implicit AGP requirement (not something the user typed in build.gradle.kts),
    // so an explanatory banner helps. When jvmToolchain raises the floor above
    // AGP, the user already opted in to that JDK requirement explicitly — no
    // banner needed.
    if (sig.agpIsBinding) {
      return { kind: 'preserved', required, current, agpVersion: sig.agpVersion };
    }
    return null;
  }

  return { kind: 'mismatch', required, current, agpVersion: sig.agpVersion };
}

// v0.8.1 — Gradle config diagnostic. Pure-additive `--json` field on
// `kmp-test doctor`: surfaces the resolved values for `org.gradle.parallel` /
// `workers.max` / `caching` / `daemon` / `jvmargs` / `configureondemand` from
// `<projectRoot>/gradle.properties` + `~/.gradle/gradle.properties`. Project
// values override user-global. No behaviour change — agents read this to
// decide e.g. whether to layer their own parallel scheduler on top of gradle's.
//
// Tier 1 of the "Adapt CLI to project's Gradle config" BACKLOG entry. Tier 2
// (`--gradle-args` passthrough) deferred to v0.9; Tier 3 (auto-respect) v1.0.
//
// `homedirOverride` exists for tests — production calls without it use the
// real `os.homedir()`.
const GRADLE_CONFIG_KEYS = [
  'org.gradle.parallel',
  'org.gradle.workers.max',
  'org.gradle.caching',
  'org.gradle.daemon',
  'org.gradle.jvmargs',
  'org.gradle.configureondemand',
];

/**
 * Parse the project + user gradle.properties files for diagnostic keys
 * (jvmargs, parallel, caching, daemon, java.home, …).
 * @param {string} projectRoot - Absolute path to the gradle project root.
 * @param {string} [homedirOverride] - Override for $HOME (test injection).
 * @returns {{props: object, sources: {project:boolean, user:boolean}}}
 */
function parseGradleConfig(projectRoot, homedirOverride) {
  const props = {};
  const sources = { project: false, user: false };
  const home = homedirOverride || os.homedir();

  const userPath = path.join(home, '.gradle', 'gradle.properties');
  if (existsSync(userPath)) {
    try {
      _readGradleConfigKeys(readFileSync(userPath, 'utf8'), props);
      sources.user = true;
    } catch { /* best-effort — never block doctor on this */ }
  }

  // Project values applied second so they override user-global on collision.
  const projectPath = path.join(projectRoot, 'gradle.properties');
  if (existsSync(projectPath)) {
    try {
      _readGradleConfigKeys(readFileSync(projectPath, 'utf8'), props);
      sources.project = true;
    } catch { /* best-effort */ }
  }

  return {
    parallel: _toGradleBool(props['org.gradle.parallel'], false),
    workers_max: props['org.gradle.workers.max']
      ? parseInt(props['org.gradle.workers.max'], 10)
      : null,
    caching: _toGradleBool(props['org.gradle.caching'], false),
    daemon: _toGradleBool(props['org.gradle.daemon'], true),
    jvmargs: props['org.gradle.jvmargs'] ?? null,
    configureondemand: _toGradleBool(props['org.gradle.configureondemand'], false),
    sources,
  };
}

function _readGradleConfigKeys(txt, props) {
  for (const k of GRADLE_CONFIG_KEYS) {
    const re = new RegExp(
      '^[ \\t]*' + k.replace(/\./g, '\\.') + '[ \\t]*=[ \\t]*(.+?)[ \\t\\r]*$',
      'm'
    );
    const m = txt.match(re);
    if (m) props[k] = m[1];
  }
}

function _toGradleBool(v, defaultVal) {
  if (v === undefined || v === null) return defaultVal;
  return String(v).trim().toLowerCase() === 'true';
}

// Per-OS hint for setting JAVA_HOME to the required JDK version.
function jdkMismatchHint(required, sub = 'parallel', platform = process.platform) {
  if (platform === 'darwin') {
    return `JAVA_HOME=$(/usr/libexec/java_home -v ${required}) kmp-test ${sub}`;
  }
  if (platform === 'win32') {
    return `$env:JAVA_HOME = "C:\\Program Files\\...\\jdk-${required}"; kmp-test ${sub}`;
  }
  return `JAVA_HOME=/usr/lib/jvm/java-${required} kmp-test ${sub}`;
}

export {
  findRequiredJdkVersion,
  preflightJdkCheck,
  parseGradleConfig,
  jdkMismatchHint,
  GRADLE_CONFIG_KEYS,
};

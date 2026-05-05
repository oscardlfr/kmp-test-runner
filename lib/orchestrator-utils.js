// SPDX-License-Identifier: MIT
// lib/orchestrator-utils.js — shared helpers for the v0.8 PIVOT orchestrators
// (benchmark / changed / android / coverage / parallel). Centralizes the
// settings.gradle.kts + per-module build.gradle.kts walking that every
// orchestrator needs. Sub-entries 1+2 wired this module; 3-5 follow.

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// Strip Kotlin `//` + `/* ... */` comments. Legacy bash matched commented
// `//include(":foo")` lines AND comment text containing plugin-name keywords
// in module build files, both causing phantom discovery / mis-classification.
export function stripKotlinComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// Read a module's build.gradle.kts, comment-stripped. Returns null if the
// file does not exist or is unreadable.
export function readBuildFile(projectRoot, modulePath) {
  const dir = path.join(projectRoot, ...modulePath.split(':'));
  const file = path.join(dir, 'build.gradle.kts');
  if (!existsSync(file)) return null;
  try { return stripKotlinComments(readFileSync(file, 'utf8')); } catch { return null; }
}

// Walk settings.gradle.kts for `include(":foo")` and `include("foo", "bar")`
// declarations. Returns a deduplicated list of module names without the
// leading colon (`["foo", "core:domain"]`). Comments stripped before parsing
// so commented-out includes don't surface as phantom modules.
export function discoverIncludedModules(projectRoot) {
  const settings = path.join(projectRoot, 'settings.gradle.kts');
  if (!existsSync(settings)) return [];
  let content;
  try { content = readFileSync(settings, 'utf8'); } catch { return []; }
  content = stripKotlinComments(content);
  const out = [];
  const re = /include\s*\(\s*"(:[\w\-:]+)"/g;
  for (const m of content.matchAll(re)) out.push(m[1].replace(/^:/, ''));
  const multi = /include\s*\(\s*((?:"[^"]+"\s*,?\s*)+)\)/g;
  for (const m of content.matchAll(multi)) {
    for (const sub of m[1].matchAll(/"(:[\w\-:]+)"/g)) {
      const name = sub[1].replace(/^:/, '');
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

// Cross-platform-safe gradle dispatch wrapper.
//
// Background: Node 18.20.2 / 20.12.2 / 22.0.0+ enforce CVE-2024-27980 which
// blocks direct .bat / .cmd execution via spawn — `spawnSync('gradlew.bat',...)`
// on Windows returns `status:null, error:'EINVAL'` without ever invoking gradle.
// The migrated v0.8 orchestrators all hit this; the wide-smoke pass against
// 23 Windows projects (2026-05-03) showed 14/14 false-positive PASS envelopes
// because dispatchLeg's spawn returned EINVAL → empty stdout/stderr →
// classifyTaskResults' regex didn't match → silent fall-through to 'passed'.
//
// Fix: route through cmd.exe explicitly on Windows. Avoids both the EINVAL
// error AND the DEP0190 deprecation warning that `shell:true` triggers in
// Node 22+. Args are quoted for cmd.exe per the standard rules: any arg
// containing whitespace or shell-meta gets wrapped in `"..."` with internal
// `"` doubled. Module names + task names from Gradle never contain meta
// chars; the only user-supplied arg in our surface is `--tests "<filter>"`,
// which goes through the same quoter.
//
// Pass `spawn` as first arg so tests can inject a mock; the helper just
// shapes the cross-platform call before delegating.
export function spawnGradle(spawn, gradlewPath, gradleArgs, opts) {
  if (process.platform !== 'win32') {
    return spawn(gradlewPath, gradleArgs, opts);
  }
  const quote = (s) => {
    s = String(s);
    if (s !== '' && !/[\s"&|<>()^%!]/.test(s)) return s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  // cmd.exe /s /c quote-stripping rule (see `cmd.exe /?`): with /s, exactly
  // one leading and one trailing quote are stripped from the command line
  // before parsing. To make this round-trip safely we (a) ALWAYS inline-quote
  // the gradlew path (so the post-strip line still has the path quoted and
  // cmd.exe parses it as one token even if it contains whitespace), and
  // (b) wrap the whole command line in one outer pair of quotes (consumed by
  // the strip). After strip, cmd.exe sees: `"<gradlewPath>" arg1 arg2 ...`
  // which is the canonical shape. Args that contain whitespace are also
  // inline-quoted by quote() above; simple args pass through unquoted.
  const quotedPath = `"${gradlewPath.replace(/"/g, '""')}"`;
  const cmdLine = `"${[quotedPath, ...gradleArgs.map(quote)].join(' ')}"`;
  const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  // windowsVerbatimArguments: Node otherwise re-quotes any arg containing
  // whitespace, which mangles our carefully-crafted cmdLine. With verbatim
  // mode Node passes args[3] to cmd.exe exactly as we built it.
  return spawn(comspec, ['/d', '/s', '/c', cmdLine], { ...opts, windowsVerbatimArguments: true });
}

// adb device probe — port of scripts/sh/lib/benchmark-detect.sh:36-80.
// Returns array of { serial, type, model }; empty when no devices or no adb.
// Shared across benchmark + android orchestrators (sub-entries 1 + 3).
export function defaultAdbProbe() {
  const result = spawnSync('adb', ['devices', '-l'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return [];
  const out = [];
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('List of devices')) continue;
    if (!line.trim()) continue;
    const serial = line.split(/\s+/)[0];
    if (!serial) continue;
    const type = serial.startsWith('emulator-') ? 'emulator' : 'physical';
    const modelMatch = line.match(/model:(\S+)/);
    out.push({ serial, type, model: modelMatch ? modelMatch[1] : 'unknown' });
  }
  return out;
}

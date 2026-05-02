// SPDX-License-Identifier: MIT
// lib/orchestrator-utils.js — shared helpers for the v0.8 PIVOT orchestrators
// (benchmark / changed / android / coverage / parallel). Centralizes the
// settings.gradle.kts + per-module build.gradle.kts walking that every
// orchestrator needs. Sub-entries 1+2 wired this module; 3-5 follow.

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

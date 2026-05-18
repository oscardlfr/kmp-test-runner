// SPDX-License-Identifier: MIT
// lib/parsers/test-filter.js — `--test-filter` pattern resolution.
//
// cli.js re-exports these names through its `export {}` block so existing
// consumers (cli.test.js, orchestrators) keep importing from './cli.js'
// unchanged via ESM live bindings.
//
// Two responsibilities:
//   1. Walk projectRoot for class declarations matching a wildcard pattern
//      and return the FQN. Used by Android instrumentation filters which
//      require a fully-qualified class name (gradle --tests can glob, adb
//      runner can't).
//   2. Decide per-subcommand whether to resolve the pattern at all
//      (parallel/changed/coverage pass through; android/benchmark resolve).

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { getBenchmarkPlatform } from './argv.js';

// Walk projectRoot for *.kt / *.java with a top-level `class <simpleName>` declaration.
// Returns the FQN (package + class) of the first match, or null. Skips build/, .gradle/,
// node_modules/, .git/. Depth-limited so we don't crawl pathological trees.
// Find the first class declaration matching `pattern` under `projectRoot`
// and return its fully-qualified name (`package.ClassName`), or null if
// nothing matches.
//
// Pattern grammar:
//   "Foo"       — exact class name
//   "Foo*"      — prefix:    matches `class Foo`, `class FooBar`, …
//   "*Foo"      — suffix:    matches `class Foo`, `class BarFoo`, …
//   "*Foo*"     — substring: matches `class Foo`, `class FooBar`,
//                            `class BarFoo`, `class BarFooBaz`, …
//
// The capture group around the actual matched class name lets us return the
// real FQN even when wildcards expand the literal core (e.g. `*Scale*` →
// `com.example.ScaleBenchmark`).
function findFirstClassFqn(projectRoot, pattern, maxDepth = 12) {
  if (!pattern) return null;
  const hasLeading = pattern.startsWith('*');
  const hasTrailing = pattern.endsWith('*');
  const core = pattern.replace(/\*/g, '').trim();
  if (!core) return null;

  const skip = new Set(['build', '.gradle', 'node_modules', '.git', '.idea', 'dist', 'out', 'target', '.vscode']);
  const before = hasLeading ? '\\w*' : '';
  const after = hasTrailing ? '\\w*' : '';
  const classRe = new RegExp(`(?:^|\\s)class\\s+(${before}${escapeRegex(core)}${after})\\b`);
  const pkgRe = /^\s*package\s+([\w.]+)/m;

  function walk(dir, depth) {
    if (depth > maxDepth) return null;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    // Visit files first so a class match short-circuits before recursing into subdirs.
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!(e.name.endsWith('.kt') || e.name.endsWith('.java'))) continue;
      const full = path.join(dir, e.name);
      let content;
      try { content = readFileSync(full, 'utf8'); } catch { continue; }
      const m = content.match(classRe);
      if (m) {
        const className = m[1];
        const pkgMatch = content.match(pkgRe);
        return pkgMatch ? `${pkgMatch[1]}.${className}` : className;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skip.has(e.name)) continue;
      const res = walk(path.join(dir, e.name), depth + 1);
      if (res) return res;
    }
    return null;
  }

  try { return walk(projectRoot, 0); } catch { return null; }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Split a test pattern into class + method portions. Two accepted forms:
//   "FQN#method"  — explicit, unambiguous (preferred for Android filters)
//   "FQN.method"  — heuristic: last `.`-segment must start lowercase
//                    AND there must be ≥ 2 segments. Relies on Java/Kotlin
//                    convention that classes are UpperCamelCase, methods
//                    lowerCamelCase. Won't split a bare package
//                    (no segments lowercase) or a single token.
// Returns { cls, method }; method is null when no method portion captured.
function splitClassMethod(pattern) {
  if (!pattern) return { cls: pattern, method: null };
  const hashIdx = pattern.indexOf('#');
  if (hashIdx >= 0) {
    return {
      cls: pattern.slice(0, hashIdx),
      method: pattern.slice(hashIdx + 1) || null,
    };
  }
  const segments = pattern.split('.');
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    if (last && /^[a-z]/.test(last)) {
      return {
        cls: segments.slice(0, -1).join('.'),
        method: last,
      };
    }
  }
  return { cls: pattern, method: null };
}

// If pattern contains `*`, resolve to a class FQN by scanning projectRoot
// (`*Foo*` is substring, `Foo*` prefix, `*Foo` suffix). If no match found
// — or the pattern has no wildcards — return pattern unchanged so the
// downstream tool (gradle / Android instrumentation) can surface a clear
// error.
//
// Method-level filter support (v0.5.2 Gap E): when the pattern carries a
// method portion (`#method` or `.method` heuristic), split → resolve class
// → recombine as `<resolvedClass>#<method>`. The `#` is the canonical wire
// separator between cli.js and the platform scripts (run-android-tests,
// run-benchmarks); scripts split it back and emit both
// `-Pandroid.testInstrumentationRunnerArguments.class=<class>` AND
// `-Pandroid.testInstrumentationRunnerArguments.method=<method>` flags
// (AndroidJUnitRunner accepts both args together).
function resolveAndroidTestFilter(pattern, projectRoot) {
  if (!pattern) return pattern;
  const { cls, method } = splitClassMethod(pattern);
  let resolvedCls = cls;
  if (cls && cls.includes('*')) {
    resolvedCls = findFirstClassFqn(projectRoot, cls) || cls;
  }
  return method ? `${resolvedCls}#${method}` : resolvedCls;
}

// Decide how to translate a --test-filter pattern based on the subcommand. Returns the
// (possibly-resolved) pattern that gets passed through to the platform script.
function resolvePatternForSubcommand(pattern, sub, args, projectRoot) {
  if (!pattern) return null;
  if (sub === 'parallel' || sub === 'changed' || sub === 'coverage') {
    // Pure JVM gradle test tasks — gradle --tests handles globs natively.
    return pattern;
  }
  if (sub === 'android') {
    return resolveAndroidTestFilter(pattern, projectRoot);
  }
  if (sub === 'benchmark') {
    const platform = getBenchmarkPlatform(args);
    if (platform === 'jvm') return pattern;
    // android or all → resolve once for android. JVM uses same value (gradle --tests
    // accepts a literal class name and filters to that exact one).
    return resolveAndroidTestFilter(pattern, projectRoot);
  }
  return pattern;
}

export {
  findFirstClassFqn,
  escapeRegex,
  splitClassMethod,
  resolveAndroidTestFilter,
  resolvePatternForSubcommand,
};

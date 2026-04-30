// SPDX-License-Identifier: MIT
// lib/jdk-catalogue.js — discover installed JDKs on the host so kmp-test
// can auto-select a matching one when the project requires a different
// JDK than the host default. v0.6.x Gap 2.
//
// Probe strategy: each JDK install carries a `release` file at its root
// (Linux/Windows layout) or under `Contents/Home/release` (macOS bundle
// layout) with `JAVA_VERSION` and `IMPLEMENTOR` keys. Reading the file
// gives us major version + vendor without spawning java for each candidate.
//
// Returns: Array<{ majorVersion: number, vendor: string, path: string }>,
// sorted ascending by majorVersion, deduped by realpath.

import { readdirSync, readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// Common JDK install locations per platform. Conservative — only the
// directories real installers (Adoptium / Zulu / Microsoft / Semeru /
// BellSoft / Oracle) and macOS / Linux distro packages actually use.
const WIN_CANDIDATE_DIRS = [
  'C:\\Program Files\\Eclipse Adoptium',
  'C:\\Program Files\\Zulu',
  'C:\\Program Files\\Microsoft',
  'C:\\Program Files\\Java',
  'C:\\Program Files\\Semeru',
  'C:\\Program Files\\BellSoft',
  'C:\\Program Files\\Azul Zulu',
];

const MACOS_CANDIDATE_DIRS = [
  '/Library/Java/JavaVirtualMachines',
];

const LINUX_CANDIDATE_DIRS = [
  '/usr/lib/jvm',
  '/opt/java',
  '/opt/jdk',
];

// Parse a `release` file's content. Returns null when JAVA_VERSION is
// missing or unparseable. Handles both quoted and unquoted values.
function parseReleaseFile(content) {
  const verMatch = content.match(/^JAVA_VERSION="?([^"\n]+)"?/m);
  if (!verMatch) return null;
  const ver = verMatch[1].trim();
  const head = ver.split('.')[0];
  const majorVersion = head === '1' ? parseInt(ver.split('.')[1] || '0', 10) : parseInt(head, 10);
  if (!majorVersion || !Number.isFinite(majorVersion)) return null;

  const vendorMatch = content.match(/^IMPLEMENTOR="?([^"\n]+)"?/m);
  const vendor = (vendorMatch?.[1] || 'unknown').trim();

  return { majorVersion, vendor };
}

// Probe a candidate directory. Returns { majorVersion, vendor, path } or null.
// `path` is the JAVA_HOME (the directory whose `bin/java` is the launcher).
function probeJdkDir(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  let stat;
  try { stat = statSync(candidate); } catch { return null; }
  if (!stat.isDirectory()) return null;

  // Try root layout first (Linux / Windows / Adoptium tarball).
  const rootRelease = path.join(candidate, 'release');
  if (existsSync(rootRelease)) {
    try {
      const parsed = parseReleaseFile(readFileSync(rootRelease, 'utf8'));
      if (parsed) return { ...parsed, path: candidate };
    } catch { /* fall through to bundle layout */ }
  }

  // Try macOS bundle layout: <bundle>.jdk/Contents/Home/release.
  const bundleRelease = path.join(candidate, 'Contents', 'Home', 'release');
  if (existsSync(bundleRelease)) {
    try {
      const parsed = parseReleaseFile(readFileSync(bundleRelease, 'utf8'));
      if (parsed) return { ...parsed, path: path.join(candidate, 'Contents', 'Home') };
    } catch { /* skip */ }
  }

  return null;
}

// Scan a list of base directories, treat each subdirectory as a JDK
// candidate, and probe it.
function scanBaseDirs(baseDirs) {
  const found = [];
  for (const baseDir of baseDirs) {
    if (!existsSync(baseDir)) continue;
    let entries;
    try { entries = readdirSync(baseDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const probe = probeJdkDir(path.join(baseDir, e.name));
      if (probe) found.push(probe);
    }
  }
  return found;
}

// Public entry point. `opts` keys:
//   - platform: 'win32' | 'darwin' | 'linux' (default process.platform)
//   - env: object with JAVA_HOME (default process.env)
//   - candidateDirs: explicit override for testing (skips per-platform default)
export function discoverInstalledJdks(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const candidateDirs = opts.candidateDirs
    || (platform === 'win32' ? WIN_CANDIDATE_DIRS
      : platform === 'darwin' ? MACOS_CANDIDATE_DIRS
        : LINUX_CANDIDATE_DIRS);

  const found = scanBaseDirs(candidateDirs);

  // Also probe JAVA_HOME if set — covers installs in non-standard locations.
  if (env.JAVA_HOME) {
    const probe = probeJdkDir(env.JAVA_HOME);
    if (probe) found.push(probe);
  }

  // Dedup by realpath so symlinked installs (e.g., Linux distro alternatives
  // pointing at the same physical install) collapse to one entry.
  const seen = new Set();
  const unique = [];
  for (const e of found) {
    let real;
    try { real = realpathSync(e.path); } catch { real = e.path; }
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push({ ...e, path: real });
  }

  unique.sort((a, b) => a.majorVersion - b.majorVersion);
  return unique;
}

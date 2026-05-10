#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/decouple-audit.mjs — privacy enforcement gate.
//
// Walks `git ls-files` (committed text only) and fails on any hit against
// PRIVATE_PATTERNS below. Patterns identify:
//   - the maintainer's private library composite project name,
//   - internal benchmark/core module names from that private library,
//   - private application names (DawSync, WakeTheCave, ...),
//   - home-directory + maintainer-machine paths,
//   - private toolkit names.
//
// This script IS the policy registry. It deliberately lives in-file because
// the script's whole purpose is enforcement: extending the list outside the
// script would be a separate-config-source-of-truth bug. Maintainer extends
// PRIVATE_PATTERNS in this file when a new private identifier shows up.
//
// Self-skip: this file is excluded from the scan (otherwise it would trip
// every regex it defines).
//
// Usage:
//   node tools/decouple-audit.mjs           # exit 0 on clean, non-zero on hit
//
// CI: wired as `decouple-audit` job in .github/workflows/ci.yml, mirroring
// `secrets-scan` shape. Required check on `develop` and `main` branches.
//
// Fast path: ~1-2s walk over the full repo (a few hundred files). No deps.

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const SELF_REL   = path.relative(REPO_ROOT, __filename).replace(/\\/g, '/');

// PRIVATE_PATTERNS — extend here when a new private identifier shows up.
// Each entry is a JS regex tested per line. Keep them anchored on word
// boundaries (\b) where possible to avoid spurious hits inside longer
// identifiers.
const PRIVATE_PATTERNS = [
  /shared-kmp-libs/,
  /:benchmark-storage/, /:benchmark-network/, /:benchmark-infra/, /:benchmark-sdk/, /:benchmark-io/,
  /:core-firebase-native/, /:core-network-retrofit/, /:core-storage-cache/, /:core-storage-api/,
  /:core-storage-datastore/, /:core-encryption/, /:core-domain/, /:core-result/, /:core-common/,
  /com\.grinx/,
  /\bDawSync\b/, /\bWakeTheCave\b/,
  /\bAndroidCommonDoc\b/,
  /\bdipatternsdemo\b/, /\bgyg\b/, /\bOmniSound\b/, /\bTaskFlow\b/,
  /\bandroid-challenge\b/, /\bdokka-markdown-plugin\b/,
  /AndroidStudioProjects/,
  /\/c\/Users\/34645/, /C:\\Users\\34645/,
  /\/Volumes\/XcodeOscar\b/,
];

// Path prefixes (relative to REPO_ROOT, forward-slash-normalised) that the
// audit deliberately skips. Artefact directories that snapshot historical
// real output legitimately contain private identifiers — we don't want them
// committed long-term, but .gitignore already excludes them.
const SKIP_PREFIXES = [
  'tools/runs/',
  '__snapshots__/',
];

function listGitFiles() {
  // spawnSync with explicit args (no shell) is safe — no user input, all
  // arguments are static. Mirrors the pattern used across tools/wide-smoke-*.
  const r = spawnSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  if (r.status !== 0) {
    console.error('decouple-audit: `git ls-files` failed.');
    console.error(r.stderr);
    process.exit(2);
  }
  return r.stdout.split('\n').filter(Boolean);
}

function isText(filePath) {
  // Skip likely-binary by extension. Cheaper than sniffing magic bytes.
  const ext = path.extname(filePath).toLowerCase();
  const binaryExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
    '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z',
    '.jar', '.war', '.class', '.so', '.dylib', '.dll',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
  ]);
  return !binaryExts.has(ext);
}

function shouldSkip(rel) {
  if (rel === SELF_REL) return true;
  return SKIP_PREFIXES.some((p) => rel.startsWith(p) || rel.includes(`/${p}`));
}

function scanFile(absPath, rel, hits) {
  let body;
  try {
    body = readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const re of PRIVATE_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        hits.push({ file: rel, lineNo: i + 1, match: m[0], line });
      }
    }
  }
}

function main() {
  const files = listGitFiles();
  const hits = [];
  let scanned = 0;
  for (const rel of files) {
    if (shouldSkip(rel)) continue;
    if (!isText(rel)) continue;
    const abs = path.join(REPO_ROOT, rel);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    scanFile(abs, rel, hits);
    scanned += 1;
  }

  if (hits.length > 0) {
    for (const h of hits) {
      console.error(`${h.file}:${h.lineNo}:${h.match}`);
    }
    console.error('');
    console.error(`decouple-audit: ${hits.length} hit(s) across ${scanned} file(s) — fix these before committing.`);
    console.error('See CLAUDE.md "Decouple from L0" for the policy.');
    process.exit(1);
  }

  console.log(`decouple-audit: clean (${scanned} files scanned, ${PRIVATE_PATTERNS.length} patterns).`);
}

main();

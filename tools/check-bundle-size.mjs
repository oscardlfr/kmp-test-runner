#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/check-bundle-size.mjs — bundle-size budget gate.
//
// Runs `npm pack --dry-run --json` and fails if the would-be-published
// tarball exceeds named-constant budgets. Mirrors the `tools/decouple-audit.mjs`
// shape (always-runnable, zero deps, clear failure message).
//
// Baseline measured 2026-05-11 on develop tip `cd719d0`:
//   tarball: 215_614 bytes (210.6 KB)
//   unpacked: 727_541 bytes (710.5 KB)
//   files: 76 (kmp-test-runner-0.9.0.tgz)
//
// Budgets = ceil(baseline * 1.25 / 1024) * 1024 — +25% headroom rounded up
// to the next KB. Retune by re-measuring and updating the constants below.
//
// Usage:
//   node tools/check-bundle-size.mjs        # exit 0 on pass, exit 1 on breach
//
// CI: wired as `bundle-size` job in .github/workflows/ci.yml, mirroring
// `decouple-audit` shape. Required check on `develop` and `main` (branch
// protection update is OWNER manual after this job lands).

import { spawnSync } from 'node:child_process';

// Budgets in bytes — named so they show up in stack traces if a future
// regression demands debugging.
const TARBALL_BUDGET_BYTES  = 270_336;  // 264 KB (+25% from 210.6 KB baseline)
const UNPACKED_BUDGET_BYTES = 910_336;  // 889 KB (+25% from 710.5 KB baseline)

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fmtPct(num, denom) {
  return `${(((denom - num) / num) * 100).toFixed(1)}%`;
}

function npmPackDryRunJson() {
  // On Windows, `npm` is `npm.cmd` and Node 20+ refuses to spawnSync a .cmd
  // file directly (EINVAL per CVE-2024-27980). Route through cmd.exe with
  // an explicit command line — mirrors lib/orchestrators/orchestrator-utils.js
  // `spawnGradle`. The command is entirely static (no user input), so no
  // injection surface.
  const isWin = process.platform === 'win32';
  const opts = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false };
  const r = isWin
    ? spawnSync(
        process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/s', '/c', '"npm pack --dry-run --json"'],
        { ...opts, windowsVerbatimArguments: true }
      )
    : spawnSync('npm', ['pack', '--dry-run', '--json'], opts);
  if (r.status !== 0) {
    console.error('[bundle-size] FAIL — `npm pack --dry-run --json` exited non-zero.');
    console.error(r.stderr || r.stdout || '(no output)');
    process.exit(2);
  }
  // npm 9+ emits the JSON array on stdout. Some versions interleave notice
  // lines on stderr — those are ignored. Find the first '[' to anchor the
  // JSON in case npm prepends anything.
  const out = r.stdout || '';
  const start = out.indexOf('[');
  if (start < 0) {
    console.error('[bundle-size] FAIL — `npm pack --dry-run --json` produced no JSON.');
    console.error(out);
    process.exit(2);
  }
  let pkg;
  try {
    pkg = JSON.parse(out.slice(start))[0];
  } catch (err) {
    console.error('[bundle-size] FAIL — could not parse `npm pack` JSON output.');
    console.error(err.message);
    console.error(out);
    process.exit(2);
  }
  if (!pkg || typeof pkg.size !== 'number' || typeof pkg.unpackedSize !== 'number') {
    console.error('[bundle-size] FAIL — `npm pack` JSON missing size / unpackedSize.');
    console.error(JSON.stringify(pkg, null, 2));
    process.exit(2);
  }
  return pkg;
}

function main() {
  const pkg = npmPackDryRunJson();
  const tarball  = pkg.size;
  const unpacked = pkg.unpackedSize;

  const tarballOver  = tarball  > TARBALL_BUDGET_BYTES;
  const unpackedOver = unpacked > UNPACKED_BUDGET_BYTES;

  if (tarballOver || unpackedOver) {
    if (tarballOver) {
      console.error(`[bundle-size] FAIL — tarball ${fmtKB(tarball)} > budget ${fmtKB(TARBALL_BUDGET_BYTES)} (+${tarball - TARBALL_BUDGET_BYTES} bytes over).`);
    }
    if (unpackedOver) {
      console.error(`[bundle-size] FAIL — unpacked ${fmtKB(unpacked)} > budget ${fmtKB(UNPACKED_BUDGET_BYTES)} (+${unpacked - UNPACKED_BUDGET_BYTES} bytes over).`);
    }
    console.error('');
    console.error('Inspect with: npm pack --dry-run --json');
    console.error('Retune budgets in tools/check-bundle-size.mjs if growth is intentional.');
    process.exit(1);
  }

  console.log(
    `[bundle-size] OK — tarball ${fmtKB(tarball)} / ${fmtKB(TARBALL_BUDGET_BYTES)} (${fmtPct(tarball, TARBALL_BUDGET_BYTES)} headroom); ` +
    `unpacked ${fmtKB(unpacked)} / ${fmtKB(UNPACKED_BUDGET_BYTES)} (${fmtPct(unpacked, UNPACKED_BUDGET_BYTES)} headroom).`
  );
}

main();

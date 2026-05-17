// SPDX-License-Identifier: MIT
// tests/vitest/_test-helpers.js — shared fixtures + sentinels for vitest suites.
//
// Leading underscore mirrors `_parity-helpers.js` to flag this as a non-test
// helper module (vitest discovers `*.test.js` only).

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Build a temp dir with a stub gradlew so the gradlew pre-flight passes.
// Cross-platform: writes both `gradlew` and `gradlew.bat` so the test stays
// portable regardless of host. The directory is torn down via `rmSync` in
// the finally block of `fn`.
export function withFakeGradleProject(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kmp-test-fixture-'));
  writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// PID 999999999 is well outside any OS PID range — process.kill(pid, 0)
// reliably throws ESRCH on every supported platform, giving a deterministic
// "dead PID" sentinel for tests that exercise stale-lock reclamation paths.
export const DEAD_PID = 999999999;

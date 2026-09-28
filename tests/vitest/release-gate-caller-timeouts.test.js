// tests/vitest/release-gate-caller-timeouts.test.js
// Static guard: every `release-gate.mjs poll-checks` caller in .github/workflows
// must wait long enough for a full CI run on the SAME sha to actually finish.
// A release's fast-forward to `main` triggers a second, independent `ci.yml` run
// on that commit (ci.yml also fires on push to `main`) -- the guard has to
// outlast whichever of the two (develop's own push, or main's) finishes last.
// Measured on 0.15.0's real release (27c943d): main-push CI took ~27 minutes.
// A caller with too short a timeout doesn't fail loudly on a real problem --
// it fails on ordinary CI duration, indistinguishably from a real one. Reads
// files from disk; no network, no subprocess.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, '..', '..', '.github', 'workflows');

// Measured worst case (27 min) plus runner-queue margin.
const MIN_TIMEOUT_MINUTES = 40;

function findPollChecksCallers() {
  const callers = [];
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    const path = join(WORKFLOWS_DIR, name);
    const content = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    if (!content.includes('release-gate.mjs poll-checks')) continue;
    const match = content.match(/--timeout-minutes\s+(\d+)/);
    callers.push({ file: name, timeoutMinutes: match ? Number(match[1]) : null });
  }
  return callers;
}

describe('release-gate.mjs poll-checks callers', () => {
  it('finds at least the 3 known callers (publish-npm, publish-gradle, release)', () => {
    // Not a hardcoded allow-list of files -- a floor, so a new caller added later
    // still gets caught by the timeout assertion below instead of silently
    // defaulting to release-gate.mjs's own 15-minute default.
    const callers = findPollChecksCallers();
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it('every caller passes an explicit --timeout-minutes of at least 40', () => {
    const callers = findPollChecksCallers();
    for (const { file, timeoutMinutes } of callers) {
      expect(timeoutMinutes, `${file} should pass --timeout-minutes explicitly`).not.toBeNull();
      expect(timeoutMinutes, `${file}'s --timeout-minutes (${timeoutMinutes}) is below the measured-safe floor`).toBeGreaterThanOrEqual(MIN_TIMEOUT_MINUTES);
    }
  });
});

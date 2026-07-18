#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/path-shim.mjs -- generates a temp kmp-test shim pinned to a specific
// worktree's bin/kmp-test.js (Round 3 fix #3 / Round 4 fix #9), never a global install.
//
// The real installers (scripts/install.sh / install.ps1) use a plain symlink (POSIX) or a
// minimal `@echo off` + `node "<path>" %*` wrapper (Windows) -- see install.ps1's
// $WrapperContent. This shim necessarily differs: it additionally redirects HOME/USERPROFILE
// for the grandchild node process ONLY (never the parent claude session's own env, which needs
// its real HOME for OAuth -- see env-builder.mjs's header comment), so ~/.kmp-test/config.json
// can never affect either measured arm. A plain symlink can't inject an environment override,
// so a wrapper script is required here even though the production installer doesn't need one.
//
// Verified empirically during Step 1: the POSIX form correctly resolves to the pinned
// worktree's version (not a stray global install) and correctly redirects what
// `os.homedir()` returns for the grandchild process.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {{worktreeRoot: string}} opts - absolute path to the kmp-test-runner worktree whose
 *   bin/kmp-test.js this shim must invoke.
 * @returns {{shimDir: string}} a fresh temp directory containing the shim, ready to be
 *   prepended to PATH. Callers pass the temp-HOME target via the KMP_EVAL_TEMP_HOME env var
 *   (read by the shim at invocation time, not baked in at generation time), so the same shim
 *   works for every condition in a run-pair.
 */
export function buildPathShim({ worktreeRoot }) {
  const shimDir = mkdtempSync(join(tmpdir(), 'kmp-agentic-eval-shim-'));
  const kmpTestJsPath = join(worktreeRoot, 'bin', 'kmp-test.js');
  const posixKmpTestJsPath = kmpTestJsPath.replace(/\\/g, '/');

  const posixShimPath = join(shimDir, 'kmp-test');
  const posixShim = [
    '#!/usr/bin/env bash',
    'HOME="$KMP_EVAL_TEMP_HOME" USERPROFILE="$KMP_EVAL_TEMP_HOME" exec node "' + posixKmpTestJsPath + '" "$@"',
    '',
  ].join('\n');
  writeFileSync(posixShimPath, posixShim);
  chmodSync(posixShimPath, 0o755);

  const cmdShimPath = join(shimDir, 'kmp-test.cmd');
  const cmdShim = [
    '@echo off',
    'set "HOME=%KMP_EVAL_TEMP_HOME%"',
    'set "USERPROFILE=%KMP_EVAL_TEMP_HOME%"',
    'node "' + kmpTestJsPath + '" %*',
    '',
  ].join('\r\n');
  writeFileSync(cmdShimPath, cmdShim);

  return { shimDir, posixShimPath, cmdShimPath };
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

/**
 * Prepends a portable fake Claude fixture to PATH.
 *
 * Production deliberately invokes `claude.cmd` on Windows because Git Bash
 * does not perform PATHEXT lookup. The fixtures are POSIX scripts named only
 * `claude`, so Windows tests receive a temporary cmd façade that delegates to
 * the selected fixture through the same Git Bash binary as production.
 */
export function createFakeClaudeCommandPath({ fixtureDir, basePath, shimRoot = null }) {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  if (process.platform !== 'win32') {
    return {
      path: `${fixtureDir}${delimiter}${basePath ?? ''}`,
      cleanup() {},
    };
  }

  const ownedRoot = shimRoot ?? mkdtempSync(path.join(os.tmpdir(), 'ae-fake-claude-cmd-'));
  const shimDir = path.join(ownedRoot, path.basename(fixtureDir));
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(
    path.join(shimDir, 'claude.cmd'),
    `@echo off\r\n"${resolveBash()}" "${path.join(fixtureDir, 'claude')}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    'utf8',
  );
  return {
    path: `${shimDir}${delimiter}${fixtureDir}${delimiter}${basePath ?? ''}`,
    cleanup() {
      if (!shimRoot) rmSync(ownedRoot, { recursive: true, force: true });
    },
  };
}

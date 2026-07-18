#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/resolve-bash.mjs -- resolves an unambiguous bash executable path.
//
// Every git/tar/archive operation in this harness routes through `bash -c` (Windows-native
// spawnSync/execFileSync of git/tar directly has been shown elsewhere in this harness to
// mangle backslash-heavy path arguments). Spawning the literal string 'bash' relies on PATH
// resolution, which is NOT unambiguous on Windows: if WSL is installed, `C:\Windows\System32\
// bash.exe` (a thin launcher into the WSL subsystem, using POSIX-inside-WSL-filesystem
// semantics) can resolve ahead of Git for Windows' MSYS2 bash.exe, depending on PATH order --
// confirmed empirically (running under PowerShell, where System32 precedes Git's bin/ on
// PATH by default, npm test failed 6 tests; prefixing Git Bash on PATH fixed all of them). This
// harness's `/c/...`-style POSIX path translation (toPosixPath() in materialize.mjs /
// condition-launcher.mjs) is an MSYS2 convention specifically -- it does not mean the same thing
// under WSL's own path translation, so an ambiguous 'bash' is a real correctness hazard, not
// just a performance one.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const WINDOWS_GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

let cached = null;

/**
 * Resolves the bash executable this harness must use for every `bash -c` invocation.
 * Resolution order: an explicit KMP_EVAL_BASH_PATH override (if it exists on disk) > well-known
 * Git for Windows install locations > deriving bash.exe from `where git`'s own install root >
 * fail loudly (never silently fall back to a bare 'bash' that PATH might resolve to WSL). On
 * POSIX, PATH resolution of 'bash' is unambiguous (no WSL-style split), so it's returned as-is.
 * Cached per-process; pass {fresh:true} to force re-resolution (test-only).
 */
export function resolveBash({ fresh = false } = {}) {
  if (cached != null && !fresh) return cached;
  if (process.env.KMP_EVAL_BASH_PATH) {
    if (!existsSync(process.env.KMP_EVAL_BASH_PATH)) {
      throw new Error(`KMP_EVAL_BASH_PATH is set to "${process.env.KMP_EVAL_BASH_PATH}" but that path does not exist`);
    }
    cached = process.env.KMP_EVAL_BASH_PATH;
    return cached;
  }
  if (process.platform !== 'win32') {
    cached = 'bash';
    return cached;
  }
  for (const candidate of WINDOWS_GIT_BASH_CANDIDATES) {
    if (existsSync(candidate)) { cached = candidate; return cached; }
  }
  try {
    const whereOutput = execFileSync('where', ['git'], { encoding: 'utf8' });
    const gitExePath = whereOutput.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (gitExePath) {
      // git.exe lives at <GitRoot>\cmd\git.exe or <GitRoot>\bin\git.exe; bash.exe lives at
      // <GitRoot>\bin\bash.exe either way.
      const gitRoot = dirname(dirname(gitExePath));
      const derived = join(gitRoot, 'bin', 'bash.exe');
      if (existsSync(derived)) { cached = derived; return cached; }
    }
  } catch {
    // `where git` failing is not itself fatal -- fall through to the error below.
  }
  throw new Error(
    'Could not resolve Git Bash on Windows (checked well-known install paths and `where git`). ' +
    'Set KMP_EVAL_BASH_PATH to an explicit bash.exe path, or install Git for Windows.',
  );
}

export { WINDOWS_GIT_BASH_CANDIDATES };

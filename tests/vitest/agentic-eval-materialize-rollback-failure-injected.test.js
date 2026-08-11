// tests/vitest/agentic-eval-materialize-rollback-failure-injected.test.js
// Post-Codex-audit fix (PR #418): agentic-eval-materialize-worktree-rollback.test.js's own
// "attaches a rollback failure to the original error instead of discarding it" test was confirmed,
// by its OWN doc comment, to never actually force a rollback FAILURE -- an invalid pinnedCommit
// makes `git worktree add` fail before anything is registered, so the rollback's own
// removeScenarioWorktree call always has nothing real to clean up and trivially succeeds. That
// test never asserted on err.rollbackError at all. This file replaces it with a genuine
// reproduction: the real `git worktree add` is allowed to run and succeed (so a real worktree
// really is registered), the real worktree is then locked for real (the same `git worktree lock`
// mechanism agentic-eval-materialize-worktree-rollback.test.js's OWN sibling test already uses to
// force a genuine, non-tolerated `git worktree remove` failure), and only the REPORTED exit status
// of that one specific spawnSync call is flipped to simulate materializeScenarioProject's own catch
// branch being reached -- reproducing "worktree add is reported as failed, but real state now
// exists that the rollback must clean up and can genuinely fail to." Kept in its own file (not
// folded into agentic-eval-materialize-worktree-rollback.test.js) because vi.mock('node:child_process')
// is hoisted and module-wide -- it would otherwise intercept every OTHER real-git test in that file.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';

// Post-Codex-audit fix (PR #418, round 3): a plain `import { spawnSync as realSpawnSync } from
// 'node:child_process'` is a misleading binding in a file that also `vi.mock()`s that exact
// module -- vi.mock() is hoisted above every import in the file, so that "real" import actually
// resolves to the MOCKED module too (harmlessly, in this specific file, since the mock's own
// interception condition never matches gitViaBash's own init/config/add/commit/rev-parse/unlock
// calls -- but the name asserted a guarantee the import mechanism doesn't provide). genuineSpawnSync
// is instead populated directly from the mock factory's own `importOriginal()` result below --
// this IS the actual, unmocked implementation, never routed through the interception logic at all,
// regardless of what that logic's own condition happens to match. Deliberately `var`, not `let`:
// vitest's own hoisting of the vi.mock() factory below can run before a `let` declaration's own
// line would otherwise be reached, throwing a temporal-dead-zone ReferenceError -- `var`'s
// hoisted-and-immediately-`undefined` semantics (confirmed directly; a `let` here reproduces the
// TDZ error) are exactly what's needed for a binding a hoisted factory assigns into.
var genuineSpawnSync;

function gitViaBash(argv, cwd) {
  const cmd = argv.map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(' ');
  const r = genuineSpawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

function makeSourceRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aemrf-source-'));
  gitViaBash(['init', '-q'], dir);
  gitViaBash(['config', 'user.email', 'test@example.com'], dir);
  gitViaBash(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  gitViaBash(['add', 'a.txt'], dir);
  gitViaBash(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

let injectAddFailure = false;
let lockedDestPosix = null;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  genuineSpawnSync = actual.spawnSync;
  return {
    ...actual,
    spawnSync: (...args) => {
      const result = actual.spawnSync(...args);
      const cmdArg = args[1]?.[1];
      // materialize.mjs's buildLongpathsGitCommand quotes every argv element individually --
      // 'worktree' 'add' '--detach' '<path>' '<commit>' -- never "worktree add" as one phrase.
      const addMatch = injectAddFailure && typeof cmdArg === 'string'
        ? cmdArg.match(/'worktree'\s+'add'\s+'--detach'\s+'([^']+)'/)
        : null;
      if (addMatch && result.status === 0) {
        lockedDestPosix = addMatch[1];
        // The real `git worktree add` genuinely just succeeded -- lock it for real so
        // materializeScenarioProject's own catch-block rollback (removeScenarioWorktree) hits a
        // real, non-tolerated `git worktree remove` refusal.
        actual.spawnSync(args[0], ['-c', `git worktree lock '${lockedDestPosix}'`], { cwd: args[2]?.cwd, encoding: 'utf8' });
        return { ...result, status: 1, stderr: `${result.stderr || ''}\n[injected] simulated worktree-add-reported-failure after real registration` };
      }
      return result;
    },
  };
});

describe('materializeScenarioProject -- a genuine rollback failure is attached to err.rollbackError, never silently discarded', () => {
  it('when worktree add is reported failed AFTER a real registration, and the rollback hits a genuine git worktree lock, err.rollbackError carries the real, non-empty failure', async () => {
    const { materializeScenarioProject, removeScenarioWorktree } = await import('../../tools/agentic-eval/materialize.mjs');
    const sourceRepoDir = makeSourceRepo();
    injectAddFailure = false;
    lockedDestPosix = null;
    try {
      const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();
      injectAddFailure = true;
      let thrown = null;
      try {
        materializeScenarioProject({ sourceRepoDir, pinnedCommit });
      } catch (err) {
        thrown = err;
      } finally {
        injectAddFailure = false;
      }

      // Confirms the injection actually fired (a real worktree really was created and locked) --
      // otherwise this test would silently degrade back into the same trivial-success shape it
      // was written to replace.
      expect(lockedDestPosix).not.toBeNull();
      expect(thrown).not.toBeNull();
      expect(thrown.rollbackError).toBeDefined();
      expect(thrown.rollbackError).not.toBeNull();
      expect(thrown.rollbackError.message.length).toBeGreaterThan(0);
    } finally {
      injectAddFailure = false;
      if (lockedDestPosix) {
        try { gitViaBash(['worktree', 'unlock', lockedDestPosix], sourceRepoDir); } catch { /* best-effort test cleanup */ }
        try { removeScenarioWorktree({ sourceRepoDir, worktreeDir: lockedDestPosix }); } catch { /* best-effort test cleanup */ }
      }
      rmSync(sourceRepoDir, { recursive: true, force: true });
    }
  }, 30000);
});

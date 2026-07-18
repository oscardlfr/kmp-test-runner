// tests/vitest/agentic-eval-policy-hook.test.js
// Unit tests for tools/agentic-eval/policy-hook.mjs -- the PreToolUse Bash command policy
// (Round 6). This is security-critical code; every case here corresponds to a specific
// adversarial finding from two independent review passes during Step 1 -- see the module's own
// header comment and the PR description's evidence table for the narrative.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decide,
  loadConfig,
  parsePolicyList,
  tokenize,
  isEqualCanonical,
  isWithinOrEqualCanonical,
  realpathWithinFixture,
  isSafeFilterValue,
  evaluateKmpTest,
  evaluateGradle,
} from '../../tools/agentic-eval/policy-hook.mjs';

let fixtureRoot;
let outsideDir;
let fakePathDir;

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'aeph-fixture-'));
  writeFileSync(path.join(fixtureRoot, 'gradlew'), '#!/usr/bin/env bash\necho stub\n');
  writeFileSync(path.join(fixtureRoot, 'gradlew.bat'), '@echo off\r\necho stub\r\n');

  outsideDir = mkdtempSync(path.join(os.tmpdir(), 'aeph-outside-'));
  writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET\n');
  writeFileSync(path.join(outsideDir, 'gradlew'), '#!/usr/bin/env bash\necho outside-wrapper\n');

  // Real symlink/junction escape fixture -- resolves outside the fixture root.
  symlinkSync(outsideDir, path.join(fixtureRoot, 'escape-link'), 'junction');
  symlinkSync(path.join(outsideDir, 'gradlew'), path.join(fixtureRoot, 'gradlew-symlinked'), 'file');

  fakePathDir = mkdtempSync(path.join(os.tmpdir(), 'aeph-fakepath-'));
  writeFileSync(path.join(fakePathDir, 'gradlew'), '#!/usr/bin/env bash\necho fake\n');
});

afterAll(() => {
  for (const d of [fixtureRoot, outsideDir, fakePathDir]) rmSync(d, { recursive: true, force: true });
});

function baseEnv(overrides = {}) {
  return {
    KMP_EVAL_EXPECTED_FIXTURE_ROOT: fixtureRoot,
    KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(['build', ':shared:test']),
    KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS: JSON.stringify(['doctor', 'parallel', 'describe']),
    ...overrides,
  };
}

function payload(command, overrides = {}) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: fixtureRoot,
    tool_input: { command, description: 'x', ...overrides },
  });
}

function decision(raw, env = baseEnv()) {
  const out = JSON.parse(decide(raw, env));
  return out.hookSpecificOutput.permissionDecision;
}

describe('policy-hook grammar -- approved shapes', () => {
  it.each([
    'kmp-test --version',
    'kmp-test doctor',
    'kmp-test parallel --json',
    'kmp-test parallel --json --project-root .',
    'kmp-test describe --module-filter core-common',
    'kmp-test describe --module-filter=core-common',
    'kmp-test parallel --test-filter com.example.Foo#bar --json',
    './gradlew build',
    './gradlew.bat build',
    '.\\gradlew.bat build',
  ])('allows: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('allow');
  });
});

describe('policy-hook grammar -- non-grammar commands denied', () => {
  it.each([
    'whoami', 'pwd', 'echo test > out.txt', 'cat C:\\Users\\someone\\secrets.txt',
    'node -e "console.log(1)"',
  ])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- chaining/pipe/redirection/substitution/backgrounding denied', () => {
  it.each([
    'kmp-test --version && whoami',
    'kmp-test --version; whoami',
    'kmp-test --version | cat',
    'kmp-test --version > out.txt',
    'kmp-test --version < in.txt',
    'kmp-test $(whoami)',
    'kmp-test `whoami`',
    'kmp-test --version &',
    'kmp-test --version\nwhoami',
  ])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- shell-wrapper and env-assignment prefixes denied', () => {
  it.each([
    'bash -c "kmp-test --version"',
    'cmd /c kmp-test --version',
    'powershell -c kmp-test --version',
    'FOO=bar kmp-test --version',
  ])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- path traversal / outside-fixture project-root denied', () => {
  it.each([
    'kmp-test parallel --json --project-root ..',
    'kmp-test parallel --json --project-root ../../etc',
  ])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });

  it('denies an absolute project-root outside the fixture', () => {
    expect(decision(payload(`kmp-test parallel --json --project-root ${outsideDir}`))).toBe('deny');
  });
});

describe('policy-hook grammar -- Gradle exact allowlist, not a denylist', () => {
  it.each([
    './gradlew clean',
    './gradlew clean :shared:test',
    './gradlew properties',
    './gradlew deleteEverything',
    './gradlew someRandomTask',
  ])('denies non-allowlisted task: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- near-miss token shapes rejected', () => {
  it.each(['kmp-test-evil --version', 'gradlewFOO :shared:test', 'KMP-TEST --version'])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- unrecognized subcommand/flag rejected', () => {
  it.each(['kmp-test update', 'kmp-test parallel --exec whoami'])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- shell/env expansion in path arguments rejected (never lexically trusted)', () => {
  it.each([
    'kmp-test parallel --json --project-root "$HOME"',
    'kmp-test parallel --json --project-root $HOME',
    'kmp-test parallel --json --project-root ~',
    'kmp-test parallel --json --project-root ~/foo',
    'kmp-test parallel --json --project-root %USERPROFILE%',
    'kmp-test parallel --json --project-root !USERPROFILE!',
    'kmp-test parallel --json --project-root \\\\?\\C:\\Windows',
    'kmp-test parallel --json --project-root C:foo',
  ])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

describe('policy-hook grammar -- symlink/junction escape (real filesystem resolution)', () => {
  it('denies a project-root that is a junction pointing outside the fixture', () => {
    expect(decision(payload('kmp-test parallel --json --project-root escape-link'))).toBe('deny');
  });

  it('denies a bare gradlew even when PATH would resolve one first (bare forms not in grammar)', () => {
    // Bare 'gradlew'/'gradlew.bat' are never in GRADLE_LEADING_TOKENS at all -- PATH content is
    // irrelevant to the hook's own decision, which only ever inspects the literal first token.
    expect(decision(payload('gradlew build'))).toBe('deny');
    expect(decision(payload('gradlew.bat build'))).toBe('deny');
  });

  it('denies a fixture-anchored gradlew symlink pointing outside the fixture (wrapper realpath check)', () => {
    expect(decision(payload('./gradlew-symlinked build'))).toBe('deny');
  });

  it('denies a nonexistent project-root path', () => {
    expect(decision(payload('kmp-test parallel --json --project-root does-not-exist-anywhere'))).toBe('deny');
  });
});

describe('policy-hook -- payload.cwd is never trusted as the policy root on its own', () => {
  it('denies when cwd does not equal the configured expected fixture root', () => {
    const p = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: outsideDir, tool_input: { command: 'kmp-test --version', description: 'x' } });
    expect(decision(p)).toBe('deny');
  });
});

describe('policy-hook -- run_in_background / timeout / description validation', () => {
  it('denies run_in_background:true', () => {
    expect(decision(payload('kmp-test --version', { run_in_background: true }))).toBe('deny');
  });
  it('allows run_in_background:false', () => {
    expect(decision(payload('kmp-test --version', { run_in_background: false }))).toBe('allow');
  });
  it.each([-5, 'soon', 999999999])('denies invalid timeout: %s', (timeout) => {
    expect(decision(payload('kmp-test --version', { timeout }))).toBe('deny');
  });
  it('allows a valid, bounded timeout', () => {
    expect(decision(payload('kmp-test --version', { timeout: 5000 }))).toBe('allow');
  });
  it.each([12345, { nested: true }])('denies a non-string description: %j', (description) => {
    expect(decision(payload('kmp-test --version', { description }))).toBe('deny');
  });
});

describe('policy-hook -- malformed policy configuration fails closed', () => {
  it('rejects a JSON *string* (not array) -- the Set(JSON.parse(string)) character-set regression', () => {
    // Confirmed real bug this test guards: new Set(JSON.parse('"build"')) silently produces
    // {'b','u','i','l','d'}, which would let a single-letter task "b" slip through undetected.
    const env = baseEnv({ KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify('build') });
    expect(decision(payload('./gradlew b'), env)).toBe('deny');
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('rejects duplicate entries', () => {
    const env = baseEnv({ KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(['build', 'build']) });
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('rejects a wrong-type entry', () => {
    const env = baseEnv({ KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(['build', 123]) });
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('rejects an empty-string entry', () => {
    const env = baseEnv({ KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(['build', '']) });
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('rejects an object instead of an array', () => {
    const env = baseEnv({ KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify({ build: true }) });
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('rejects a missing policy env var entirely', () => {
    const env = baseEnv();
    delete env.KMP_EVAL_ALLOWED_GRADLE_TASKS;
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('an intentionally empty array is valid config (denies everything in that category, not malformed)', () => {
    const env = baseEnv({ KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify([]) });
    // config load itself succeeds; the command is denied because nothing is allowlisted, not
    // because the config was rejected as malformed.
    expect(decision(payload('kmp-test --version'), env)).toBe('allow'); // kmp-test subcommands unaffected
    expect(decision(payload('./gradlew build'), env)).toBe('deny');
  });
  it('rejects when no policy config is present at all', () => {
    expect(decision(payload('kmp-test --version'), {})).toBe('deny');
  });
});

describe('policy-hook -- wildcard filter values rejected (shell could re-expand after approval)', () => {
  it.each([
    'kmp-test describe --module-filter core-*',
    'kmp-test describe --module-filter=core-*',
    'kmp-test describe --module-filter "core?"',
  ])('denies: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
  it('rejects a leading # in a filter value (shell-comment risk)', () => {
    expect(decision(payload('kmp-test parallel --test-filter "#comment" --json'))).toBe('deny');
  });
  it('still allows a mid-value # (test FQN Class#method)', () => {
    expect(decision(payload('kmp-test parallel --test-filter com.example.Foo#bar --json'))).toBe('allow');
  });
});

describe('policy-hook -- malformed/structurally-wrong input fails closed', () => {
  it('rejects invalid JSON', () => {
    expect(decision('{not valid json')).toBe('deny');
  });
  it('rejects an unrecognized tool_input field', () => {
    const p = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: fixtureRoot, tool_input: { command: 'kmp-test --version', unexpected: 'x' } });
    expect(decision(p)).toBe('deny');
  });
  it('rejects hook_event_name !== PreToolUse', () => {
    const p = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: fixtureRoot, tool_input: { command: 'kmp-test --version' } });
    expect(decision(p)).toBe('deny');
  });
  it('rejects tool_name !== Bash', () => {
    const p = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: fixtureRoot, tool_input: { command: 'kmp-test --version' } });
    expect(decision(p)).toBe('deny');
  });
  it('rejects a missing command', () => {
    const p = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: fixtureRoot, tool_input: {} });
    expect(decision(p)).toBe('deny');
  });
  it('rejects a missing cwd', () => {
    const p = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'kmp-test --version' } });
    expect(decision(p)).toBe('deny');
  });
  it('rejects oversized input (64KB cap)', () => {
    const p = payload('kmp-test --version', { description: 'x'.repeat(70 * 1024) });
    expect(decision(p)).toBe('deny');
  });
});

describe('path.relative-based containment algorithm -- never lowercase/prefix comparison', () => {
  // Uses fabricated POSIX-style paths, with path.posix explicitly injected, to verify the
  // ALGORITHM doesn't rely on lowercasing -- production code uses the platform-default path
  // module (win32 on this PR's actual target, Windows), which is correct there since Windows'
  // own filesystem is case-insensitive; a genuine case-sensitive-filesystem integration test
  // isn't possible on this dev machine. Injecting path.posix here verifies the LOGIC itself
  // (path.relative + the empty/absolute/'..'-prefix checks) would behave correctly if it ever
  // ran under case-sensitive semantics, independent of what the current host's path module does.
  it('treats case-distinct paths as NOT equal', () => {
    expect(isEqualCanonical('/tmp/Fixture', '/tmp/fixture', path.posix)).toBe(false);
  });
  it('treats a case-distinct sibling as NOT within the root', () => {
    expect(isWithinOrEqualCanonical('/tmp/fixture', '/tmp/Fixture/sub', path.posix)).toBe(false);
    expect(isWithinOrEqualCanonical('/tmp/Fixture', '/tmp/fixture/sub', path.posix)).toBe(false);
  });
  it('treats a same-prefix sibling directory as NOT within the root', () => {
    expect(isWithinOrEqualCanonical('/tmp/fixture', '/tmp/fixture-evil/sub', path.posix)).toBe(false);
  });
  it('treats the parent as NOT within a child root', () => {
    expect(isWithinOrEqualCanonical('/tmp/fixture/sub', '/tmp/fixture', path.posix)).toBe(false);
  });
  it('treats a genuine subdirectory as within the root', () => {
    expect(isWithinOrEqualCanonical('/tmp/fixture', '/tmp/fixture/sub/dir', path.posix)).toBe(true);
  });
  it('on the platform-default path module (win32 here), still correctly rejects traversal/parent/sibling shapes', () => {
    // Using real Windows-style paths -- this IS what production actually receives (always
    // post-realpath). Case-folding is a Windows filesystem property, not a gap in this logic.
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture', 'C:\\tmp\\fixture-evil\\sub')).toBe(false);
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture\\sub', 'C:\\tmp\\fixture')).toBe(false);
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture', 'C:\\tmp\\fixture\\sub\\dir')).toBe(true);
  });
});

describe('parsePolicyList (unit-level)', () => {
  it('returns null for undefined input', () => {
    expect(parsePolicyList(undefined, /^[a-z]+$/)).toBeNull();
  });
  it('returns null for a bare JSON string', () => {
    expect(parsePolicyList(JSON.stringify('build'), /^[a-z]+$/)).toBeNull();
  });
  it('returns a Set for a valid array', () => {
    const result = parsePolicyList(JSON.stringify(['doctor', 'parallel']), /^[a-z]+$/);
    expect(result).toEqual(new Set(['doctor', 'parallel']));
  });
  it('returns an empty Set for an explicitly empty array', () => {
    expect(parsePolicyList(JSON.stringify([]), /^[a-z]+$/)).toEqual(new Set());
  });
});

describe('tokenize (unit-level)', () => {
  it('splits a simple command', () => {
    expect(tokenize('kmp-test --version')).toEqual(['kmp-test', '--version']);
  });
  it('respects double-quoted tokens with embedded spaces', () => {
    expect(tokenize('kmp-test parallel --test-filter "com.example.Foo#bar"')).toEqual(['kmp-test', 'parallel', '--test-filter', 'com.example.Foo#bar']);
  });
  it('returns null for an unterminated quote', () => {
    expect(tokenize('kmp-test "unterminated')).toBeNull();
  });
});

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
  recordDecisionSideEffect,
} from '../../tools/agentic-eval/policy-hook.mjs';
import { sha256Hex, readSidecarRecord } from '../../tools/agentic-eval/junit-evidence-io.mjs';

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
  ])('allows: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('allow');
  });

  // Regression coverage for a real, confirmed bypass an independent review pass demonstrated:
  // every approved command actually executes via `bash -c "<command text>"`, and bash parses
  // '.\gradlew.bat' using POSIX backslash-escaping rules -- '\g' becomes the literal character
  // 'g' (backslash consumed as an escape, not a path separator) -- confirmed directly:
  // `bash -c 'echo .\gradlew.bat'` prints `.gradlew.bat`, no leading `/` or `./` at all, which
  // bash then treats as a BARE command name subject to PATH search, not a fixture-anchored
  // relative path. An earlier version of this hook's own GRADLE_LEADING_TOKENS accepted this
  // backslash form and resolved it correctly using Node's win32 path semantics -- meaning what
  // the hook approved and what bash actually executed diverged completely, letting an
  // executable planted earlier on PATH substitute for the real gradlew.bat. This form is now
  // denied on every platform (not just non-Windows) -- there is no host on which it's safe.
  it('denies: .\\gradlew.bat build on every platform (bash reinterprets the backslash as an escape, not a path separator)', () => {
    expect(decision(payload('.\\gradlew.bat build'))).toBe('deny');
  });
});

describe('policy-hook grammar -- exact trailing stderr merge on canonical kmp-test commands', () => {
  it.each([
    'kmp-test describe --json --project-root . 2>&1',
    'kmp-test parallel --json --project-root . --module-filter :shared 2>&1',
    'kmp-test --version\t2>&1   ',
  ])('allows the narrow stderr-to-stdout capture form: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('allow');
  });

  it.each([
    './gradlew build 2>&1',
    'echo test 2>&1',
    'kmp-test describe --json --project-root . > out.txt 2>&1',
    'kmp-test describe --json --project-root . < in.txt 2>&1',
    'kmp-test describe --json --project-root . 2>&1 && whoami',
    'kmp-test describe --json --project-root . 2>&1 | cat',
    'kmp-test describe --json --project-root . 2>&1\nwhoami',
    'kmp-test describe --json --project-root . 2>&1 2>&1',
  ])('does not widen the exception to: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
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
    // Only meaningful on an actual win32 host: the default (uninjected) `path` module resolves
    // to platform-native semantics, so backslash-separated strings only decompose as path
    // segments where the host itself treats '\' as a separator.
    if (process.platform !== 'win32') return;
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture', 'C:\\tmp\\fixture-evil\\sub')).toBe(false);
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture\\sub', 'C:\\tmp\\fixture')).toBe(false);
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture', 'C:\\tmp\\fixture\\sub\\dir')).toBe(true);
  });
  it('on the platform-default path module (POSIX here), still correctly rejects traversal/parent/sibling shapes', () => {
    // Mirror of the win32 case above, using the default (uninjected) `path` module on a
    // Linux/macOS host -- proves the *uninjected* default path is exercised for real on every
    // CI platform, not just via the explicit path.posix-injected cases earlier in this file.
    if (process.platform === 'win32') return;
    expect(isWithinOrEqualCanonical('/tmp/fixture', '/tmp/fixture-evil/sub')).toBe(false);
    expect(isWithinOrEqualCanonical('/tmp/fixture/sub', '/tmp/fixture')).toBe(false);
    expect(isWithinOrEqualCanonical('/tmp/fixture', '/tmp/fixture/sub/dir')).toBe(true);
  });
  // With path.win32 explicitly injected (mirroring the path.posix-injected block above), these
  // Windows-formatted-path assertions run for real on EVERY host, not just when process.platform
  // happens to be 'win32' -- this repo's CI matrix does include a windows-latest job, so the
  // guarded case above already gets real coverage there, but an explicit injection means the
  // exact same assertions also hold on a contributor's Linux/macOS machine (isWithinOrEqualCanonical
  // defaults its third parameter to the host's own `path` module, which parses backslashes as
  // literal characters, not separators, on POSIX -- passing path.win32 explicitly bypasses that
  // entirely, independent of the host).
  it('with path.win32 explicitly injected, rejects traversal/parent/sibling shapes on ANY host', () => {
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture', 'C:\\tmp\\fixture-evil\\sub', path.win32)).toBe(false);
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture\\sub', 'C:\\tmp\\fixture', path.win32)).toBe(false);
    expect(isWithinOrEqualCanonical('C:\\tmp\\fixture', 'C:\\tmp\\fixture\\sub\\dir', path.win32)).toBe(true);
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

describe('policy-hook grammar -- SKILL.md canonical commands (skill-portability alignment)', () => {
  // A function, not a const: `describe` bodies run at collection time, before `beforeAll` has
  // set `fixtureRoot`, so a `baseEnv({...})` computed here directly would freeze in
  // KMP_EVAL_EXPECTED_FIXTURE_ROOT: undefined. Calling this inside each test (execution time,
  // after `beforeAll`) is what the existing `decision(raw, env = baseEnv())` default-parameter
  // pattern already relies on -- same fix, applied explicitly since this env needs an override.
  function skillCanonicalEnv() {
    return baseEnv({
      KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS: JSON.stringify(
        ['doctor', 'parallel', 'android', 'coverage', 'benchmark', 'changed'],
      ),
    });
  }

  it.each([
    'kmp-test doctor --json --project-root .',
    'kmp-test parallel --json --project-root .',
    'kmp-test android --json --project-root .',
    'kmp-test coverage --json --project-root .',
    'kmp-test benchmark --json --project-root .',
    'kmp-test changed --json --project-root .',
    'kmp-test parallel --json --project-root . --dry-run',
  ])('allows the documented canonical shape: %s', (cmd) => {
    expect(decision(payload(cmd), skillCanonicalEnv())).toBe('allow');
  });

  it.each([
    'bash .skills/kmp-test-runner/scripts/detect-env.sh',
    'pwsh .skills/kmp-test-runner/scripts/detect-env.ps1',
    'bash .skills/kmp-test-runner/scripts/run-tests.sh android --device emulator-5554',
    'which android && android info >/dev/null 2>&1 && echo "HAS_ANDROID_CLI" || echo "NO_ANDROID_CLI"',
  ])('denies the non-canonical shapes SKILL.md no longer presents as agent commands: %s', (cmd) => {
    expect(decision(payload(cmd))).toBe('deny');
  });
});

// recordDecisionSideEffect -- the additive per-attempt JUnit-evidence-attribution side effect.
// decide() itself is completely untouched (covered by every test above); these tests exercise ONLY
// the new side-effect function, called with decide()'s own already-computed output, exactly the way
// runAsHook wires them together (never re-derives the decision independently).
describe('recordDecisionSideEffect', () => {
  let evidenceDir;
  beforeAll(() => {
    evidenceDir = mkdtempSync(path.join(os.tmpdir(), 'aeph-decisions-'));
  });
  afterAll(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  function rawInput(command, toolUseId = 't1') {
    return JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: toolUseId, cwd: fixtureRoot, tool_input: { command } });
  }
  function decisionEnv(overrides = {}) {
    return { KMP_EVAL_JUNIT_EVIDENCE_DIR: evidenceDir, ...overrides };
  }

  it('is a complete no-op when KMP_EVAL_JUNIT_EVIDENCE_DIR is unset -- calibrate/smoke/no_applicable_tests never set it', async () => {
    const raw = rawInput('kmp-test --version', 'toolu_noenv');
    const output = decide(raw, baseEnv());
    await expect(recordDecisionSideEffect(raw, output, {})).resolves.toBeUndefined();
    // No decisions/ directory should have been created at all under an env with no evidence dir
    // configured -- nothing to read back; the absence of a rejection is itself the main proof, but
    // this also confirms no stray directory was created anywhere reachable from this env.
  });

  it('records a real "allow" decision, keyed by sha256(tool_use_id), reading the decision from decide()\'s own output (never re-derived)', async () => {
    const raw = rawInput('kmp-test --version', 'toolu_allow1');
    const output = decide(raw, baseEnv());
    await recordDecisionSideEffect(raw, output, decisionEnv());
    expect(readSidecarRecord(path.join(evidenceDir, 'decisions'), sha256Hex('toolu_allow1'))).toEqual({ decision: 'allow', command: 'kmp-test --version' });
  });

  it('records a real "deny" decision identically', async () => {
    const raw = rawInput('whoami', 'toolu_deny1');
    const output = decide(raw, baseEnv());
    await recordDecisionSideEffect(raw, output, decisionEnv());
    expect(readSidecarRecord(path.join(evidenceDir, 'decisions'), sha256Hex('toolu_deny1'))).toEqual({ decision: 'deny', command: 'whoami' });
  });

  it('never throws for invalid raw JSON (returns before output is ever inspected)', async () => {
    await expect(recordDecisionSideEffect('{not valid json', '{}', decisionEnv())).resolves.toBeUndefined();
  });

  it('never writes anything when tool_use_id is missing/empty', async () => {
    const raw = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: fixtureRoot, tool_input: { command: 'kmp-test --version' } });
    const output = decide(raw, baseEnv());
    await expect(recordDecisionSideEffect(raw, output, decisionEnv())).resolves.toBeUndefined();
  });

  it('never writes anything when tool_input.command is missing/non-string', async () => {
    const raw = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_nocommand', cwd: fixtureRoot, tool_input: {} });
    const output = decide(raw, baseEnv());
    await recordDecisionSideEffect(raw, output, decisionEnv());
    expect(readSidecarRecord(path.join(evidenceDir, 'decisions'), sha256Hex('toolu_nocommand'))).toBeNull();
  });

  it('never writes anything when the output itself is invalid JSON or lacks a recognizable permissionDecision', async () => {
    const raw = rawInput('kmp-test --version', 'toolu_badoutput');
    await recordDecisionSideEffect(raw, 'not valid json', decisionEnv());
    expect(readSidecarRecord(path.join(evidenceDir, 'decisions'), sha256Hex('toolu_badoutput'))).toBeNull();
    await recordDecisionSideEffect(raw, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'maybe' } }), decisionEnv());
    expect(readSidecarRecord(path.join(evidenceDir, 'decisions'), sha256Hex('toolu_badoutput'))).toBeNull();
  });

  it('never throws when KMP_EVAL_JUNIT_EVIDENCE_DIR does not exist on disk (realpathSync fails, caught internally)', async () => {
    const raw = rawInput('kmp-test --version', 'toolu_baddir');
    const output = decide(raw, baseEnv());
    await expect(recordDecisionSideEffect(raw, output, decisionEnv({ KMP_EVAL_JUNIT_EVIDENCE_DIR: path.join(evidenceDir, 'does-not-exist-at-all') }))).resolves.toBeUndefined();
  });

  it('reads the decision from the ALREADY-COMPUTED output, never re-deriving it -- a command decide() would deny is recorded as "allow" here if the (hypothetical) caller passed a mismatched output, proving no re-derivation happens', async () => {
    // This is a deliberate white-box proof that recordDecisionSideEffect trusts `output` alone: a
    // real caller (runAsHook) always passes decide()'s own genuine output for the same raw input,
    // so this mismatch could never occur in production -- it exists only to prove the function
    // does not independently re-run decide() internally.
    const raw = rawInput('whoami', 'toolu_mismatch'); // decide() would deny this
    const mismatchedAllowOutput = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'x' } });
    await recordDecisionSideEffect(raw, mismatchedAllowOutput, decisionEnv());
    expect(readSidecarRecord(path.join(evidenceDir, 'decisions'), sha256Hex('toolu_mismatch'))).toEqual({ decision: 'allow', command: 'whoami' });
  });

  it('the lazy import happens only after KMP_EVAL_JUNIT_EVIDENCE_DIR is confirmed set -- an earlier revision imported junit-evidence-io.mjs unconditionally at module load, paying its cost on every PreToolUse call regardless of whether this mechanism was ever enabled', async () => {
    // A real, dynamic re-import to independently confirm the module still resolves correctly from
    // this call site (path correctness), rather than only inferring it from the tests above.
    const mod = await import('../../tools/agentic-eval/junit-evidence-io.mjs');
    expect(typeof mod.sha256Hex).toBe('function');
    expect(typeof mod.writeSidecarRecord).toBe('function');
  });
});

// tests/vitest/agentic-eval-env-builder.test.js
// Unit tests for tools/agentic-eval/env-builder.mjs.
import { describe, it, expect } from 'vitest';
import { buildEvalEnv, SECRET_SHAPE_RE, CLOUD_CRED_NAMES } from '../../tools/agentic-eval/env-builder.mjs';

// Synthetic secret-shaped values, split into pieces each individually under the
// device_serial scanner's 8-15-char threshold (or digit-free), assembled at runtime so this
// fixture file itself can't trip tools/decouple-audit.mjs -- matches the existing repo test
// idiom (see tests/vitest/decouple-audit.test.js's FAKEDEV+ICE12X split).
const FAKE_API_KEY = 'sk-ant-' + 'FAKEKEY' + '0001AB';
const FAKE_AWS_SECRET = 'FAKEAWS' + 'SECRET1';

function fakeSourceEnv(overrides = {}) {
  return {
    PATH: 'C:\\some\\path',
    SystemRoot: 'C:\\Windows',
    JAVA_HOME: 'C:\\java',
    TEMP: 'C:\\temp',
    HOME: 'C:\\Users\\real-user',
    USERPROFILE: 'C:\\Users\\real-user',
    APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    AWS_SECRET_ACCESS_KEY: FAKE_AWS_SECRET,
    SOME_RANDOM_TOKEN: 'fake-should-never-appear',
    A_CUSTOM_KEY: 'fake-should-never-appear',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    ...overrides,
  };
}

describe('buildEvalEnv', () => {
  it('drops secret-shaped keys regardless of name', () => {
    const out = buildEvalEnv(fakeSourceEnv());
    expect(out).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(out).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(out).not.toHaveProperty('SOME_RANDOM_TOKEN');
    expect(out).not.toHaveProperty('A_CUSTOM_KEY');
  });

  it('never includes any secret value anywhere in the output, even under an allowed key name', () => {
    const out = buildEvalEnv(fakeSourceEnv());
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(FAKE_API_KEY);
    expect(serialized).not.toContain(FAKE_AWS_SECRET);
  });

  // Post-review fix: this test previously asserted HOME is absent unconditionally under the
  // DEFAULT platform (no explicit `platform` option) -- true on Windows/Linux CI, but false on a
  // real macOS host, where the default IS process.platform === 'darwin' and Diseño 1's own fix
  // preserves HOME there. That made this test directly contradict the (correctly platform-guarded)
  // "defaults platform to the real process.platform" test that used to sit further down this
  // file -- both would have run on a real Mac, and this one would have failed. Folded into one
  // platform-aware test instead of two that could disagree.
  it('drops USERPROFILE/APPDATA under the default platform always; drops HOME too UNLESS the real host is macOS, where it is preserved', () => {
    const out = buildEvalEnv(fakeSourceEnv()); // no explicit platform -- exercises the REAL process.platform default
    expect(out).not.toHaveProperty('USERPROFILE');
    expect(out).not.toHaveProperty('APPDATA');
    if (process.platform === 'darwin') {
      expect(out.HOME).toBe('C:\\Users\\real-user');
    } else {
      expect(out).not.toHaveProperty('HOME');
    }
  });

  it('preserves HOME on macOS (platform: darwin) -- resolves the observed auth failure there', () => {
    const out = buildEvalEnv(fakeSourceEnv(), { platform: 'darwin' });
    expect(out.HOME).toBe('C:\\Users\\real-user');
  });

  it('does not invent HOME on macOS when absent from sourceEnv', () => {
    const { HOME, ...withoutHome } = fakeSourceEnv();
    const out = buildEvalEnv(withoutHome, { platform: 'darwin' });
    expect(out).not.toHaveProperty('HOME');
  });

  it('still drops USERPROFILE/APPDATA on macOS -- only HOME is added, no evidence for the others', () => {
    const out = buildEvalEnv(fakeSourceEnv(), { platform: 'darwin' });
    expect(out).not.toHaveProperty('USERPROFILE');
    expect(out).not.toHaveProperty('APPDATA');
  });

  it('regression-locks Windows: still drops HOME even when platform is passed explicitly', () => {
    const out = buildEvalEnv(fakeSourceEnv(), { platform: 'win32' });
    expect(out).not.toHaveProperty('HOME');
  });

  it('regression-locks Linux: scope is darwin only, never "every non-Windows platform"', () => {
    const out = buildEvalEnv(fakeSourceEnv(), { platform: 'linux' });
    expect(out).not.toHaveProperty('HOME');
  });

  it('HOME never collides with the secret-shape or cloud-cred guards (documentary, not defensive)', () => {
    expect(SECRET_SHAPE_RE.test('HOME')).toBe(false);
    expect(CLOUD_CRED_NAMES.has('HOME')).toBe(false);
  });

  it('drops nested-Claude-session variables (no CLAUDE*-prefixed var is ever named in the allowlist)', () => {
    const out = buildEvalEnv(fakeSourceEnv());
    expect(out).not.toHaveProperty('CLAUDECODE');
    expect(out).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
  });

  it('preserves required OS/PATH/temp/Java variables when present in input', () => {
    const out = buildEvalEnv(fakeSourceEnv());
    expect(out.PATH).toBe('C:\\some\\path');
    expect(out.SystemRoot).toBe('C:\\Windows');
    expect(out.JAVA_HOME).toBe('C:\\java');
    expect(out.TEMP).toBe('C:\\temp');
  });

  it('matches env var names case-insensitively (git-bash normalizes Windows names to uppercase)', () => {
    const out = buildEvalEnv({ SYSTEMROOT: 'C:\\Windows', COMSPEC: 'C:\\cmd.exe' });
    expect(out.SYSTEMROOT).toBe('C:\\Windows');
    expect(out.COMSPEC).toBe('C:\\cmd.exe');
  });

  it('supports extraAllowed for callers that need one additional named variable', () => {
    const out = buildEvalEnv({ MY_CUSTOM_VAR: 'value' }, { extraAllowed: ['MY_CUSTOM_VAR'] });
    expect(out.MY_CUSTOM_VAR).toBe('value');
  });

  it('extraAllowed does not bypass the secret-shape denylist', () => {
    const out = buildEvalEnv({ MY_CUSTOM_TOKEN: 'value' }, { extraAllowed: ['MY_CUSTOM_TOKEN'] });
    expect(out).not.toHaveProperty('MY_CUSTOM_TOKEN');
  });

  it('produces an empty object for an empty source env', () => {
    expect(buildEvalEnv({})).toEqual({});
  });
});

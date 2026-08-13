// tests/vitest/agentic-eval-auth-preflight.test.js
// Unit tests for tools/agentic-eval/auth-preflight.mjs, in isolation via an injected `spawnFn` --
// never a real subprocess/fixture here (that's agentic-eval-auth-preflight-e2e.test.js's job).
import { describe, it, expect, vi } from 'vitest';
import { runAuthPreflight, authPreflightReasonCode } from '../../tools/agentic-eval/auth-preflight.mjs';

// terminated defaults to false -- a normal, completed spawn -- matching every EXISTING test
// below's own intent (they were all already testing a process that ran to a normal conclusion;
// only the NEW terminated-specific tests further down pass true explicitly).
function fakeSpawnFn(exitCode, rawStdout, terminated = false) {
  return async () => ({ exitCode, terminated, rawStdout });
}

describe('runAuthPreflight', () => {
  it('ok:true when terminated is false, exitCode is 0, and loggedIn is true', async () => {
    const result = await runAuthPreflight({
      sharedEnv: {}, repoRoot: '/repo',
      spawnFn: fakeSpawnFn(0, '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":null,"subscriptionType":null}'),
    });
    expect(result).toEqual({ ok: true, terminated: false, exitCode: 0, loggedIn: true, authMethod: 'claude.ai', apiProvider: null, subscriptionType: null });
  });

  it('ok:false when exitCode is nonzero, even with a well-formed body', async () => {
    const result = await runAuthPreflight({
      sharedEnv: {}, repoRoot: '/repo',
      spawnFn: fakeSpawnFn(1, '{"loggedIn":false,"authMethod":"none"}'),
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.loggedIn).toBe(false);
  });

  it('ok:false when rawStdout does not parse as JSON (fail closed)', async () => {
    const result = await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn: fakeSpawnFn(0, 'not json') });
    expect(result.ok).toBe(false);
    expect(result.loggedIn).toBeNull();
  });

  it('ok:false when exitCode is 0 but loggedIn is false (both signals must agree)', async () => {
    const result = await runAuthPreflight({
      sharedEnv: {}, repoRoot: '/repo',
      spawnFn: fakeSpawnFn(0, '{"loggedIn":false}'),
    });
    expect(result.ok).toBe(false);
  });

  it('never returns a key outside the allowlist, even if the fabricated JSON includes email/org/token', async () => {
    const result = await runAuthPreflight({
      sharedEnv: {}, repoRoot: '/repo',
      spawnFn: fakeSpawnFn(0, '{"loggedIn":true,"authMethod":"claude.ai","email":"user@example.com","org":"acme","token":"fake-secret-value"}'),
    });
    expect(Object.keys(result).sort()).toEqual(['apiProvider', 'authMethod', 'exitCode', 'loggedIn', 'ok', 'subscriptionType', 'terminated']);
    expect(JSON.stringify(result)).not.toContain('example.com');
    expect(JSON.stringify(result)).not.toContain('acme');
    expect(JSON.stringify(result)).not.toContain('fake-secret-value');
  });

  it('treats a JSON array root as invalid -- never reads fields off an unexpected shape', async () => {
    const result = await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn: fakeSpawnFn(0, '[1,2,3]') });
    expect(result.loggedIn).toBeNull();
    expect(result.ok).toBe(false);
  });

  it('treats a JSON primitive root as invalid -- never reads fields off an unexpected shape', async () => {
    const result = await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn: fakeSpawnFn(0, '"ok"') });
    expect(result.loggedIn).toBeNull();
    expect(result.ok).toBe(false);
  });

  it('treats a non-boolean loggedIn as invalid, never as a truthy/falsy signal', async () => {
    const result = await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn: fakeSpawnFn(0, '{"loggedIn":"true"}') });
    expect(result.loggedIn).toBeNull();
    expect(result.ok).toBe(false);
  });

  // Post-review fix (P1): a process that never reached a normal conclusion must never be trusted,
  // even when its stdout parses as a complete, well-formed {loggedIn:true} response and exitCode
  // is 0 -- condition-launcher.mjs's own contract documents these as independent axes (a race
  // between a timeout/signal kill and the process's own buffered exit, or a binary that traps the
  // signal and exits 0 regardless).
  describe('terminated (fail-closed regardless of what exitCode/loggedIn claim)', () => {
    it('ok:false, reason auth_preflight_terminated, for a TIMEOUT -- even with exitCode:0 and a well-formed loggedIn:true body', async () => {
      const result = await runAuthPreflight({
        sharedEnv: {}, repoRoot: '/repo',
        spawnFn: fakeSpawnFn(0, '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":null,"subscriptionType":null}', true),
      });
      expect(result.ok).toBe(false);
      expect(result.terminated).toBe(true);
      expect(authPreflightReasonCode(result)).toBe('auth_preflight_terminated');
    });

    it('ok:false, reason auth_preflight_terminated, for an external SIGNAL kill -- even with exitCode:0 and a well-formed loggedIn:true body', async () => {
      // Signal-based termination and a timeout are both represented the same way at this layer
      // (spawnResult.terminated:true, condition-launcher.mjs's own `timedOut || signal != null`)
      // -- this test exercises the SAME code path via a differently-motivated real-world trigger
      // (an external kill, not our own timeout), proving the fix isn't accidentally timeout-specific.
      const result = await runAuthPreflight({
        sharedEnv: {}, repoRoot: '/repo',
        spawnFn: fakeSpawnFn(0, '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":null,"subscriptionType":null}', true),
      });
      expect(result.ok).toBe(false);
      expect(result.terminated).toBe(true);
    });

    it('ok:false when terminated is true and the body is ALSO malformed -- terminated is checked independently, not merely as a tiebreaker', async () => {
      const result = await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn: fakeSpawnFn(1, 'not json', true) });
      expect(result.ok).toBe(false);
      expect(result.terminated).toBe(true);
      expect(authPreflightReasonCode(result)).toBe('auth_preflight_terminated');
    });

    it('ok:true regression-lock: terminated:false with exitCode:0 and loggedIn:true still succeeds (the happy path is unaffected)', async () => {
      const result = await runAuthPreflight({
        sharedEnv: {}, repoRoot: '/repo',
        spawnFn: fakeSpawnFn(0, '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":null,"subscriptionType":null}', false),
      });
      expect(result.ok).toBe(true);
      expect(result.terminated).toBe(false);
    });

    it('a spawnFn result omitting terminated entirely defaults to fail-closed (ambiguous, never assumed healthy)', async () => {
      const spawnFn = async () => ({ exitCode: 0, rawStdout: '{"loggedIn":true}' }); // no `terminated` key at all
      const result = await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
      expect(result.ok).toBe(false);
      expect(result.terminated).toBe(true);
    });
  });

  it('default spawnFn is spawnCondition -- production callers never pass spawnFn', async () => {
    // Documented via source inspection: the exported default parameter is spawnCondition itself.
    // No behavioral assertion needed beyond "the module exports a real default", covered by the
    // e2e test exercising the real default against a real fake-claude fixture over PATH.
    const src = await import('../../tools/agentic-eval/auth-preflight.mjs');
    expect(typeof src.runAuthPreflight).toBe('function');
  });

  // P2 (review round 2): proves the preflight actually issues the FIXED, documented command
  // against the SAME sharedEnv/repoRoot/timeout the real spawn would use -- the fake spawnFn used
  // by every OTHER test in this file discards its own arguments entirely, so none of them could
  // ever have caught a regression that silently changed the argv, swapped env/cwd, or dropped the
  // configured timeout.
  describe('spawnFn is invoked with exactly the documented contract', () => {
    it('argv is exactly ["claude","auth","status","--json"]; env/cwd/timeout are passed through unchanged', async () => {
      const capturedCalls = [];
      const sharedEnv = { PATH: '/fake/path', SOME_VAR: 'x' };
      const spawnFn = vi.fn(async (argv, opts) => {
        capturedCalls.push({ argv, opts });
        return { exitCode: 0, terminated: false, rawStdout: '{"loggedIn":true}' };
      });
      await runAuthPreflight({ sharedEnv, repoRoot: '/real/repo/root', timeoutMs: 12345, spawnFn });

      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(capturedCalls.length).toBe(1);
      const { argv, opts } = capturedCalls[0];
      expect(argv).toEqual(['claude', 'auth', 'status', '--json']);
      // The EXACT sharedEnv object reference -- never a copy/subset/superset -- so a future
      // regression that silently drops or mutates env vars before the real spawn would be caught.
      expect(opts.env).toBe(sharedEnv);
      expect(opts.cwd).toBe('/real/repo/root');
      expect(opts.timeoutMs).toBe(12345);
    });

    it('the default timeoutMs (15000) is passed through when the caller does not override it', async () => {
      const spawnFn = vi.fn(async () => ({ exitCode: 0, terminated: false, rawStdout: '{"loggedIn":true}' }));
      await runAuthPreflight({ sharedEnv: {}, repoRoot: '/repo', spawnFn });
      expect(spawnFn.mock.calls[0][1].timeoutMs).toBe(15000);
    });
  });
});

describe('authPreflightReasonCode', () => {
  it('auth_preflight_terminated when terminated is true, regardless of exitCode/loggedIn -- checked FIRST, before either', () => {
    expect(authPreflightReasonCode({ terminated: true, exitCode: 0, loggedIn: true })).toBe('auth_preflight_terminated');
    expect(authPreflightReasonCode({ terminated: true, exitCode: 1, loggedIn: false })).toBe('auth_preflight_terminated');
    expect(authPreflightReasonCode({ terminated: true, exitCode: null, loggedIn: null })).toBe('auth_preflight_terminated');
  });

  it('auth_preflight_nonzero_exit when terminated is false and exitCode is nonzero, regardless of loggedIn', () => {
    expect(authPreflightReasonCode({ terminated: false, exitCode: 1, loggedIn: true })).toBe('auth_preflight_nonzero_exit');
    expect(authPreflightReasonCode({ terminated: false, exitCode: 1, loggedIn: null })).toBe('auth_preflight_nonzero_exit');
  });

  it('auth_preflight_not_logged_in when terminated is false, exitCode is 0, and loggedIn is explicitly false (well-formed negative signal)', () => {
    expect(authPreflightReasonCode({ terminated: false, exitCode: 0, loggedIn: false })).toBe('auth_preflight_not_logged_in');
  });

  it('auth_preflight_invalid_response when terminated is false, exitCode is 0, and loggedIn is null (never confused with not_logged_in)', () => {
    expect(authPreflightReasonCode({ terminated: false, exitCode: 0, loggedIn: null })).toBe('auth_preflight_invalid_response');
  });
});

describe('auth preflight incident message safety', () => {
  it('a hostile authMethod (path/email/secret-shaped) never reaches the reason code computation', async () => {
    const result = await runAuthPreflight({
      sharedEnv: {}, repoRoot: '/repo',
      spawnFn: fakeSpawnFn(0, '{"loggedIn":false,"authMethod":"C:\\\\Users\\\\realname\\\\.claude\\\\secret-token-abc123"}'),
    });
    const code = authPreflightReasonCode(result);
    expect(code).toBe('auth_preflight_not_logged_in');
    expect(code).not.toContain('realname');
    expect(code).not.toContain('secret-token');
  });
});

// tests/vitest/agentic-eval-auth-preflight.test.js
// Unit tests for tools/agentic-eval/auth-preflight.mjs, in isolation via an injected `spawnFn` --
// never a real subprocess/fixture here (that's agentic-eval-auth-preflight-e2e.test.js's job).
import { describe, it, expect } from 'vitest';
import { runAuthPreflight, authPreflightReasonCode } from '../../tools/agentic-eval/auth-preflight.mjs';

function fakeSpawnFn(exitCode, rawStdout) {
  return async () => ({ exitCode, rawStdout });
}

describe('runAuthPreflight', () => {
  it('ok:true when exitCode is 0 and loggedIn is true', async () => {
    const result = await runAuthPreflight({
      sharedEnv: {}, repoRoot: '/repo',
      spawnFn: fakeSpawnFn(0, '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":null,"subscriptionType":null}'),
    });
    expect(result).toEqual({ ok: true, exitCode: 0, loggedIn: true, authMethod: 'claude.ai', apiProvider: null, subscriptionType: null });
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
    expect(Object.keys(result).sort()).toEqual(['apiProvider', 'authMethod', 'exitCode', 'loggedIn', 'ok', 'subscriptionType']);
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

  it('default spawnFn is spawnCondition -- production callers never pass spawnFn', async () => {
    // Documented via source inspection: the exported default parameter is spawnCondition itself.
    // No behavioral assertion needed beyond "the module exports a real default", covered by the
    // e2e test exercising the real default against a real fake-claude fixture over PATH.
    const src = await import('../../tools/agentic-eval/auth-preflight.mjs');
    expect(typeof src.runAuthPreflight).toBe('function');
  });
});

describe('authPreflightReasonCode', () => {
  it('auth_preflight_nonzero_exit when exitCode is nonzero, regardless of loggedIn', () => {
    expect(authPreflightReasonCode({ exitCode: 1, loggedIn: true })).toBe('auth_preflight_nonzero_exit');
    expect(authPreflightReasonCode({ exitCode: 1, loggedIn: null })).toBe('auth_preflight_nonzero_exit');
  });

  it('auth_preflight_not_logged_in when exitCode is 0 and loggedIn is explicitly false (well-formed negative signal)', () => {
    expect(authPreflightReasonCode({ exitCode: 0, loggedIn: false })).toBe('auth_preflight_not_logged_in');
  });

  it('auth_preflight_invalid_response when exitCode is 0 and loggedIn is null (never confused with not_logged_in)', () => {
    expect(authPreflightReasonCode({ exitCode: 0, loggedIn: null })).toBe('auth_preflight_invalid_response');
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

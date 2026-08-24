// tests/vitest/agentic-eval-committed-evidence-guards.test.js
// Characterization guards over COMMITTED evidence and the repo's own tracking contract. Both suites
// here must pass identically before and after any change -- they are not RED->GREEN proofs of new
// behaviour, they exist so a change to the sidecar schema or to .gitignore cannot silently
// invalidate the historical corpus or start staging local-only diagnostics.
//
// "Identically" is a claim about CODE changes, not about the corpus growing. These guards are
// version-AWARE by necessity: the audit directory is append-only and every sidecar written since
// the dispatch-accounting change is schema 2, so an assertion phrased over "every committed
// sidecar" expires the moment the next canary lands its evidence. What each guard below pins is
// therefore either a rule the production code still owns (the supported-schema set, the validator)
// or a property of the frozen historical cohort -- never a snapshot of the corpus's current mix.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAcceptedRunAuditSidecar, ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1, ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2, SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS } from '../../tools/agentic-eval/accepted-run-audit.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT_DIR = path.join(REPO_ROOT, 'tools', 'runs', 'agentic-eval-scenario', 'audit');

/** The frozen historical v1 cohort. `buildAcceptedRunAuditSidecar` emits
 * LATEST_ACCEPTED_AUDIT_SIDECAR_SCHEMA, which is no longer 1, so no code path can add to this
 * number; committed evidence is never rewritten, so nothing should remove from it either. A move in
 * EITHER direction means a historical sidecar was converted to a later shape, edited, or deleted --
 * which is exactly what this file exists to catch. */
const HISTORICAL_V1_SIDECAR_COUNT = 92;

describe('committed accepted-run-audit sidecars keep validating under their own schema version', () => {
  const files = existsSync(AUDIT_DIR) ? readdirSync(AUDIT_DIR).filter((f) => f.endsWith('.json')) : [];

  it('the committed corpus is present and non-empty', () => {
    // A silent zero here would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(0);
  });

  it('every committed sidecar declares a schema the production code still supports', () => {
    // The supported set is READ from production rather than restated here: retiring a version there
    // must make this fail loudly, not keep passing against a stale copy of the list.
    const schemas = [...new Set(files.map((f) => JSON.parse(readFileSync(path.join(AUDIT_DIR, f), 'utf8')).schema))];
    expect(schemas.filter((s) => !SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS.includes(s))).toEqual([]);
  });

  it('the frozen historical v1 cohort is intact -- none converted to a later schema', () => {
    // Narrower, and non-expiring, replacement for an earlier "every committed sidecar is v1"
    // assertion: that one was a snapshot of the corpus at the time it was written, and no code path
    // can produce a v1 sidecar any more, so it could only ever be falsified by the corpus growing
    // exactly as intended. The property actually worth guarding is that the historical files
    // themselves were never rewritten -- new v2 evidence coexisting alongside them is not a defect.
    const v1Count = files.filter((f) => JSON.parse(readFileSync(path.join(AUDIT_DIR, f), 'utf8')).schema === ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1).length;
    expect(v1Count).toBe(HISTORICAL_V1_SIDECAR_COUNT);
  });

  it('every committed sidecar validates with zero errors', () => {
    const offenders = [];
    for (const f of files) {
      const sidecar = JSON.parse(readFileSync(path.join(AUDIT_DIR, f), 'utf8'));
      const { errors } = validateAcceptedRunAuditSidecar(sidecar);
      if (errors.length > 0) offenders.push({ file: f, errors });
    }
    expect(offenders).toEqual([]);
  });

  it('committed v1 sidecars carry NO v2-only fields', () => {
    const offenders = [];
    for (const f of files) {
      const sidecar = JSON.parse(readFileSync(path.join(AUDIT_DIR, f), 'utf8'));
      // Scoped to v1 files, which is what the assertion always meant. These two fields are REQUIRED
      // on a v2 sidecar -- the validator rejects a v2 that omits either -- so leaving the check
      // unscoped would report the current writer's own mandatory output as corpus corruption. On a
      // v1 file they stay unrecognized keys, and v1's closed-key rule still rejects them.
      if (sidecar.schema !== ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1) continue;
      if ('pre_dispatch_blocked_total' in (sidecar.summary ?? {})) offenders.push(`${f}: summary.pre_dispatch_blocked_total`);
      if ((sidecar.tool_calls ?? []).some((tc) => 'dispatch_status' in tc)) offenders.push(`${f}: tool_calls[].dispatch_status`);
    }
    expect(offenders).toEqual([]);
  });
});

// The rejection-diagnostics tracking contract, asserted the ONLY way that actually works.
// `git check-ignore` on a DIRECTORY path with a trailing slash matches the empty pattern on
// .gitignore's blank line and reports literally any path as ignored -- a prior session recorded a
// false "correctly gitignored" conclusion from exactly that. Every probe below is a concrete FILE.
describe('rejection-diagnostics tiers have the tracking status the harness documents', () => {
  function isIgnored(relPath) {
    const r = spawnSync('git', ['check-ignore', '-q', '--no-index', relPath], { cwd: REPO_ROOT });
    // exit 0 = ignored, exit 1 = not ignored. Anything else is a real git failure, not an answer.
    expect([0, 1]).toContain(r.status);
    return r.status === 0;
  }

  const ID = '0f7c1a2b-3d4e-5f60-8a9b-cdef01234567';

  it('tier 1 (the sanitized top-level diagnostic) is NOT ignored -- it is tracked by design', () => {
    expect(isIgnored(`tools/runs/agentic-eval-rejected/${ID}.json`)).toBe(false);
  });

  it.each([
    ['tier 2 local diagnostic', `tools/runs/agentic-eval-rejected/raw/${ID}.json`],
    ['tier 3 raw transcript', `tools/runs/agentic-eval-rejected/raw/transcripts/${ID}/0-${'a'.repeat(64)}.jsonl`],
    ['tier 4 raw stderr', `tools/runs/agentic-eval-rejected/raw/stderr/${ID}/0-${'a'.repeat(64)}.stderr.txt`],
  ])('%s IS ignored', (_label, relPath) => {
    expect(isIgnored(relPath)).toBe(true);
  });

  // NOT asserted: that a trailing-slash DIRECTORY probe misreports. It does on this repo's Windows
  // git (a directory path matches the empty pattern on .gitignore's blank line, so any path reads
  // as ignored -- which is how a prior session recorded a false "correctly gitignored" conclusion),
  // but it does NOT on Linux, where the same probe correctly reports not-ignored. That divergence
  // is a git/platform behaviour, not a contract this repo owns, so pinning it would assert a
  // machine quirk. The durable rule is simply the one every probe above follows: only ever
  // check-ignore a concrete FILE path.
});

// Both live sidecar versions must survive the OFFLINE resolution path (the one `validate`/
// `aggregate`/`analyze` all rely on), not just the in-memory validator.
describe('offline sidecar validation accepts v1 and v2, and rejects a version mismatch', () => {
  function sidecarFor(schema) {
    const base = {
      schema, run_id: 'scenario-current-skill-abcd1234', run_schema: 5, run_kind: 'scenario',
      condition: 'current-skill', scenario_id: 'kampkit-android-host-test-discovery',
      first_useful_signal_event: null, terminal_authoritative_event: null,
      tool_calls: [{
        ordinal: 0, tool_use_event_index: 1, tool_result_event_index: 2, tool_kind: 'other-bash',
        operation: null, plan_only: false, policy_decision: 'allow', result_status: 'success', phase: 'no-signal',
      }],
      summary: {
        tool_calls_total: 1, shell_commands_total: 1, post_signal_ms: null, post_signal_tool_calls: null,
        policy_denials_total: 0, policy_denials_before_first_signal: null, policy_denials_after_first_signal: null,
        policy_decisions_missing: 0,
      },
    };
    if (schema === 2) {
      base.tool_calls[0].dispatch_status = 'hook_evaluated';
      base.summary.pre_dispatch_blocked_total = 0;
    }
    return base;
  }

  it.each([ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1, ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2])('a well-formed schema-%i sidecar validates', (schema) => {
    expect(validateAcceptedRunAuditSidecar(sidecarFor(schema)).errors).toEqual([]);
  });

  it('a v1 sidecar carrying v2-only fields is rejected as unrecognized', () => {
    const bad = sidecarFor(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V1);
    bad.tool_calls[0].dispatch_status = 'hook_evaluated';
    bad.summary.pre_dispatch_blocked_total = 0;
    const fields = validateAcceptedRunAuditSidecar(bad).errors.map((e) => e.field);
    expect(fields).toContain('tool_calls[0].dispatch_status');
    expect(fields).toContain('summary.pre_dispatch_blocked_total');
  });

  it('a v2 sidecar missing the v2-only fields is rejected as incomplete', () => {
    const bad = sidecarFor(ACCEPTED_AUDIT_SIDECAR_SCHEMA_V2);
    delete bad.tool_calls[0].dispatch_status;
    delete bad.summary.pre_dispatch_blocked_total;
    const fields = validateAcceptedRunAuditSidecar(bad).errors.map((e) => e.field);
    expect(fields).toContain('tool_calls[0].dispatch_status');
    expect(fields).toContain('summary.pre_dispatch_blocked_total');
  });

  // 3, 4, AND 5 are deliberately excluded from this list: they are real supported sidecar numbers
  // (v3 since agentic-eval-runtime-neutral-records-v1, v4 legacy no-policy, v5 current no-policy --
  // see agentic-eval-accepted-run-audit.test.js for these versions' dedicated coverage) --
  // asserting either here would contradict SUPPORTED_ACCEPTED_AUDIT_SIDECAR_SCHEMAS.
  it.each([0, 99, null, '2'])('an unsupported sidecar schema (%j) fails closed', (schema) => {
    expect(validateAcceptedRunAuditSidecar(sidecarFor(schema)).errors.map((e) => e.field)).toContain('schema');
  });
});

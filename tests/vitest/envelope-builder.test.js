// SPDX-License-Identifier: MIT
// Direct unit coverage for the shared envelope-builder helpers
// (lib/envelope/builder.js) that construct a minimal coverage:{} stub.
// buildDryRunReport is used, unmodified, by parallel/changed's own
// --dry-run short-circuit (neither overwrites envelope.coverage afterward,
// unlike coverage-orchestrator.js's own --dry-run) -- so a gap here silently
// reaches those two subcommands' real --json output. No prior test asserted
// the shape of any of these three functions' coverage:{} object directly.
import { describe, it, expect } from 'vitest';
import { buildInvalidArgsEnvelope, envErrorJson, buildDryRunReport } from '../../lib/envelope/builder.js';

describe('envelope/builder.js -- shared coverage:{} stub carries covered_lines/total_lines', () => {
  it('buildInvalidArgsEnvelope', () => {
    const envelope = buildInvalidArgsEnvelope({
      subcommand: 'parallel',
      projectRoot: '/fake',
      durationMs: 1,
      errors: [{ code: 'invalid_flag_value', message: 'bad' }],
    });
    expect(envelope.coverage.missed_lines).toBeNull();
    expect(envelope.coverage.covered_lines).toBeNull();
    expect(envelope.coverage.total_lines).toBeNull();
  });

  it('envErrorJson', () => {
    const envelope = envErrorJson({
      subcommand: 'changed',
      projectRoot: '/fake',
      durationMs: 1,
      message: 'no project',
      code: 'no_project',
    });
    expect(envelope.coverage.missed_lines).toBeNull();
    expect(envelope.coverage.covered_lines).toBeNull();
    expect(envelope.coverage.total_lines).toBeNull();
  });

  it('buildDryRunReport', () => {
    const envelope = buildDryRunReport({
      subcommand: 'parallel',
      projectRoot: '/fake',
      plan: {},
    });
    expect(envelope.coverage.missed_lines).toBeNull();
    expect(envelope.coverage.covered_lines).toBeNull();
    expect(envelope.coverage.total_lines).toBeNull();
  });
});

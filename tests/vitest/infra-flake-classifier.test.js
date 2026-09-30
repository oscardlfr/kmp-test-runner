import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  INFRA_FLAKE_CLASSIFIER_SCHEMA,
  INFRA_FLAKE_SIGNATURE_RE,
  INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE,
  classifyTranscriptText,
  classifyCellTranscript,
  classifyCampaign,
} from '../../tools/agentic-eval/infra-flake-classifier.mjs';

const INFRA_FLAKE_CLASSIFIER_SCRIPT = fileURLToPath(new URL('../../tools/agentic-eval/infra-flake-classifier.mjs', import.meta.url));
import { buildProbeFailureWarning } from '../../lib/orchestrators/orchestrator-utils.js';
import { buildProbeFailureExcerpt } from '../../lib/project/cache.js';

// The exact verbatim signature from the real P2 diagnostic capture (docs/audits/
// evidence2-preregistration.md Amendment A2 §2), embedded in a realistic Gradle failure block.
const REAL_SIGNATURE_TEXT = `
FAILURE: Build failed with an exception.

* What went wrong:
Script compilation error:

  class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ByteArrayCharSequence cannot be cast to class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ZipEntryDescription (org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ByteArrayCharSequence and org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ZipEntryDescription are in unnamed module of loader org.gradle.internal.classloader.VisitableURLClassLoader @619a5dff)

1 error
`;

describe('INFRA_FLAKE_SIGNATURE_RE', () => {
  it('matches the real verbatim P2 signature', () => {
    expect(INFRA_FLAKE_SIGNATURE_RE.test(REAL_SIGNATURE_TEXT)).toBe(true);
  });

  it('does NOT match the generic "Script compilation error" text alone (A2 R5 -- an agent edit can produce this)', () => {
    const genericFailure = `
FAILURE: Build failed with an exception.

* What went wrong:
Script compilation error:

  e: file:///workspace/core/database/build.gradle.kts:12:5 Unresolved reference: totallyMadeUpDsl

1 error
`;
    expect(INFRA_FLAKE_SIGNATURE_RE.test(genericFailure)).toBe(false);
  });
});

// 2026-09-29 (WO-A2 auditor finding, Amendment A4): the real verbatim text from DryRunPassed's
// own product-smoke failure, campaign 99f67197 -- Gradle's own fixed daemon-death message, the
// SAME symmetric guarantee as the jarfs cast signature above (never something a build script or an
// agent's own code edit can produce).
const REAL_DAEMON_DISAPPEARED_TEXT = `
FAILURE: Build failed with an exception.

* What went wrong:
Gradle build daemon disappeared unexpectedly (it may have been killed or may have crashed)

* Try:
> Run with --stacktrace option to get the stack trace.
`;

describe('INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE', () => {
  it('matches the real verbatim campaign-99f67197 daemon-disappeared text', () => {
    expect(INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE.test(REAL_DAEMON_DISAPPEARED_TEXT)).toBe(true);
  });

  it('does NOT match an ordinary Gradle task failure an agent\'s own edit can legitimately produce', () => {
    const ordinaryFailure = `
FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':core:domain:test'.
> There were failing tests.

* Try:
> Run with --stacktrace option to get the stack trace.
`;
    expect(INFRA_FLAKE_DAEMON_DISAPPEARED_SIGNATURE_RE.test(ordinaryFailure)).toBe(false);
  });
});

describe('classifyTranscriptText', () => {
  it('flags on the real signature (R7: matches and flags)', () => {
    const result = classifyTranscriptText(REAL_SIGNATURE_TEXT);
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });

  it('does NOT flag a generic "Script compilation error" without the jarfs cast (R7)', () => {
    const result = classifyTranscriptText('Script compilation error:\n\n  e: unresolved reference foo\n');
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('clean');
  });

  it('counts gradle_probe_failed recovered:false WITHOUT the signature as probe_failed_unrecovered, not flagged (R7)', () => {
    const text = 'tool output\n{"warnings":[{"code":"gradle_probe_failed","recovered":false,"message":"probe timed out after 60000ms"}]}\nmore output';
    const result = classifyTranscriptText(text);
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('probe_failed_unrecovered');
  });

  it('flags gradle_probe_failed recovered:false whose OWN message carries the signature (A2 R5)', () => {
    const text = `{"code":"gradle_probe_failed","recovered":false,"message":"${REAL_SIGNATURE_TEXT.replace(/\n/g, ' ').replace(/"/g, '\\"')}"}`;
    const result = classifyTranscriptText(text);
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });

  it('counts gradle_probe_failed recovered:true as probe_failed_absorbed, not flagged (R7)', () => {
    const text = '{"code":"gradle_probe_failed","recovered":true,"message":"probe failed once, retried, succeeded"}';
    const result = classifyTranscriptText(text);
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('probe_failed_absorbed');
  });

  it('classifies clean output with neither signature nor probe warning as clean', () => {
    const result = classifyTranscriptText('BUILD SUCCESSFUL in 42s\n17 actionable tasks: 17 executed');
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('clean');
  });

  it('scans past an absorbed warning to find a LATER unrecovered one -- precedence, not first-match (auditor review of 9f2aa05)', () => {
    const text = [
      '{"code":"gradle_probe_failed","recovered":true,"message":"probe failed once, retried, succeeded"}',
      'more tool output in between',
      '{"code":"gradle_probe_failed","recovered":false,"message":"probe timed out after 60000ms"}',
    ].join('\n');
    const result = classifyTranscriptText(text);
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('probe_failed_unrecovered');
  });

  // 2026-09-29 (WO-A2 auditor finding, Amendment A4): the SAME flagged/signature_match outcome
  // the jarfs cast produces -- both are infra-level faults an agent's own edit cannot produce, so
  // this classifier deliberately does not distinguish which one fired in its own reason field.
  it('flags on the real daemon-disappeared signature (Amendment A4)', () => {
    const result = classifyTranscriptText(REAL_DAEMON_DISAPPEARED_TEXT);
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });

  it('does NOT flag an ordinary failing-test build without either signature', () => {
    const result = classifyTranscriptText("Execution failed for task ':core:domain:test'.\n> There were failing tests.\n");
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('clean');
  });

  it('flags gradle_probe_failed recovered:false whose OWN message carries the daemon-disappeared signature', () => {
    const text = `{"code":"gradle_probe_failed","recovered":false,"message":"${REAL_DAEMON_DISAPPEARED_TEXT.replace(/\n/g, ' ').replace(/"/g, '\\"')}"}`;
    const result = classifyTranscriptText(text);
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });

  it('an unrecovered warning followed by one whose message carries the signature still flags (belt-and-suspenders: the top-level whole-text check already guarantees this independent of loop order, but this pins the observable behavior directly rather than relying on that alone)', () => {
    const text = [
      '{"code":"gradle_probe_failed","recovered":false,"message":"probe timed out after 60000ms"}',
      'more tool output in between',
      `{"code":"gradle_probe_failed","recovered":false,"message":"${REAL_SIGNATURE_TEXT.replace(/\n/g, ' ').replace(/"/g, '\\"')}"}`,
    ].join('\n');
    const result = classifyTranscriptText(text);
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });
});

describe('classifier vs the REAL product warning shape (item 4 step 2: run the actual code, not a guess)', () => {
  // Full, realistic Gradle failure stderr -- same shape as the real P2 diagnostic capture
  // this whole investigation started from (docs/audits/evidence2-preregistration.md Amendment
  // A2 §2), fed through the product's OWN buildProbeFailureExcerpt (lib/project/cache.js) to
  // get a REAL excerpt, not a hand-written approximation of one.
  const JARFS_CRASH_STDERR = [
    'FAILURE: Build failed with an exception.',
    '',
    '* Where:',
    "Build file 'C:\\workspace\\core\\database\\build.gradle.kts'",
    '',
    '* What went wrong:',
    'Script compilation error:',
    '',
    '  class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ByteArrayCharSequence cannot be cast to class org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ZipEntryDescription (org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ByteArrayCharSequence and org.jetbrains.kotlin.cli.jvm.compiler.jarfs.ZipEntryDescription are in unnamed module of loader org.gradle.internal.classloader.VisitableURLClassLoader @619a5dff)',
    '',
    '1 error',
    '',
    '* Try:',
    '> Run with --stacktrace option to get the stack trace.',
    '',
    'BUILD FAILED in 40s',
  ].join('\n');

  // A DIFFERENT real-shaped failure with no jarfs cast anywhere -- an agent's own broken DSL
  // edit, the exact case A2 R5 says must never flag.
  const AGENT_EDIT_STDERR = [
    'FAILURE: Build failed with an exception.',
    '',
    '* Where:',
    "Build file 'C:\\workspace\\core\\database\\build.gradle.kts'",
    '',
    '* What went wrong:',
    'Script compilation error:',
    '',
    '  e: build.gradle.kts:12:5: Unresolved reference: totallyMadeUpDsl',
    '',
    '1 error',
    '',
    'BUILD FAILED in 3s',
  ].join('\n');

  it('recovered:true from an unrelated, non-signature transient failure (the real warning shape) counts as probe_failed_absorbed', () => {
    // A realistic absorbed case: the FIRST attempt failed for a reason unrelated to the jarfs
    // cast (a generic build error), then the retry succeeded. Deliberately NOT the jarfs
    // excerpt here -- see the next test for what happens when it is.
    const excerpt = buildProbeFailureExcerpt(AGENT_EDIT_STDERR);
    const warning = buildProbeFailureWarning({ reason: 'exit_nonzero', exit_code: 1, attempts: 2, recovered: true, excerpt });
    expect(warning.code).toBe('gradle_probe_failed');
    const result = classifyTranscriptText(JSON.stringify(warning));
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('probe_failed_absorbed');
  });

  it('recovered:true whose CARRIED excerpt still has the jarfs cast still flags (real product behavior, found by running the real code, not assumed)', () => {
    // lib/project/cache.js's real retry logic spreads the FIRST (failed) attempt's own
    // {reason, exit_code, excerpt} forward into the recovered probeFailure object
    // (`{...firstFailure, attempts, duration_ms, recovered: true}`) -- so if attempt 1 was
    // genuinely the jarfs-cast crash and attempt 2 happened to succeed, the recovered warning's
    // OWN message still carries the original crash excerpt. Per D13's own design ("any recorded
    // output... matches" flags, unconditionally), the environment fault genuinely occurred in
    // this cell's run even though dispatch ultimately succeeded -- this SHOULD still flag, not
    // silently disappear into "absorbed" just because the retry happened to work.
    const excerpt = buildProbeFailureExcerpt(JARFS_CRASH_STDERR);
    const warning = buildProbeFailureWarning({ reason: 'exit_nonzero', exit_code: 1, attempts: 2, recovered: true, excerpt });
    const result = classifyTranscriptText(JSON.stringify(warning));
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });

  it('recovered:false with the jarfs cast surviving into the real excerpt MUST flag', () => {
    const excerpt = buildProbeFailureExcerpt(JARFS_CRASH_STDERR);
    expect(excerpt).toMatch(INFRA_FLAKE_SIGNATURE_RE); // the product's own excerpt-builder keeps the cast line
    const warning = buildProbeFailureWarning({ reason: 'exit_nonzero', exit_code: 1, attempts: 2, recovered: false, excerpt });
    const result = classifyTranscriptText(JSON.stringify(warning));
    expect(result.infra_flake_suspected).toBe(true);
    expect(result.reason).toBe('signature_match');
  });

  it('recovered:false WITHOUT the jarfs cast (an agent\'s own broken edit) does NOT flag', () => {
    const excerpt = buildProbeFailureExcerpt(AGENT_EDIT_STDERR);
    expect(excerpt).not.toMatch(INFRA_FLAKE_SIGNATURE_RE);
    const warning = buildProbeFailureWarning({ reason: 'exit_nonzero', exit_code: 1, attempts: 2, recovered: false, excerpt });
    const result = classifyTranscriptText(JSON.stringify(warning));
    expect(result.infra_flake_suspected).toBe(false);
    expect(result.reason).toBe('probe_failed_unrecovered');
  });
});

describe('classifyCellTranscript (filesystem-backed, R7: missing transcript)', () => {
  it('classifies a missing transcript as "unknown", never false (R7, R6 fail-closed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'infra-flake-classifier-'));
    try {
      const missingPath = join(root, 'does-not-exist', 'transcript.jsonl');
      const result = classifyCellTranscript(missingPath);
      expect(result.infra_flake_suspected).toBe('unknown');
      expect(result.reason).toBe('transcript_missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a real transcript file and classifies its content', () => {
    const root = mkdtempSync(join(tmpdir(), 'infra-flake-classifier-'));
    try {
      const cellDir = join(root, 'cell');
      mkdirSync(cellDir, { recursive: true });
      const transcriptPath = join(cellDir, 'transcript.jsonl');
      writeFileSync(transcriptPath, REAL_SIGNATURE_TEXT, 'utf8');
      const result = classifyCellTranscript(transcriptPath);
      expect(result.infra_flake_suspected).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('classifyCampaign (end to end against a real fixture campaign directory)', () => {
  it('enumerates every manifest cell, computes arm from record/rejection condition, and rolls up per (runtime, arm)', () => {
    const root = mkdtempSync(join(tmpdir(), 'infra-flake-classifier-campaign-'));
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        runtimes: [
          { runtime_id: 'claude-code', campaign_cell_indices: [0, 1] },
          { runtime_id: 'codex-cli', campaign_cell_indices: [0] },
        ],
      }));

      // Cell 0 (claude-code): accepted, product arm, transcript carries the real signature.
      const cell0 = join(root, 'private', 'claude-code-0');
      mkdirSync(cell0, { recursive: true });
      writeFileSync(join(cell0, 'record.json'), JSON.stringify({ condition: 'current-skill' }));
      writeFileSync(join(cell0, 'audit.json'), JSON.stringify({}));
      writeFileSync(join(cell0, 'transcript.jsonl'), REAL_SIGNATURE_TEXT);

      // Cell 1 (claude-code): accepted, free arm, clean transcript.
      const cell1 = join(root, 'private', 'claude-code-1');
      mkdirSync(cell1, { recursive: true });
      writeFileSync(join(cell1, 'record.json'), JSON.stringify({ condition: 'no-skill' }));
      writeFileSync(join(cell1, 'audit.json'), JSON.stringify({}));
      writeFileSync(join(cell1, 'transcript.jsonl'), 'BUILD SUCCESSFUL');

      // Cell 0 (codex-cli): record present, but transcript never copied -- unknown.
      const cell2 = join(root, 'private', 'codex-cli-0');
      mkdirSync(cell2, { recursive: true });
      writeFileSync(join(cell2, 'record.json'), JSON.stringify({ condition: 'current-skill' }));
      writeFileSync(join(cell2, 'audit.json'), JSON.stringify({}));

      const result = classifyCampaign(root);

      expect(result.schema).toBe(INFRA_FLAKE_CLASSIFIER_SCHEMA);
      expect(result.cells).toHaveLength(3);

      const byKey = Object.fromEntries(result.cells.map((c) => [c.cell_key, c]));
      expect(byKey['claude-code-0'].infra_flake_suspected).toBe(true);
      expect(byKey['claude-code-0'].arm).toBe('product');
      expect(byKey['claude-code-1'].infra_flake_suspected).toBe(false);
      expect(byKey['claude-code-1'].arm).toBe('free');
      expect(byKey['codex-cli-0'].infra_flake_suspected).toBe('unknown');
      expect(byKey['codex-cli-0'].arm).toBe('product');

      const claudeProduct = result.rollup.find((r) => r.runtime_id === 'claude-code' && r.arm === 'product');
      expect(claudeProduct.flagged).toBe(1);
      const claudeFree = result.rollup.find((r) => r.runtime_id === 'claude-code' && r.arm === 'free');
      expect(claudeFree.flagged).toBe(0);
      const codexProduct = result.rollup.find((r) => r.runtime_id === 'codex-cli' && r.arm === 'product');
      expect(codexProduct.unknown).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Real subprocess invocation, not an imported-function call -- same rationale as
// agentic-eval-campaign-summary.test.js's and agentic-eval-cost-estimate.test.js's own identical
// describe blocks: a bare `file://${argv[1]}` guard never matches on Windows (import.meta.url is
// file:///C:/..., argv[1] is a bare backslash path), so main() silently never ran there -- confirmed
// live (WO-C14 dry run: `node infra-flake-classifier.mjs <dir>` exited 0 with zero stdout and no
// error). This file was missed when campaign-summary.mjs and cost-estimate.mjs got the same fix;
// it now copies their FIXED guard (resolve(process.argv[1]) === fileURLToPath(import.meta.url)).
// Proves the claim by executing the real script, not by pattern-matching the source.
describe('CLI entry point -- real `node infra-flake-classifier.mjs <dir>` subprocess invocation', () => {
  it('prints non-empty, schema-1 JSON and exits 0 for a minimal real campaign directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'infra-flake-classifier-cli-'));
    try {
      writeFileSync(join(root, 'manifest.json'), JSON.stringify({
        runtimes: [{ runtime_id: 'claude-code', campaign_cell_indices: [0] }],
      }));
      const cell0 = join(root, 'private', 'claude-code-0');
      mkdirSync(cell0, { recursive: true });
      writeFileSync(join(cell0, 'record.json'), JSON.stringify({ condition: 'current-skill' }));
      writeFileSync(join(cell0, 'audit.json'), JSON.stringify({}));

      const result = spawnSync(process.execPath, [INFRA_FLAKE_CLASSIFIER_SCRIPT, root], { encoding: 'utf8' });
      expect(result.status, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.schema).toBe(INFRA_FLAKE_CLASSIFIER_SCHEMA);
      expect(parsed.cells).toHaveLength(1);
      expect(parsed.cells[0].cell_key).toBe('claude-code-0');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits 2 with no campaign-dir argument, printing usage -- never a silent no-op', () => {
    const result = spawnSync(process.execPath, [INFRA_FLAKE_CLASSIFIER_SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});

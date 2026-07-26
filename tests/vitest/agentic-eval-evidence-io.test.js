// tests/vitest/agentic-eval-evidence-io.test.js
// Direct-import tests for tools/agentic-eval/evidence-io.mjs -- the shared atomic-write
// primitives extracted out of cli.mjs so both cli.mjs's own writers and the new
// rejection-diagnostics.mjs writer can reuse the identical mechanism. The extraction's
// behavior-preservation is already proven by the full pre-existing agentic-eval suite staying
// green unmodified (it exercises these functions indirectly through cli.mjs's writers); this file
// covers what has no other coverage: direct importability from the new module, and
// resolveRejectedDiagnosticsDir, which is brand new.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  RUNS_ROOT,
  resolveEvidenceOutDir,
  resolveRejectedDiagnosticsDir,
  isRawDirSafeFromAccidentalCommit,
  promoteTargetsAtomically,
} from '../../tools/agentic-eval/evidence-io.mjs';

describe('evidence-io.mjs -- resolveEvidenceOutDir', () => {
  it('joins an explicit runsRootOverride with agentic-eval-<runKind>, ignoring RUNS_ROOT', () => {
    expect(resolveEvidenceOutDir('scenario', '/isolated/root')).toBe(path.join('/isolated/root', 'agentic-eval-scenario'));
  });

  it('defaults to the module RUNS_ROOT when no override is passed', () => {
    expect(resolveEvidenceOutDir('calibration')).toBe(path.join(RUNS_ROOT, 'agentic-eval-calibration'));
  });
});

describe('evidence-io.mjs -- resolveRejectedDiagnosticsDir (new)', () => {
  it('resolves to agentic-eval-rejected under an explicit runsRootOverride, never keyed by run_kind', () => {
    expect(resolveRejectedDiagnosticsDir('/isolated/root')).toBe(path.join('/isolated/root', 'agentic-eval-rejected'));
  });

  it('defaults to the module RUNS_ROOT when no override is passed', () => {
    expect(resolveRejectedDiagnosticsDir()).toBe(path.join(RUNS_ROOT, 'agentic-eval-rejected'));
  });

  it('never collides with resolveEvidenceOutDir for any real run_kind', () => {
    for (const runKind of ['calibration', 'corpus-probe', 'scenario', 'smoke']) {
      expect(resolveRejectedDiagnosticsDir('/isolated/root')).not.toBe(resolveEvidenceOutDir(runKind, '/isolated/root'));
    }
  });
});

describe('evidence-io.mjs -- promoteTargetsAtomically, imported directly', () => {
  it('writes every target and leaves no .tmp-* leftovers on success', () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeio-promote-'));
    try {
      const outDir = path.join(runsRoot, 'agentic-eval-rejected');
      const targetA = path.join(outDir, 'a.json');
      const targetB = path.join(outDir, 'raw', 'a.json');
      promoteTargetsAtomically([[targetA, '{"a":1}'], [targetB, '{"detail":true}']], path.join(outDir, 'raw'));
      expect(readFileSync(targetA, 'utf8')).toBe('{"a":1}');
      expect(readFileSync(targetB, 'utf8')).toBe('{"detail":true}');
      expect(readdirSync(outDir).some((f) => f.includes('.tmp-'))).toBe(false);
      expect(readdirSync(path.join(outDir, 'raw')).some((f) => f.includes('.tmp-'))).toBe(false);
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it('refuses (and writes nothing new) when a target already exists', () => {
    const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeio-collide-'));
    try {
      const outDir = path.join(runsRoot, 'agentic-eval-rejected');
      const target = path.join(outDir, 'a.json');
      promoteTargetsAtomically([[target, '{"first":true}']], outDir);
      expect(() => promoteTargetsAtomically([[target, '{"second":true}']], outDir)).toThrow(/already exists/);
      expect(readFileSync(target, 'utf8')).toBe('{"first":true}');
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  // accepted-run-observability PR: promoteTargetsAtomically's own `ensureDir` param now ALSO
  // accepts an array of directories (e.g. both raw/ and audit/, siblings under one outDir) --
  // conservative extension, a bare string still works exactly as before (every test above this one
  // passes a single string, unchanged).
  describe('ensureDir accepts an array of directories (raw/ + audit/ siblings)', () => {
    it('creates every directory in the array before writing, even when none exist yet', () => {
      const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeio-promote-multidir-'));
      try {
        const outDir = path.join(runsRoot, 'agentic-eval-scenario');
        const rawDir = path.join(outDir, 'raw');
        const auditDir = path.join(outDir, 'audit');
        const targetSummary = path.join(outDir, 'r1.json');
        const targetRaw = path.join(rawDir, 'r1.jsonl');
        const targetAudit = path.join(auditDir, 'r1.json');
        promoteTargetsAtomically(
          [[targetSummary, '{"summary":true}'], [targetRaw, '{"raw":true}\n'], [targetAudit, '{"audit":true}']],
          [rawDir, auditDir],
        );
        expect(readFileSync(targetSummary, 'utf8')).toBe('{"summary":true}');
        expect(readFileSync(targetRaw, 'utf8')).toBe('{"raw":true}\n');
        expect(readFileSync(targetAudit, 'utf8')).toBe('{"audit":true}');
        expect(readdirSync(outDir).some((f) => f.includes('.tmp-'))).toBe(false);
      } finally {
        rmSync(runsRoot, { recursive: true, force: true });
      }
    });

    it('a collision on one target still rolls back every target this invocation created, across BOTH directories', () => {
      const runsRoot = mkdtempSync(path.join(os.tmpdir(), 'aeio-promote-multidir-rollback-'));
      try {
        const outDir = path.join(runsRoot, 'agentic-eval-scenario');
        const rawDir = path.join(outDir, 'raw');
        const auditDir = path.join(outDir, 'audit');
        mkdirSync(auditDir, { recursive: true });
        // Pre-create the audit target -- simulating a collision on that specific tier.
        writeFileSync(path.join(auditDir, 'r1.json'), '{"pre-existing":true}');
        expect(() => promoteTargetsAtomically(
          [[path.join(outDir, 'r1.json'), '{"summary":true}'], [path.join(rawDir, 'r1.jsonl'), '{"raw":true}\n'], [path.join(auditDir, 'r1.json'), '{"audit":true}']],
          [rawDir, auditDir],
        )).toThrow(/already exists/);
        expect(existsSync(path.join(outDir, 'r1.json'))).toBe(false);
        expect(existsSync(path.join(rawDir, 'r1.jsonl'))).toBe(false);
        expect(readFileSync(path.join(auditDir, 'r1.json'), 'utf8')).toBe('{"pre-existing":true}');
      } finally {
        rmSync(runsRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('evidence-io.mjs -- isRawDirSafeFromAccidentalCommit, imported directly', () => {
  it('confirms safe for a destination genuinely outside any git repository', () => {
    const outsideRoot = mkdtempSync(path.join(os.tmpdir(), 'aeio-outside-repo-'));
    try {
      expect(isRawDirSafeFromAccidentalCommit(path.join(outsideRoot, 'raw'), outsideRoot)).toBe(true);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('confirms UNSAFE for a real path inside this repo that no .gitignore rule covers', () => {
    // realpath() runs on runsRootOverride itself inside the function under test, so THAT path must
    // genuinely exist -- RUNS_ROOT is <repoRoot>/tools/runs, so two levels up is the real,
    // on-disk repo root. uncoveredDir itself does not need to exist -- git check-ignore only
    // needs the path string, and this made-up directory name matches no .gitignore rule at all.
    const repoRoot = path.dirname(path.dirname(RUNS_ROOT));
    const uncoveredDir = path.join(repoRoot, 'evidence-io-test-uncovered-probe', 'raw');
    expect(isRawDirSafeFromAccidentalCommit(uncoveredDir, repoRoot)).toBe(false);
  });
});

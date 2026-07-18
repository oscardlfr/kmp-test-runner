// tests/vitest/agentic-eval-corpus.test.js
// Validates tools/agentic-eval/corpus/trigger-queries.json content shape: counts/partitions,
// banned-term rules. Scenario definitions (corpus/scenarios/) and their graders are deferred
// to a follow-up PR -- see BACKLOG.md -- and are not present in this PR at all.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTriggerQueries } from '../../tools/agentic-eval/schemas.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, '..', '..', 'tools', 'agentic-eval', 'corpus');
const BANNED_TERMS_RE = /\bkmp-test\b|kmp-test-runner|bin[\\/]kmp-test\.js/i;

const trigger = JSON.parse(readFileSync(path.join(CORPUS_DIR, 'trigger-queries.json'), 'utf8'));

// Regression coverage for a real contradiction an independent review pass found: `corpus
// validate` (cli.mjs's cmdCorpusValidate) previously only counted should-trigger/near-miss
// categories, even though the README claims it validates shape and banned terms too. Fixed by
// porting this file's own assertions into a shared, exported validateTriggerQueries() that both
// the CLI command and this test call -- proving here that it agrees with every individual
// assertion below, on the SAME real corpus file, so the two can never silently drift apart.
it('validateTriggerQueries reports zero errors for the real, committed trigger-queries.json', () => {
  const { errors } = validateTriggerQueries(trigger);
  expect(errors).toEqual([]);
});

describe('trigger-queries.json', () => {
  it('has at least 10 should-trigger queries', () => {
    const shouldTrigger = trigger.queries.filter((q) => q.expected === 'should-trigger');
    expect(shouldTrigger.length).toBeGreaterThanOrEqual(10);
  });

  it('has at least 10 near-miss queries', () => {
    const nearMiss = trigger.queries.filter((q) => q.expected === 'near-miss');
    expect(nearMiss.length).toBeGreaterThanOrEqual(10);
  });

  it('has both train and held-out partitions represented in each category', () => {
    for (const expected of ['should-trigger', 'near-miss']) {
      const partitions = new Set(trigger.queries.filter((q) => q.expected === expected).map((q) => q.partition));
      expect(partitions.has('train')).toBe(true);
      expect(partitions.has('held-out')).toBe(true);
    }
  });

  it('declares repeats support (default_repeats >= 1)', () => {
    expect(trigger.default_repeats).toBeGreaterThanOrEqual(1);
  });

  it('every query has a unique id', () => {
    const ids = trigger.queries.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no query text mentions kmp-test, the skill name, or the bin path', () => {
    for (const q of trigger.queries) {
      expect(BANNED_TERMS_RE.test(q.text)).toBe(false);
    }
  });

  it('no query text mentions an expected command or activation result', () => {
    const suspiciousRe = /--json|--dry-run|gradlew|Skill tool|invoke the skill/i;
    for (const q of trigger.queries) {
      expect(suspiciousRe.test(q.text)).toBe(false);
    }
  });
});

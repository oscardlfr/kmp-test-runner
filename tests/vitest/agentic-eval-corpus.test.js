// tests/vitest/agentic-eval-corpus.test.js
// Validates tools/agentic-eval/corpus/ content shape: trigger-queries.json counts/partitions,
// banned-term rules, and the six scenario definitions.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScenario } from '../../tools/agentic-eval/schemas.mjs';
import { getGrader } from '../../tools/agentic-eval/graders.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.resolve(__dirname, '..', '..', 'tools', 'agentic-eval', 'corpus');
const BANNED_TERMS_RE = /\bkmp-test\b|kmp-test-runner|bin[\\/]kmp-test\.js/i;

const trigger = JSON.parse(readFileSync(path.join(CORPUS_DIR, 'trigger-queries.json'), 'utf8'));

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

describe('scenario definitions', () => {
  const scenariosDir = path.join(CORPUS_DIR, 'scenarios');
  const files = readdirSync(scenariosDir).filter((f) => f.endsWith('.json'));

  it('all six named scenarios from the task brief exist', () => {
    const expectedIds = [
      'kampkit-android-host-test-discovery',
      'kampkit-no-applicable-tests',
      'nowinandroid-core-common',
      'deterministic-unit-test-failure',
      'coverage-threshold-failure',
      'changed-module-verification',
    ];
    const actualIds = files.map((f) => f.replace('.json', ''));
    for (const id of expectedIds) expect(actualIds).toContain(id);
  });

  it.each(files)('%s passes schema validation', (file) => {
    const scenario = JSON.parse(readFileSync(path.join(scenariosDir, file), 'utf8'));
    const { errors } = validateScenario(scenario);
    expect(errors).toEqual([]);
  });

  it.each(files)('%s prompt does not mention kmp-test, the skill name, or the bin path', (file) => {
    const scenario = JSON.parse(readFileSync(path.join(scenariosDir, file), 'utf8'));
    expect(BANNED_TERMS_RE.test(scenario.prompt)).toBe(false);
  });

  it.each(files)('%s has a registered grader in graders.mjs', (file) => {
    const scenario = JSON.parse(readFileSync(path.join(scenariosDir, file), 'utf8'));
    expect(() => getGrader(scenario.id)).not.toThrow();
  });

  it.each(files)('%s references only a public (https) project URL', (file) => {
    const scenario = JSON.parse(readFileSync(path.join(scenariosDir, file), 'utf8'));
    expect(scenario.project_url.startsWith('https://')).toBe(true);
  });
});

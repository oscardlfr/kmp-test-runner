// tests/vitest/coderabbit-config.test.js
// Static guard for .coderabbit.yaml: keeps auto-review scoped to "develop"
// without a catch-all pattern. Reads the file from disk; no network, no
// subprocess.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const CONFIG_PATH = join(REPO_ROOT, '.coderabbit.yaml');

// Extracts the indented block under a `key:` line (exclusive of that line),
// stopping at the next line whose indentation is <= the key's own. Plain
// indentation-walk, no YAML parser -- scoped tighter than a flat regex so an
// unrelated `enabled: true` elsewhere in the file can't accidentally pass.
function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function section(yaml, key) {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n');
  const startIndex = lines.findIndex((l) => l.trim() === `${key}:`);
  if (startIndex === -1) return null;
  const baseIndent = indentOf(lines[startIndex]);
  const endIndex = lines.findIndex(
    (l, i) => i > startIndex && l.trim() !== '' && indentOf(l) <= baseIndent
  );
  return (endIndex === -1 ? lines.slice(startIndex + 1) : lines.slice(startIndex + 1, endIndex)).join('\n');
}

describe('.coderabbit.yaml', () => {
  it('exists at repo root', () => {
    expect(existsSync(CONFIG_PATH)).toBe(true);
  });

  describe('content', () => {
    let config;
    let autoReview;

    beforeAll(() => {
      config = readFileSync(CONFIG_PATH, 'utf8');
      autoReview = section(config, 'auto_review');
    });

    it('declares reviews as the top-level key', () => {
      expect(config).toMatch(/^reviews:/m);
    });

    it('has an auto_review block', () => {
      expect(autoReview).not.toBeNull();
    });

    it('enables auto_review with drafts excluded, inside the auto_review block', () => {
      expect(autoReview).toMatch(/^\s*enabled:\s*true\s*$/m);
      expect(autoReview).toMatch(/^\s*drafts:\s*false\s*$/m);
    });

    it('keeps auto_incremental_review on, inside the auto_review block', () => {
      expect(autoReview).toMatch(/^\s*auto_incremental_review:\s*true\s*$/m);
    });

    it('lists develop under auto_review.base_branches', () => {
      expect(autoReview).toMatch(/base_branches:\s*\n\s*-\s*"develop"/);
    });

    it('does not use a catch-all ".*" base_branches pattern', () => {
      expect(config).not.toContain('.*');
    });

    it('keeps review_status reporting on, outside the auto_review block', () => {
      expect(config).toMatch(/^\s*review_status:\s*true\s*$/m);
      expect(autoReview).not.toMatch(/review_status/);
    });
  });
});

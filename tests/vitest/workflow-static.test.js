// tests/vitest/workflow-static.test.js
// Static guards for .github/workflows/*.yml and related config files.
// Reads files from disk; no network, no subprocess.
//
// Guards enforce the desired post-PR-06 end state and catch future regressions.

import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = join(__dirname, '..', '..');
const WORKFLOWS   = join(REPO_ROOT, '.github', 'workflows');
const REQUIRED_CHECKS_JSON = join(REPO_ROOT, '.github', 'required-checks.json');

// Load all workflow files once
let wf = {};
beforeAll(() => {
  for (const f of readdirSync(WORKFLOWS).filter(n => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    wf[f] = readFileSync(join(WORKFLOWS, f), 'utf8');
  }
});

// ---------------------------------------------------------------------------
// SHA pinning — all external action refs must be pinned to a 40-char commit SHA

describe('action SHA pins', () => {
  it('no floating @vN version tags', () => {
    const RE = /uses:\s+\S+@v\d/;
    const violations = [];
    for (const [name, content] of Object.entries(wf)) {
      content.split('\n').forEach((line, i) => {
        if (RE.test(line)) violations.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations, `Unpinned floating-tag refs:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('no @main or @master branch refs', () => {
    const RE = /uses:\s+\S+@(main|master)/;
    const violations = [];
    for (const [name, content] of Object.entries(wf)) {
      content.split('\n').forEach((line, i) => {
        if (RE.test(line)) violations.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations, `Branch-pinned refs:\n${violations.join('\n')}`).toHaveLength(0);
  });

  it('all external uses: refs have a 40-char commit SHA', () => {
    // Refs starting with "./" are internal workflow calls — exempt.
    // Use \b to avoid matching "statuses:" which ends with the substring "uses:".
    const EXT   = /\buses:\s+([^.\s][^\s]*)/;
    const SHA40 = /@[0-9a-f]{40}/;
    const violations = [];
    for (const [name, content] of Object.entries(wf)) {
      content.split('\n').forEach((line, i) => {
        const m = EXT.exec(line);
        if (m && !SHA40.test(m[1])) violations.push(`${name}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations, `Refs without 40-char SHA:\n${violations.join('\n')}`).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Specific workflow guards

describe('publish-npm.yml', () => {
  it('does not contain npm@latest', () => {
    expect(wf['publish-npm.yml']).not.toMatch(/npm@latest/);
  });
  it('has tip-of-main guard (GITHUB_SHA vs origin/main)', () => {
    const c = wf['publish-npm.yml'];
    expect(c).toMatch(/origin\/main/);
    expect(c).toMatch(/GITHUB_SHA/);
  });
  it('declares checks: read permission', () => {
    expect(wf['publish-npm.yml']).toMatch(/checks:\s*read/);
  });
  it('declares statuses: read permission', () => {
    expect(wf['publish-npm.yml']).toMatch(/statuses:\s*read/);
  });
  it('invokes release-gate poll-checks', () => {
    expect(wf['publish-npm.yml']).toMatch(/release-gate\.mjs/);
    expect(wf['publish-npm.yml']).toMatch(/poll-checks/);
  });
});

describe('publish-gradle.yml', () => {
  it('has tip-of-main guard (GITHUB_SHA vs origin/main)', () => {
    const c = wf['publish-gradle.yml'];
    expect(c).toMatch(/origin\/main/);
    expect(c).toMatch(/GITHUB_SHA/);
  });
  it('declares checks: read permission', () => {
    expect(wf['publish-gradle.yml']).toMatch(/checks:\s*read/);
  });
  it('declares statuses: read permission', () => {
    expect(wf['publish-gradle.yml']).toMatch(/statuses:\s*read/);
  });
  it('invokes release-gate poll-checks', () => {
    expect(wf['publish-gradle.yml']).toMatch(/release-gate\.mjs/);
    expect(wf['publish-gradle.yml']).toMatch(/poll-checks/);
  });
});

describe('release.yml', () => {
  it('invokes release-gate poll-checks before fast-forwarding main', () => {
    expect(wf['release.yml']).toMatch(/release-gate\.mjs/);
    expect(wf['release.yml']).toMatch(/poll-checks/);
  });
});

describe('publish-release.yml', () => {
  it('has a pre-checkout tag format guard', () => {
    expect(wf['publish-release.yml']).toMatch(/[Vv]alidate tag format/);
  });
  it('validates tag via release-gate.mjs (all trigger paths)', () => {
    expect(wf['publish-release.yml']).toMatch(/release-gate\.mjs/);
    expect(wf['publish-release.yml']).toMatch(/validate-tag/);
  });
  it('generates .sha256 checksum files', () => {
    expect(wf['publish-release.yml']).toMatch(/sha256/i);
  });
  it('attaches .sha256 files to the GitHub Release', () => {
    expect(wf['publish-release.yml']).toMatch(/\.sha256/);
  });
  it('verifies tag commit is reachable from origin/main', () => {
    expect(wf['publish-release.yml']).toMatch(/is-ancestor/);
    expect(wf['publish-release.yml']).toMatch(/origin\/main/);
  });
});

describe('auto-tag.yml', () => {
  it('has a tip-of-main guard gated on workflow_dispatch', () => {
    const c = wf['auto-tag.yml'];
    expect(c).toMatch(/origin\/main/);
    expect(c).toMatch(/workflow_dispatch/);
  });
});

describe('ci.yml', () => {
  it('skills-ref invocation has an exact version pin', () => {
    const c = wf['ci.yml'];
    // The run: command must NOT invoke skills-ref without a version pin.
    // Use a pattern that specifically targets npx invocations (not step names).
    expect(c).not.toMatch(/npx\s+(?:-y\s+)?skills-ref\s+validate/);
    // The run: command MUST have skills-ref@x.y.z
    expect(c).toMatch(/skills-ref@\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// required-checks.json integrity

describe('.github/required-checks.json', () => {
  it('file exists', () => {
    expect(existsSync(REQUIRED_CHECKS_JSON)).toBe(true);
  });

  it('is valid JSON with version 1 and a non-empty contexts array of strings', () => {
    const manifest = JSON.parse(readFileSync(REQUIRED_CHECKS_JSON, 'utf8'));
    expect(manifest.version).toBe(1);
    expect(Array.isArray(manifest.required_contexts)).toBe(true);
    expect(manifest.required_contexts.length).toBeGreaterThan(0);
    for (const ctx of manifest.required_contexts) {
      expect(typeof ctx).toBe('string');
    }
  });

  it('contains the expected check names', () => {
    const manifest = JSON.parse(readFileSync(REQUIRED_CHECKS_JSON, 'utf8'));
    const ctx = manifest.required_contexts;
    expect(ctx).toContain('build (ubuntu-latest)');
    expect(ctx).toContain('build (windows-latest)');
    expect(ctx).toContain('secrets-scan');
    expect(ctx).toContain('Commit Lint');
  });
});

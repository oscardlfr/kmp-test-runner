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

// Extracts the YAML text block for a named job (2-space-indented key).
// Normalizes CRLF → LF first so equality checks work on Windows checkouts.
// The end-of-job sentinel matches any 2-space-indented identifier including
// hyphenated job names (e.g. installer-e2e, gradle-plugin-test-ios).
function jobSection(yaml, jobName) {
  const normalized = yaml.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const start = lines.findIndex(l => l === `  ${jobName}:`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^  [\w][\w-]*:/.test(l));
  return (end === -1 ? lines.slice(start) : lines.slice(start, end)).join('\n');
}

// ---------------------------------------------------------------------------
// jobSection() CRLF safety regression

describe('jobSection() helper', () => {
  it('extracts a job block correctly from LF-terminated YAML', () => {
    const yaml = [
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 15',
      '  secrets-scan:',
      '    runs-on: ubuntu-latest',
    ].join('\n');
    const section = jobSection(yaml, 'build');
    expect(section).not.toBeNull();
    expect(section).toMatch(/runs-on/);
    expect(section).toMatch(/timeout-minutes/);
    expect(section).not.toMatch(/secrets-scan/);
  });

  it('extracts a job block correctly from CRLF-terminated YAML (Windows checkout)', () => {
    const yaml = [
      'jobs:',
      '  installer-e2e:',
      '    runs-on: ubuntu-latest',
      '    timeout-minutes: 10',
      '    steps:',
      '      - run: npm ci',
      '  gradle-plugin-test:',
      '    runs-on: ubuntu-latest',
    ].join('\r\n');
    const section = jobSection(yaml, 'installer-e2e');
    expect(section).not.toBeNull();
    expect(section).toMatch(/npm ci/);
    expect(section).toMatch(/timeout-minutes/);
    expect(section).not.toMatch(/gradle-plugin-test/);
  });

  it('returns null for an unknown job name', () => {
    const yaml = '  build:\n    runs-on: ubuntu-latest\n';
    expect(jobSection(yaml, 'nonexistent')).toBeNull();
  });
});

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
// PR-19 CI cost discipline guards

describe('ci.yml PR-19 guards', () => {
  it('declares a concurrency group', () => {
    expect(wf['ci.yml']).toMatch(/^concurrency:/m);
  });

  it('cancel-in-progress is conditional on pull_request, not unconditional true', () => {
    const c = wf['ci.yml'];
    expect(c).not.toMatch(/cancel-in-progress:\s+true\b/);
    expect(c).toMatch(/cancel-in-progress:.*github\.event_name/);
  });

  it('non-PR CI concurrency group uses github.run_id (each push run is isolated)', () => {
    expect(wf['ci.yml']).toMatch(/github\.run_id/);
  });

  it('every job declares timeout-minutes (count matches runs-on count)', () => {
    const c = wf['ci.yml'];
    const runsOn   = (c.match(/^    runs-on:/gm) || []).length;
    const timeouts = (c.match(/^    timeout-minutes:/gm) || []).length;
    expect(timeouts).toBe(runsOn);
  });

  it('bats-macos job is not in ci.yml', () => {
    expect(wf['ci.yml']).not.toMatch(/^\s*bats-macos:/m);
  });

  it('gradle-plugin-test-ios job is not in ci.yml', () => {
    expect(wf['ci.yml']).not.toMatch(/^\s*gradle-plugin-test-ios:/m);
  });

  it('regular CI does not run macOS jobs (all macOS is in macos-validation.yml)', () => {
    expect(wf['ci.yml']).not.toMatch(/macos-latest/);
  });

  it('build job setup-node uses npm cache (build runs npm ci)', () => {
    const section = jobSection(wf['ci.yml'], 'build');
    expect(section).not.toBeNull();
    expect(section).toMatch(/npm ci/);
    expect(section).toMatch(/cache:\s+'?npm'?/);
  });

  it('installer-e2e job setup-node uses npm cache (installer-e2e runs npm ci)', () => {
    const section = jobSection(wf['ci.yml'], 'installer-e2e');
    expect(section).not.toBeNull();
    expect(section).toMatch(/npm ci/);
    expect(section).toMatch(/cache:\s+'?npm'?/);
  });
});

describe('macos-validation.yml', () => {
  it('file exists', () => {
    expect(wf['macos-validation.yml']).toBeDefined();
  });

  it('triggers only on workflow_dispatch (no push, pull_request, or schedule)', () => {
    const c = wf['macos-validation.yml'];
    expect(c).toMatch(/workflow_dispatch/);
    expect(c).not.toMatch(/\bpush:/);
    expect(c).not.toMatch(/\bpull_request:/);
    expect(c).not.toMatch(/\bschedule:/);
  });

  it('contains build-macos job', () => {
    expect(wf['macos-validation.yml']).toMatch(/^\s*build-macos:/m);
  });

  it('contains installer-e2e-macos job', () => {
    expect(wf['macos-validation.yml']).toMatch(/^\s*installer-e2e-macos:/m);
  });

  it('contains bats-macos job', () => {
    expect(wf['macos-validation.yml']).toMatch(/^\s*bats-macos:/m);
  });

  it('contains gradle-plugin-test-ios job', () => {
    expect(wf['macos-validation.yml']).toMatch(/^\s*gradle-plugin-test-ios:/m);
  });

  it('declares permissions: contents: read', () => {
    const c = wf['macos-validation.yml'];
    expect(c).toMatch(/permissions:/);
    expect(c).toMatch(/contents:\s*read/);
  });
});

describe('.github/required-checks.json — PR-19 stability', () => {
  it('contains exactly the 10 required check names (no renames, no additions)', () => {
    const manifest = JSON.parse(readFileSync(REQUIRED_CHECKS_JSON, 'utf8'));
    const ctx = manifest.required_contexts;
    const EXPECTED = [
      'build (ubuntu-latest)',
      'build (windows-latest)',
      'secrets-scan',
      'gradle-plugin-test',
      'installer-e2e (ubuntu-latest)',
      'installer-e2e (windows-latest)',
      'Commit Lint',
      'decouple-audit',
      'bundle-size',
      'skills-validate',
    ];
    for (const name of EXPECTED) expect(ctx).toContain(name);
    expect(ctx.length).toBe(EXPECTED.length);
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

// ---------------------------------------------------------------------------
// PR-20b: Node 24 upgrade + line-ending guard + Node 18 floor smoke

describe('ci.yml Node 24 upgrade and PR-20b guards', () => {
  it('regular CI still has no macos-latest', () => {
    expect(wf['ci.yml']).not.toMatch(/macos-latest/);
  });

  it('ci.yml has no node-version: 20 (EOL Node fully replaced by Node 24)', () => {
    // Node 20 reached EOL April 2026. Primary runtime upgraded to Node 24 (Active LTS).
    expect(wf['ci.yml']).not.toMatch(/node-version:\s+20\b/);
  });

  it('build job uses Node 24 as primary runtime with npm cache', () => {
    const section = jobSection(wf['ci.yml'], 'build');
    expect(section).not.toBeNull();
    expect(section).toMatch(/node-version:\s+['"]24\.18\.0['"]/);
    expect(section).toMatch(/cache:\s+'?npm'?/);
  });

  it('build job contains Node 18 floor smoke (setup-node + fresh npm ci + vitest run)', () => {
    const section = jobSection(wf['ci.yml'], 'build');
    expect(section).not.toBeNull();
    expect(section).toMatch(/node-version:\s+['"]18\.20\.8['"]/);
    expect(section).toMatch(/Node 18 smoke/i);
  });

  it('build job invokes check-line-endings.mjs', () => {
    const section = jobSection(wf['ci.yml'], 'build');
    expect(section).not.toBeNull();
    expect(section).toMatch(/check-line-endings\.mjs/);
  });

  it('required_contexts count unchanged — still exactly 10', () => {
    const manifest = JSON.parse(readFileSync(REQUIRED_CHECKS_JSON, 'utf8'));
    expect(manifest.required_contexts.length).toBe(10);
  });

  it('decide job skip filter does not include .gitattributes (it is source of truth for line-ending rules)', () => {
    // .gitattributes is not skip-eligible: a PR that weakens LF rules must run
    // build (check-line-endings.mjs + workflow-static tests) to be validated.
    const section = jobSection(wf['ci.yml'], 'decide');
    expect(section).not.toBeNull();
    expect(section).not.toMatch(/\.gitattributes/);
  });
});

// ---------------------------------------------------------------------------
// .gitattributes minimum LF-rule invariants

describe('.gitattributes minimum LF rules', () => {
  let ga;
  beforeAll(() => {
    ga = readFileSync(join(REPO_ROOT, '.gitattributes'), 'utf8');
  });

  const REQUIRED_LF_PATTERNS = [
    'scripts/*.sh',
    'scripts/**/*.sh',
    '.skills/**/*.sh',
    'tests/skill-scripts/*.bats',
    'tools/check-line-endings.mjs',
  ];

  for (const pattern of REQUIRED_LF_PATTERNS) {
    it(`${pattern} has eol=lf rule`, () => {
      // Escape regex metacharacters in the pattern for the contains-check.
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(ga).toMatch(new RegExp(`^${escaped}\\s+.*eol=lf`, 'm'));
    });
  }
});

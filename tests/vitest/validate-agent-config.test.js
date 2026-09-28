import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  LIMITS,
  parseRuleFrontmatter,
  validateAgentConfig,
} from '../../tools/validate-agent-config.mjs';

const REAL_REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VALIDATOR = path.join(REAL_REPO_ROOT, 'tools', 'validate-agent-config.mjs');

const REQUIRED = [
  'PRODUCT.md',
  'CONTRIBUTING.md',
  'BACKLOG.md',
  'CHANGELOG.md',
  'docs/maintainers/agent-configuration.md',
  'docs/maintainers/release-process.md',
  'docs/testing/local-ci.md',
];

let scratch = null;

function write(relativePath, content) {
  const absolute = path.join(scratch, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function makeFixture({ agents = '# Repository instructions\n', claude = '# Claude Code adapter\n\n@AGENTS.md\n', rule = null } = {}) {
  scratch = mkdtempSync(path.join(tmpdir(), 'agent-config-test-'));
  write('AGENTS.md', agents);
  write('CLAUDE.md', claude);
  write('.gitignore', '.claude/*\n!.claude/rules/\n!.claude/rules/*.md\n');
  for (const file of REQUIRED) write(file, `# ${path.basename(file)}\n`);
  write(
    '.claude/rules/node-runtime.md',
    rule ?? '---\npaths:\n  - "lib/**/*.js"\n---\n\n# Node\n\n- Keep it portable.\n',
  );
  return scratch;
}

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('parseRuleFrontmatter', () => {
  it('accepts a bounded paths list', () => {
    const parsed = parseRuleFrontmatter('---\npaths:\n  - "lib/**/*.js"\n  - tests/**/*.js\n---\nbody');
    expect(parsed).toEqual({ ok: true, paths: ['lib/**/*.js', 'tests/**/*.js'], body: 'body' });
  });

  it.each([
    ['missing opening delimiter', 'paths:\n  - "lib/**"\n---\nbody'],
    ['missing paths', '---\nname: nope\n---\nbody'],
    ['missing closing delimiter', '---\npaths:\n  - "lib/**"\nbody'],
  ])('rejects %s', (_label, content) => {
    expect(parseRuleFrontmatter(content).ok).toBe(false);
  });
});

describe('validateAgentConfig', () => {
  it('accepts the canonical adapter and a scoped rule', () => {
    makeFixture();
    expect(validateAgentConfig({ repoRoot: scratch })).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects missing canonical files', () => {
    makeFixture();
    rmSync(path.join(scratch, 'AGENTS.md'));
    const result = validateAgentConfig({ repoRoot: scratch });
    expect(result.errors.some((error) => error.code === 'missing-file' && error.file === 'AGENTS.md')).toBe(true);
  });

  it('rejects startup bloat and temporal release snapshots', () => {
    makeFixture({ agents: `# Repository instructions\n\n## Repo state\n\nReleased v1.2.3\n${'x'.repeat(LIMITS.agentsBytes)}` });
    const codes = validateAgentConfig({ repoRoot: scratch }).errors.map((error) => error.code);
    expect(codes).toContain('startup-budget');
    expect(codes).toContain('temporal-repo-state');
    expect(codes).toContain('temporal-release-pin');
  });

  it('rejects a CLAUDE adapter that omits AGENTS or duplicates H2 policy', () => {
    makeFixture({ claude: '# Claude Code adapter\n\n## Workflow\n\nDo the thing.\n' });
    const codes = validateAgentConfig({ repoRoot: scratch }).errors.map((error) => error.code);
    expect(codes).toContain('missing-canonical-import');
    expect(codes).toContain('adapter-duplication');
  });

  it.each([
    ['no paths', '---\nname: global\n---\nbody', 'rule-frontmatter'],
    ['universal scope', '---\npaths:\n  - "**/*"\n---\nbody', 'rule-path-universal'],
    ['absolute scope', '---\npaths:\n  - "/tmp/**/*"\n---\nbody', 'rule-path-absolute'],
    ['traversal scope', '---\npaths:\n  - "../other/**/*"\n---\nbody', 'rule-path-traversal'],
    ['empty body', '---\npaths:\n  - "lib/**/*"\n---\n', 'rule-body'],
  ])('rejects rule with %s', (_label, rule, code) => {
    makeFixture({ rule });
    expect(validateAgentConfig({ repoRoot: scratch }).errors.some((error) => error.code === code)).toBe(true);
  });

  it('rejects broken relative links in live instructions', () => {
    makeFixture({ agents: '# Repository instructions\n\nSee [missing](docs/missing.md).\n' });
    expect(validateAgentConfig({ repoRoot: scratch }).errors.some((error) => error.code === 'broken-relative-link')).toBe(true);
  });

  it('rejects private-memory references in live workflow configuration', () => {
    makeFixture();
    write('.github/workflows/ci.yml', '# See feedback_old_session.md\n');
    const result = validateAgentConfig({ repoRoot: scratch });
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'private-memory-reference',
      file: '.github/workflows/ci.yml',
    }));
  });

  it('rejects ignored path-rule configuration', () => {
    makeFixture();
    write('.gitignore', '.claude/\n');
    const errors = validateAgentConfig({ repoRoot: scratch }).errors.filter((error) => error.code === 'rules-ignore-contract');
    expect(errors).toHaveLength(3);
  });

  it('fails closed when obsolete repository-owned roles reappear', () => {
    makeFixture();
    write('.claude/agents/debugger.md', '# Generic debugger alias\n');
    const result = validateAgentConfig({ repoRoot: scratch });
    expect(result.errors.some((error) => error.code === 'retired-agent-config' && error.file === '.claude/agents')).toBe(true);
  });
});

describe('CLI', () => {
  it('passes on the live repository', () => {
    const result = spawnSync(process.execPath, [VALIDATOR], { cwd: REAL_REPO_ROOT, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[validate-agent-config] OK');
  });

  it('prints help and rejects unknown flags', () => {
    const help = spawnSync(process.execPath, [VALIDATOR, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('Usage:');

    const bad = spawnSync(process.execPath, [VALIDATOR, '--bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('Unknown argument');
  });
});

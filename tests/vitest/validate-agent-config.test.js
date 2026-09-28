import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  LIMITS,
  parseRuleFrontmatter,
  REQUIRED_RULE_FILES,
  REQUIRED_RULE_PATHS,
  validateAgentConfig,
} from '../../tools/validate-agent-config.mjs';

const REAL_REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VALIDATOR = path.join(REAL_REPO_ROOT, 'tools', 'validate-agent-config.mjs');

const REQUIRED = [
  'README.md',
  'PRODUCT.md',
  'CONTRIBUTING.md',
  'BACKLOG.md',
  'CHANGELOG.md',
  'docs/envelope-contract.md',
  'docs/maintainers/agent-configuration.md',
  'docs/maintainers/release-process.md',
  'docs/testing/local-ci.md',
];

const VALID_AGENTS = `# Repository instructions

## Sources of truth

- docs/envelope-contract.md owns the contract.

## Repository shape

- Keep implementations together.

## Working agreement

- Do not merge unless the user explicitly asks.
- Do not create, rename, move, or drop milestones without an explicit user decision.

## Product invariants

- The documented CLI flags, configuration variables, and Gradle DSL are public API.
- Run tools/decouple-audit.mjs.

## Verification

- Run focused tests.

## Agent configuration and memory

- Keep durable policy here.
`;

const RULE_FIXTURES = {
  '.claude/rules/agentic-eval.md': '# Eval\n\n- Treat outputs as evidence contracts. Fail closed.\n',
  '.claude/rules/consumer-skill.md': '# Skill\n\n- This is a shipped consumer artifact.\n',
  '.claude/rules/docs-ci-release.md': '# Docs\n\n- Route a "What\'s new" request to CHANGELOG.md.\n- Keep squash_merge_commit_title=PR_TITLE.\n',
  '.claude/rules/gradle-plugin.md': '# Gradle\n\n- Treat the Gradle DSL as public API. Never use withPluginClasspath().\n',
  '.claude/rules/node-runtime.md': '# Node\n\n- Synchronize docs/envelope-contract.md.\n',
  '.claude/rules/platform-scripts.md': '# Scripts\n\n- Support Bash 3.2 and redirect-first resolution with API fallback.\n',
  '.claude/rules/project-model.md': '# Model\n\n- Keep unitTestTask, iosTestTask, and macosTestTask independent.\n',
};

const SOURCE_FIXTURES = {
  'docs/maintainers/release-process.md': `# Release

- Use a top-level \`kmp-test-runner-\${VER}/\` directory.
- Publish \`kmp-test-runner-\${VER}-linux.tar.gz\` and
  \`kmp-test-runner-\${VER}-windows.zip\` with no architecture suffix.
- Include \`package.json\` inside both archives.
- Mint the App token from RELEASE_APP_ID and RELEASE_APP_PRIVATE_KEY; a
  GITHUB_TOKEN push cannot replace it because of anti-recursion.
- Pass gh the \`GH_TOKEN\` environment variable, not the \`GITHUB_TOKEN\`
  environment variable.
- Trusted Publishing needs npm 11.5.1 and Node 22.14.0; pin Node 24.18.0.
- Keep a 45-minute timeout for the second CI run.
`,
};

function ruleFrontmatter(file, paths = REQUIRED_RULE_PATHS[file]) {
  return `---\npaths:\n${paths.map((entry) => `  - ${JSON.stringify(entry)}`).join('\n')}\n---\n\n`;
}

let scratch = null;

function write(relativePath, content) {
  const absolute = path.join(scratch, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function makeFixture({ agents = VALID_AGENTS, claude = '# Claude Code adapter\n\n@AGENTS.md\n', rule = null } = {}) {
  scratch = mkdtempSync(path.join(tmpdir(), 'agent-config-test-'));
  write('AGENTS.md', agents);
  write('CLAUDE.md', claude);
  write('.gitignore', '.claude/*\n!.claude/rules/\n!.claude/rules/*.md\n');
  for (const file of REQUIRED) write(file, SOURCE_FIXTURES[file] ?? `# ${path.basename(file)}\n`);
  for (const file of REQUIRED_RULE_FILES) {
    const body = file === '.claude/rules/node-runtime.md' && rule !== null
      ? rule
      : `${ruleFrontmatter(file)}${RULE_FIXTURES[file]}`;
    write(file, body);
  }
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
  it('accepts the canonical adapter and complete scoped-rule contract', () => {
    makeFixture();
    expect(validateAgentConfig({ repoRoot: scratch })).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects missing canonical files', () => {
    makeFixture();
    rmSync(path.join(scratch, 'AGENTS.md'));
    const result = validateAgentConfig({ repoRoot: scratch });
    expect(result.errors.some((error) => error.code === 'missing-file' && error.file === 'AGENTS.md')).toBe(true);
  });

  it('rejects a missing canonical rule family', () => {
    makeFixture();
    rmSync(path.join(scratch, '.claude/rules/project-model.md'));
    const result = validateAgentConfig({ repoRoot: scratch });
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: 'missing-required-rule',
      file: '.claude/rules/project-model.md',
    }));
  });

  it('rejects a canonical rule that no longer loads for a required consumer', () => {
    makeFixture();
    const file = '.claude/rules/project-model.md';
    const omitted = 'lib/orchestrators/android-orchestrator.js';
    write(file, `${ruleFrontmatter(file, REQUIRED_RULE_PATHS[file].filter((entry) => entry !== omitted))}${RULE_FIXTURES[file]}`);
    expect(validateAgentConfig({ repoRoot: scratch }).errors).toContainEqual(expect.objectContaining({
      code: 'missing-rule-path',
      file,
      message: expect.stringContaining(omitted),
    }));
  });

  it('rejects deletion of a canonical AGENTS section', () => {
    makeFixture({ agents: VALID_AGENTS.replace('## Product invariants', '## Product behavior') });
    expect(validateAgentConfig({ repoRoot: scratch }).errors).toContainEqual(expect.objectContaining({
      code: 'missing-agent-section',
      message: expect.stringContaining('Product invariants'),
    }));
  });

  it('rejects mutation of a durable AGENTS contract', () => {
    makeFixture({ agents: VALID_AGENTS.replace('Gradle DSL are public API', 'Gradle DSL are implementation details') });
    expect(validateAgentConfig({ repoRoot: scratch }).errors).toContainEqual(expect.objectContaining({
      code: 'missing-agent-contract',
      message: expect.stringContaining('public API surfaces'),
    }));
  });

  it('rejects mutation of a durable scoped-rule contract', () => {
    makeFixture();
    write(
      '.claude/rules/docs-ci-release.md',
      `${ruleFrontmatter('.claude/rules/docs-ci-release.md')}# Docs\n\n- Route a "What's new" request to CHANGELOG.md.\n`,
    );
    expect(validateAgentConfig({ repoRoot: scratch }).errors).toContainEqual(expect.objectContaining({
      code: 'missing-rule-contract',
      file: '.claude/rules/docs-ci-release.md',
      message: expect.stringContaining('squash-title setting'),
    }));
  });

  it('rejects mutation of a durable release document contract', () => {
    makeFixture();
    const file = 'docs/maintainers/release-process.md';
    write(file, SOURCE_FIXTURES[file].replace('`package.json` inside both archives', '`package-lock.json` inside both archives'));
    expect(validateAgentConfig({ repoRoot: scratch }).errors).toContainEqual(expect.objectContaining({
      code: 'missing-document-contract',
      file,
      message: expect.stringContaining('packaged runtime version source'),
    }));
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

  it.each(['.claude/agents', '.codex/agents', '.Codex/agents'])('fails closed when obsolete repository-owned roles reappear under %s', (directory) => {
    makeFixture();
    write(`${directory}/debugger.md`, '# Generic debugger alias\n');
    const result = validateAgentConfig({ repoRoot: scratch });
    expect(result.errors.some((error) => error.code === 'retired-agent-config' && error.file === directory)).toBe(true);
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

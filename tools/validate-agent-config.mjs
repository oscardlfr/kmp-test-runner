#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = dirname(dirname(__filename));

export const LIMITS = Object.freeze({
  agentsBytes: 12 * 1024,
  claudeBytes: 2 * 1024,
  ruleBytes: 4 * 1024,
});

const REQUIRED_PROJECT_FILES = [
  'PRODUCT.md',
  'CONTRIBUTING.md',
  'BACKLOG.md',
  'CHANGELOG.md',
  'docs/maintainers/agent-configuration.md',
  'docs/maintainers/release-process.md',
  'docs/testing/local-ci.md',
];

const RETIRED_CONFIG_DIRS = [
  '.claude/agents',
  '.Codex/agents',
  '.claude/agent-memory',
  '.Codex/memory',
];

const SNAPSHOT_PATTERNS = [
  { code: 'temporal-repo-state', pattern: /^#{1,6}\s+Repo state\b/im, message: 'move repository state to live sources' },
  { code: 'temporal-milestones', pattern: /^#{1,6}\s+Active milestones\b/im, message: 'move milestone state to BACKLOG.md' },
  { code: 'temporal-version-heading', pattern: /^#{1,6}\s+v\d+\.\d+(?:\.\d+)?\b/im, message: 'move version chronology to CHANGELOG.md' },
  { code: 'temporal-release-pin', pattern: /\bv\d+\.\d+\.\d+\b/i, message: 'derive release versions from package.json' },
];

const PRIVATE_MEMORY_PATTERN = /\bfeedback_[a-z0-9_-]+(?:\.md)?\b/i;

function makeError(file, code, message, line = null) {
  return { file, line, code, message };
}

function lineFor(content, index) {
  return content.slice(0, index).split('\n').length;
}

function readText(repoRoot, relativePath, errors, missingCode = 'missing-file') {
  const absolute = join(repoRoot, relativePath);
  try {
    return readFileSync(absolute, 'utf8').replaceAll('\r\n', '\n');
  } catch (error) {
    errors.push(makeError(relativePath, missingCode, error.code === 'ENOENT' ? 'required file is missing' : `cannot read file: ${error.message}`));
    return null;
  }
}

function walkMarkdown(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

function walkYaml(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkYaml(path));
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) found.push(path);
  }
  return found.sort();
}

function directoryHasFiles(path) {
  if (!existsSync(path)) return false;
  if (!statSync(path).isDirectory()) return true;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile() || entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && directoryHasFiles(join(path, entry.name))) return true;
  }
  return false;
}

function validateStartupFile(file, content, limit, errors) {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > limit) {
    errors.push(makeError(file, 'startup-budget', `${bytes} bytes exceeds the ${limit}-byte startup budget`));
  }
  for (const check of SNAPSHOT_PATTERNS) {
    const match = check.pattern.exec(content);
    if (match) errors.push(makeError(file, check.code, check.message, lineFor(content, match.index)));
  }
  validateNoPrivateMemoryReference(file, content, errors);
}

function validateNoPrivateMemoryReference(file, content, errors) {
  const match = PRIVATE_MEMORY_PATTERN.exec(content);
  if (match) {
    errors.push(makeError(file, 'private-memory-reference', 'materialize durable policy in a tracked source', lineFor(content, match.index)));
  }
}

export function parseRuleFrontmatter(content) {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { ok: false, error: 'frontmatter must start on line 1', paths: [], body: '' };
  const close = lines.indexOf('---', 1);
  if (close === -1) return { ok: false, error: 'frontmatter closing delimiter is missing', paths: [], body: '' };

  const frontmatter = lines.slice(1, close);
  const paths = [];
  let inPaths = false;
  for (let i = 0; i < frontmatter.length; i += 1) {
    const raw = frontmatter[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed === 'paths:') {
      if (inPaths) return { ok: false, error: 'paths must be declared exactly once', paths: [], body: '' };
      inPaths = true;
      continue;
    }
    const item = raw.match(/^\s+-\s+(.+?)\s*$/);
    if (inPaths && item) {
      const value = item[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single);
      paths.push(value);
      continue;
    }
    return { ok: false, error: `unsupported frontmatter on line ${i + 2}; only paths is allowed`, paths: [], body: '' };
  }

  if (!inPaths || paths.length === 0) return { ok: false, error: 'paths must contain at least one glob', paths: [], body: '' };
  return { ok: true, paths, body: lines.slice(close + 1).join('\n').trim() };
}

function validateRule(repoRoot, absolutePath, errors) {
  const file = relative(repoRoot, absolutePath).split(sep).join('/');
  const name = file.slice(file.lastIndexOf('/') + 1, -3);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    errors.push(makeError(file, 'rule-name', 'rule filename must be lowercase kebab-case'));
  }
  const content = readText(repoRoot, file, errors);
  if (content === null) return;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > LIMITS.ruleBytes) {
    errors.push(makeError(file, 'rule-budget', `${bytes} bytes exceeds the ${LIMITS.ruleBytes}-byte rule budget`));
  }
  const parsed = parseRuleFrontmatter(content);
  if (!parsed.ok) {
    errors.push(makeError(file, 'rule-frontmatter', parsed.error));
    return;
  }
  if (!parsed.body) errors.push(makeError(file, 'rule-body', 'rule body must not be empty'));
  validateNoPrivateMemoryReference(file, content, errors);
  for (const pattern of parsed.paths) {
    const normalized = pattern.replaceAll('\\', '/');
    if (!pattern || isAbsolute(pattern) || /^[A-Za-z]:\//.test(normalized)) {
      errors.push(makeError(file, 'rule-path-absolute', `path glob must be repository-relative: ${pattern}`));
    }
    if (normalized.split('/').includes('..')) {
      errors.push(makeError(file, 'rule-path-traversal', `path glob must not escape the repository: ${pattern}`));
    }
    if (normalized === '**/*' || normalized === '**') {
      errors.push(makeError(file, 'rule-path-universal', 'path-scoped rules must not use a universal glob'));
    }
  }
  validateRelativeReferences(repoRoot, file, content, errors);
}

function resolvesInside(repoRoot, fromFile, target) {
  const withoutAnchor = target.split('#', 1)[0];
  if (!withoutAnchor) return true;
  const absolute = resolve(repoRoot, dirname(fromFile), withoutAnchor);
  const root = resolve(repoRoot);
  return (absolute === root || absolute.startsWith(`${root}${sep}`)) && existsSync(absolute);
}

function validateRelativeReferences(repoRoot, file, content, errors) {
  const links = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(links)) {
    const target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
    if (!resolvesInside(repoRoot, file, target)) {
      errors.push(makeError(file, 'broken-relative-link', `relative link does not resolve inside the repository: ${target}`, lineFor(content, match.index)));
    }
  }

  const imports = /^@([^\s]+)\s*$/gm;
  for (const match of content.matchAll(imports)) {
    const target = match[1];
    if (!resolvesInside(repoRoot, file, target)) {
      errors.push(makeError(file, 'broken-import', `import does not resolve inside the repository: ${target}`, lineFor(content, match.index)));
    }
  }
}

export function validateAgentConfig({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const root = resolve(repoRoot);
  const errors = [];
  const agents = readText(root, 'AGENTS.md', errors);
  const claude = readText(root, 'CLAUDE.md', errors);

  if (agents !== null) {
    validateStartupFile('AGENTS.md', agents, LIMITS.agentsBytes, errors);
    validateRelativeReferences(root, 'AGENTS.md', agents, errors);
  }
  if (claude !== null) {
    validateStartupFile('CLAUDE.md', claude, LIMITS.claudeBytes, errors);
    if (!/^@AGENTS\.md\s*$/m.test(claude)) {
      errors.push(makeError('CLAUDE.md', 'missing-canonical-import', 'adapter must import @AGENTS.md on its own line'));
    }
    const operationalHeadings = [...claude.matchAll(/^##\s+.+$/gm)];
    if (operationalHeadings.length > 0) {
      errors.push(makeError('CLAUDE.md', 'adapter-duplication', 'adapter must not define operational H2 sections', lineFor(claude, operationalHeadings[0].index)));
    }
    validateRelativeReferences(root, 'CLAUDE.md', claude, errors);
  }

  for (const file of REQUIRED_PROJECT_FILES) {
    if (!existsSync(join(root, file))) errors.push(makeError(file, 'missing-source-of-truth', 'referenced source-of-truth file is missing'));
  }

  const rulesDir = join(root, '.claude', 'rules');
  const rules = walkMarkdown(rulesDir);
  if (rules.length === 0) errors.push(makeError('.claude/rules', 'missing-rules', 'at least one path-scoped rule is required'));
  for (const rule of rules) validateRule(root, rule, errors);

  for (const workflowPath of walkYaml(join(root, '.github', 'workflows'))) {
    const file = relative(root, workflowPath).split(sep).join('/');
    const content = readText(root, file, errors);
    if (content !== null) validateNoPrivateMemoryReference(file, content, errors);
  }

  const gitignore = readText(root, '.gitignore', errors);
  if (gitignore !== null) {
    for (const required of ['.claude/*', '!.claude/rules/', '!.claude/rules/*.md']) {
      if (!gitignore.split('\n').includes(required)) {
        errors.push(makeError('.gitignore', 'rules-ignore-contract', `missing exact rule required to version path-scoped config: ${required}`));
      }
    }
  }

  for (const directory of RETIRED_CONFIG_DIRS) {
    if (directoryHasFiles(join(root, directory))) {
      errors.push(makeError(directory, 'retired-agent-config', 'repository-owned role or auto-memory files require an explicit contract and validator update'));
    }
  }

  return { ok: errors.length === 0, errors, rules: rules.map((path) => relative(root, path).split(sep).join('/')) };
}

export function formatErrors(errors) {
  return errors.map((error) => `${error.file}${error.line ? `:${error.line}` : ''} [${error.code}] ${error.message}`).join('\n');
}

const HELP = `tools/validate-agent-config.mjs -- validate repository agent instructions

Usage:
  node tools/validate-agent-config.mjs
  node tools/validate-agent-config.mjs --help
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length > 0) {
    process.stderr.write(`Unknown argument: ${argv[0]}\n\n${HELP}`);
    return 2;
  }
  const result = validateAgentConfig();
  if (!result.ok) {
    process.stderr.write(`${formatErrors(result.errors)}\n`);
    return 1;
  }
  process.stdout.write(`[validate-agent-config] OK (${result.rules.length} path-scoped rules)\n`);
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isMain) process.exit(main(process.argv.slice(2)));

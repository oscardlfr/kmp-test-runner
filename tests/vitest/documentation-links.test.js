import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './_parity-helpers.js';

function markdownFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(absolute);
  }
  return out;
}

function localTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    target = target.split('#', 1)[0].split('?', 1)[0];
    if (target) targets.push(decodeURIComponent(target));
  }
  return targets;
}

describe('documentation links', () => {
  it('all audited local markdown targets exist', () => {
    const rootDocs = ['README.md', 'CONTRIBUTING.md', 'PRODUCT.md', 'CLAUDE.md', 'BACKLOG.md',
      '.github/PULL_REQUEST_TEMPLATE.md']
      .map(file => path.join(REPO_ROOT, file));
    const docs = markdownFiles(path.join(REPO_ROOT, 'docs'));
    const skillDocs = markdownFiles(path.join(REPO_ROOT, '.skills', 'kmp-test-runner'));
    const tools = [
      path.join(REPO_ROOT, 'tools', 'README.md'),
      path.join(REPO_ROOT, 'tools', 'agentic-eval', 'README.md'),
      ...markdownFiles(path.join(REPO_ROOT, 'tools', 'runs')),
    ];

    const missing = [];
    for (const file of [...rootDocs, ...docs, ...skillDocs, ...tools]) {
      const markdown = readFileSync(file, 'utf8');
      for (const target of localTargets(markdown)) {
        const resolved = path.resolve(path.dirname(file), target);
        if (!existsSync(resolved)) {
          missing.push(`${path.relative(REPO_ROOT, file)} -> ${target}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

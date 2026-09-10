import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './_parity-helpers.js';

function markdownFiles(root, { skip = new Set() } = {}) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(absolute, { skip }));
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
  it('every local Markdown target in the repository exists', () => {
    const docs = markdownFiles(REPO_ROOT, {
      skip: new Set(['.git', 'node_modules']),
    });

    const missing = [];
    for (const file of docs) {
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

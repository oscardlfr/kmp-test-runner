// tests/vitest/publish-npm-config.test.js
// Static guard for .github/workflows/publish-npm.yml: npm's Trusted Publishing
// (OIDC, --provenance) requires npm >= 11.5.1 and Node >= 22.14.0
// (docs.npmjs.com/trusted-publishers). An older bundled npm still signs a
// provenance statement with the GitHub OIDC token -- a separate, older
// feature -- but predates Trusted Publishing itself, so the registry PUT
// goes out with no valid auth and fails with a bare 404, a failure mode with
// no useful error until you're staring at the actual publish log. Reads the
// file from disk; no network, no subprocess.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'publish-npm.yml');

describe('publish-npm.yml Node/npm version', () => {
  let workflow;

  beforeAll(() => {
    workflow = readFileSync(WORKFLOW_PATH, 'utf8').replace(/\r\n/g, '\n');
  });

  it('pins node-version to an exact quoted string, never a bare major', () => {
    const match = workflow.match(/node-version:\s*(.+)/);
    expect(match).not.toBeNull();
    expect(match[1].trim()).toMatch(/^'[0-9]+\.[0-9]+\.[0-9]+'$/);
  });

  it('pins Node 24.18.0 -- the exact version verified to bundle npm >= 11.5.1', () => {
    // Hardcoded, not a >= check: forces a conscious re-verification (does the new
    // pin's bundled npm still clear the floor?) on any future edit, the same
    // discipline as the project-model cache SCHEMA_VERSION assertion in cli.test.js.
    // Node 22's entire line only ever bundled npm 10.x (verified against
    // nodejs.org/dist/index.json) -- "just bump the major to 22" is not enough.
    expect(workflow).toMatch(/node-version:\s*'24\.18\.0'/);
  });

  it('never installs npm via @latest', () => {
    expect(workflow).not.toMatch(/npm\s+install\s+-g\s+npm@latest/);
  });
});

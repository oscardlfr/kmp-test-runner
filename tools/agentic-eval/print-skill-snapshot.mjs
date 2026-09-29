import { resolve } from 'node:path';
import { computeSkillSnapshotArtifact } from './input-artifacts.mjs';
import { PINNED_SKILL_SHA } from './cli.mjs';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--repo-root');
if (rootIndex === -1 || typeof args[rootIndex + 1] !== 'string' || args[rootIndex + 1].length === 0) {
  throw new Error('print-skill-snapshot: --repo-root is required');
}

const repoRoot = resolve(args[rootIndex + 1]);
const snapshot = computeSkillSnapshotArtifact({
  repoRoot,
  sha: PINNED_SKILL_SHA,
  root: '.skills/kmp-test-runner',
});

process.stdout.write(`${JSON.stringify({
  schema: 1,
  skill_source_sha: PINNED_SKILL_SHA,
  ...snapshot,
})}\n`);

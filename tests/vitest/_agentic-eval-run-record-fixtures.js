// tests/vitest/_agentic-eval-run-record-fixtures.js
// Shared buildRunRecord() fixture inputs for tests whose subject is NOT the
// selection/promptArtifact/skillSnapshotArtifact contract itself (that contract has its own
// dedicated coverage in agentic-eval-cli.test.js's "selection/promptArtifact/skillSnapshotArtifact
// are required..." describe block, which builds its own deliberately-broken overrides directly --
// this file exists only to keep the many PRE-EXISTING buildRunRecord() unit tests green across the
// schema v6 migration without repeating the same three fixture object literals at every call site).
//
// Deliberately NOT a `.test.js` file (vitest.config.js's `include` only matches
// `tests/vitest/**/*.test.js`), so importing this from a test file never registers a second,
// empty suite.
//
// `selection` comes from the real, public resolveSelection({}) seam -- never a hand-reconstructed
// registry entry -- so this fixture can never silently drift from what the registries actually
// contain (a hand-typed runtime_id/model_id/execution-profile literal would keep "working" even
// after a real registry edit invalidated it). promptArtifact/skillSnapshotArtifact are genuinely
// synthetic (buildRunRecord never recomputes either -- it only reads the shape), but still
// well-formed: lowercase hex64 hashes, positive integer byte/file counts -- exactly the shape
// computePromptArtifact()/computeSkillSnapshotArtifact() themselves produce.
import { resolveSelection } from '../../tools/agentic-eval/registries.mjs';

const result = resolveSelection({});
if (result.ok !== true) {
  throw new Error(`_agentic-eval-run-record-fixtures.js: resolveSelection({}) failed to resolve the default selection: ${result.reason}`);
}
const selection = result.selection;

export const TEST_RUN_RECORD_V6_INPUTS = Object.freeze({
  modelRequested: selection.model.model_id,
  selection,
  promptArtifact: Object.freeze({ prompt_sha256: 'b'.repeat(64), prompt_bytes: 55 }),
  skillSnapshotArtifact: Object.freeze({ snapshot_sha256: 'c'.repeat(64), snapshot_bytes: 234997, snapshot_file_count: 28 }),
});

// tests/vitest/skill-canonical-workflow.test.js
// Regression coverage for SKILL.md's canonical agent workflow: ONE authoritative Decision
// protocol section (first heading in the document) drives scope classification (broad / exact
// module / test-capability target / likely-no-tests target), preview-only dry-run,
// envelope-as-authority, stop-after-evidence, and conditional doctor -- replacing the old split
// across Quick start / Steps section 1 / Steps section 2. Also locks: no policy-unsafe
// placeholder commands, no policy-denied commands in the "optional" Environment detection
// section, no stale hardcoded version, no unconditional `kmp-test --version` check, frontmatter
// description covers module/task discovery and pre-inspection invocation -- as one rule binding a
// module identified only indirectly (role/contents/platform/test capability) to that same
// pre-inspection instruction -- canonical-vs-decorated command denial exercised against the REAL
// policy-hook decide() function (not just prose), the test-capability step's dispatch filter
// bound to the one eligible modules[] entry's own exact name (never a differently-named/typed/
// platformed entry) with a pre-dispatch check against the real matchModuleFilter substring
// semantics (binding to an exact name alone doesn't stop --module-filter from also matching a
// differently-named module), and no agentic-eval-harness-internal leakage. Section-scoped (not
// whole-file substring checks) so a fix landing in the wrong section can't produce a false green.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverCoverageModules, parseArgs as parseCoverageArgs, runCoverage } from '../../lib/orchestrators/coverage-orchestrator.js';
import { parseArgs as parseParallelArgs } from '../../lib/orchestrators/parallel-orchestrator.js';
import { parseArgs as parseChangedArgs } from '../../lib/orchestrators/changed-orchestrator.js';
import { matchModuleFilter } from '../../lib/orchestrators/orchestrator-utils.js';
import { TEST_TYPE_VALUES } from '../../lib/parsers/argv-constants.js';
import { SOFT_ERROR_CODES } from '../../lib/envelope/builder.js';
import { ENV_ERROR_CODES } from '../../lib/envelope/exit-codes.js';
import { decide } from '../../tools/agentic-eval/policy-hook.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_DIR = path.join(REPO_ROOT, '.skills', 'kmp-test-runner');
// SKILL.md is CRLF on a Windows checkout; .gitattributes LF-pins only .skills/**/*.sh and
// scripts/**/*.sh, not .md files. Normalize so fenced-code-block regexes anchored on \n match
// regardless of the host checkout's line endings -- this is a test-robustness fix, not a reason
// to add a new .gitattributes rule.
const skillMd = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\r/g, '\n');

// Narrow section extraction by level-2 (## ) heading boundaries -- not a general markdown
// parser. Level-3 (### ) subheadings stay inside their parent section.
function section(heading) {
  const marker = `## ${heading}`;
  const start = skillMd.indexOf(marker);
  if (start === -1) throw new Error(`heading not found: ${marker}`);
  const rest = skillMd.slice(start + marker.length);
  const nextIdx = rest.search(/^## /m);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

// Round-4 addition: ground SKILL.md's coverage-scoping claims in the REAL orchestrator's actual
// behavior, not just prose pattern-matching -- round 3's own text-presence tests couldn't have
// caught that --coverage-modules uses exact/colonless matching (proven wrong by round 3's
// content, which implied it shared --module-filter's substring/glob semantics). Reuses the exact
// fixture shape already established in tests/vitest/coverage-orchestrator.test.js (colon-prefixed
// module keys, {coveragePlugin, type} minimal shape, real parseArgs()).
describe('Coverage module-scoping contract (grounds SKILL.md claims in the real orchestrator)', () => {
  const projectModel = { modules: { ':app': { coveragePlugin: 'kover', type: 'jvm' } } };

  it(':app (colon-prefixed, as describe modules[].name literally returns it) matches ZERO modules', () => {
    const r = discoverCoverageModules(projectModel, parseCoverageArgs(['--coverage-modules', ':app']));
    expect(r.dispatched).toHaveLength(0);
  });

  it('app (colonless, exact) matches the :app module', () => {
    const r = discoverCoverageModules(projectModel, parseCoverageArgs(['--coverage-modules', 'app']));
    expect(r.dispatched.map((m) => m.name)).toEqual(['app']);
  });

  it('app* (glob-shaped) matches ZERO modules -- no glob or substring support', () => {
    const r = discoverCoverageModules(projectModel, parseCoverageArgs(['--coverage-modules', 'app*']));
    expect(r.dispatched).toHaveLength(0);
  });
});

// Post-merge CodeRabbit + human review round (PR #403, HEAD 87278cd): step 5's "bind dispatch to
// that entry's exact modules[].name" is necessary but not sufficient for --module-filter workflows
// (parallel/android/benchmark) -- matchModuleFilter's own non-glob branch is a SUBSTRING match, so
// binding to :foo still lets --module-filter :foo ALSO select a co-resident :fooApp module. Grounds
// the SKILL.md pre-dispatch ambiguity check (added below) in the REAL matcher, not just asserted
// prose -- reproduces the exact :foo / :fooApp collision the reviewer flagged.
describe('Module-filter substring-widening contract (grounds the SKILL.md pre-dispatch ambiguity check in the real matcher)', () => {
  it(':foo (the bound modules[].name, passed as-is to --module-filter per step 4) matches BOTH :foo and a co-resident :fooApp', () => {
    expect(matchModuleFilter(':foo', ':foo')).toBe(true);
    expect(matchModuleFilter(':fooApp', ':foo')).toBe(true);
  });

  it('a colon-stripped bound name collides the same way (relevant if a workflow ever passed it colonless)', () => {
    expect(matchModuleFilter(':fooApp', 'foo')).toBe(true);
  });

  it('a glob-shaped filter is unaffected -- this contract is specific to the non-glob substring branch', () => {
    expect(matchModuleFilter(':fooApp', ':foo*')).toBe(true);
    expect(matchModuleFilter(':bar', ':foo*')).toBe(false);
  });
});

// Round-4 addition: ground the no-test-outcome caveat (describe's test_tasks field names aren't
// --test-type values) in the real enum, not an asserted mapping that could itself go stale.
describe('--test-type value contract (grounds the no-test-outcome caveat in real behavior)', () => {
  it('device and web are NOT real --test-type values', () => {
    expect(TEST_TYPE_VALUES).not.toContain('device');
    expect(TEST_TYPE_VALUES).not.toContain('web');
  });

  it('the real enum includes androidInstrumented, js, wasm, ios, macos', () => {
    expect(TEST_TYPE_VALUES).toContain('androidInstrumented');
    expect(TEST_TYPE_VALUES).toContain('js');
    expect(TEST_TYPE_VALUES).toContain('wasm');
    expect(TEST_TYPE_VALUES).toContain('ios');
    expect(TEST_TYPE_VALUES).toContain('macos');
  });
});

// Round-5 addition: ground the "changed has no user-facing module filter" claim in the real
// parser -- changed-orchestrator.js's parseArgs has no `--module-filter` case at all, so it falls
// through to the generic unknown-flag handler. Round 4's SKILL.md text wrongly grouped `changed`
// alongside parallel/android/benchmark as accepting --module-filter; this is the real behavior
// that the Decision-protocol assertion below is tied to.
describe('changed unsupported-flag contract (grounds SKILL.md and reference-doc claims in the real parser)', () => {
  it('--module-filter is rejected as unknown_flag -- changed has no user-facing module filter', () => {
    const opts = parseChangedArgs(['--module-filter', 'app']);
    expect(opts.errors).toContainEqual(
      expect.objectContaining({ code: 'unknown_flag', flag: '--module-filter' })
    );
  });

  // Round-6 addition: the same bug class as --module-filter -- flags-reference.md marked
  // `changed` as accepting --max-workers, and changed.md claimed it "behaves the same as setting
  // it for parallel". But parseArgs has no case for --max-workers either, so it's also rejected
  // as unknown_flag before ever reaching the in-process runParallel() delegation.
  it('--max-workers is rejected as unknown_flag -- changed has no user-facing worker-count flag', () => {
    const opts = parseChangedArgs(['--max-workers', '2']);
    expect(opts.errors).toContainEqual(
      expect.objectContaining({ code: 'unknown_flag', flag: '--max-workers' })
    );
  });

  it('reference docs do not present --max-workers as supported by changed', () => {
    const flagsRef = readFileSync(
      path.join(SKILL_DIR, 'references', 'cli', 'flags-reference.md'), 'utf8'
    );
    const changedDoc = readFileSync(
      path.join(SKILL_DIR, 'references', 'workflows', 'changed.md'), 'utf8'
    );

    // The --max-workers row's `changed` column (index 6 of the pipe-split cells: '', Flag,
    // Default, parallel, coverage, benchmark, changed, android, Notes, '') must be a dash.
    const row = flagsRef.split('\n').find((l) => l.includes('--max-workers'));
    expect(row).toBeTruthy();
    const cells = row.split('|').map((c) => c.trim());
    expect(cells[6]).toBe('—');

    expect(changedDoc).not.toMatch(/--max-workers[\s\S]{0,80}behaves the same/i);
    expect(changedDoc).not.toMatch(/every `parallel` flag works the same way/i);
  });
});

// `changed` workflow contract parity -- aligns changed.md/flags-reference.md/README.md/
// unit-tests.md/no-changed-modules.md with the real, verified-correct runtime, and fully retires
// --max-failures (never implemented by parallel; was actively breaking every real invocation with
// a downstream unknown_flag CONFIG_ERROR after git detection had already run). Every assertion
// below is grounded either directly in the real parser (parseChangedArgs) or in specific, quoted
// prior false claims -- never whole-file substring/co-occurrence checks.
describe('changed workflow contract parity (doc/help alignment with verified runtime)', () => {
  const changedDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'workflows', 'changed.md'), 'utf8'
  );
  const flagsRefDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'cli', 'flags-reference.md'), 'utf8'
  );
  const noChangedModulesDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'troubleshooting', 'no-changed-modules.md'), 'utf8'
  );
  const unitTestsDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'workflows', 'unit-tests.md'), 'utf8'
  );
  const readmeDoc = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const cliSrc = readFileSync(path.join(REPO_ROOT, 'lib', 'cli.js'), 'utf8')
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const overviewDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'workflows', 'overview.md'), 'utf8'
  );
  const noTestModulesDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'troubleshooting', 'no-test-modules.md'), 'utf8'
  );
  const flavorUnusedDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'troubleshooting', 'flavor-unused.md'), 'utf8'
  );
  const taskNotFoundDoc = readFileSync(
    path.join(SKILL_DIR, 'references', 'troubleshooting', 'task-not-found.md'), 'utf8'
  );
  const changedOrchestratorSrc = readFileSync(
    path.join(REPO_ROOT, 'lib', 'orchestrators', 'changed-orchestrator.js'), 'utf8'
  ).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  it('--max-failures is fully retired from changed\'s parser -- valid, malformed, and dangling forms all converge on unknown_flag', () => {
    for (const args of [['--max-failures', '1'], ['--max-failures', 'abc'], ['--max-failures']]) {
      const opts = parseChangedArgs(args);
      expect(opts.errors).toContainEqual(
        expect.objectContaining({ code: 'unknown_flag', flag: '--max-failures' })
      );
    }
  });

  it('changed.md no longer documents --max-failures anywhere', () => {
    expect(changedDoc).not.toMatch(/--max-failures/);
  });

  it('flags-reference.md no longer has a --max-failures row', () => {
    expect(flagsRefDoc).not.toMatch(/--max-failures/);
  });

  it('changed.md states the real default detection mechanism (git status --porcelain), not "git diff" as the default', () => {
    const quickstart = changedDoc.split('\n').find((l) => l.startsWith('1. Runs'));
    expect(quickstart).toBeTruthy();
    expect(quickstart).toContain('git status --porcelain');
    expect(quickstart).not.toMatch(/git diff --name-only HEAD.*default/);
    expect(quickstart).not.toMatch(/plus `git status --porcelain` for untracked/);
  });

  it('changed.md coverage-tool default is auto, matching parallel -- no historical jacoco-divergence claim', () => {
    expect(changedDoc).not.toMatch(/jacoco \(default\)/);
    expect(changedDoc).not.toMatch(/historical reason/i);
    const row = changedDoc.split('\n').find((l) => l.includes('`--coverage-tool <tool>`'));
    expect(row).toBeTruthy();
    expect(row).toMatch(/\|\s*`auto`\s*\|/);
  });

  it('flags-reference.md coverage-tool row shows the same auto default for changed, not a divergent jacoco', () => {
    const row = flagsRefDoc.split('\n').find((l) => l.includes('--coverage-tool <tool>'));
    expect(row).toBeTruthy();
    // Cell 2 (0-indexed after split on '|': '', Flag, Default, ...) is the
    // Default column -- must be a single, undivided `auto`, not a per-subcommand
    // split ("auto (...), jacoco (changed)"). The Notes cell legitimately lists
    // `jacoco` as one of 4 valid enum VALUES, so a whole-row substring check
    // can't distinguish that from a false default-claim -- must isolate the cell.
    const cells = row.split('|').map((c) => c.trim());
    expect(cells[2]).toBe('`auto`');
  });

  it('changed.md rename handling: only the destination module survives, source is discarded -- not both', () => {
    expect(changedDoc).not.toMatch(/both.{0,40}(enter the changed set|feed the module-mapping step)/i);
    expect(changedDoc).toMatch(/only the destination (path|module)/i);
  });

  it('changed.md root-path handling: files matching no module are discarded outright, not mapped to a "root module"', () => {
    expect(changedDoc).not.toMatch(/maps? to (the )?root module/i);
    expect(changedDoc).toMatch(/no "root module" concept/i);
  });

  it('changed.md: dry-run always yields empty detected_modules regardless of other flags, not framed as a show-modules-only preview aid', () => {
    expect(changedDoc).not.toMatch(/Useful with `--show-modules-only` to see which modules WOULD run/);
    expect(changedDoc).toMatch(/regardless of any other flag.{0,40}--show-modules-only/i);
  });

  it('changed.md envelope shape: no phantom changed.files[]/changed.modules[] fields, only detected_modules', () => {
    expect(changedDoc).not.toMatch(/changed\.files\[\]/);
    expect(changedDoc).not.toMatch(/changed\.modules\[\]/);
  });

  it('changed.md: base_ref is always the literal "HEAD" in both modes, never described as becoming "the index"', () => {
    expect(changedDoc).not.toMatch(/the index for `--staged-only`/);
    expect(changedDoc).toMatch(/always the literal string `"HEAD"`/);
  });

  it('changed.md: no real envelope carries a top-level parallel:{} block, in the illustrative example or the prose', () => {
    expect(changedDoc).not.toMatch(/"parallel":\s*\{/);
    expect(changedDoc).not.toMatch(/envelope's `parallel:\{\}` block is present too/);
    expect(changedDoc).toMatch(/no top-level `parallel:\{\}` block/);
  });

  it('changed.md: detected_modules examples are bare/colon-less, never colon-prefixed', () => {
    expect(changedDoc).not.toMatch(/"name":\s*":/);
    expect(changedDoc).not.toMatch(/"detected_modules":\s*\[\s*":/);
    expect(changedDoc).not.toMatch(/:feature:auth:impl/);
    expect(changedDoc).toContain('feature:auth:impl');
  });

  it('changed.md: detached HEAD / zero commits are not framed as a git diff HEAD failure requiring a commit', () => {
    expect(changedDoc).not.toMatch(/`git diff HEAD` fails/);
    expect(changedDoc).not.toMatch(/Recovery: ensure the project has at least one commit/);
  });

  it('changed.md: the file-list recovery suggestion is mode-aware, not a blanket git diff --name-only HEAD', () => {
    expect(changedDoc).not.toMatch(/re-run `git diff --name-only HEAD` directly/);
    expect(changedDoc).toMatch(/git status --porcelain.{0,20}for the default mode/i);
  });

  it('unit-tests.md cross-link to changed.md does not name git-diff as the mechanism', () => {
    expect(unitTestsDoc).not.toMatch(/narrow-by-git-diff/);
  });

  it('no-changed-modules.md does not claim the subcommand "ran git diff" as its default mechanism', () => {
    expect(noChangedModulesDoc).not.toMatch(/ran `git diff` and found nothing/);
    expect(noChangedModulesDoc).not.toMatch(/re-running git diff against the same working tree/);
  });

  it('no-changed-modules.md no longer treats detached HEAD as a distinct root cause based on git diff HEAD', () => {
    expect(noChangedModulesDoc).not.toMatch(/`git diff HEAD` works but `HEAD` points to an unusual ref/);
  });

  it('README.md coverage-tool tables use the same auto default for changed as parallel/coverage, not a divergent jacoco', () => {
    const rows = readmeDoc.split('\n').filter((l) => l.includes('--coverage-tool') && l.includes('|'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toMatch(/jacoco.{0,20}changed/i);
    }
  });

  it('README.md --module-filter row does not claim it applies to changed', () => {
    // Second review round split this into a <glob> row (parallel/android/benchmark) and a
    // <regex> row (describe-only) -- the changed-exclusion clause now lives on the glob row.
    const row = readmeDoc.split('\n').find((l) => l.includes('--module-filter <glob>'));
    expect(row).toBeTruthy();
    const appliesToClause = row.match(/Applies to ([^(|]+)/);
    expect(appliesToClause).toBeTruthy();
    expect(appliesToClause[1]).not.toMatch(/`changed`/);
  });

  it('changed.md and no-changed-modules.md quote the real no_changed_modules message, not an invented one', () => {
    // Adversarial-review catch: the real message (changed-orchestrator.js:457) is
    // "No modules with uncommitted changes detected." -- both docs previously quoted
    // different, wrong strings ("Working tree clean...", "No changes detected since HEAD").
    const REAL_MESSAGE = 'No modules with uncommitted changes detected.';
    expect(changedDoc).toContain(REAL_MESSAGE);
    expect(noChangedModulesDoc).toContain(REAL_MESSAGE);
    expect(changedDoc).not.toMatch(/Working tree clean — no changed modules to test/);
    expect(noChangedModulesDoc).not.toMatch(/No changes detected since `HEAD`/);
  });

  it('changed.md distinguishes a root-level build.gradle.kts (discarded) from a module\'s own (maps to that module)', () => {
    // Adversarial-review catch: mapFileToModule matches any path under <module>/,
    // including that module's own build.gradle.kts -- only a ROOT-level one (no
    // enclosing module dir) is actually unmatched. The prior wording implied ALL
    // build.gradle.kts changes are discarded.
    expect(changedDoc).toMatch(/root-level.{0,20}build\.gradle\.kts/i);
    expect(changedDoc).toMatch(/module's \*own\*.{0,150}maps to `core:b`/i);
  });

  it('changed.md\'s --exclude-modules example uses a glob that actually matches the colon-separated module name it claims to drop', () => {
    // Adversarial-review catch (wet-verified): matchModuleFilter('core:network', 'core-*')
    // is false -- a hyphen-style glob cannot match a colon-separated name. The example
    // must use a glob shape that genuinely matches, and must say so explicitly.
    expect(changedDoc).not.toMatch(/--exclude-modules "core-\*"/);
    expect(changedDoc).toMatch(/--exclude-modules "core:\*"/);
    expect(changedDoc).toMatch(/will NOT match `core:network`/);
  });

  it('cli.js changed --help, README.md, and flags-reference.md all agree on auto as the coverage-tool default -- none announce --max-failures', () => {
    const changedHelpMatch = cliSrc.match(/changed: `[\s\S]*?`,\n  android:/);
    expect(changedHelpMatch).toBeTruthy();
    const changedHelp = changedHelpMatch[0];
    expect(changedHelp).not.toMatch(/--max-failures/);
    expect(changedHelp).toMatch(/--coverage-tool <tool>\s+auto \(default\)/);

    for (const doc of [readmeDoc, flagsRefDoc, changedDoc]) {
      expect(doc).not.toMatch(/--max-failures/);
    }
  });

  // Second review round (Codex audit of PR #415 @ 1f1bae9): --module-filter has two
  // genuinely incompatible contracts sharing one flag name -- parallel/android/benchmark
  // take a glob, describe takes a REAL regex (new RegExp(opts.moduleFilter) at
  // describe-orchestrator.js:254, with an invalid_regex error code on bad patterns).
  // README.md's single conflated row must become two, neither implying the other's syntax.
  it('README.md splits --module-filter into a glob row (parallel/android/benchmark) and a describe-only regex row, never conflating the two', () => {
    const globRow = readmeDoc.split('\n').find((l) => l.includes('--module-filter <glob>'));
    expect(globRow).toBeTruthy();
    expect(globRow).not.toMatch(/`describe`/);
    expect(globRow).toMatch(/`parallel`/);
    expect(globRow).toMatch(/`android`/);
    expect(globRow).toMatch(/`benchmark`/);

    const regexRow = readmeDoc.split('\n').find((l) => l.includes('--module-filter <regex>') && l.startsWith('|'));
    expect(regexRow).toBeTruthy();
    expect(regexRow).toMatch(/real regular expression/i);
    expect(regexRow).toMatch(/`describe`-only/);
  });

  it('README.md\'s describe section still documents --module-filter as a real regex (preserved, not collapsed into the glob row)', () => {
    const describeFlagsLine = readmeDoc.split('\n').find((l) => l.startsWith('Flags:') && l.includes('--module-filter'));
    expect(describeFlagsLine).toBeTruthy();
    expect(describeFlagsLine).toContain('--module-filter <regex>');
  });

  // The prior round left 3 residual "changed is based on git diff" claims outside the
  // originally-touched files, deliberately deferred as out-of-scope. This round's
  // instruction explicitly brought them in-scope (they'd otherwise get baked into a
  // future PINNED_SKILL_SHA snapshot) -- scoped, non-global assertions per claim site,
  // not a repo-wide substring sweep that could pass through unrelated "git diff" prose.
  it('SKILL.md\'s changed row no longer says "From git diff" in its Notes column', () => {
    const skillChangedRow = skillMd.split('\n').find((l) => l.includes('kmp-test changed --json --project-root .'));
    expect(skillChangedRow).toBeTruthy();
    expect(skillChangedRow).not.toMatch(/From git diff/);
    expect(skillChangedRow).toContain('Git-derived');
  });

  it('overview.md no longer names "git diff strategy" among the behaviors únicos it says each workflow doc covers', () => {
    expect(overviewDoc).not.toMatch(/git diff strategy/i);
  });

  it('changed-orchestrator.js\'s own JSDoc no longer describes its module set as "touched by `git diff`"', () => {
    expect(changedOrchestratorSrc).not.toMatch(/touched by `git diff`/);
  });

  // CodeRabbit review comment on PR #415: info only reports the detected coverage tool
  // (info-orchestrator.js never parses --coverage-tool at all), it doesn't accept or
  // resolve the flag -- listing it among subcommands that "share the auto default" implies
  // it does. Scoped to the specific "Same default across ..." clause, not the whole row,
  // since the row legitimately mentions `info` afterward to clarify the distinction.
  it('README.md does not list info among the subcommands sharing the auto --coverage-tool default', () => {
    const row = readmeDoc.split('\n').find((l) => l.startsWith('| `--coverage-tool`') && l.includes('Same default across'));
    expect(row).toBeTruthy();
    const sharingClause = row.match(/Same default across ([^—]+)—/);
    expect(sharingClause).toBeTruthy();
    expect(sharingClause[1]).not.toMatch(/info/);
    expect(row).toMatch(/`info` reports the detected tool but does not accept or resolve this flag/);
  });

  // Third review round (Codex audit of PR #415 @ fabfe97): the flags-reference table
  // split (glob row vs regex row) was correct, but several USAGE EXAMPLES still reused
  // a parallel-shaped glob as if it were valid describe regex syntax -- "core-*" as an
  // unanchored regex matches "coreFoo", ":core:network", ":feature:core-ui" (anything
  // containing "core" followed by zero-or-more literal hyphens), nothing like the glob's
  // anchored-prefix semantics, and the README example's own shown output (":sample-result")
  // doesn't even contain "core". Each fix is checked in its own file/line context, not a
  // repo-wide substring sweep that could pass through unrelated glob/regex prose.
  it('README.md\'s describe example uses a real, anchored regex that actually matches the module shown in its own output', () => {
    const exampleLine = readmeDoc.split('\n').find((l) => l.trim().startsWith('kmp-test describe --json --module-filter'));
    expect(exampleLine).toBeTruthy();
    expect(exampleLine).not.toContain('"core-*"');
    const match = exampleLine.match(/--module-filter "([^"]+)"/);
    expect(match).toBeTruthy();
    const pattern = match[1];
    // Fourth review round (Codex audit @ 9731cc2): a bare true/false pair on 2 handpicked
    // strings doesn't prove anchoring -- an UNANCHORED /sample-result/ would ALSO pass
    // (matches ':sample-result' via substring, doesn't match ':core-network' either way).
    // Check the anchors explicitly, then reject both an added prefix and an added suffix --
    // only a real ^...$ anchor does that.
    expect(pattern.startsWith('^')).toBe(true);
    expect(pattern.endsWith('$')).toBe(true);
    const regex = new RegExp(pattern);
    expect(regex.test(':sample-result')).toBe(true);
    expect(regex.test('x:sample-result')).toBe(false);
    expect(regex.test(':sample-result-extra')).toBe(false);
  });

  it('README.md\'s describe section is referenced as "below", matching its actual position in the file', () => {
    const regexRow = readmeDoc.split('\n').find((l) => l.includes('--module-filter <regex>') && l.startsWith('|'));
    expect(regexRow).toBeTruthy();
    expect(regexRow).toMatch(/describe.{0,10}section below/);
    expect(regexRow).not.toMatch(/describe.{0,10}section above/);
  });

  it('no-test-modules.md never recommends passing the same parallel glob pattern to describe, and explains describe takes a real regex', () => {
    expect(noTestModulesDoc).not.toMatch(/describe --json --module-filter <same-pattern>/);
    expect(noTestModulesDoc).not.toMatch(/describe --json --module-filter "<your-pattern>"/);
    expect(noTestModulesDoc).toMatch(/real regular expression/i);
    // parallel --list-only with the original glob stays the authoritative dispatch preview.
    expect(noTestModulesDoc).toMatch(/parallel --list-only --json --module-filter <same-pattern>/);
  });

  it('flavor-unused.md no longer passes "<your-filter>" from a parallel/android command straight into describe', () => {
    expect(flavorUnusedDoc).not.toMatch(/describe --json --module-filter "<your-filter>"/);
    expect(flavorUnusedDoc).toMatch(/separate|explicit regex|own.{0,10}regular expression/i);
  });

  // Fourth review round (Codex audit @ 9731cc2): even the ROUND-3 "translated" example
  // ("core-*" -> "^:core:.*$") was itself wrong -- wet-verified against the real matchers:
  // matchModuleFilter (glob, used by parallel/android/benchmark) tests the full name, the
  // colon-stripped name, AND the leaf segment after the last ':'; describe's regex tests only
  // the full name and the colon-stripped name. There is no pattern pair that is safe to present
  // as "equivalent" in general -- e.g. the same glob/regex pair the file used to show select
  // completely different, barely-overlapping module sets. No fix should ever claim mechanical
  // translation again; the safe default is describe with no filter + exact modules[].name pick.
  it('no-test-modules.md drops the false "core-*" -> "^:core:.*$" equivalence and makes no other glob<->regex translation claim', () => {
    expect(noTestModulesDoc).not.toMatch(/"core-\*".{0,40}"\^:core:\.\*\$"/);
    expect(noTestModulesDoc).not.toMatch(/translate the glob into an equivalent/i);
    expect(noTestModulesDoc).not.toMatch(/\bliteral-or-invalid\b/);
    expect(noTestModulesDoc).toMatch(/no general mechanical translation/i);
    expect(noTestModulesDoc).toMatch(/leaf segment/i);
  });

  it('no-test-modules.md\'s Recovery path numbers its caused_by_filter:true steps 1-4 without a duplicate', () => {
    const recoveryPath = noTestModulesDoc.split('## Recovery path')[1].split('## Recovery commands')[0];
    const section = recoveryPath.split('For `caused_by_filter: false`')[0];
    const numbered = [...section.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbered).toEqual([1, 2, 3, 4]);
  });

  it('task-not-found.md no longer passes an unescaped/unanchored module name straight into describe\'s regex filter', () => {
    expect(taskNotFoundDoc).not.toMatch(/describe --json --module-filter "<affected-module>"/);
    expect(taskNotFoundDoc).toMatch(/no filter/i);
    expect(taskNotFoundDoc).toMatch(/exact `name`|exact.{0,10}modules\[\]\.name/i);
  });

  it('overview.md no longer mixes languages in "behaviors únicos" -- pure English "unique behaviors"', () => {
    expect(overviewDoc).not.toMatch(/behaviors únicos/);
    expect(overviewDoc).toMatch(/unique behaviors/);
  });
});

// Round-5 addition: ground the dry-run-vs-real-run coverage verification split in the real
// orchestrator. Round 4's SKILL.md text said to verify --coverage-modules scope via
// coverage.module_buckets unconditionally -- but on --dry-run, module_buckets is ALWAYS the
// hardcoded-empty shape (no model build, no XML reads); the filter value only surfaces via
// plan.coverage_modules (unresolved -- it echoes the raw split value, not a validated module list).
describe('Coverage dry-run verification contract (grounds the dry-run-vs-real-run split in real behavior)', () => {
  it('--dry-run echoes the filter into plan.coverage_modules but leaves module_buckets empty', async () => {
    const { envelope, exitCode } = await runCoverage({
      projectRoot: REPO_ROOT,
      args: ['--dry-run', '--coverage-modules', 'app'],
    });
    expect(exitCode).toBe(0);
    expect(envelope.dry_run).toBe(true);
    expect(envelope.plan.coverage_modules).toEqual(['app']);
    expect(envelope.coverage.module_buckets).toEqual({
      with_data: [],
      no_xml: [],
      parse_errored: [],
      skipped_by_user: [],
    });
  });
});

// PR fix(skill): route test coverage gates through parallel -- closes BACKLOG's two
// PR #412 follow-up blockers. Bare "run coverage" never runs tests (coverage-orchestrator.js
// only reads existing XML); a request combining "run/verify tests" with "apply a coverage
// budget" must route to `parallel`, and "with coverage" must never resolve ambiguously to the
// coverage-only path. Row/clause-scoped (not whole-file co-occurrence): a test that only checked
// both `parallel` and `--min-missed-lines` appear anywhere in SKILL.md would also pass if they
// were merely mentioned in unrelated places (e.g. Decision protocol already neighbors `parallel`
// and `--module-filter`), which wouldn't prove the routing table itself was fixed. Locks the
// final 3-way contract precisely: explicit "run tests with coverage" dispatches plain parallel
// (no fabricated --min-missed-lines default); an explicit tests+budget ask ("run tests; missed
// lines under N") dispatches parallel --min-missed-lines; and a context-free "with coverage"
// alone, with no stated test-execution intent, stays ambiguous and must ask -- it is never
// silently routed to either command.
describe('Steps table -- tests+coverage-budget routing (grounds the BACKLOG "skill routing gap" fix)', () => {
  const steps = section('Steps');
  const coverageDoc = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'coverage.md'), 'utf8');

  function findRowContaining(tableText, phrase) {
    return tableText.split('\n').find((l) => l.startsWith('|') && l.includes(phrase));
  }

  it('the "run tests with coverage" row dispatches plain parallel, no fabricated --min-missed-lines', () => {
    const row = findRowContaining(steps, 'run tests with coverage');
    expect(row).toBeTruthy();
    expect(row).toContain('kmp-test parallel --json --project-root .');
    expect(row).not.toContain('--min-missed-lines');
  });

  // Locks the exact mistake caught in review: a context-free "with coverage" (no "run tests"
  // prefix) must stay covered by the Decision protocol's existing, untouched "if ambiguous, ask
  // before running" rule -- not get silently routed as if it were unambiguous on its own.
  it('bare "with coverage" never appears as its own isolated quoted trigger phrase', () => {
    expect(steps).not.toContain('"with coverage"');
  });

  // CodeRabbit (PR #413, SKILL.md:115, Major): a bare "missed lines under 100" ask does not
  // itself say tests must run -- it could mean "check the threshold against whatever coverage
  // XML already exists", which belongs to `coverage --min-missed-lines` (grounded above), not
  // `parallel`. The row must carry explicit test-execution intent, not just "missed lines".
  it('a separate row exists for an explicit missed-lines budget, carrying explicit test-execution intent (not just "missed lines" co-occurrence) and linking parallel + --min-missed-lines in the SAME row', () => {
    const row = findRowContaining(steps, 'missed lines');
    expect(row).toBeTruthy();
    expect(row.toLowerCase()).toMatch(/run tests|test this/);
    expect(row).toContain('parallel');
    expect(row).toContain('--min-missed-lines');
    expect(row).toContain('kmp-test parallel --min-missed-lines 100 --json --project-root .');
  });

  it('the bare "run coverage" row stays separate -- no "with coverage", no parallel, no --min-missed-lines', () => {
    const row = findRowContaining(steps, '"run coverage"');
    expect(row).toBeTruthy();
    expect(row).not.toContain('with coverage');
    expect(row).toContain('kmp-test coverage --json --project-root .');
    expect(row).not.toContain('parallel');
    expect(row).not.toContain('--min-missed-lines');
  });

  it('coverage.md still documents applying a threshold to EXISTING coverage without new tests (the 4th matrix cell, deliberately kept out of SKILL.md\'s compact table)', () => {
    expect(coverageDoc).toMatch(/didn.t drop below X missed lines/i);
    expect(coverageDoc).toContain('--min-missed-lines');
  });

  // Closes the coverage-threshold-failure 1/2 gap (tools/runs/agentic-eval-full-corpus-final-
  // canary-v3-2026-08-11.md), investigated via a scoped, sanitized raw-transcript inspection
  // (chain-of-custody preserved -- see BACKLOG.md). Observed execution mechanism, not a claim
  // about the model's internal reasoning: BOTH the failed and control current-skill runs tried
  // `kmp-test coverage` first, denied because `coverage` is not in this scenario's
  // allowed_kmptest_subcommands (only doctor/describe/parallel) -- that allowlist check is the
  // direct technical cause of the denial; "no test run has happened yet" is the scenario design's
  // rationale for that allowlist, not the mechanism the policy hook evaluates. After the denial,
  // the failed run fell back to a flag-less `parallel` (never checked the threshold at all:
  // terminal envelope exit_code:0, errors:[], coverage.min_missed_lines:null) while the control
  // run self-corrected to `parallel --min-missed-lines 15`. Confirmed documentation gap, plausible
  // contributor (not demonstrated causality): coverage.md's own trigger bullet above is a genuine,
  // intentional 4th matrix cell (existing-reports-only gating) but didn't exclude the case where
  // tests must run fresh first -- exactly this scenario's shape ("confirm unit tests pass, AND
  // check coverage") -- consistent with, not proof of, why both runs reached for `coverage`
  // first. Scoped to that same bullet's own line so this can't just match a disambiguation
  // appearing anywhere else in the file.
  it('the existing-coverage-only trigger explicitly excludes the fresh-test-run case, pointing at parallel instead', () => {
    const lines = coverageDoc.split('\n');
    const triggerLineIdx = lines.findIndex((l) => /didn.t drop below X missed lines/i.test(l));
    expect(triggerLineIdx).toBeGreaterThan(-1);
    const triggerClause = lines.slice(triggerLineIdx, triggerLineIdx + 3).join(' ');
    expect(triggerClause).toMatch(/already exist|no fresh test run|existing report/i);
    expect(triggerClause).toMatch(/parallel --min-missed-lines/i);
  });
});

// Closes the other PR #412 follow-up blocker: coverage.md:49 correctly says a 0 threshold
// disables the gate; :95 of the same file and coverage-threshold-exceeded.md:35 both incorrectly
// claimed 0 requires perfect coverage. Detector proven synthetically against the verbatim
// pre-fix sentences (and against correct phrasing that must NOT match) before being applied for
// real, so its discriminating power doesn't depend on what the files currently say.
describe('--min-missed-lines 0 semantics -- "disables the gate", never "perfect coverage" (grounds doc coherence in the real gate)', () => {
  function claimsZeroRequiresPerfectCoverage(text) {
    return /(?:`?0`?|zero)[^.\n]{0,40}(?:means|requires?)[^.\n]{0,40}(?:perfect|100%|zero.missed)[^.\n]{0,20}coverage/i.test(text);
  }

  it('[detector] catches the verbatim pre-fix coverage.md:95 sentence', () => {
    const old95 = '`0` means "perfect coverage required" — usually too strict; set realistic thresholds.';
    expect(claimsZeroRequiresPerfectCoverage(old95)).toBe(true);
  });

  it('[detector] catches the verbatim pre-fix coverage-threshold-exceeded.md:35 sentence', () => {
    const old35 = 'zero missed lines means 100% coverage required. Almost never achievable on real projects.';
    expect(claimsZeroRequiresPerfectCoverage(old35)).toBe(true);
  });

  it('[detector] does not flag the real correct flags-reference.md phrasing', () => {
    const good = 'Fail (`coverage_threshold_exceeded`, exit 1) if aggregated missed lines exceed `N`. `0` = no gate.';
    expect(claimsZeroRequiresPerfectCoverage(good)).toBe(false);
  });

  it('[detector] does not flag a sentence that correctly says 0 disables the gate', () => {
    const good2 = '`0` disables the gate entirely, regardless of how many lines are missed.';
    expect(claimsZeroRequiresPerfectCoverage(good2)).toBe(false);
  });

  const coverageDoc = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'coverage.md'), 'utf8');
  const thresholdDoc = readFileSync(path.join(SKILL_DIR, 'references', 'troubleshooting', 'coverage-threshold-exceeded.md'), 'utf8');
  const unitTestsDoc = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'unit-tests.md'), 'utf8');
  const flagsRefDoc = readFileSync(path.join(SKILL_DIR, 'references', 'cli', 'flags-reference.md'), 'utf8');

  it('coverage.md is clean of the false claim after the fix', () => {
    expect(claimsZeroRequiresPerfectCoverage(coverageDoc)).toBe(false);
  });

  it('coverage-threshold-exceeded.md is clean of the false claim after the fix', () => {
    expect(claimsZeroRequiresPerfectCoverage(thresholdDoc)).toBe(false);
  });

  it('unit-tests.md is clean of the false claim (non-regression)', () => {
    expect(claimsZeroRequiresPerfectCoverage(unitTestsDoc)).toBe(false);
  });

  it('flags-reference.md is already clean of the false claim (non-regression on an unedited file)', () => {
    expect(claimsZeroRequiresPerfectCoverage(flagsRefDoc)).toBe(false);
  });

  it('coverage.md positively states 0 disables/is no gate', () => {
    expect(coverageDoc).toMatch(/no gate|don.t gate|disables? the gate/i);
  });

  it('flags-reference.md positively states 0 = no gate', () => {
    expect(flagsRefDoc).toMatch(/no gate|don.t gate|disables? the gate/i);
  });

  it('coverage-threshold-exceeded.md positively states 0 disables the gate after the fix', () => {
    expect(thresholdDoc).toMatch(/no gate|don.t gate|disables? the gate/i);
  });

  it('unit-tests.md positively states 0 = no gate after the fix', () => {
    expect(unitTestsDoc).toMatch(/no gate|don.t gate|disables? the gate/i);
  });
});

// CodeRabbit (PR #413, coverage.md:100, Major -- see the real-execution grounding test in the
// fixture describe block above): "complete, unfiltered project total" is misleading -- the
// aggregate is scoped to whichever modules --coverage-modules/--exclude-coverage selected for
// this run; --min-missed-lines is what never filters WITHIN that already-selected set. Detector
// proven synthetically against the verbatim pre-fix sentences before being applied for real.
describe('coverage.missed_lines is scoped to selected modules, never claimed as an unqualified "project total" (grounds doc coherence in the real dispatched-module filter)', () => {
  function claimsUnqualifiedProjectTotal(text) {
    return /\bcomplete,?\s*(?:\*\*)?unfiltered(?:\*\*)?\s*project total\b/i.test(text);
  }

  it('[detector] catches the verbatim pre-fix coverage-threshold-exceeded.md:27 sentence', () => {
    const old27 = 'is always the **complete, unfiltered** project total — `--min-missed-lines` never removes coverage data.';
    expect(claimsUnqualifiedProjectTotal(old27)).toBe(true);
  });

  it('[detector] catches the verbatim pre-fix envelope-schema.md:19 sentence', () => {
    const old19 = '`missed_lines` / `modules_contributing` are always the complete, unfiltered project total.';
    expect(claimsUnqualifiedProjectTotal(old19)).toBe(true);
  });

  it('[detector] does not flag a sentence correctly scoping the total to selected modules', () => {
    const good = 'the aggregate across the modules selected by `--coverage-modules` / `--exclude-coverage`; `--min-missed-lines` never narrows that selected aggregate.';
    expect(claimsUnqualifiedProjectTotal(good)).toBe(false);
  });

  const coverageDoc2 = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'coverage.md'), 'utf8');
  const thresholdDoc2 = readFileSync(path.join(SKILL_DIR, 'references', 'troubleshooting', 'coverage-threshold-exceeded.md'), 'utf8');
  const envelopeSchemaDoc = readFileSync(path.join(SKILL_DIR, 'references', 'cli', 'envelope-schema.md'), 'utf8');

  it('coverage.md is clean of the unqualified "project total" claim after the fix', () => {
    expect(claimsUnqualifiedProjectTotal(coverageDoc2)).toBe(false);
  });

  it('coverage-threshold-exceeded.md is clean of the unqualified "project total" claim after the fix', () => {
    expect(claimsUnqualifiedProjectTotal(thresholdDoc2)).toBe(false);
  });

  it('envelope-schema.md is clean of the unqualified "project total" claim after the fix (both occurrences)', () => {
    expect(claimsUnqualifiedProjectTotal(envelopeSchemaDoc)).toBe(false);
  });

  it('coverage.md positively scopes the aggregate to selected/dispatched modules', () => {
    expect(coverageDoc2.toLowerCase()).toMatch(/selected by.*--coverage-modules|--coverage-modules.*selected/);
  });
});

// CodeRabbit (PR #413, thread on skill-canonical-workflow.test.js's own README-mirroring review):
// coverage.md:31 conflated two distinct caches -- runCoverage() passes useCache:false, which
// bypasses the WHOLE project-model cache (forces a fresh analyzeModule pass); only the NESTED
// gradle-tasks discovery probe (inside buildProjectModel) has its own separate cache FILE, and it
// only spawns `gradlew tasks --all --quiet` on a miss of THAT cache.
describe('coverage.md Quickstart correctly distinguishes the two caches (grounds the useCache:false claim in the real call site)', () => {
  it('coverage.md does not claim the project-model cache is used (that cache is explicitly bypassed)', () => {
    const coverageDoc3 = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'coverage.md'), 'utf8');
    expect(coverageDoc3).not.toMatch(/uses the project model cache/i);
  });

  it('coverage.md mentions the nested tasks-probe cache is a SEPARATE cache from the project model', () => {
    const coverageDoc3 = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'coverage.md'), 'utf8');
    expect(coverageDoc3.toLowerCase()).toMatch(/separate cache|own.*cache|nested.*cache/);
  });

  it('grounds useCache:false in the real call site (coverage-orchestrator.js)', () => {
    const orchestratorSrc = readFileSync(
      path.join(REPO_ROOT, 'lib', 'orchestrators', 'coverage-orchestrator.js'), 'utf8'
    );
    expect(orchestratorSrc).toMatch(/useCache:\s*false/);
  });
});

// A second adversarial review round caught that "coverage never spawns gradle" is ITSELF false --
// runCoverage() -> buildProjectModel({skipProbe:false}) -> probeGradleTasksCached() -> (on a real
// cache miss) spawnGradle('gradlew tasks --all --quiet') is a real, verified call chain
// (coverage-orchestrator.js:618 -> lib/project-model.js:273 -> lib/project/cache.js:295-321).
// Do NOT assert anything about the absence of a node:child_process import -- that only proves
// THIS file has no direct spawn call, not that the transitive chain never spawns anything. The
// real, narrower contract: coverage never dispatches report-generation (koverXmlReport /
// jacocoTestReport) or test tasks, and structurally cannot produce task_not_found (it never calls
// applyErrorCodeDiscriminators, the only function in the codebase that emits that code). These
// tests detect the specific false claim via prose pattern, then ground the real, narrower
// contract via actual runCoverage() execution -- not an import check.
describe('Coverage report-generation-dispatch claim -- detector proven synthetically, then checked for real', () => {
  function claimsCoverageDispatchesReportTasks(text) {
    return /falls?\s+back\s+to\s+running|triggers?\s+`?kover|shape of the gradle invocation|forces?\s+kover\s+dispatch|`?kover(?:XmlReport|HtmlReport)`?\s+task\s+per\s+module|`?jacocoTestReport`?\s+task\s+per\s+module/i.test(text);
  }

  it('[detector] catches the verbatim pre-fix coverage.md:37 sentence', () => {
    const old37 = 'The shape of the gradle invocation is `./gradlew :<mod>:koverXmlReport :<mod>:koverHtmlReport` (or the jacoco equivalent) per module — no test tasks.';
    expect(claimsCoverageDispatchesReportTasks(old37)).toBe(true);
  });

  it('[detector] catches the verbatim pre-fix coverage.md:89 sentence', () => {
    const old89 = 'the orchestrator falls back to running `koverXmlReport` / `jacocoTestReport` gradle tasks first.';
    expect(claimsCoverageDispatchesReportTasks(old89)).toBe(true);
  });

  it('[detector] catches the verbatim pre-fix coverage.md:94 sentence', () => {
    const old94 = "forces Kover dispatch on modules that don't apply Kover → cascade of `task_not_found` per module.";
    expect(claimsCoverageDispatchesReportTasks(old94)).toBe(true);
  });

  it('[detector] catches the verbatim pre-fix coverage.md:76-77 sentences', () => {
    const old76 = 'Kover modules → `koverXmlReport` task per module.';
    expect(claimsCoverageDispatchesReportTasks(old76)).toBe(true);
  });

  it('[detector] does not flag the corrected phrasing', () => {
    const good = 'coverage never dispatches per-module report-generation tasks; it only reads whatever XML already exists on disk. It never generates or regenerates coverage XML.';
    expect(claimsCoverageDispatchesReportTasks(good)).toBe(false);
  });

  it('coverage.md is clean of the false gradle-dispatch claim after the fix', () => {
    const coverageDoc = readFileSync(path.join(SKILL_DIR, 'references', 'workflows', 'coverage.md'), 'utf8');
    expect(claimsCoverageDispatchesReportTasks(coverageDoc)).toBe(false);
  });
});

// Grounds the "never dispatches report tasks" / "0 doesn't gate" contracts in the REAL
// runCoverage() export via actual fixtures -- not doc prose. Mirrors the makeProject /
// makeParseCoverageStub / dropFakeXml fixture shape already established in
// tests/vitest/coverage-orchestrator.test.js (real settings.gradle.kts + build.gradle.kts +
// gradlew/gradlew.bat so buildProjectModel genuinely discovers/classifies modules, not mocked).
describe('Coverage gradle-dispatch + threshold grounding contracts (real runCoverage() fixtures)', () => {
  let projectRoot;

  afterEach(() => {
    if (projectRoot && existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = null;
  });

  function makeCoverageFixture(modules) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-coverage-grounding-'));
    projectRoot = dir;
    const includes = modules.map((m) => `include(":${m.name}")`).join('\n');
    writeFileSync(path.join(dir, 'settings.gradle.kts'), `rootProject.name = "fixture"\n${includes}\n`);
    writeFileSync(path.join(dir, 'gradlew'), '#!/usr/bin/env bash\nexit 0\n');
    writeFileSync(path.join(dir, 'gradlew.bat'), '@echo off\r\nexit /b 0\r\n');
    for (const mod of modules) {
      const modDir = path.join(dir, ...mod.name.split(':'));
      mkdirSync(modDir, { recursive: true });
      const plugins =
        mod.coverage === 'kover' ? 'plugins {\n  id("org.jetbrains.kotlinx.kover")\n  kotlin("jvm")\n}\n'
        : mod.coverage === 'jacoco' ? 'plugins {\n  jacoco\n  kotlin("jvm")\n}\n'
        : 'plugins {\n  kotlin("jvm")\n}\n';
      writeFileSync(path.join(modDir, 'build.gradle.kts'), plugins);
    }
    return dir;
  }

  function dropFakeCoverageXml(root, moduleName, tool) {
    const modDir = path.join(root, ...moduleName.split(':'));
    const xmlDir = tool === 'kover'
      ? path.join(modDir, 'build', 'reports', 'kover')
      : path.join(modDir, 'build', 'reports', 'jacoco');
    const xmlFile = tool === 'kover' ? path.join(xmlDir, 'report.xml') : path.join(xmlDir, 'jacocoTestReport.xml');
    mkdirSync(xmlDir, { recursive: true });
    writeFileSync(xmlFile, '<report></report>');
  }

  function makeParseCoverageXmlStub(rowsByModule = {}) {
    return (xmlPath, moduleName) => ({ rows: rowsByModule[moduleName] ?? [], errored: false, reason: 'ok', message: null });
  }

  // CodeRabbit nitpick (PR #413, test.js:401-405): the outcome-only assertion below would still
  // pass if a future regression dispatched jacocoTestReport and merely produced no XML. Strengthened
  // to make the fixture's gradlew/gradlew.bat RECORD every invocation's arguments, then assert none
  // of them name a report-generation or test task -- only the documented `tasks --all --quiet`
  // discovery probe is permitted. The log file is expected to exist (a fresh mkdtempSync fixture has
  // no `.kmp-test-runner-cache/`, so the nested tasks-probe is a guaranteed cache miss and genuinely
  // spawns gradlew) -- proving the probe actually ran, not that this test vacuously passed because
  // nothing was invoked at all.
  it('missing XML lands in module_buckets.no_xml -- and the fixture gradlew proves no report-generation or test task was ever dispatched (only the documented discovery probe)', async () => {
    const root = makeCoverageFixture([{ name: 'j-bare', coverage: 'jacoco' }]);
    const logPath = path.join(root, 'gradlew-invocations.log');
    const posixGradlew = path.join(root, 'gradlew');
    writeFileSync(posixGradlew, '#!/usr/bin/env bash\necho "$@" >> "$(dirname "$0")/gradlew-invocations.log"\nexit 0\n');
    // writeFileSync alone leaves the default (non-executable) mode on POSIX -- spawnGradle's
    // non-Windows branch spawns this path directly (no shell), so without +x the spawn fails with
    // EACCES, probeGradleTasksCached swallows it as `result.error` and returns null, and the log
    // below is never created. Caught by real Linux CI (Ubuntu), not by Windows-only local runs --
    // Windows doesn't gate execution on a POSIX mode bit, so this only reproduces on POSIX.
    chmodSync(posixGradlew, 0o755);
    writeFileSync(path.join(root, 'gradlew.bat'), '@echo off\r\necho %* >> "%~dp0gradlew-invocations.log"\r\nexit /b 0\r\n');

    const { envelope } = await runCoverage({ projectRoot: root, args: [], parseCoverageXml: makeParseCoverageXmlStub() });
    expect(envelope.coverage.module_buckets.no_xml).toContain('j-bare');

    expect(existsSync(logPath)).toBe(true);
    const invocations = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    expect(invocations.length).toBeGreaterThan(0);
    // Exact token-array equality, not a "forbidden names absent" check: a substring/exact-bare-name
    // check would miss a qualified regression like `:j-bare:jacocoTestReport`, since that token
    // never equals the bare name `jacocoTestReport`. The documented probe's args are exactly
    // `tasks --all --quiet` (spawnGradle may additionally inject `--console=plain` when stdout
    // isn't a TTY, e.g. under vitest -- stripped here since it's orthogonal to what this test
    // verifies, not part of the permitted-command claim).
    for (const line of invocations) {
      const tokens = line.trim().split(/\s+/).filter((t) => !t.startsWith('--console'));
      expect(tokens).toEqual(['tasks', '--all', '--quiet']);
    }
  });

  // This is the test that would have caught the original coverage.md:94 / :143 false claim,
  // grounded in actual execution rather than doc-reading: forcing the wrong --coverage-tool does
  // NOT cause task_not_found (coverage never dispatches a named gradle task at all) -- it just
  // means the forced tool's XML-path shape isn't found on disk, landing the module in no_xml.
  it('--coverage-tool kover forced on a JaCoCo-only module (real JaCoCo XML present): lands in no_xml, never task_not_found', async () => {
    const root = makeCoverageFixture([{ name: 'j-real', coverage: 'jacoco' }]);
    dropFakeCoverageXml(root, 'j-real', 'jacoco');
    const { envelope } = await runCoverage({
      projectRoot: root,
      args: ['--coverage-tool', 'kover'],
      parseCoverageXml: makeParseCoverageXmlStub(),
    });
    expect(envelope.coverage.module_buckets.no_xml).toContain('j-real');
    expect(envelope.errors.find((e) => e.code === 'task_not_found')).toBeFalsy();
  });

  it('--min-missed-lines 0 against a fixture with real missed lines does not fire coverage_threshold_exceeded', async () => {
    const root = makeCoverageFixture([{ name: 'lib-with-gaps', coverage: 'kover' }]);
    dropFakeCoverageXml(root, 'lib-with-gaps', 'kover');
    const { envelope, exitCode } = await runCoverage({
      projectRoot: root,
      args: ['--min-missed-lines', '0'],
      parseCoverageXml: makeParseCoverageXmlStub({
        'lib-with-gaps': ['lib-with-gaps|pkg|Big.kt|Big|0|100|100|0|1-100'],
      }),
    });
    expect(envelope.coverage.missed_lines).toBe(100);
    expect(exitCode).toBe(0);
    expect(envelope.errors.find((e) => e.code === 'coverage_threshold_exceeded')).toBeFalsy();
  });

  // CodeRabbit (PR #413, coverage.md:100, Major): coverage.missed_lines is NOT "the complete,
  // unfiltered project total" -- discoverCoverageModules() filters to `dispatched` BEFORE any XML
  // is read (coverage-orchestrator.js: the aggregation loop iterates `for (const m of dispatched)`
  // only), so --coverage-modules/--exclude-coverage genuinely change what's in the aggregate.
  // --min-missed-lines itself never filters WITHIN that already-selected set -- a materially
  // different, narrower claim than "unfiltered project total". Grounded here via the real
  // runCoverage(), not doc prose: excluding one of two modules must change both the total AND
  // the threshold decision. This grounds unchanged production code (module selection already
  // worked this way) -- pass-both-sides, not a RED-before/GREEN-after production bug fixture.
  it('excluding one of two modules changes both the aggregate total and the threshold decision (coverage.missed_lines is scoped to the selected/dispatched modules, not "the whole project")', async () => {
    const root = makeCoverageFixture([
      { name: 'mod-a', coverage: 'kover' },
      { name: 'mod-b', coverage: 'kover' },
    ]);
    dropFakeCoverageXml(root, 'mod-a', 'kover');
    dropFakeCoverageXml(root, 'mod-b', 'kover');
    const stub = makeParseCoverageXmlStub({
      'mod-a': ['mod-a|pkg|A.kt|A|0|30|30|0|1-30'],
      'mod-b': ['mod-b|pkg|B.kt|B|0|80|80|0|1-80'],
    });

    const both = await runCoverage({ projectRoot: root, args: ['--min-missed-lines', '100'], parseCoverageXml: stub });
    expect(both.envelope.coverage.missed_lines).toBe(110);
    expect(both.exitCode).toBe(1);
    expect(both.envelope.errors.find((e) => e.code === 'coverage_threshold_exceeded')).toBeTruthy();

    const excluded = await runCoverage({
      projectRoot: root,
      args: ['--min-missed-lines', '100', '--exclude-coverage', 'mod-b'],
      parseCoverageXml: stub,
    });
    expect(excluded.envelope.coverage.missed_lines).toBe(30);
    expect(excluded.exitCode).toBe(0);
    expect(excluded.envelope.errors.find((e) => e.code === 'coverage_threshold_exceeded')).toBeFalsy();
  });
});

// Anchors the routing contract in the real parsers (not doc-reading): both subcommands the
// routing table dispatches to must actually accept --min-missed-lines.
describe('--min-missed-lines flag support on both real parsers (anchors the routing contract in actual parseArgs)', () => {
  it('coverage-orchestrator.js parseArgs accepts --min-missed-lines', () => {
    const opts = parseCoverageArgs(['--min-missed-lines', '100']);
    expect(opts.minMissedLines).toBe(100);
  });

  it('parallel-orchestrator.js parseArgs (re-exported from parallel/dispatch.js) accepts --min-missed-lines', () => {
    const opts = parseParallelArgs(['--min-missed-lines', '100']);
    expect(opts.minMissedLines).toBe(100);
  });
});

// Guards against the failure mode explicitly ruled out for this fix: a second "routing" section,
// or a duplicated Decision protocol, sneaking in alongside the Steps-table fix.
describe('No second routing section / no duplicated Decision protocol (guards the SKILL.md fix does not fork routing guidance)', () => {
  it('"## Decision protocol" occurs exactly once', () => {
    expect(skillMd.split('## Decision protocol').length - 1).toBe(1);
  });

  it('"## Steps" occurs exactly once (the ONE Steps-table home for routing rules)', () => {
    expect(skillMd.split('## Steps').length - 1).toBe(1);
  });

  it('no second "routing" heading was introduced', () => {
    const headings = [...skillMd.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings.filter((h) => /routing/i.test(h))).toEqual([]);
  });
});

// CodeRabbit round (PR #395, HEAD 46ea8c9): grounds the Verification section's gradle_timeout
// soft-code claim in the real envelope builder rather than documenting it from memory.
// SOFT_ERROR_CODES proves gradle_timeout is genuinely treated as soft (WS-5 does not promote it);
// ENV_ERROR_CODES proves it is otherwise a hard environment error -- together they prove the real
// contract is a benchmark-partial-timeout EXCEPTION, not a universally-safe code.
describe('gradle_timeout soft-code contract (grounds SKILL.md Verification claim in the real envelope builder)', () => {
  it('gradle_timeout is a genuine SOFT_ERROR_CODES member, alongside no_summary and no_changed_modules', () => {
    expect(SOFT_ERROR_CODES.has('gradle_timeout')).toBe(true);
    expect(SOFT_ERROR_CODES.has('no_summary')).toBe(true);
    expect(SOFT_ERROR_CODES.has('no_changed_modules')).toBe(true);
  });

  it('gradle_timeout is otherwise ENV_ERROR-classified -- soft only as the benchmark partial-timeout exception', () => {
    expect(ENV_ERROR_CODES.has('gradle_timeout')).toBe(true);
  });
});

describe('Decision protocol -- single canonical entry point, first in the document', () => {
  it('is the first ## heading in the document (not a fourth layer alongside old ones)', () => {
    const headings = [...skillMd.matchAll(/^## (.+)$/gm)];
    expect(headings.length).toBeGreaterThan(0);
    expect(headings[0][1]).toBe('Decision protocol');
  });

  // Computed lazily in beforeAll (not at describe-body scope like the other sections below) --
  // unlike those, this heading is genuinely absent pre-fix, and section() throws synchronously
  // when a heading is missing. Throwing during describe-body collection would abort collecting
  // the *entire file*, hiding every other describe block's real pass/fail state; throwing inside
  // beforeAll only fails this block's own tests, leaving the rest of the file to run normally.
  let protocol;
  beforeAll(() => {
    protocol = section('Decision protocol');
  });

  it('shows the canonical command for the no-module-known case', () => {
    expect(protocol).toContain('kmp-test parallel --json --project-root .');
  });

  it('doctor appears exactly once, only in a conditionally-framed context (exit_code 3)', () => {
    const occurrences = protocol.split('kmp-test doctor').length - 1;
    expect(occurrences).toBe(1);
    const idx = protocol.indexOf('kmp-test doctor');
    const window = protocol.slice(Math.max(0, idx - 150), idx + 150);
    expect(window).toMatch(/exit_code/);
    expect(window).toMatch(/\b3\b/);
  });

  // Round-2 addition: workflow resolution (parallel/android/coverage/benchmark/changed) and
  // module resolution are two DIFFERENT decisions. `describe` discovers modules and their tasks;
  // it never decides which workflow the user wants. Scoped to step 1's own text so this doesn't
  // just match the word "workflow" appearing anywhere else in the section.
  it('step: resolves the workflow first; describe does not decide it; asks if ambiguous', () => {
    const start = protocol.indexOf('Resolve the workflow first');
    const end = protocol.indexOf('**Classify scope**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step1 = protocol.slice(start, end);
    expect(step1.toLowerCase()).toMatch(/does not decide/);
    expect(step1.toLowerCase()).toMatch(/ambiguous/);
    expect(step1.toLowerCase()).toMatch(/\bask\b/);
  });

  // Closes the changed-module-verification 0/2 gap (tools/runs/agentic-eval-full-corpus-final-
  // canary-v3-2026-08-11.md): both current-skill cells' committed audit sidecars show every
  // kmp-test call as operation "parallel"/"describe"/null -- never "changed" -- despite `changed`
  // being policy-legal both times. The scenario's prompt never says "changed"/"edited"/"my
  // changes"; it's phrased as an unnamed target implied only by an existing local/uncommitted
  // edit, a case step 1 previously had no rule for. Scoped to step 1's own span (same anchors as
  // the test above) so this can't just match the word "changed" appearing anywhere else in the
  // section, and so it structurally proves the rule is resolved as a WORKFLOW choice in step 1,
  // before scope is ever classified in step 2.
  it('step: resolves an unnamed, edit-implied target to the changed workflow, before scope is classified', () => {
    const start = protocol.indexOf('Resolve the workflow first');
    const end = protocol.indexOf('**Classify scope**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step1 = protocol.slice(start, end);
    expect(step1).toMatch(/unnamed target/i);
    expect(step1).toMatch(/uncommitted|local[\s-]change/i);
    expect(step1).toMatch(/workflow is `changed`/i);
  });

  // Schema-v5 canary forensic fact #1/#2 (tools/runs/agentic-eval-evidence-driven-scope-canary-
  // 2026-07-26.md): the skill was invoked first in only 1/4 current-skill cells (the other 3
  // spent 3-4 denied Bash probes before invocation), and a separate cell landed on a wrong,
  // conventionally-named module despite correct describe evidence. This state machine makes scope
  // classification its own explicit step, BEFORE any of the four dispatch branches, and states the
  // naming-vs-capability principle once with a concrete worked example rather than repeating it.
  it('step: classify names all four scope categories', () => {
    const start = protocol.indexOf('**Classify scope**');
    const end = protocol.indexOf('**Broad**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step2 = protocol.slice(start, end);
    expect(step2).toMatch(/\bbroad\b/i);
    expect(step2).toMatch(/exact module/i);
    expect(step2).toMatch(/test-capability target/i);
    expect(step2).toMatch(/likely-no-tests target/i);
  });

  // Generic worked example locking task evidence over module naming/type -- the exact failure
  // shape the runbook and forensic finding #2 both name: an Android-named module with a null unit
  // task field must lose to a differently-named KMP module whose own field is populated.
  it('step: classify locks task evidence over naming/platform wording with a generic worked example', () => {
    const start = protocol.indexOf('**Classify scope**');
    const end = protocol.indexOf('**Broad**');
    const step2 = protocol.slice(start, end);
    expect(step2.toLowerCase()).toMatch(/never settles task capability/);
    expect(step2).toMatch(/android-named module/i);
    expect(step2).toContain('test_tasks.unit: null');
    expect(step2).toMatch(/differently-named KMP module/i);
    expect(step2).toContain('"testAndroidHostTest"');
  });

  it('step: broad scope with no specific module dispatches globally', () => {
    expect(protocol).toMatch(/\bBroad\b[\s\S]{0,30}dispatch/i);
  });

  // RC3 + CodeRabbit round (PR #395 thread on line 32): the first Bash action after loading the
  // skill must be THAT workflow's own resolved dispatch, not a hard-coded `parallel` -- an
  // instrumented/coverage/benchmark request with no known module must still run its own
  // workflow. Also asserts true ORDERING (CodeRabbit thread on test line 211): the canonical
  // dispatch example must be the first backtick-quoted `kmp-test ...` command in the step, so a
  // future edit inserting a preflight/exploration command ahead of it fails this test, not just
  // co-occurrence within the same text window.
  it('step: broad dispatches that workflow\'s own command globally as the first action, not hard-coded to parallel', () => {
    const start = protocol.indexOf('**Broad**');
    const end = protocol.indexOf('**Exact module**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step3 = protocol.slice(start, end);
    expect(step3).toMatch(/dispatch\s+that\s+workflow.s\s+own\s+command\s+globally\s+as\s+the\s+first\s+action/i);
    expect(step3).toContain('kmp-test parallel --json --project-root .');
    // Proves the rule isn't hard-coded to parallel -- the other dispatchable workflows are named.
    expect(step3).toMatch(/\bandroid\b/);
    expect(step3).toMatch(/\bcoverage\b/);
    expect(step3).toMatch(/\bbenchmark\b/);
    expect(step3).toMatch(/\bchanged\b/);
    // Ordering: nothing else shaped like a `kmp-test <subcommand>` command precedes the example.
    const firstKmpTestIdx = step3.search(/`kmp-test\s+\S+/);
    const dispatchIdx = step3.indexOf('`kmp-test parallel --json --project-root .`');
    expect(firstKmpTestIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBe(firstKmpTestIdx);
  });

  // RC1 + CodeRabbit round (thread on test line 223): a conventional or descriptive platform
  // label ("app", "shared") is intent/context, not a verified Gradle module path. Asserted as ONE
  // complete clause tying the examples directly to the negation -- not independent keyword
  // checks that would still pass if the protocol contradicted itself elsewhere.
  it('step: descriptive/conventional wording is explicitly rejected as an exact module -- one coherent clause', () => {
    const start = protocol.indexOf('**Broad**');
    const end = protocol.indexOf('**Exact module**');
    const step3 = protocol.slice(start, end);
    expect(step3).toMatch(/descriptive\s+wording\s+\("app",\s*"shared"\)\s+isn.t\s+an\s+exact\s+module/i);
  });

  it('step: exact module dispatches filtered using the already-known name', () => {
    // Round-2 fix: scoped to this step's own text (was previously an unscoped whole-section
    // match, which doesn't actually prove THIS step's content is correct/complete).
    const start = protocol.indexOf('**Exact module**');
    const end = protocol.indexOf('**Test-capability target**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step4 = protocol.slice(start, end);
    expect(step4).toMatch(/already known|already-known/i);
    expect(step4).toMatch(/--module-filter/);
    // Round-5 fix: changed has NO user-facing --module-filter at all (proven against the real
    // parser in the "changed module-filter contract" describe block above -- parseArgs returns
    // unknown_flag) -- round 4 wrongly grouped it alongside parallel/android/benchmark. Scoped to
    // the parenthetical immediately after the first --module-filter mention, the exact shape of
    // the old bug ("(parallel/android/benchmark/changed)"), so this doesn't just re-match the
    // unscoped word "changed" appearing anywhere else in the step (e.g. a future unrelated
    // mention would not false-fail this check).
    const filterIdx = step4.indexOf('--module-filter');
    const parenWindow = step4.slice(filterIdx, filterIdx + 60);
    expect(parenWindow).not.toMatch(/\bchanged\b/);
    expect(step4).toMatch(/`changed`/);
    expect(step4.toLowerCase()).toMatch(/git-derived/);
    // Round-3 fix: coverage silently accepts --module-filter but ignores it (its own scoping
    // flag is --coverage-modules, confirmed in lib/orchestrators/coverage-orchestrator.js) -- an
    // agent following workflow-agnostic advice here would believe it scoped to one module while
    // actually aggregating coverage across all of them.
    expect(step4).toContain('--coverage-modules');
    // Round-4 fix: --coverage-modules is exact/colonless-match only (proven against the real
    // discoverCoverageModules() in the "Coverage module-scoping contract" describe block above) --
    // round 3's wording wrongly implied it shared --module-filter's substring/glob semantics.
    expect(step4.toLowerCase()).toContain('stripped');
    expect(step4.toLowerCase()).toContain('no glob');
  });

  // RC1 + CodeRabbit round (thread on test line 223, "also applies to 259-271"): a module is
  // "known" only when the user explicitly supplied an exact Gradle module identity, or an
  // earlier structured envelope already established that exact modules[].name -- never from
  // descriptive wording alone. Asserted as one ordered relationship (each anchor must appear,
  // in order) rather than four independent word checks that would pass even if disconnected.
  it('step: exact module identity is sourced only from an explicit statement or a prior envelope, never descriptive wording -- one ordered relationship', () => {
    const start = protocol.indexOf('**Exact module**');
    const end = protocol.indexOf('**Test-capability target**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step4 = protocol.slice(start, end);
    expect(step4).toMatch(
      /already\s+known[\s\S]*?explicit\s+from\s+the\s+user[\s\S]*?prior\s+envelope.s[\s\S]*?modules\[\]\.name[\s\S]*?never\s+descriptive\s+wording\s+alone/i
    );
  });

  it('step: test-capability target runs describe once before a targeted dispatch', () => {
    // Scoped to this step's own text (not the whole section) -- the preceding step legitimately
    // mentions the module-scoping flags too, which would false-fail an unscoped
    // describe-before-dispatch check even after a correct implementation.
    const start = protocol.indexOf('**Test-capability target**');
    const end = protocol.indexOf('**Likely-no-tests target**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step5 = protocol.slice(start, end);
    const describeIdx = step5.indexOf('kmp-test describe --json --project-root .');
    const dispatchIdx = step5.toLowerCase().indexOf('dispatch');
    expect(describeIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(describeIdx).toBeLessThan(dispatchIdx);
    // Round-4 fix: describe returns modules[].name WITH the leading colon: stripping it before
    // use is required specifically for --coverage-modules (proven above), so this step must
    // repeat this instruction rather than leaving it implicit.
    expect(step5.toLowerCase()).toContain('strip');
  });

  it('step: exact module reads the exact value from modules[].name', () => {
    expect(protocol).toMatch(/modules\[\]\.name/);
  });

  // RC2 + CodeRabbit round (thread on test line 223, "also applies to 300-308"): reading one
  // modules[].name is insufficient when describe returns several modules -- candidate selection
  // must inspect every entry and filter by task capability, as one complete clause.
  it('step: test-capability dispatch inspects every returned module and filters by task capability -- one complete clause', () => {
    const start = protocol.indexOf('**Test-capability target**');
    const end = protocol.indexOf('**Likely-no-tests target**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step5 = protocol.slice(start, end);
    expect(step5).toMatch(/check\s+every\s+`modules\[\]`\s+entry.s\s+task\s+field\s+for\s+the\s+test\s+type/i);
  });

  // Reviewer finding beyond the 5 CodeRabbit threads: "task field for the test type" alone still
  // lets an agent guess which field applies. Default parallel dispatch must be pinned to
  // test_tasks.unit; an explicit platform must defer to the documented --test-type mapping.
  it('step: test-capability default is pinned to test_tasks.unit, explicit platforms defer to flags-reference.md', () => {
    const start = protocol.indexOf('**Test-capability target**');
    const end = protocol.indexOf('**Likely-no-tests target**');
    const step5 = protocol.slice(start, end);
    expect(step5).toMatch(/`test_tasks\.unit`\s+for\s+`parallel`.s\s+default/i);
    expect(step5).toMatch(/`flags-reference\.md`\s+for\s+an\s+explicit\s+`--test-type`/i);
  });

  // Schema-v5 canary forensic fact #2 + runbook requirement: expected-tests and likely-no-tests
  // are now two SEPARATE candidate rules (not one merged "1/2+/0 eligible" step), each with its
  // own scoped test below -- so a future edit can't quietly re-merge them without failing here.
  //
  // Follow-up review finding (post-PR #399): the schema-v5 restructure dropped the ORIGINAL
  // protocol's own "0 eligible: don't invent one" branch when test-capability was split out of the
  // old merged step -- 0-eligible silently had no defined outcome at all. Restored as its own
  // explicit fail-closed branch, asserted here alongside 1/2+ so a future edit can't drop it again
  // without this test catching the gap.
  it('step: test-capability 0/1/2+ eligible-candidate branches all have a defined, fail-closed outcome', () => {
    const start = protocol.indexOf('**Test-capability target**');
    const end = protocol.indexOf('**Likely-no-tests target**');
    const step5 = protocol.slice(start, end);
    expect(step5).toMatch(/\b1\s+eligible:\s*bind\s+dispatch\s+to\s+that\s+entry.s\s+exact\s+`modules\[\]\.name`/i);
    expect(step5).toMatch(/2\+\s+eligible:\s*dispatch\s+globally\s+if\s+broad,\s*else\s+ask/i);
    expect(step5).toMatch(/\b0\s+eligible:\s*report\s+no\s+match;\s*don.t\s+invent\s+one/i);
  });

  // evidence-driven-scope-canary follow-up (android-host-test-discovery cell, skill 21f1894): both
  // current-skill cells ran describe successfully, but one still dispatched a DIFFERENT, wrong
  // structured target. The sidecars show that observable shape -- a successful describe followed
  // by a wrong-target dispatch -- not why the agent picked that target, so this test asserts only
  // what's actually observable. Step 2's classify-scope principle already states naming never
  // settles capability (tested above); repeating that same warning here would be "another
  // warning", not a fix. Instead this step's own dispatch action must name the exact binding
  // operation -- selecting the one eligible entry and reusing THAT entry's own name as the
  // dispatch value -- tied to the guard in one clause, not two independently-passable checks that
  // would still pass if the two halves were disconnected.
  it('step: test-capability binds the dispatch filter to the SAME eligible entry\'s exact name, never a differently-named/typed/platformed entry -- one tied clause', () => {
    const start = protocol.indexOf('**Test-capability target**');
    const end = protocol.indexOf('**Likely-no-tests target**');
    const step5 = protocol.slice(start, end);
    expect(step5).toMatch(
      /1\s+eligible:\s*bind\s+dispatch\s+to\s+that\s+entry.s\s+exact\s+`modules\[\]\.name`[\s\S]{0,80}never\s+a\s+different\s+entry\s+merely\s+resembling\s+by\s+name,\s*type,\s*or\s+platform/i
    );
  });

  // Post-merge CodeRabbit + human review round (PR #403, HEAD 87278cd): the binding test above is
  // necessary but not sufficient. Even a correctly-bound exact modules[].name can still widen
  // dispatch scope, because --module-filter's own non-glob matching is a SUBSTRING contract
  // (proven against the real matchModuleFilter() in the "Module-filter substring-widening
  // contract" describe block above: binding to :foo also matches a co-resident :fooApp). The
  // protocol must close that gap with an explicit pre-dispatch check against the SAME already-
  // fetched modules[] list, scoped to --module-filter workflows only -- --coverage-modules is
  // separately exact-match (tested above) and needs no such check.
  it('step: before an exact-bind dispatch via --module-filter, the SAME modules[] must be checked for a substring collision -- ask instead of silently widening scope', () => {
    const start = protocol.indexOf('**Test-capability target**');
    const end = protocol.indexOf('**Likely-no-tests target**');
    const step5 = protocol.slice(start, end);
    expect(step5).toMatch(
      /`--module-filter`,\s*first\s+check\s+`modules\[\]`:\s*if\s+the\s+bound\s+name.s\s+substring\s+also\s+matches\s+another\s+entry,\s*ask\s+instead\s+of\s+dispatching\s*\(`--coverage-modules`\s+is\s+already\s+exact\)/i
    );
  });

  it('never presents --module-filter with a bracketed placeholder', () => {
    expect(protocol).not.toContain('--module-filter <module>');
    expect(protocol).not.toMatch(/--module-filter\s+<[^>]*>/);
  });

  it('never presents --module-filter with an unbracketed "module-name" placeholder', () => {
    expect(protocol).not.toContain('--module-filter module-name');
  });

  it('step: preview-only uses --dry-run and forbids guessing filters', () => {
    expect(protocol).toMatch(/--dry-run/);
    expect(protocol).toMatch(/guessed filters|guessing filters/i);
  });

  it('step: preview-only scopes --dry-run to the five test-dispatch subcommands, not "any"', () => {
    // Round-3 fix: doctor/info/describe don't support --dry-run at all (confirmed against
    // flags-reference.md's own support table); "any subcommand" overclaims.
    const start = protocol.indexOf('**Preview only**');
    const end = protocol.indexOf('**Trust the real envelope**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step7 = protocol.slice(start, end);
    expect(step7).not.toMatch(/any subcommand/i);
    expect(step7).toMatch(/\bparallel\b/);
    expect(step7).toMatch(/\bcoverage\b/);
    expect(step7).toMatch(/\bbenchmark\b/);
    expect(step7).toMatch(/\bchanged\b/);
    expect(step7).toMatch(/\bandroid\b/);
  });

  // Round-5 addition: changed's own preview mechanism is --show-modules-only (lists the
  // git-derived module set without running tests), not --dry-run alone -- pointing agents only at
  // --dry-run here would still be correct but less informative for this specific subcommand.
  it('step: preview mentions --show-modules-only as changed\'s own preview flag', () => {
    const start = protocol.indexOf('**Preview only**');
    const end = protocol.indexOf('**Trust the real envelope**');
    const step7 = protocol.slice(start, end);
    expect(step7).toMatch(/--show-modules-only/);
  });

  // Schema-v5 canary forensic fact #4: successful cells still ran an unrequested --dry-run
  // preflight before the real dispatch. Dry-run remains legitimate for an explicit preview ask,
  // but must never stand in as a preflight step for an execution request.
  it('step: preview-only dry-run is not a preflight for an execution request', () => {
    const start = protocol.indexOf('**Preview only**');
    const end = protocol.indexOf('**Trust the real envelope**');
    const step7 = protocol.slice(start, end);
    expect(step7).toMatch(/not\s+a\s+preflight\s+for\s+an\s+execution\s+request/i);
  });

  it('step: trusts the real (non-dry-run) envelope as authoritative', () => {
    expect(protocol).toMatch(/authoritative/i);
  });

  it('step: stops once the outcome is proven', () => {
    expect(protocol).toMatch(/stop once proven/i);
  });

  // RC4 + CodeRabbit round (thread on test line 384): the terminal condition is operational, not
  // abstract, AND must be verified as one complete condition -- expected outcome, coherent
  // exit_code/errors[], and (for executed tests) matching counts/failures together, not as three
  // independently-passable checks that would still pass on an incoherent envelope description.
  it('step: a successful non-dry-run envelope is terminal only with expected outcome, coherent exit_code/errors[], and matching counts/failures', () => {
    const start = protocol.indexOf('Stop once proven');
    const end = protocol.indexOf('**Diagnose only on failure**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step9 = protocol.slice(start, end);
    expect(step9).toMatch(
      /non-dry-run\s+envelope\s+with\s+expected\s+outcome,\s+coherent\s+`exit_code`\/`errors\[\]`,\s+and\s+\(when\s+tests\s+ran\)\s+matching\s+counts\/failures\s+is\s+terminal/i
    );
  });

  // RC4 + CodeRabbit round (thread on test line 384, "also applies to 388-397"): post-success
  // probes must be NEGATED, not merely mentioned -- a prior version of this test would have
  // passed even if the protocol affirmatively recommended running doctor/describe after success.
  // Re-adds raw Gradle invocation and Gradle task-listing, the two probe shapes the forensic
  // analysis flagged as missing from the prior exclusion list.
  it('step: post-success probes are negated as one list, not merely present -- includes raw Gradle and task-listing', () => {
    const start = protocol.indexOf('Stop once proven');
    const end = protocol.indexOf('**Diagnose only on failure**');
    const step9 = protocol.slice(start, end);
    // The full negated list, anchored on "no post-success ... probe" so this fails if the
    // negation frame is ever dropped, inverted, or any listed probe shape is removed.
    expect(step9).toMatch(
      /no\s+post-success\s+dry-run,\s+doctor,\s+describe,\s+raw\s+or\s+task-listing\s+Gradle,\s+version,\s+or\s+ls\/pwd\/which\s+probe/i
    );
    // Negative control: the protocol must never affirmatively instruct running doctor/describe
    // as a post-success confirmation step.
    expect(step9).not.toMatch(/run\s+`kmp-test\s+(doctor|describe)/i);
  });

  it('step: an unrelated skipped[] entry is explicitly framed as context, not a reason to keep exploring -- one tied clause', () => {
    const start = protocol.indexOf('Stop once proven');
    const end = protocol.indexOf('**Diagnose only on failure**');
    const step9 = protocol.slice(start, end);
    expect(step9).toMatch(/unrelated\s+`skipped\[\]`\s+entry\s+isn.t\s+a\s+reason\s+to\s+keep\s+exploring/i);
  });

  it('step: diagnose only for exit_code 3 or an explicit request', () => {
    expect(protocol).toMatch(/only.{0,20}exit_code.{0,10}3|exit_code.{0,10}3.{0,30}explicit/i);
  });

  it('gives positive shell-discovery guidance (structured CLI from the project root)', () => {
    expect(protocol.toLowerCase()).toMatch(/structured cli/);
    expect(protocol.toLowerCase()).toMatch(/project root/);
  });

  it('does not present cd/pwd/ls/git as a runnable example', () => {
    expect(protocol).not.toMatch(/`cd[\s`]/i);
    expect(protocol).not.toMatch(/`ls\b/i);
    expect(protocol).not.toMatch(/`pwd`/i);
    expect(protocol).not.toMatch(/`git[\s`]/i);
  });

  // Round-3 addition, round-4 corrected: matchModuleFilter's own doc comment
  // (lib/orchestrators/orchestrator-utils.js) confirms non-glob patterns are SUBSTRING matches --
  // `--module-filter app` matches both `:app` and `:application`. This property belongs to
  // --module-filter ONLY -- round 3 wrongly implied --coverage-modules shared it (it's exact/
  // colonless-only, proven in the "Coverage module-scoping contract" describe block above).
  // Round-4 also fixes a false-pass CodeRabbit found independently on this same test: an unscoped
  // whole-protocol "verify" search would keep passing even if this specific warning were deleted,
  // since neighboring steps use "verify" for unrelated things -- both warnings are now scoped to
  // their own paragraph, ending exactly where the next one begins.
  it('warns --module-filter (only) is substring-based and to verify modules[]', () => {
    const start = protocol.indexOf('`--module-filter` matches by substring');
    const end = protocol.indexOf('`--coverage-modules` is exact-match only');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const paragraph = protocol.slice(start, end);
    expect(paragraph.toLowerCase()).toContain('substring');
    expect(paragraph).toMatch(/modules\[\]/);
    expect(paragraph).not.toContain('--coverage-modules');
  });

  it('warns --coverage-modules is exact-match only, distinguishing dry-run from real-run verification', () => {
    const start = protocol.indexOf('`--coverage-modules` is exact-match only');
    const end = protocol.indexOf('A denied exploratory command');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const paragraph = protocol.slice(start, end);
    expect(paragraph.toLowerCase()).toContain('exact');
    // Explicitly ruling out substring matching ("no substring") is correct, precise content --
    // what must never appear is the AFFIRMATIVE claim (module-filter's own property).
    expect(paragraph).not.toMatch(/matches by substring/i);
    expect(paragraph.toLowerCase()).toMatch(/always empty/);
    // Round-5 fix: round 4 pointed unconditionally at coverage.module_buckets -- but on
    // --dry-run, module_buckets is ALWAYS the hardcoded-empty shape regardless of the filter
    // (proven in the "Coverage dry-run verification contract" describe block above), so that
    // guidance silently misled a dry-run caller into reading "nothing matched" from an envelope
    // that never ran anything. The filter only surfaces pre-run via plan.coverage_modules.
    expect(paragraph).toMatch(/--dry-run/);
    expect(paragraph).toContain('plan.coverage_modules');
    expect(paragraph).toContain('module_buckets');
  });

  it('denial recovery: a denied exploratory probe is abandoned, not retried', () => {
    expect(protocol.toLowerCase()).toMatch(/abandon/);
    expect(protocol.toLowerCase()).toMatch(/next canonical/);
  });

  // CodeRabbit round (PR #399): scoped to the exact-canonical clause itself, matching the
  // neighboring DECORATED-command test's own slicing -- an unscoped whole-protocol match doesn't
  // prove THIS clause's content is correct/complete (this file's own header comment and the
  // round-2-fix precedent both call out exactly this anti-pattern).
  it('denial recovery: a denied exact-canonical command is final -- stop, report, no retry', () => {
    const start = protocol.indexOf('A denied EXACT canonical');
    expect(start).toBeGreaterThan(-1);
    const clause = protocol.slice(start, start + 220).toLowerCase();
    expect(clause).toMatch(/stop and report/);
    expect(clause).toMatch(/don.t retry/);
  });

  // Schema-v5 canary forensic fact #3: a cell decorated the canonical describe command (e.g. with
  // shell redirection); policy correctly denied the decorated form, and the agent then spiralled
  // through further denied commands instead of recovering with the bare canonical command. This is
  // a THIRD, distinct denial-recovery case -- neither "abandon an exploratory probe" (no retry
  // needed) nor "a denied exact-canonical command is final" (no retry in any form): a decorated
  // command is not yet canonical at all, so exactly one bare retry with the undecorated form is the
  // correct recovery, tested here separately so a merged/vague rule can't silently satisfy both.
  it('denial recovery: a denied DECORATED command gets one bare retry with the exact form, distinct from a denied exact-canonical command\'s no-retry rule', () => {
    const start = protocol.indexOf('A denied DECORATED command');
    expect(start).toBeGreaterThan(-1);
    const clause = protocol.slice(start, start + 220);
    expect(clause).toMatch(/redirection/i);
    expect(clause).toMatch(/\bpipe\b/i);
    expect(clause).toMatch(/chaining/i);
    expect(clause).toMatch(/isn.t yet canonical/i);
    expect(clause).toMatch(/issue the exact standalone command once/i);
    expect(clause).toMatch(/if denied too, stop and report/i);
  });

  // Round-3 fix (preserved through the schema-v5 restructure): round 2's version let describe's
  // test_tasks.unit:null ALONE justify "no applicable tests" -- reproduced against the real canary
  // scenario ground truth (kampkit-no-applicable-tests.json, which requires an ACTUAL executed
  // parallel envelope, not a describe-only inference) and against real describe output shape: a
  // module can have test_tasks.unit:null while test_tasks.ios:"iosX64Test" is populated and
  // genuinely dispatchable via --test-type ios -- unit:null alone would have wrongly
  // short-circuited that. Now scoped to its own numbered step (Likely-no-tests target) instead of
  // a disconnected trailing paragraph -- the schema-v5 canary's forensic fact #5 found the old
  // paragraph's prose was present but not operationally salient.
  it('step: likely-no-tests requires a REAL non-dry-run parallel envelope, not describe alone -- its own separate rule from test-capability\'s eligible-count branches', () => {
    const start = protocol.indexOf('**Likely-no-tests target**');
    const end = protocol.indexOf('**Preview only**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step6 = protocol.slice(start, end);
    expect(step6).toMatch(/non-dry-run/i);
    expect(step6).toContain('no_test_modules');
    expect(step6).toContain('caused_by_filter:true');
    expect(step6.toLowerCase()).toMatch(/\balone\b/);
    expect(step6).toContain('test_tasks.unit');
    expect(step6).toMatch(/no applicable tests/i);
    expect(step6.toLowerCase()).toMatch(/\bstop\b/);
  });

  // Follow-up review finding (post-PR #399): likely-no-tests referenced null task fields but never
  // instructed HOW to obtain or select them -- not an executable state. Fixed to explicitly order
  // describe (once, reusing a prior envelope if one already exists so test-capability and
  // likely-no-tests never double-probe) before inspecting test_tasks.unit.
  it('step: likely-no-tests orders describe (once, reusing any prior envelope) before inspecting test_tasks.unit', () => {
    const start = protocol.indexOf('**Likely-no-tests target**');
    const end = protocol.indexOf('**Preview only**');
    const step6 = protocol.slice(start, end);
    const describeIdx = step6.indexOf('kmp-test describe --json --project-root .');
    const inspectIdx = step6.toLowerCase().indexOf('inspect every');
    expect(describeIdx).toBeGreaterThan(-1);
    expect(inspectIdx).toBeGreaterThan(-1);
    expect(describeIdx).toBeLessThan(inspectIdx);
    expect(step6).toMatch(/once\s+if\s+not\s+already\s+run/i);
  });

  // Follow-up review finding (post-PR #399): likely-no-tests never resolved cardinality when
  // describe returns zero, one, or several null-task-field candidates -- these are precisely the
  // decisions the state machine must close, mirroring test-capability's own 0/1/2+ split (but
  // inverted polarity: candidates identified by a NULL field, not a non-null one).
  it('step: likely-no-tests 0/1/2+ null-candidate branches each perform their specified action', () => {
    const start = protocol.indexOf('**Likely-no-tests target**');
    const end = protocol.indexOf('**Preview only**');
    const step6 = protocol.slice(start, end);
    expect(step6).toMatch(/\b1\s+null:\s*dispatch\s+its\s+exact\s+`modules\[\]\.name`\s+for\s+one\s+real\s+filtered\s+run/i);
    expect(step6).toMatch(/2\+\s+null:\s*ask\s+for\s+the\s+exact\s+target,\s*never\s+guess\s+from\s+names\s+or\s+types/i);
    expect(step6).toMatch(/\b0\s+null:\s*report\s+no\s+matching\s+candidate;\s*don.t\s+invent\s+one/i);
  });

  // Round-5 fix: the round-4 version of this check only looked for the literal concatenation
  // "--test-type device" / "--test-type web" -- but the ACTUAL old (round-3-era) bug never wrote
  // that concatenation. It wrote device/web backtick-quoted alongside ios/macos in a list near
  // "--test-type", e.g. "...run via `ios`/`device`/`web`/`macos` under an explicit `--test-type`".
  // The round-4 regex would have stayed green against that exact real bad sentence -- it was
  // never actually discriminating. Extracted as a pure detector so its power can be proven with a
  // synthetic copy of the real old sentence, independent of whatever the paragraph currently says.
  function mentionsDeviceOrWebNearTestType(text) {
    return /--test-type/.test(text) && /`device`|`web`/.test(text);
  }

  // Round-4 fix: round 3 named device/web as things a module can "run via ... under an explicit
  // --test-type" -- but device and web are describe's OWN test_tasks field names, not real
  // --test-type values at all (proven against the real TEST_TYPE_VALUES enum in the "--test-type
  // value contract" describe block above; the real analogues are androidInstrumented and js/wasm).
  // Rather than hardcode a field-name-to-CLI-value mapping in SKILL.md (which could itself go
  // stale), the fix points to the reference doc and never presents device/web as if they were
  // literal --test-type arguments.
  it('[detector] catches a synthetic copy of the real old sentence', () => {
    const oldBadSentence =
      'the module may still run via `ios`/`device`/`web`/`macos` under an explicit `--test-type`';
    expect(mentionsDeviceOrWebNearTestType(oldBadSentence)).toBe(true);
  });

  it('[detector] does not flag an ordinary --test-type mention with no device/web backticks', () => {
    const goodSentence =
      'the module may still run under a different `--test-type`; see flags-reference.md';
    expect(mentionsDeviceOrWebNearTestType(goodSentence)).toBe(false);
  });

  it('does not present device/web as literal --test-type values; points to the real enum', () => {
    const start = protocol.indexOf('**Likely-no-tests target**');
    const end = protocol.indexOf('**Preview only**');
    const step6 = protocol.slice(start, end);
    expect(mentionsDeviceOrWebNearTestType(step6)).toBe(false);
    expect(step6).toMatch(/test_tasks/);
    expect(step6).toMatch(/flags-reference/i);
  });

  it('the no-test-outcome guidance does not enumerate specific alternate subcommands', () => {
    const start = protocol.indexOf('**Likely-no-tests target**');
    const end = protocol.indexOf('**Preview only**');
    const step6 = protocol.slice(start, end);
    expect(step6).not.toMatch(/\bandroid\b/i);
    expect(step6).not.toMatch(/\bcoverage\b/i);
    expect(step6).not.toMatch(/\bchanged\b/i);
    expect(step6).not.toMatch(/\binfo\b/i);
  });
});

// Three schema-v5 canaries showed that agents naturally append a terminal `2>&1` when capturing
// kmp-test output. The policy tolerates only that non-mutating stderr merge; pipes, chaining, and
// file redirection remain denied. This block exercises the REAL policy-hook decide() function
// (tools/agentic-eval/policy-hook.mjs) directly, not just SKILL.md's prose.
describe('Decision protocol canonical-command policy -- exercises the REAL policy-hook decide() function', () => {
  let fixtureRoot;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'skill-canonical-policy-'));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function decisionFor(command) {
    const raw = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: fixtureRoot,
      tool_input: { command },
    });
    const env = {
      KMP_EVAL_EXPECTED_FIXTURE_ROOT: fixtureRoot,
      KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(['build']),
      KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS: JSON.stringify(['describe', 'parallel', 'doctor']),
    };
    return JSON.parse(decide(raw, env)).hookSpecificOutput.permissionDecision;
  }

  const CANONICAL_DESCRIBE = 'kmp-test describe --json --project-root .';

  it('the exact canonical describe command SKILL.md documents is allowed by the real policy', () => {
    expect(decisionFor(CANONICAL_DESCRIBE)).toBe('allow');
  });

  it('the canonical describe command with only a terminal stderr-to-stdout merge is also allowed', () => {
    expect(decisionFor(`${CANONICAL_DESCRIBE} 2>&1`)).toBe('allow');
  });

  it.each([
    `${CANONICAL_DESCRIBE} | cat`,
    `${CANONICAL_DESCRIBE} && echo done`,
    `${CANONICAL_DESCRIBE} > out.txt`,
  ])('other decorated forms remain denied: %s', (decorated) => {
    expect(decisionFor(decorated)).toBe('deny');
  });
});

// Round-4 addition: CodeRabbit's own fresh review of b957984 flagged that "initialize the gradle
// wrapper first if missing" reads as an instruction for the AGENT to auto-initialize it -- which
// can mutate project files and pick an unspecified Gradle version before the requested test run.
describe('SKILL.md Prerequisites -- does not implicitly initialize a missing gradle wrapper', () => {
  const prereqs = section('Prerequisites');

  it('reports a missing gradlew as a prerequisite failure, never auto-initializes it', () => {
    expect(prereqs).not.toMatch(/initialize the gradle wrapper first/i);
    expect(prereqs.toLowerCase()).toMatch(/report the prerequisite|prerequisite failure/);
  });
});

describe('Environment detection -- optional, prose only, no policy-denied commands', () => {
  const env = section('Environment detection');

  it('contains no fenced code block', () => {
    expect(env).not.toMatch(/```/);
  });

  it('does not instruct which/android/adb probing', () => {
    expect(env).not.toMatch(/\bwhich\b/);
    expect(env).not.toMatch(/\badb devices\b/);
    expect(env).not.toMatch(/android info/);
  });

  it('is explicitly framed as optional', () => {
    expect(env.toLowerCase()).toContain('optional');
  });
});

describe('Steps -- dispatch table and envelope parsing', () => {
  const steps = section('Steps');

  it.each([
    'kmp-test parallel --json --project-root .',
    'kmp-test android --json --project-root .',
    'kmp-test coverage --json --project-root .',
    'kmp-test benchmark --json --project-root .',
    'kmp-test changed --json --project-root .',
  ])('dispatch table documents: %s', (cmd) => {
    expect(steps).toContain(cmd);
  });

  // Round-4 addition: CodeRabbit's own fresh review of b957984 -- errors[] is documented as
  // `[{ message, code?, ...extra }]`; only a subset of codes (module_failed, spawn_error,
  // gradle_timeout) carry an optional module field. Requiring it unconditionally would have an
  // agent expect/invent a module for error shapes that never carry one.
  it('reports errors[].module only when present, not for every entry', () => {
    expect(steps.toLowerCase()).toMatch(/only when present|not every/);
  });

  // Round-5 fix: round 4's wording claimed module_failed/spawn_error/gradle_timeout "do" carry a
  // module field, as if unconditionally -- but classifySpawnError (lib/runners/script-dispatcher.js)
  // constructs spawn_error entries with NO module field at all. Whitespace-collapsed before
  // matching so the check doesn't depend on exactly where the prose happens to wrap.
  it('does not overclaim that specific codes always carry a module field', () => {
    const flattened = steps.replace(/\s+/g, ' ');
    expect(flattened).not.toMatch(/spawn_error.{0,10}gradle_timeout.{0,10}\bdo\b/i);
  });
});

describe('SKILL.md Verification section -- exit_code:1 covers WS-5 promotion too', () => {
  // Round-3 fix: exit-codes.md's own WS-5 invariant says exit_code:1 fires "OR a hard errors[]
  // entry promoted via WS-5" -- not just a failed test. The old wording ("a test failed: drill
  // into modules[].test_failures[]") only covered the test-failure half.
  const verification = section('Verification');

  it('exit_code 1 guidance covers WS-5 hard-error promotion, not just a failed test', () => {
    expect(verification.toLowerCase()).toMatch(/ws-5/);
  });

  // CodeRabbit round (PR #395, thread on line 144): gradle_timeout is the benchmark
  // partial-timeout soft code (grounded above in the real SOFT_ERROR_CODES/ENV_ERROR_CODES
  // exports) and belongs in the exit_code:0 soft-codes list alongside no_summary/
  // no_changed_modules. Scoped to item 1's own text so a future item wouldn't false-pass this.
  it('exit_code 0 guidance lists gradle_timeout alongside the other real soft codes', () => {
    const start = verification.indexOf('`0`');
    const end = verification.indexOf('`1`');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const item1 = verification.slice(start, end);
    expect(item1).toMatch(/no_summary/);
    expect(item1).toMatch(/no_changed_modules/);
    expect(item1).toMatch(/gradle_timeout/);
  });

  it('exit_code 1 guidance requires inspecting errors[] in addition to test_failures[]', () => {
    // Scoped to item 2's own text specifically -- items 3/4 already mention `errors[].code` for
    // OTHER exit codes, which would make an unscoped whole-section check trivially pass even
    // without this fix (confirmed: it did, before this scoping correction).
    const start = verification.indexOf('`1`');
    const end = verification.indexOf('`2`');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const item2 = verification.slice(start, end);
    expect(item2).toMatch(/errors\[\]/);
    expect(item2).toMatch(/test_failures\[\]/);
  });
});

describe('Convenience scripts -- optional framing, accurate envelope claim, no runnable example', () => {
  const scripts = section('Convenience scripts');

  it('does not present a bash/pwsh .skills/kmp-test-runner/... command as something to run', () => {
    expect(scripts).not.toMatch(/^(bash|pwsh)\s+\.skills\/kmp-test-runner\//m);
  });

  it('is explicitly framed as optional', () => {
    expect(scripts.toLowerCase()).toMatch(/optional/);
  });

  it('attributes the JSON envelope only to run-tests, not detect-env', () => {
    expect(scripts).toMatch(/run-tests[^\n]*envelope|envelope[^\n]*run-tests/i);
  });
});

describe('SKILL.md version wording', () => {
  it('does not hardcode a stale "current" version', () => {
    expect(skillMd).not.toContain('0.10.0');
  });

  // Round-2 fix: broadened from the exact old phrase ("`kmp-test --version` prints") to a bare
  // substring check -- the old regex only caught that one specific sentence and would have
  // missed any other rephrasing of an unconditional preflight version check.
  it('does not include an unconditional kmp-test --version check, in any phrasing', () => {
    expect(skillMd).not.toContain('kmp-test --version');
  });
});

// Round-2 addition: catches the general failure class, not just Decision protocol's own
// examples -- a policy-unsafe bracketed placeholder anywhere in SKILL.md (e.g. Guidelines'
// pre-existing `--module-filter <glob>` / `--test-filter <FQN>#<method>`) undermines this PR's
// whole purpose just as much as one in the new section would.
describe('SKILL.md never presents a bracketed flag-value placeholder as literal syntax', () => {
  it('no "--flag <placeholder>" pattern appears anywhere in the document', () => {
    expect(skillMd).not.toMatch(/--[\w-]+\s+<[^>]*>/);
  });
});

describe('SKILL.md frontmatter description triggers on running tests and on module/task discovery', () => {
  const match = skillMd.match(/^description:\s*"(.*)"\s*$/m);
  const description = match ? match[1] : '';

  it('has a description field', () => {
    expect(match).not.toBeNull();
  });

  it('preservation: still mentions kmp-test', () => {
    expect(description).toMatch(/kmp-test/);
  });

  it('preservation: still triggers on a "run tests" intent', () => {
    expect(description).toContain('run tests');
  });

  it('preservation: still triggers on the structured-JSON-for-agents need', () => {
    expect(description).toMatch(/structured JSON/i);
  });

  it('new: triggers when the target module or Gradle test task is unclear', () => {
    expect(description).toMatch(/module[\s\S]{0,60}unclear/i);
  });

  // Schema-v5 canary forensic fact #1: the skill was invoked first in only 1/4 current-skill
  // cells; the other cells spent 3-4 denied Bash probes before ever invoking it. Pushing this
  // ordering into the frontmatter description itself (read before any tool call) is the only
  // lever that can influence invocation order -- the Decision protocol body is only read AFTER
  // the skill is already invoked.
  it('new: pushes invocation ahead of Bash/file/Gradle-task exploration for test or module-selection intents', () => {
    expect(description).toMatch(/invoke before/i);
    expect(description.toLowerCase()).toMatch(/bash exploration/);
    expect(description.toLowerCase()).toMatch(/file traversal/);
    expect(description.toLowerCase()).toMatch(/gradle task listing/);
    expect(description.toLowerCase()).toMatch(/project-structure inspection/);
  });

  // evidence-driven-scope-canary follow-up (android-host-test-discovery cell, skill 21f1894):
  // both current-skill cells now invoke the skill at ordinal 0 for an EXPLICIT module ask, but
  // the no-applicable-tests cell's pre-skill invocation ordinals remain exactly 3 and 4 across its
  // two batches -- every attempt at an earlier ordinal is a denied Bash probe. That scenario
  // identifies its target indirectly, by capability, not by an exact name. Only the frontmatter
  // can move invocation earlier than the first tool call, so the indirect-identification trigger
  // must be bound to the SAME instruction that governs pre-inspection invocation, not just be
  // present somewhere in the document.
  //
  // CodeRabbit round (PR #403, HEAD 87278cd): `indexOf('invoke before')` only proved ordering --
  // an unrelated later occurrence of that phrase would have satisfied the old assertion while the
  // actual Bash/file-traversal/Gradle pre-inspection instruction stayed absent or detached. Now
  // matches the complete canonical instruction as one regex, directly adjacent to the indirect
  // clause, so the two can't be satisfied independently.
  it('new: invoking before Bash/file/Gradle-task exploration is bound to indirect module identification as ONE causal rule, not two independently-satisfiable clauses', () => {
    expect(description).toMatch(
      /invoke before bash exploration, file traversal, gradle task listing, or project-structure inspection[\s\S]{0,20}including when named only by role, contents, platform, or test capability/i
    );
  });
});

describe('SKILL.md relative markdown references resolve', () => {
  it('every relative .md link target exists on disk', () => {
    const linkRe = /\]\(([^)]+\.md[^)]*)\)/g;
    const targets = new Set();
    for (const m of skillMd.matchAll(linkRe)) {
      const target = m[1].split('#')[0];
      if (!/^https?:\/\//.test(target)) targets.add(target);
    }
    expect(targets.size).toBeGreaterThan(0);
    for (const target of targets) {
      expect(existsSync(path.resolve(SKILL_DIR, target)), target).toBe(true);
    }
  });
});

describe('Leakage guard -- pure detector proven via synthetic strings, then checked against SKILL.md', () => {
  // Extracted as a pure helper (not exported from production code -- SKILL.md isn't a lib/
  // concern) so its discriminating power can be proven with synthetic strings, independent of
  // whatever SKILL.md's real content happens to be. A test can't verify this by mutating a
  // "scratch copy" -- skillMd above always reads the real file at its fixed repo path.
  const FORBIDDEN_TERM_PATTERNS = [
    /KaMPKit/i,
    /:shared\b/,
    /:app\b/,
    /KMP_EVAL_/,
    /policy hook/i,
    /harness allowlist/i,
    /benchmark_eligible/,
    /calibration run/i,
    /\bgrading\b/i,
  ];

  function findForbiddenTerms(text) {
    return FORBIDDEN_TERM_PATTERNS.filter((re) => re.test(text));
  }

  it('detector catches KaMPKit in a synthetic string', () => {
    expect(findForbiddenTerms('Tested against KaMPKit for validation.')).not.toHaveLength(0);
  });

  it('detector catches a :shared module reference in a synthetic string', () => {
    expect(findForbiddenTerms('Run tests for :shared and :core.')).not.toHaveLength(0);
  });

  it('detector catches an :app module reference in a synthetic string', () => {
    expect(findForbiddenTerms('The :app module needs testing.')).not.toHaveLength(0);
  });

  it('detector catches KMP_EVAL_-prefixed tokens in a synthetic string', () => {
    expect(findForbiddenTerms('Set KMP_EVAL_RESULT before grading.')).not.toHaveLength(0);
  });

  it('detector catches "policy hook" mentions in a synthetic string', () => {
    expect(findForbiddenTerms('The policy hook denies this command.')).not.toHaveLength(0);
  });

  it('detector catches "harness allowlist" mentions in a synthetic string', () => {
    expect(findForbiddenTerms('Check the harness allowlist first.')).not.toHaveLength(0);
  });

  it('detector catches benchmark_eligible in a synthetic string', () => {
    expect(findForbiddenTerms('This run is benchmark_eligible: true.')).not.toHaveLength(0);
  });

  it('detector catches "calibration run" mentions in a synthetic string', () => {
    expect(findForbiddenTerms('Start a calibration run first.')).not.toHaveLength(0);
  });

  it('detector catches bare "grading" mentions in a synthetic string', () => {
    expect(findForbiddenTerms('The grading step checks the answer.')).not.toHaveLength(0);
  });

  it('detector returns empty for ordinary skill prose', () => {
    const ordinary = 'Run kmp-test parallel --json --project-root . to test modules.';
    expect(findForbiddenTerms(ordinary)).toHaveLength(0);
  });

  it('SKILL.md contains none of the forbidden terms', () => {
    expect(findForbiddenTerms(skillMd)).toEqual([]);
  });

  it('SKILL.md still documents the real kmp-test benchmark subcommand (leakage guard did not collateral-damage a real workflow)', () => {
    expect(skillMd).toContain('kmp-test benchmark --json --project-root .');
  });
});

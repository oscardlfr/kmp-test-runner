// tests/vitest/agentic-eval-materialize.test.js
// Unit tests for tools/agentic-eval/materialize.mjs. Real `git archive`/`git worktree` against
// *this* repo at a known commit -- local, no network, no Claude, matching the existing repo
// idiom of real subprocess tests over mocking.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  materializeSkillSnapshot,
  materializeCalibrationProject,
  materializeScenarioProject,
  materializeGradleUserHome,
} from '../../tools/agentic-eval/materialize.mjs';
import { resolveBash } from '../../tools/agentic-eval/resolve-bash.mjs';
import { runValidator } from '../../tools/validate-plugin.mjs';
import { PINNED_SKILL_SHA } from '../../tools/agentic-eval/cli.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KNOWN_SHA = 'c5c0661852f7c9da145ef56892048e706216a6ce';

// Local mirror of materialize.mjs's own bash-routing helpers -- Windows-native `execFileSync`/
// `spawnSync` with shell:false has been shown elsewhere in this harness to mangle
// backslash-heavy path arguments embedded in a command string, so all git calls that build a
// path into the command text itself go through `bash -c`, matching the proven pattern. Uses
// resolveBash() (not a bare 'bash') for the same reason production code does -- an ambiguous
// PATH-resolved 'bash' can be WSL's launcher instead of Git Bash, which broke this exact test
// suite under a PowerShell shell where System32 (WSL's bash.exe) precedes Git's bin/ on PATH.
function toPosixPath(winPath) {
  return winPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}
const shQuote = (arg) => `'${String(arg).replace(/'/g, `'\\''`)}'`;
function gitViaBash(argv, cwd) {
  const cmd = argv.map(shQuote).join(' ');
  const r = spawnSync(resolveBash(), ['-c', `git ${cmd}`], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

const cleanupDirs = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true });
});

describe('materializeSkillSnapshot', () => {
  it('extracts and validates a real pinned-SHA snapshot from this repo', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: KNOWN_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'))).toBe(true);
  });

  // Uses the live HEAD (not KNOWN_SHA above, which is intentionally a fixed historical pin for
  // mechanism-only tests) because this test's whole point is content-sensitive: it proves the
  // skill-portability fix survives real plugin materialization, not just a working-tree read.
  // Only meaningful once a commit containing the fix exists -- added in the commit right after it.
  it('a materialized snapshot of the current commit reflects the portable canonical workflow', async () => {
    const headSha = gitViaBash(['rev-parse', 'HEAD'], REPO_ROOT).trim();
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: headSha, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const materializedSkillMd = readFileSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'), 'utf8');
    expect(materializedSkillMd).not.toMatch(/^(bash|pwsh)\s+\.skills\/kmp-test-runner\//m);
    expect(materializedSkillMd).toContain('kmp-test parallel --json --project-root .');
  });

  // Locks the harness's actual runtime pin to this specific update -- separate from KNOWN_SHA
  // above (mechanism-only) and from the live-HEAD test above (tracks develop's tip forever, never
  // references this constant). calibrate/smoke both materialize current-skill via
  // runConditionPair's one call site using exactly PINNED_SKILL_SHA. This is a tripwire, not a
  // general staleness detector: it deliberately hardcodes 8492d98 and will need its own edit on
  // every future legitimate pin advance -- the next test verifies the semantics that should
  // survive such an advance. Split into two independent it() blocks on purpose: expect().toBe()
  // throws synchronously, so a single block with the equality check first would hide whether the
  // content assertions below actually discriminate -- two blocks means a run against a stale pin
  // shows both failing for real, not just the first one.
  it('PINNED_SKILL_SHA is locked to the PR #420 v3 skill-remediation snapshot', () => {
    expect(PINNED_SKILL_SHA).toBe('8492d98d40b9f2208bac88cf8ac357aeb4c095ca');
  });

  it('the pinned current-skill snapshot reflects the PR #403 target-binding fix', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const materializedSkillMd = readFileSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'), 'utf8');
    // SKILL.md is CRLF on this Windows checkout; .gitattributes doesn't LF-pin .md files --
    // normalize before line-anchored regex matching. Markdown line-wraps also mean a phrase that
    // reads as one sentence in the source can straddle a real line break in the raw text (this
    // file's own history has hit that trap more than once) -- multi-word assertions below use
    // \s+ between words instead of a literal space specifically to stay correct regardless of
    // exactly where a future edit happens to wrap a line.
    const normalizedSkillMd = materializedSkillMd.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Decision protocol must be the canonical entry point -- the first ## heading, not layered
    // alongside a surviving Quick start.
    const firstH2Heading = normalizedSkillMd.match(/^## .+$/m)?.[0];
    expect(firstH2Heading).toBe('## Decision protocol');
    expect(normalizedSkillMd).toContain('kmp-test parallel --json --project-root .');
    // Workflow-specific scoping survives: `changed` has no user-facing module filter (always
    // git-derived), coverage scope is verified via plan.coverage_modules.
    expect(normalizedSkillMd).toMatch(/`changed`\s+has\s+no\s+such\s+flag/);
    expect(normalizedSkillMd).toContain('plan.coverage_modules');
    // "### 1. Run the relevant test type" is deliberately NOT asserted absent below: it was
    // Steps item 1 before the #388 fix and stays Steps item 1 through #399 -- only its sibling
    // "### 2. Diagnose only if..." (and the old "## Quick start" heading) were folded into the
    // Decision protocol, back in #388. Asserting "### 1." absent would be false against the real
    // shipped file.
    expect(normalizedSkillMd).not.toContain('## Quick start');
    expect(normalizedSkillMd).not.toContain('### 2. Diagnose only if the environment blocks the run');
    expect(normalizedSkillMd).not.toMatch(/^(bash|pwsh)\s+\.skills\/kmp-test-runner\//m);
    expect(normalizedSkillMd).not.toContain('current: 0.10.0+');

    // Pre-#399 (still true): descriptive/conventional module wording ("app", "shared") is
    // explicitly rejected as an exact module identity -- a known module requires an explicit
    // user statement or a prior envelope's `modules[].name`, never descriptive wording alone.
    expect(normalizedSkillMd).toContain('descriptive wording ("app", "shared") isn\'t an exact module');
    expect(normalizedSkillMd).toContain("explicit from the user, or a prior envelope's");
    expect(normalizedSkillMd).toMatch(/never\s+descriptive\s+wording\s+alone/);

    // #399 (1/6): pre-inspection invocation guidance lives in the frontmatter description itself
    // -- the schema-v5 canary's own forensic finding was that the skill was invoked first in only
    // 1/4 current-skill cells (the other 3 spent 3-4 denied Bash probes first), and the Decision
    // protocol body is only ever read AFTER the skill is already invoked -- so ordering guidance
    // has to sit where it's read BEFORE any tool call, not inside the body.
    expect(normalizedSkillMd).toMatch(
      /Invoke\s+before\s+Bash\s+exploration,\s+file\s+traversal,\s+Gradle\s+task\s+listing,\s+or\s+project-structure\s+inspection/i
    );

    // #403 (1/3): the pre-inspection instruction above is bound, as ONE causal rule, to a module
    // identified only INDIRECTLY (role/contents/platform/test capability) -- a later
    // evidence-driven-scope-canary finding was that a scenario identifying its target by capability
    // (not an exact name) still burned 2-3 denied Bash probes before the skill was ever invoked,
    // because only frontmatter (read before any tool call) can move invocation earlier -- and a
    // bare "appears somewhere later" ordering check can't tell a genuinely bound rule from two
    // independently-satisfiable clauses. CodeRabbit round (PR #404): an earlier version of this
    // regex used `[\s\S]{0,30}` between the two halves, which still let an unrelated injected
    // sentence ("...inspection. This rule is important. including...") bridge two independently-
    // scoped occurrences within that budget -- proven against a synthetic case built from exactly
    // that shape. The real text joins the two halves with a single em-dash connector and nothing
    // else, so matching that literal connector (whitespace-tolerant, not a wildcard span) is both
    // tighter AND simpler than trying to pick a "safe" character budget.
    expect(normalizedSkillMd).toMatch(
      /invoke\s+before\s+bash\s+exploration,\s+file\s+traversal,\s+gradle\s+task\s+listing,\s+or\s+project-structure\s+inspection\s*—\s*including\s+when\s+named\s+only\s+by\s+role,\s+contents,\s+platform,\s+or\s+test\s+capability/i
    );

    // #399 (2/6): scope classification names all four states as its own step, ahead of the four
    // dispatch branches -- not folded into module-presence branching the way the prior fix's
    // "known workflow, no/known/unclear module" framing did.
    expect(normalizedSkillMd).toContain(
      '**Classify scope** — broad, exact module, test-capability target, or likely-no-tests target'
    );

    // #399 (3/6): test-capability and likely-no-tests are two SEPARATE candidate rules, each with
    // its OWN complete 0/1/2+ branching -- a follow-up review round found the first cut of this
    // fix dropped the original protocol's "0 eligible: don't invent one" branch entirely, and left
    // likely-no-tests referencing null task fields without ever saying how to obtain or select
    // them. Both gaps are closed and asserted here explicitly so a future edit can't silently
    // re-drop either branch or re-merge the two rules.
    //
    // #403 (2/3) supersedes the "1 eligible" half of this same assertion: binding dispatch to the
    // one eligible candidate's OWN exact modules[].name (never a different, merely-resembling
    // entry) replaced the earlier "its exact name" wording -- a review round found a successful
    // describe followed by a wrong-target dispatch anyway, so the binding operation itself now has
    // to be named explicitly at the point dispatch happens, not just as a classification principle
    // elsewhere in the doc. CodeRabbit round (PR #404): the apostrophe in "entry's" was matched
    // with a bare `.` wildcard, which would also accept a malformed "entryXs" -- narrowed to an
    // explicit straight/curly-apostrophe character class.
    expect(normalizedSkillMd).toMatch(
      /1\s+eligible:\s*bind\s+dispatch\s+to\s+that\s+entry['’]s\s+exact\s+`modules\[\]\.name`[\s\S]{0,80}never\s+a\s+different\s+entry\s+merely\s+resembling\s+by\s+name,\s*type,\s*or\s+platform/i
    );
    expect(normalizedSkillMd).toMatch(/2\+\s+eligible:\s+dispatch\s+globally\s+if\s+broad,\s+else\s+ask/);
    expect(normalizedSkillMd).toContain('0 eligible: report no');

    // #403 (3/3): binding to the exact name alone is necessary but not sufficient for
    // `--module-filter` workflows (parallel/android/benchmark) -- a review round caught that
    // `--module-filter`'s own non-glob matching is a SUBSTRING contract (`matchModuleFilter`,
    // lib/orchestrators/orchestrator-utils.js), so binding dispatch to `:foo` doesn't stop a
    // co-resident `:fooApp` module from ALSO matching. The protocol must check the same
    // already-fetched modules[] list before dispatch and ask rather than silently widen scope;
    // `--coverage-modules` needs no such check (already exact-match, asserted separately in
    // skill-canonical-workflow.test.js against the live working-tree file). CodeRabbit round
    // (PR #404): same wildcard-apostrophe fix as #403 (2/3) above, applied to "name's".
    expect(normalizedSkillMd).toMatch(
      /`--module-filter`,\s*first\s+check\s+`modules\[\]`:\s*if\s+the\s+bound\s+name['’]s\s+substring\s+also\s+matches\s+another\s+entry,\s*ask\s+instead\s+of\s+dispatching\s*\(`--coverage-modules`\s+is\s+already\s+exact\)/i
    );
    expect(normalizedSkillMd).toContain(
      '1 null: dispatch its exact `modules[].name` for one real filtered run'
    );
    expect(normalizedSkillMd).toContain('2+ null: ask for the');
    expect(normalizedSkillMd).toMatch(/never\s+guess\s+from\s+names\s+or\s+types/);
    expect(normalizedSkillMd).toContain('0 null: report no matching candidate');
    // "don't invent one" (or the apostrophe-normalized equivalent) must appear twice -- once per
    // 0-branch (test-capability's and likely-no-tests') -- not collapsed into one shared mention.
    const inventOneMatches = normalizedSkillMd.match(/don.t\s+invent\s+one/gi) ?? [];
    expect(inventOneMatches.length).toBe(2);

    // #399 (4/6): a denied DECORATED command (redirection/pipe/chaining/wrapper) is a THIRD,
    // distinct denial-recovery case -- one bare retry with the exact standalone canonical form,
    // separate from "abandon an exploratory probe" (no retry needed) and "a denied exact-canonical
    // command is final" (no retry in any form). A schema-v5 canary cell hit exactly this gap: it
    // invoked the skill first, decorated the canonical describe call, got denied, then spiralled
    // through 8 more denied commands instead of recovering with the bare form.
    expect(normalizedSkillMd).toContain("A denied exploratory command isn't worth retrying");
    expect(normalizedSkillMd).toContain('A denied EXACT canonical `kmp-test` command is final');
    expect(normalizedSkillMd).toContain('A denied DECORATED command');
    expect(normalizedSkillMd).toContain('issue the exact standalone command once');
    expect(normalizedSkillMd).toContain('if denied too, stop and report');

    // #399 (5/6): dry-run is never a substitute preflight ahead of an execution request -- two
    // successful schema-v5 cells both ran an unrequested --dry-run before the real dispatch.
    // Dry-run remains legitimate only for an explicit preview ask.
    expect(normalizedSkillMd).toMatch(/not\s+a\s+preflight\s+for\s+an\s+execution/);

    // #399 (6/6, preserved through both PR #399 rounds): a coherent successful envelope is an
    // operationally terminal condition -- stop and report, no post-success dry-run/doctor/
    // describe/raw-Gradle/version/ls-pwd-which probing, an unrelated skipped[] entry doesn't
    // reopen exploration, and doctor only ever runs after a real failure (exit_code 3) or an
    // explicit request.
    expect(normalizedSkillMd).toContain('is terminal');
    expect(normalizedSkillMd).toContain('no post-success dry-run, doctor, describe, raw or task-listing Gradle, version, or');
    expect(normalizedSkillMd).toContain('ls/pwd/which probe');
    expect(normalizedSkillMd).toContain("An unrelated `skipped[]` entry isn't a reason to keep exploring");
    expect(normalizedSkillMd).toContain('Diagnose only on failure');
    expect(normalizedSkillMd).toContain('kmp-test doctor --json --project-root .');
    expect(normalizedSkillMd).toMatch(/`exit_code:\s*3`\s+or\s+an\s+explicit\s+request/);
  });

  // #413 (route test coverage gates through parallel): the Steps table now distinguishes three
  // separate coverage-related asks that a pre-#413 snapshot collapsed into one ambiguous
  // "run coverage" / "with coverage" row. Row-scoped (not whole-document co-occurrence) checks,
  // matching this file's own established discipline -- `kmp-test parallel` and `--min-missed-lines`
  // both already appear elsewhere in SKILL.md (Decision protocol), so a bare toContain() on the
  // full document would pass even against the old, un-split table.
  it('the pinned snapshot routes coverage-related asks through the PR #413 3-way split', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const skillMd = readFileSync(path.join(snapshotDir, '.skills', 'kmp-test-runner', 'SKILL.md'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const stepsStart = skillMd.indexOf('\n## Steps');
    const stepsEnd = skillMd.indexOf('\n## Convenience scripts', stepsStart);
    expect(stepsStart).toBeGreaterThan(-1);
    expect(stepsEnd).toBeGreaterThan(stepsStart);
    const stepsSection = skillMd.slice(stepsStart, stepsEnd);
    const findRow = (phrase) => stepsSection.split('\n').find((l) => l.startsWith('|') && l.includes(phrase));

    // "run tests with coverage" (no explicit budget) -> bare parallel, no fabricated threshold.
    const withCoverageRow = findRow('run tests with coverage');
    expect(withCoverageRow).toBeTruthy();
    expect(withCoverageRow).toContain('kmp-test parallel --json --project-root .');
    expect(withCoverageRow).not.toContain('--min-missed-lines');

    // "run tests; missed lines under 100" (explicit test intent + explicit budget) -> parallel
    // --min-missed-lines, never bare coverage.
    const budgetRow = findRow('missed lines under 100');
    expect(budgetRow).toBeTruthy();
    expect(budgetRow).toContain('kmp-test parallel --min-missed-lines 100 --json --project-root .');

    // Bare "run coverage" (no test-execution intent) stays its own, narrower row -- existing-XML
    // aggregation only, distinct from both rows above.
    const bareCoverageRow = findRow('"run coverage"');
    expect(bareCoverageRow).toBeTruthy();
    expect(bareCoverageRow).toContain('kmp-test coverage --json --project-root .');
    expect(bareCoverageRow).not.toContain('with coverage');
    expect(bareCoverageRow).not.toContain('--min-missed-lines');

    // The old row that grouped "run coverage" / "with coverage" together under bare `coverage`
    // is gone -- a context-free "with coverage" alone is no longer pre-routed by this table.
    expect(stepsSection).not.toMatch(/"run coverage"\s*\/\s*"with coverage"/);

    // #415: the changed row's own Notes column says "Git-derived", not the old git-diff framing.
    const changedRow = findRow('run only changed tests');
    expect(changedRow).toBeTruthy();
    expect(changedRow).toContain('kmp-test changed --json --project-root .');
    expect(changedRow).toContain('Git-derived');
  });

  // #415 (align workflow contract with runtime): changed.md previously described a default-mode
  // git mechanism as `git diff`, claimed the envelope carries a top-level `parallel:{}` block,
  // still advertised the since-retired `--max-failures`, and described colon-prefixed module
  // names no real envelope carries. Every assertion below is scoped to the specific line/clause
  // making the claim, not a whole-file substring search -- `git status --porcelain` and
  // `git diff --cached --name-only` both already appeared in the PRE-#415 text too (composed
  // differently), so only the exact wording discriminates old from new.
  it('the pinned snapshot\'s changed.md documents the real PR #415 detection/envelope contract', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const changedDoc = readFileSync(
      path.join(snapshotDir, '.skills', 'kmp-test-runner', 'references', 'workflows', 'changed.md'), 'utf8'
    ).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // Default detection is `git status --porcelain`, standalone -- not `git diff --name-only
    // HEAD` plus a `git status --porcelain` fallback for untracked files (the pre-#415 shape).
    const quickstartStep1 = changedDoc.split('\n').find((l) => l.startsWith('1. Runs'));
    expect(quickstartStep1).toBeTruthy();
    expect(quickstartStep1).toMatch(/^1\.\s+Runs\s+`git status --porcelain`\s+\(default\)/);
    expect(quickstartStep1).not.toMatch(/git diff --name-only HEAD/);
    // --staged-only uses `git diff --cached --name-only`, mutually exclusive with the default.
    expect(quickstartStep1).toMatch(/`git diff --cached --name-only`\s+\(`--staged-only`\)\s*—\s*mutually exclusive/);

    // The envelope never carries a top-level `parallel:{}` block -- the pre-#415 doc claimed the
    // opposite (a `parallel:{}` block "present because changed delegates in-process").
    expect(changedDoc).toMatch(/no top-level `parallel:\{\}` block on any `changed` envelope, ever/);

    // --max-failures is fully retired -- not documented anywhere in this workflow doc.
    expect(changedDoc).not.toMatch(/--max-failures/);

    // Detected modules are bare/colon-less, and base_ref is always the literal "HEAD" in both
    // modes -- the pre-#415 doc claimed base_ref became "the index" under --staged-only.
    const changedBlockClause = changedDoc.split('\n').find((l) => l.includes('carries exactly 3 fields'));
    expect(changedBlockClause).toBeTruthy();
    expect(changedBlockClause).toContain('bare/colon-less');
    expect(changedBlockClause).toContain('always the literal string `"HEAD"`');
  });

  // #413 + #415 coverage semantics: --min-missed-lines 0 disables the gate entirely (coverage.md
  // previously claimed the opposite, "perfect coverage required"); changed's --coverage-tool
  // default is `auto`, matching parallel (not a historical jacoco divergence); and --max-failures'
  // retirement reaches the shared flags matrix, not just changed.md's own doc (checked
  // independently of the changed.md-scoped check above, on a different file).
  it('the pinned snapshot documents min-missed-lines-0 disabling the gate and a uniform auto coverage-tool default', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const skillsDir = path.join(snapshotDir, '.skills', 'kmp-test-runner');
    const coverageDoc = readFileSync(path.join(skillsDir, 'references', 'workflows', 'coverage.md'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const changedDoc = readFileSync(path.join(skillsDir, 'references', 'workflows', 'changed.md'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const flagsRefDoc = readFileSync(path.join(skillsDir, 'references', 'cli', 'flags-reference.md'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // coverage.md's own `--min-missed-lines 0` edge case, scoped to that specific bullet.
    const zeroThresholdEdgeCase = coverageDoc.split('\n').find((l) => l.includes('with any missed lines'));
    expect(zeroThresholdEdgeCase).toBeTruthy();
    expect(zeroThresholdEdgeCase).toMatch(/exit 0.*disables the gate entirely/);
    expect(zeroThresholdEdgeCase).not.toMatch(/perfect coverage required/);

    // changed.md's own --coverage-tool row shares parallel's `auto` default -- no jacoco
    // divergence claim.
    const changedCoverageToolRow = changedDoc.split('\n').find((l) => l.includes('`--coverage-tool <tool>`'));
    expect(changedCoverageToolRow).toBeTruthy();
    expect(changedCoverageToolRow).toMatch(/\|\s*`auto`\s*\|/);
    expect(changedCoverageToolRow).not.toContain('jacoco');

    // --max-failures's row is fully gone from the shared flags matrix, not just changed.md.
    expect(flagsRefDoc).not.toMatch(/--max-failures/);
  });

  // PR #420 closed the v3 changed-module-verification 0/2 routing gap. This test reads the
  // materialized pin rather than the live worktree and requires the complete workflow decision,
  // including the negative half that prevents a silent fallback to parallel.
  it('the pinned snapshot includes the PR #420 edit-implied changed routing contract', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const skillsDir = path.join(snapshotDir, '.skills', 'kmp-test-runner');
    const skillMd = readFileSync(path.join(skillsDir, 'SKILL.md'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const changedDoc = readFileSync(path.join(skillsDir, 'references', 'workflows', 'changed.md'), 'utf8')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const protocolStart = skillMd.indexOf('## Decision protocol');
    const scopeStart = skillMd.indexOf('**Classify scope**', protocolStart);
    expect(protocolStart).toBeGreaterThan(-1);
    expect(scopeStart).toBeGreaterThan(protocolStart);
    const workflowStep = skillMd.slice(protocolStart, scopeStart);

    expect(workflowStep).toMatch(
      /unnamed target,\s+only\s+an\s+uncommitted\s+change:\s+the\s+workflow\s+is\s+`changed`,\s+not\s+`parallel`/i
    );
    expect(changedDoc).toMatch(/pending change somewhere[\s\S]{0,120}find it and test just that/i);
    expect(changedDoc).toMatch(/already edited locally[\s\S]{0,120}work out where it is/i);
  });

  // PR #420 also disambiguated coverage aggregation from a fresh tests-plus-coverage run and
  // corrected --min-missed-lines to its real upper-bound semantics.
  it('the pinned snapshot includes the PR #420 coverage routing and upper-bound wording', async () => {
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: PINNED_SKILL_SHA, validateFn: runValidator });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    const coverageDoc = readFileSync(
      path.join(snapshotDir, '.skills', 'kmp-test-runner', 'references', 'workflows', 'coverage.md'),
      'utf8'
    ).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = coverageDoc.split('\n');

    const reportTriggerIndex = lines.findIndex((line) => line.includes('"what\'s the coverage?"'));
    expect(reportTriggerIndex).toBeGreaterThan(-1);
    const reportTrigger = lines.slice(reportTriggerIndex, reportTriggerIndex + 2).join(' ');
    expect(reportTrigger).toMatch(/existing XML|existing report/i);
    expect(reportTrigger).toMatch(/tests haven.t run yet[\s\S]*parallel/i);

    const thresholdTriggerIndex = lines.findIndex((line) => /missed lines do not exceed X/i.test(line));
    expect(thresholdTriggerIndex).toBeGreaterThan(-1);
    const thresholdTrigger = lines.slice(thresholdTriggerIndex, thresholdTriggerIndex + 3).join(' ');
    expect(thresholdTrigger).toMatch(/existing reports?|no\s+fresh\s+test\s+run/i);
    expect(thresholdTrigger).toContain('parallel --min-missed-lines <N>');
  });

  it('cleans up its temp directory when validation fails partway through (not just on an invalid SHA)', async () => {
    // Regression coverage for a real leak found by an independent review pass: a failure
    // AFTER mkdtempSync (specifically, a validation failure against a perfectly valid archive)
    // previously left the temp directory behind forever, since the function had no try/catch of
    // its own. Redirects TEMP/TMP/TMPDIR to a dedicated, empty, test-exclusive directory (os.
    // tmpdir() re-reads these per call) so "is it empty afterward" is exact, not a fragile
    // global count under concurrent test-file execution.
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aemat-skill-cleanup-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      const forcedFailValidate = async () => ({ ok: false, summary: 'forced failure for this test' });
      await expect(
        materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: KNOWN_SHA, validateFn: forcedFailValidate }),
      ).rejects.toThrow(/failed validation/);
      expect(existsSync(isolatedTmp)).toBe(true); // the isolated root itself must survive
      expect(readdirSync(isolatedTmp)).toEqual([]); // but nothing was left inside it
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });

  it('throws if the materialize+validate pipeline is pointed at an invalid SHA', async () => {
    await expect(
      materializeSkillSnapshot({ repoRoot: REPO_ROOT, sha: 'not-a-real-sha-0000000000000000000000', validateFn: runValidator }),
    ).rejects.toThrow();
  });

  it('backfills a commit missing from a shallow clone before archiving (the real CI shallow-checkout failure mode)', async () => {
    // A CI checkout of this repo (or any shallow clone) only has the tip commit's tree locally --
    // `git archive <ancestor-sha>` fails with "not a tree object" for the pinned skill SHA even
    // though it's a perfectly valid, reachable commit. Reproduce that exact shape with a local,
    // no-network origin: two commits, then a --depth 1 clone that only has the second.
    const originDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-origin-'));
    cleanupDirs.push(originDir);
    gitViaBash(['init', '-q'], originDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], originDir);
    gitViaBash(['config', 'user.name', 'Test'], originDir);
    mkdirSync(path.join(originDir, '.claude-plugin'), { recursive: true });
    mkdirSync(path.join(originDir, '.skills', 'kmp-test-runner'), { recursive: true });
    writeFileSync(path.join(originDir, '.claude-plugin', 'plugin.json'), '{}\n');
    writeFileSync(path.join(originDir, '.skills', 'kmp-test-runner', 'SKILL.md'), '# stub\n');
    gitViaBash(['add', '-A'], originDir);
    gitViaBash(['commit', '-q', '-m', 'first'], originDir);
    const firstSha = gitViaBash(['rev-parse', 'HEAD'], originDir).trim();
    writeFileSync(path.join(originDir, 'marker2.txt'), 'second commit\n');
    gitViaBash(['add', '-A'], originDir);
    gitViaBash(['commit', '-q', '-m', 'second'], originDir);

    const shallowDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-shallow-'));
    rmSync(shallowDir, { recursive: true, force: true }); // git clone requires the target not exist
    // --no-local is required: git silently ignores --depth for a plain local-path source
    // ("warning: --depth is ignored in local clones; use file:// instead."), which would make
    // this fixture not actually reproduce the shallow-checkout bug.
    gitViaBash(['clone', '-q', '--depth', '1', '--no-local', toPosixPath(originDir), toPosixPath(shallowDir)], os.tmpdir());
    cleanupDirs.push(shallowDir);

    // Confirm the fixture actually reproduces the bug -- the shallow clone must NOT have
    // `firstSha` locally yet, or this test would prove nothing.
    const probe = spawnSync(resolveBash(), ['-c', `git cat-file -e ${shQuote(firstSha)}^{commit}`], { cwd: shallowDir, encoding: 'utf8' });
    expect(probe.status).not.toBe(0);

    const stubValidate = async () => ({ ok: true, summary: 'stub' });
    const { snapshotDir, validation } = await materializeSkillSnapshot({ repoRoot: shallowDir, sha: firstSha, validateFn: stubValidate });
    cleanupDirs.push(snapshotDir);
    expect(validation.ok).toBe(true);
    expect(existsSync(path.join(snapshotDir, '.claude-plugin', 'plugin.json'))).toBe(true);
  }, 30000); // real init + 2 commits + a --no-local shallow clone + backfill-and-archive: several
  // real git subprocess spawns, slow enough on Windows CI runners to trip vitest's default 5000ms
  // per-test timeout (observed: build (windows-latest) timing out here with no other failure).
});

describe('materializeCalibrationProject', () => {
  function makeTemplate() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'aemat-template-'));
    cleanupDirs.push(dir);
    writeFileSync(path.join(dir, 'marker.txt'), 'pristine-content');
    return dir;
  }

  it('copies the template into a fresh temp directory', () => {
    const templateDir = makeTemplate();
    const { fixtureDir } = materializeCalibrationProject({ templateDir });
    cleanupDirs.push(fixtureDir);
    expect(existsSync(path.join(fixtureDir, 'marker.txt'))).toBe(true);
  });

  it('reset (existingDir) deletes any local mutation and restores pristine content', () => {
    const templateDir = makeTemplate();
    const { fixtureDir } = materializeCalibrationProject({ templateDir });
    cleanupDirs.push(fixtureDir);
    writeFileSync(path.join(fixtureDir, 'junk.txt'), 'should not survive reset');

    const { fixtureDir: fixtureDir2 } = materializeCalibrationProject({ templateDir, existingDir: fixtureDir });
    expect(fixtureDir2).toBe(fixtureDir);
    expect(existsSync(path.join(fixtureDir2, 'junk.txt'))).toBe(false);
    expect(existsSync(path.join(fixtureDir2, 'marker.txt'))).toBe(true);
  });

  // Regression coverage for a real leak an independent review pass reproduced concretely: a
  // cpSync failure partway through (here: a nonexistent templateDir, which cpSync throws ENOENT
  // on) previously left the mkdirSync'd `dest` behind forever, since the function had no
  // try/catch of its own. Redirects TEMP/TMP/TMPDIR to an isolated, test-exclusive directory
  // (same technique as materializeSkillSnapshot's own cleanup-on-failure test above) so "is it
  // empty afterward" is exact -- no need to parse the thrown error's message to recover the
  // dest path.
  it('cleans up the created dest directory when cpSync fails (e.g. a nonexistent templateDir)', () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aemat-calib-cleanup-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      const bogusTemplateDir = path.join(os.tmpdir(), 'aemat-nonexistent-template');
      expect(existsSync(bogusTemplateDir)).toBe(false);
      expect(() => materializeCalibrationProject({ templateDir: bogusTemplateDir })).toThrow();
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

describe('materializeScenarioProject -- worktree-add failure', () => {
  // NOTE: this is deliberately NOT a full regression test for the try/catch+removeScenarioWorktree
  // cleanup wrapping `git worktree add` in materialize.mjs. An invalid commit-ish (tried here)
  // fails cleanly during git's own ref resolution, before any worktree metadata or directory is
  // created -- confirmed empirically by temporarily removing the try/catch and re-running this
  // exact scenario, which still passed identically either way, meaning it doesn't actually
  // discriminate. No other reliably cross-platform way to force `git worktree add` to create
  // PARTIAL state before failing was found (a bad path, an already-existing dest, a locked
  // index all either fail before creating anything or aren't reliably reproducible outside a
  // real interrupted-process scenario). The code fix mirrors the already-verified pattern used
  // by materializeSkillSnapshot/materializeCalibrationProject/materializeGradleUserHome, and the
  // BROADER leak class this defends against -- a successful materialize followed by a LATER,
  // unrelated failure elsewhere in runConditionPair -- is covered for real by
  // agentic-eval-run-condition-pair.test.js. This test only confirms the function still throws
  // (and doesn't crash some other way) on a bad commit.
  it('throws (does not hang or crash unexpectedly) when pinnedCommit does not resolve to a real commit', () => {
    const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-scenario-source-'));
    cleanupDirs.push(sourceRepoDir);
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);

    const bogusCommit = '0000000000000000000000000000000000dead';
    expect(() => materializeScenarioProject({ sourceRepoDir, pinnedCommit: bogusCommit })).toThrow();
    const worktreeList = gitViaBash(['worktree', 'list'], sourceRepoDir);
    expect(worktreeList.trim().split('\n').length).toBe(1); // only the main working tree
  });
});

describe('materializeScenarioProject -- reset (existingWorktreeDir)', () => {
  // Regression coverage for a real gap an independent review pass found: the README claims
  // scenario-project reset (git clean -fdx && git reset --hard) discards local mutation between
  // conditions A and B, the same guarantee materializeCalibrationProject's own "reset (existingDir)
  // ..." test above proves for the copy-based fixture -- but nothing actually exercised the
  // git-worktree reset path itself. This is the exact mechanism every real calibration/smoke run
  // depends on to keep condition B from ever seeing condition A's leftovers.
  it('reset discards local mutation (tracked and untracked) and restores the pinned commit exactly', () => {
    const sourceRepoDir = mkdtempSync(path.join(os.tmpdir(), 'aemat-scenario-reset-source-'));
    cleanupDirs.push(sourceRepoDir);
    gitViaBash(['init', '-q'], sourceRepoDir);
    gitViaBash(['config', 'user.email', 'test@example.com'], sourceRepoDir);
    gitViaBash(['config', 'user.name', 'Test'], sourceRepoDir);
    // A machine-global core.autocrlf=true (common on Windows) would check this file back out as
    // CRLF regardless of what was committed -- irrelevant to what this test verifies (content
    // reset, not line-ending policy), so pin it off for this throwaway repo.
    gitViaBash(['config', 'core.autocrlf', 'false'], sourceRepoDir);
    writeFileSync(path.join(sourceRepoDir, 'marker.txt'), 'pristine\n');
    gitViaBash(['add', '-A'], sourceRepoDir);
    gitViaBash(['commit', '-q', '-m', 'initial'], sourceRepoDir);
    const pinnedCommit = gitViaBash(['rev-parse', 'HEAD'], sourceRepoDir).trim();

    const { fixtureDir } = materializeScenarioProject({ sourceRepoDir, pinnedCommit });
    cleanupDirs.push(fixtureDir);
    // Simulate what condition A's agent session could leave behind: a mutated TRACKED file and a
    // new UNTRACKED file.
    writeFileSync(path.join(fixtureDir, 'marker.txt'), 'mutated by condition A\n');
    writeFileSync(path.join(fixtureDir, 'untracked-junk.txt'), 'should not survive reset');

    const { fixtureDir: fixtureDir2 } = materializeScenarioProject({ sourceRepoDir, pinnedCommit, existingWorktreeDir: fixtureDir });
    expect(fixtureDir2).toBe(fixtureDir);
    expect(readFileSync(path.join(fixtureDir2, 'marker.txt'), 'utf8')).toBe('pristine\n');
    expect(existsSync(path.join(fixtureDir2, 'untracked-junk.txt'))).toBe(false);
    expect(gitViaBash(['status', '--porcelain'], fixtureDir2).trim()).toBe('');
  });
});

describe('materializeGradleUserHome', () => {
  it('creates a temp GRADLE_USER_HOME with the daemon disabled via gradle.properties', () => {
    const { gradleUserHome, daemonPolicy } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    expect(existsSync(path.join(gradleUserHome, 'gradle.properties'))).toBe(true);
    expect(daemonPolicy).toBe('disabled-via-gradle-user-home-properties');
  });

  it('resetToSnapshot restores the exact prewarmed state, discarding later mutation', () => {
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    const originalProperties = readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8');
    writeFileSync(path.join(gradleUserHome, 'fake-dep-cache.jar'), 'x');
    writeFileSync(path.join(gradleUserHome, 'gradle.properties'), 'org.gradle.daemon=true\nmutated=yes\n');
    resetToSnapshot();
    expect(existsSync(path.join(gradleUserHome, 'fake-dep-cache.jar'))).toBe(false);
    expect(readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8')).toBe(originalProperties);
  });

  it('repeated resetToSnapshot calls are idempotent (byte-identical restore each time)', () => {
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({});
    cleanupDirs.push(gradleUserHome);
    resetToSnapshot();
    const afterFirst = readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8');
    writeFileSync(path.join(gradleUserHome, 'gradle.properties'), 'mutated-between-resets\n');
    resetToSnapshot();
    const afterSecond = readFileSync(path.join(gradleUserHome, 'gradle.properties'), 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('runPrewarm callback receives the gradleUserHome path before the snapshot is taken, and its writes survive resetToSnapshot', () => {
    let seenPath = null;
    const { gradleUserHome, resetToSnapshot } = materializeGradleUserHome({
      runPrewarm: (dir) => { seenPath = dir; writeFileSync(path.join(dir, 'prewarm-marker.txt'), 'prewarmed-content'); },
    });
    cleanupDirs.push(gradleUserHome);
    expect(seenPath).toBe(gradleUserHome);
    expect(readFileSync(path.join(gradleUserHome, 'prewarm-marker.txt'), 'utf8')).toBe('prewarmed-content');

    // Prove the marker was captured IN the snapshot (prewarm ran before the snapshot was taken),
    // not just present in the live dir by coincidence -- mutate it, then confirm reset restores
    // the prewarmed content specifically, not just "some" content.
    writeFileSync(path.join(gradleUserHome, 'prewarm-marker.txt'), 'mutated-after-prewarm');
    resetToSnapshot();
    expect(readFileSync(path.join(gradleUserHome, 'prewarm-marker.txt'), 'utf8')).toBe('prewarmed-content');
  });

  // Regression coverage: a failure inside runPrewarm (or writeFileSync/cpSync) partway through
  // previously left BOTH the gradleUserHome and its own internal snapshotDir behind forever,
  // since the function had no try/catch of its own.
  it('cleans up both temp directories it created when runPrewarm throws', () => {
    const isolatedTmp = mkdtempSync(path.join(os.tmpdir(), 'aemat-gradle-cleanup-'));
    const originalEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;
    process.env.TMPDIR = isolatedTmp;
    try {
      expect(() => materializeGradleUserHome({
        runPrewarm: () => { throw new Error('injected prewarm failure'); },
      })).toThrow('injected prewarm failure');
      expect(readdirSync(isolatedTmp)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(isolatedTmp, { recursive: true, force: true });
    }
  });
});

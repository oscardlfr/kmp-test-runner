// tests/vitest/skill-canonical-workflow.test.js
// Regression coverage for SKILL.md's canonical agent workflow: ONE authoritative Decision
// protocol section (first heading in the document) drives known-scope dispatch, uncertain-scope
// discovery via describe, preview-only dry-run, envelope-as-authority, stop-after-evidence, and
// conditional doctor -- replacing the old split across Quick start / Steps section 1 / Steps
// section 2. Also locks: no policy-unsafe placeholder commands, no policy-denied commands in the
// "optional" Environment detection section, no stale hardcoded version, no unconditional
// `kmp-test --version` check, frontmatter description covers module/task discovery, no
// agentic-eval-harness-internal leakage, and relative doc references still resolve.
// Section-scoped (not whole-file substring checks) so a fix landing in the wrong section can't
// produce a false green.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverCoverageModules, parseArgs as parseCoverageArgs, runCoverage } from '../../lib/orchestrators/coverage-orchestrator.js';
import { parseArgs as parseChangedArgs } from '../../lib/orchestrators/changed-orchestrator.js';
import { TEST_TYPE_VALUES } from '../../lib/parsers/argv-constants.js';

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
    const end = protocol.indexOf('**Known workflow, no specific module**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step1 = protocol.slice(start, end);
    expect(step1.toLowerCase()).toMatch(/does not decide/);
    expect(step1.toLowerCase()).toMatch(/ambiguous/);
    expect(step1.toLowerCase()).toMatch(/\bask\b/);
  });

  it('step: known workflow with no specific module dispatches globally', () => {
    expect(protocol).toMatch(/known workflow.{0,20}no specific module/i);
  });

  // RC3: the first Bash action after loading the skill must be the canonical global dispatch
  // when the workflow is known and no exact module constraint exists -- generic preflight and
  // repository exploration must not precede it.
  it('step: no specific module dispatches globally as the first action, before any other exploration', () => {
    const start = protocol.indexOf('Known workflow, no specific module');
    const end = protocol.indexOf('**Known workflow, known module**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step2 = protocol.slice(start, end);
    expect(step2.toLowerCase()).toMatch(/first\s+action/);
    expect(step2).toContain('kmp-test parallel --json --project-root .');
  });

  // RC1: a conventional or descriptive platform label ("the Android module", "app", "shared")
  // is intent/context, not a verified Gradle module path -- it must never satisfy the
  // known-module step below.
  it('step: descriptive platform or conventional wording never counts as a specific module', () => {
    const start = protocol.indexOf('Known workflow, no specific module');
    const end = protocol.indexOf('**Known workflow, known module**');
    const step2 = protocol.slice(start, end);
    expect(step2.toLowerCase()).toMatch(/\bapp\b/);
    expect(step2.toLowerCase()).toMatch(/\bshared\b/);
    expect(step2.toLowerCase()).toMatch(/isn.t\s+an\s+exact\s+module|not\s+an\s+exact\s+module/);
  });

  it('step: known workflow + known module dispatches filtered using the already-known name', () => {
    // Round-2 fix: scoped to this step's own text (was previously an unscoped whole-section
    // match, which doesn't actually prove THIS step's content is correct/complete).
    const start = protocol.indexOf('Known workflow, known module');
    const end = protocol.indexOf('**Known workflow, unclear module**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step3 = protocol.slice(start, end);
    expect(step3).toMatch(/already known|already-known/i);
    expect(step3).toMatch(/--module-filter/);
    // Round-5 fix: changed has NO user-facing --module-filter at all (proven against the real
    // parser in the "changed module-filter contract" describe block above -- parseArgs returns
    // unknown_flag) -- round 4 wrongly grouped it alongside parallel/android/benchmark. Scoped to
    // the parenthetical immediately after the first --module-filter mention, the exact shape of
    // the old bug ("(parallel/android/benchmark/changed)"), so this doesn't just re-match the
    // unscoped word "changed" appearing anywhere else in the step (e.g. a future unrelated
    // mention would not false-fail this check).
    const filterIdx = step3.indexOf('--module-filter');
    const parenWindow = step3.slice(filterIdx, filterIdx + 60);
    expect(parenWindow).not.toMatch(/\bchanged\b/);
    expect(step3).toMatch(/`changed`/);
    expect(step3.toLowerCase()).toMatch(/git-derived/);
    // Round-3 fix: coverage silently accepts --module-filter but ignores it (its own scoping
    // flag is --coverage-modules, confirmed in lib/orchestrators/coverage-orchestrator.js) -- an
    // agent following workflow-agnostic advice here would believe it scoped to one module while
    // actually aggregating coverage across all of them.
    expect(step3).toContain('--coverage-modules');
    // Round-4 fix: --coverage-modules is exact/colonless-match only (proven against the real
    // discoverCoverageModules() in the "Coverage module-scoping contract" describe block above) --
    // round 3's wording wrongly implied it shared --module-filter's substring/glob semantics.
    expect(step3.toLowerCase()).toContain('stripped');
    expect(step3.toLowerCase()).toContain('no glob');
  });

  // RC1: a module is "known" only when the user explicitly supplied an exact Gradle module
  // identity, or an earlier structured envelope in this conversation already established that
  // exact modules[].name -- never from descriptive wording alone (previous step).
  it('step: known module identity comes from an explicit statement or a prior envelope, never descriptive wording alone', () => {
    const start = protocol.indexOf('Known workflow, known module');
    const end = protocol.indexOf('**Known workflow, unclear module**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step3 = protocol.slice(start, end);
    expect(step3.toLowerCase()).toMatch(/explicit/);
    expect(step3).toMatch(/modules\[\]\.name/);
    expect(step3.toLowerCase()).toMatch(/descriptive/);
  });

  it('step: known workflow + unclear module runs describe once before a targeted dispatch', () => {
    // Scoped to this step's own text (not the whole section) -- the preceding step legitimately
    // mentions the module-scoping flags too, which would false-fail an unscoped
    // describe-before-dispatch check even after a correct implementation.
    const start = protocol.indexOf('Known workflow, unclear module');
    const end = protocol.indexOf('**Preview only**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step4 = protocol.slice(start, end);
    const describeIdx = step4.indexOf('kmp-test describe --json --project-root .');
    const dispatchIdx = step4.toLowerCase().indexOf('dispatch');
    expect(describeIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(-1);
    expect(describeIdx).toBeLessThan(dispatchIdx);
    // Round-4 fix: describe returns modules[].name WITH the leading colon: stripping it before
    // use is required specifically for --coverage-modules (proven above), so step 4 must repeat
    // this instruction rather than leaving it implicit.
    expect(step4.toLowerCase()).toContain('strip');
  });

  it('step: unclear module reads the exact value from modules[].name', () => {
    expect(protocol).toMatch(/modules\[\]\.name/);
  });

  // RC2: reading one modules[].name is insufficient when describe returns several modules --
  // candidate selection must inspect every entry and filter by the structured task capability
  // for the requested workflow/test type, never pick by a conventionally-likely name.
  it('step: unclear-module dispatch inspects every returned module and filters by task capability, never by name alone', () => {
    const start = protocol.indexOf('Known workflow, unclear module');
    const end = protocol.indexOf('**Preview only**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step4 = protocol.slice(start, end);
    expect(step4.toLowerCase()).toMatch(/\bevery\b/);
    expect(step4.toLowerCase()).toMatch(/task field/);
  });

  // RC2: one eligible candidate dispatches directly; several eligible candidates dispatch
  // globally for a broad request or ask for a single-target request; zero eligible candidates
  // never manufacture a module name or task. Neither multi-candidate path guesses.
  it('step: multiple eligible candidates dispatch globally for a broad request or ask for a single target; zero eligible never invents one', () => {
    const start = protocol.indexOf('Known workflow, unclear module');
    const end = protocol.indexOf('**Preview only**');
    const step4 = protocol.slice(start, end);
    expect(step4.toLowerCase()).toMatch(/\b1\s+eligible/);
    expect(step4.toLowerCase()).toMatch(/2\+\s+eligible/);
    expect(step4.toLowerCase()).toMatch(/dispatch\s+globally/);
    expect(step4.toLowerCase()).toMatch(/\bask\b/);
    expect(step4.toLowerCase()).toMatch(/\b0\s+eligible/);
    expect(step4.toLowerCase()).toMatch(/don.t\s+invent/);
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
    const step5 = protocol.slice(start, end);
    expect(step5).not.toMatch(/any subcommand/i);
    expect(step5).toMatch(/\bparallel\b/);
    expect(step5).toMatch(/\bcoverage\b/);
    expect(step5).toMatch(/\bbenchmark\b/);
    expect(step5).toMatch(/\bchanged\b/);
    expect(step5).toMatch(/\bandroid\b/);
  });

  // Round-5 addition: changed's own preview mechanism is --show-modules-only (lists the
  // git-derived module set without running tests), not --dry-run alone -- pointing agents only at
  // --dry-run here would still be correct but less informative for this specific subcommand.
  it('step: preview mentions --show-modules-only as changed\'s own preview flag', () => {
    const start = protocol.indexOf('**Preview only**');
    const end = protocol.indexOf('**Trust the real envelope**');
    const step5 = protocol.slice(start, end);
    expect(step5).toMatch(/--show-modules-only/);
  });

  it('step: trusts the real (non-dry-run) envelope as authoritative', () => {
    expect(protocol).toMatch(/authoritative/i);
  });

  it('step: stops once the outcome is proven', () => {
    expect(protocol).toMatch(/stop once proven/i);
  });

  // RC4: the terminal condition is operational, not abstract -- expected module/outcome present,
  // exit_code and errors[] coherent, counts/failures answer the request for executed tests.
  it('step: a successful non-dry-run envelope is terminal once it establishes the requested outcome', () => {
    const start = protocol.indexOf('Stop once proven');
    const end = protocol.indexOf('**Diagnose only on failure**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step7 = protocol.slice(start, end);
    expect(step7).toMatch(/non-dry-run/i);
    expect(step7).toMatch(/exit_code/);
    expect(step7).toMatch(/errors\[\]/);
  });

  // RC4: no post-success confirmation probe of any of these shapes -- a skipped unrelated
  // module is context, not a reason to keep exploring.
  it('step: post-success probes are explicitly excluded -- dry-run, doctor, describe, version, ls/pwd/which', () => {
    const start = protocol.indexOf('Stop once proven');
    const end = protocol.indexOf('**Diagnose only on failure**');
    const step7 = protocol.slice(start, end);
    expect(step7.toLowerCase()).toMatch(/dry-run/);
    expect(step7.toLowerCase()).toMatch(/\bdoctor\b/);
    expect(step7.toLowerCase()).toMatch(/\bdescribe\b/);
    expect(step7.toLowerCase()).toMatch(/version/);
    expect(step7.toLowerCase()).toMatch(/ls\/pwd\/which/);
  });

  it('step: an unrelated skipped[] entry does not reopen discovery', () => {
    const start = protocol.indexOf('Stop once proven');
    const end = protocol.indexOf('**Diagnose only on failure**');
    const step7 = protocol.slice(start, end);
    expect(step7).toMatch(/skipped\[\]/);
    expect(step7.toLowerCase()).toMatch(/keep\s+exploring/);
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

  it('denial recovery: a denied canonical command is final -- stop, report, no retry', () => {
    expect(protocol.toLowerCase()).toMatch(/stop and report/);
    expect(protocol.toLowerCase()).toMatch(/don.t retry|no retry/);
  });

  // Round-3 fix: round 2's version let describe's test_tasks.unit:null ALONE justify "no
  // applicable tests" -- reproduced against the real canary scenario ground truth
  // (kampkit-no-applicable-tests.json, which requires an ACTUAL executed parallel envelope, not
  // a describe-only inference) and against real describe output shape: a module can have
  // test_tasks.unit:null while test_tasks.ios:"iosX64Test" is populated and genuinely
  // dispatchable via --test-type ios -- unit:null alone would have wrongly short-circuited that.
  const NO_TEST_PARAGRAPH_ANCHOR = /For the default unit-test `parallel` workflow[\s\S]*?(?=\n\n|$)/;

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

  it('a confirmed no-test result requires a REAL non-dry-run parallel envelope, not describe alone', () => {
    const match = protocol.match(NO_TEST_PARAGRAPH_ANCHOR);
    expect(match).not.toBeNull();
    const paragraph = match[0];
    expect(paragraph).toMatch(/non-dry-run/i);
    expect(paragraph).toContain('no_test_modules');
    expect(paragraph).toContain('caused_by_filter:true');
    expect(paragraph.toLowerCase()).toMatch(/\balone\b/);
    expect(paragraph).toContain('test_tasks.unit');
    expect(paragraph).toMatch(/no applicable tests/i);
    expect(paragraph.toLowerCase()).toMatch(/\bstop\b/);
  });

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
    const match = protocol.match(NO_TEST_PARAGRAPH_ANCHOR);
    expect(match).not.toBeNull();
    const paragraph = match[0];
    expect(mentionsDeviceOrWebNearTestType(paragraph)).toBe(false);
    expect(paragraph).toMatch(/test_tasks/);
    expect(paragraph).toMatch(/flags-reference/i);
  });

  it('the no-test-outcome guidance does not enumerate specific alternate subcommands', () => {
    const match = protocol.match(NO_TEST_PARAGRAPH_ANCHOR);
    expect(match).not.toBeNull();
    const paragraph = match[0];
    expect(paragraph).not.toMatch(/\bandroid\b/i);
    expect(paragraph).not.toMatch(/\bcoverage\b/i);
    expect(paragraph).not.toMatch(/\bchanged\b/i);
    expect(paragraph).not.toMatch(/\binfo\b/i);
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

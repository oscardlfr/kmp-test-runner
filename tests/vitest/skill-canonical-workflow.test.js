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
  });

  it('step: known workflow + unclear module runs describe once before a targeted dispatch', () => {
    // Scoped to this step's own text (not the whole section) -- the preceding step legitimately
    // mentions --module-filter too, which would false-fail an unscoped describe-before-filter
    // check even after a correct implementation.
    const start = protocol.indexOf('Known workflow, unclear module');
    const end = protocol.indexOf('**Preview only**');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const step4 = protocol.slice(start, end);
    const describeIdx = step4.indexOf('kmp-test describe --json --project-root .');
    const filterIdx = step4.indexOf('--module-filter');
    expect(describeIdx).toBeGreaterThan(-1);
    expect(filterIdx).toBeGreaterThan(-1);
    expect(describeIdx).toBeLessThan(filterIdx);
  });

  it('step: unclear module reads the exact value from modules[].name', () => {
    expect(protocol).toMatch(/modules\[\]\.name/);
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

  it('step: trusts the real (non-dry-run) envelope as authoritative', () => {
    expect(protocol).toMatch(/authoritative/i);
  });

  it('step: stops once the outcome is proven', () => {
    expect(protocol).toMatch(/stop once proven/i);
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

  it('denial recovery: a denied exploratory probe is abandoned, not retried', () => {
    expect(protocol.toLowerCase()).toMatch(/abandon/);
    expect(protocol.toLowerCase()).toMatch(/next canonical/);
  });

  it('denial recovery: a denied canonical command is final -- stop, report, no retry', () => {
    expect(protocol.toLowerCase()).toMatch(/stop and report/);
    expect(protocol.toLowerCase()).toMatch(/don.t retry|no retry/);
  });

  // Round-2 fixes: (a) explicitly scoped to the `parallel` workflow -- a targeted parallel
  // result only proves absence of unit-test modules, and this rule must not terminate an
  // android/coverage/benchmark/changed request; (b) requires describe-CONFIRMED evidence
  // (modules[].test_tasks.unit:null) rather than trusting a bare no_test_modules code alone --
  // reached via the known-module (no-describe) path, that same code can also mean the module
  // name was wrong, not that it genuinely has no tests; (c) the test now actually asserts "stop"
  // appears (the previous version's name claimed this but never checked it).
  const NO_TEST_PARAGRAPH_ANCHOR = /When the resolved workflow is `parallel`[\s\S]*?(?=\n\n|$)/;

  it('a confirmed no-test result requires describe-confirmed evidence, scoped to parallel, and stops', () => {
    const match = protocol.match(NO_TEST_PARAGRAPH_ANCHOR);
    expect(match).not.toBeNull();
    const paragraph = match[0];
    expect(paragraph).toContain('test_tasks.unit');
    expect(paragraph).toMatch(/\bnull\b/);
    expect(paragraph).toContain('no_test_modules');
    expect(paragraph).toContain('caused_by_filter:true');
    expect(paragraph).toMatch(/no applicable tests/i);
    expect(paragraph.toLowerCase()).toMatch(/\bstop\b/);
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

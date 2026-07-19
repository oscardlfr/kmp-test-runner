// tests/vitest/skill-canonical-workflow.test.js
// Regression coverage for SKILL.md's canonical agent workflow: dispatch-first with doctor only
// on failure, no consumer-cwd-relative script paths, no policy-denied commands even in the
// "optional" Environment detection section, no stale hardcoded version, frontmatter untouched,
// and relative doc references still resolve. Section-scoped (not whole-file substring checks) so
// a fix landing in the wrong section can't produce a false green.
import { describe, it, expect } from 'vitest';
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

const EXPECTED_DESCRIPTION = "Parallel test runner for Kotlin Multiplatform (KMP) and Android Gradle projects via the kmp-test CLI. Runs unit tests, instrumented tests on devices and emulators, coverage (kover/jacoco), and benchmarks across multi-module projects. Use when the user asks to run tests, the project is slow with gradle's default sequential dispatch, or the agent needs structured JSON output to parse failures and module attribution.";

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

describe('Quick start -- dispatch-first, no unconditional doctor call', () => {
  const quickStart = section('Quick start');

  it('shows exactly one canonical command', () => {
    const codeBlocks = quickStart.match(/```bash\n([\s\S]*?)```/g) || [];
    expect(codeBlocks).toHaveLength(1);
    const cmdLines = codeBlocks[0].split('\n').filter((l) => l.trim() && !l.startsWith('```'));
    expect(cmdLines).toHaveLength(1);
    expect(cmdLines[0]).toMatch(/^kmp-test \S+ --json --project-root \.$/);
  });

  it('does not run doctor unconditionally', () => {
    const codeBlocks = quickStart.match(/```bash\n([\s\S]*?)```/g) || [];
    expect(codeBlocks[0]).not.toMatch(/^kmp-test doctor/m);
  });

  it('mentions doctor only as a conditional follow-up for exit_code 3', () => {
    expect(quickStart).toMatch(/exit_code.*3/);
    expect(quickStart).toContain('kmp-test doctor --json --project-root .');
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

describe('Steps -- dispatch first, conditional diagnosis', () => {
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

  it('doctor appears only under conditional framing', () => {
    expect(steps).toContain('kmp-test doctor --json --project-root .');
    expect(steps).toMatch(/skip this step unless|only if/i);
  });

  it('"Run the relevant test type" precedes "Diagnose" (dispatch-first ordering)', () => {
    const runIdx = steps.indexOf('Run the relevant test type');
    const diagnoseIdx = steps.indexOf('Diagnose only if');
    expect(runIdx).toBeGreaterThan(-1);
    expect(diagnoseIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeLessThan(diagnoseIdx);
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

  it('the --version verification line names no specific version number', () => {
    const line = skillMd.split('\n').find((l) => l.includes('kmp-test --version'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/\d+\.\d+\.\d+/);
  });
});

describe('SKILL.md frontmatter description is unchanged', () => {
  it('matches the known description verbatim', () => {
    const match = skillMd.match(/^description:\s*"(.*)"\s*$/m);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(EXPECTED_DESCRIPTION);
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

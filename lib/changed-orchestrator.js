// SPDX-License-Identifier: MIT
// lib/changed-orchestrator.js — Node-side `kmp-test changed` orchestrator
// (v0.8 PIVOT, sub-entry 2). Replaces scripts/sh/run-changed-modules-tests.sh
// (293 LOC) + scripts/ps1/run-changed-modules-tests.ps1 (315 LOC) — together
// they hand-rolled a hardcoded "core/feature/shared/data/ui" prefix heuristic
// that missed top-level KMP modules like Confetti's `:shared` (WS-4).
//
// The new orchestrator walks the actual `discoverIncludedModules()` list from
// settings.gradle.kts and uses longest-prefix matching against the changed
// file paths — every module declared in settings is recognized regardless of
// nesting depth. WS-4 is closed by construction.
//
// v0.8 sub-entry 5: subprocess hop replaced with in-process call to
// runParallel from lib/parallel-orchestrator.js. The orchestrator computes
// the changed-module list, then delegates execution to runParallel with the
// resolved --module-filter. PRODUCT.md "logic in Node, plumbing in shell".

import { spawnSync } from 'node:child_process';

import {
  buildJsonReport,
  envErrorJson,
  buildDryRunReport,
  EXIT,
} from './cli.js';
import { discoverIncludedModules } from './orchestrator-utils.js';
import { runParallel } from './parallel-orchestrator.js';

// Argparse for changed-specific flags. Global flags (--json, --force, etc.)
// were stripped by lib/runner.js; whatever else remains we forward verbatim
// to the parallel suite.
function parseArgs(argv) {
  const out = {
    includeShared: false,
    testType: '',
    stagedOnly: false,
    showModulesOnly: false,
    maxFailures: 0,
    minMissedLines: 0,
    coverageTool: '',
    excludeCoverage: '',
    testFilter: '',
    excludeModules: '',
    includeUntested: false,
    noCoverage: false,
    ignoreJdkMismatch: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--include-shared':       out.includeShared = true; break;
      case '--test-type':            out.testType = argv[++i] || ''; break;
      case '--staged-only':          out.stagedOnly = true; break;
      case '--show-modules-only':    out.showModulesOnly = true; break;
      case '--max-failures':         out.maxFailures = Number(argv[++i] || 0); break;
      case '--min-missed-lines':     out.minMissedLines = Number(argv[++i] || 0); break;
      case '--coverage-tool':        out.coverageTool = argv[++i] || ''; break;
      case '--exclude-coverage':     out.excludeCoverage = argv[++i] || ''; break;
      case '--test-filter':          out.testFilter = argv[++i] || ''; break;
      case '--exclude-modules':      out.excludeModules = argv[++i] || ''; break;
      case '--include-untested':     out.includeUntested = true; break;
      case '--no-coverage':          out.noCoverage = true; break;
      case '--ignore-jdk-mismatch':  out.ignoreJdkMismatch = true; break;
      case '--dry-run':              out.dryRun = true; break;
      default: /* unknown — drop, runner.js already stripped globals */ break;
    }
  }
  return out;
}

// Run a git command via the injected spawn. Returns {status, stdout, stderr}.
function runGit(spawn, projectRoot, gitArgs) {
  const result = spawn('git', gitArgs, { cwd: projectRoot, encoding: 'utf8' });
  return {
    status: (result && typeof result.status === 'number') ? result.status : 1,
    stdout: (result && result.stdout) || '',
    stderr: (result && result.stderr) || '',
    error: result?.error ?? null,
  };
}

// Parse `git status --porcelain` output to extract file paths. Mirrors the
// PS1 wrapper's regex (run-changed-modules-tests.ps1:106-113) so behavior
// is identical to the legacy path. Handles renames (`X -> Y`) by keeping Y.
function parsePorcelain(output) {
  const out = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    const m = rawLine.match(/^.{2,3}(.+)$/);
    if (!m) continue;
    let file = m[1].replace(/^"/, '').replace(/"$/, '');
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    file = file.trim();
    if (file) out.push(file);
  }
  return out;
}

// Walk settings.gradle.kts → list of `(modulePath, moduleName)` tuples sorted
// by path-length descending. Longest-prefix wins for nested modules
// (`:core:domain` beats `:core` for a file under core/domain/...).
function buildModulePrefixIndex(projectRoot) {
  const modules = discoverIncludedModules(projectRoot);
  const tuples = modules.map(name => ({
    name,
    pathPrefix: name.split(':').join('/'),
  }));
  tuples.sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  return tuples;
}

// Map a single relative file path to its owning module name. Returns null
// for files outside any module (root-level build.gradle.kts, libs.versions.toml,
// etc.). The longest-prefix-match handles all 18 sourceSetNames structurally
// because every source set lives under <module>/src/<sourceSet>/, so any file
// under <module>/ matches regardless of source-set name (closes WS-4).
function mapFileToModule(filePath, prefixIndex) {
  const norm = filePath.replace(/\\/g, '/');
  for (const { name, pathPrefix } of prefixIndex) {
    if (norm === pathPrefix) return name;
    if (norm.startsWith(pathPrefix + '/')) return name;
  }
  return null;
}

// Build the kebab-case argv that runParallel expects. Mirrors the flag set
// the legacy subprocess hop forwarded.
function buildParallelArgs(opts, moduleFilter) {
  const a = ['--project-root', opts.projectRoot, '--module-filter', moduleFilter];
  if (opts.minMissedLines)    a.push('--min-missed-lines', String(opts.minMissedLines));
  if (opts.testType)          a.push('--test-type', opts.testType);
  if (opts.includeShared)     a.push('--include-shared');
  if (opts.coverageTool)      a.push('--coverage-tool', opts.coverageTool);
  if (opts.excludeCoverage)   a.push('--exclude-coverage', opts.excludeCoverage);
  if (opts.testFilter)        a.push('--test-filter', opts.testFilter);
  if (opts.excludeModules)    a.push('--exclude-modules', opts.excludeModules);
  if (opts.includeUntested)   a.push('--include-untested');
  if (opts.noCoverage)        a.push('--no-coverage');
  // --ignore-jdk-mismatch is consumed by lib/runner.js before the
  // orchestrator branch dispatches; runParallel does not re-check it.
  return a;
}

// Main entrypoint
export async function runChanged({
  projectRoot,
  args = [],
  env = process.env,
  spawn = spawnSync,
  log = () => {},
  // Test-only override: inject a runParallel stub instead of importing the
  // real one. Lets vitest assert the in-process call shape without spawning
  // gradle.
  runParallelInjection = null,
}) {
  const startTime = Date.now();
  const opts = parseArgs(args);
  opts.projectRoot = projectRoot;

  // F1: --dry-run short-circuit — emit the resolved plan and exit before any
  // git probe, module discovery, or runParallel dispatch. cli.js intercepts
  // upstream for `bin/kmp-test.js`, but direct `node lib/runner.js changed
  // --dry-run` invocations now honor it.
  if (opts.dryRun) {
    const envelope = buildDryRunReport({
      subcommand: 'changed',
      projectRoot,
      plan: {
        test_type: opts.testType || 'auto',
        staged_only: opts.stagedOnly,
        show_modules_only: opts.showModulesOnly,
        coverage_tool: opts.coverageTool || 'auto',
      },
    });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // Banner
  // ---------------------------------------------------------------
  log('');
  log('========================================');
  log('  Test Changed Modules');
  log('========================================');
  log(`Project: ${projectRoot}`);
  log(`Mode: ${opts.stagedOnly ? 'Staged only' : 'All changes'}`);
  log('');

  // ---------------------------------------------------------------
  // 1. Validate git repo
  // ---------------------------------------------------------------
  const gitProbe = runGit(spawn, projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (gitProbe.status !== 0) {
    const msg = `Not a git repository: ${projectRoot}`;
    log(`[ERROR] ${msg}`);
    const envelope = envErrorJson({
      subcommand: 'changed',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: msg,
      code: 'no_changed_modules',
    });
    envelope.changed = {
      detected_modules: [],
      staged_only: opts.stagedOnly,
      base_ref: 'HEAD',
    };
    return { envelope, exitCode: EXIT.ENV_ERROR };
  }

  // ---------------------------------------------------------------
  // 2. Get changed files
  // ---------------------------------------------------------------
  let files;
  if (opts.stagedOnly) {
    const r = runGit(spawn, projectRoot, ['diff', '--cached', '--name-only']);
    files = r.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else {
    const r = runGit(spawn, projectRoot, ['status', '--porcelain']);
    files = parsePorcelain(r.stdout);
  }

  // ---------------------------------------------------------------
  // 3. Map files → modules via longest-prefix match
  // ---------------------------------------------------------------
  const prefixIndex = buildModulePrefixIndex(projectRoot);
  const fileCounts = new Map();
  const detected = [];
  for (const file of files) {
    const mod = mapFileToModule(file, prefixIndex);
    if (!mod) continue;
    if (!detected.includes(mod)) detected.push(mod);
    fileCounts.set(mod, (fileCounts.get(mod) || 0) + 1);
  }

  // ---------------------------------------------------------------
  // 4. --include-shared filter (mirrors bash line 143 + PS1 line 197)
  // ---------------------------------------------------------------
  let detectedFiltered = detected;
  const sharedName = env.SHARED_PROJECT_NAME || '';
  if (!opts.includeShared && sharedName) {
    detectedFiltered = detected.filter(m => !m.includes(sharedName));
  }
  detectedFiltered.sort();

  // ---------------------------------------------------------------
  // 5. Zero modules → no_changed_modules + exit 0
  // ---------------------------------------------------------------
  if (detectedFiltered.length === 0) {
    log('[WARN] No modules with uncommitted changes detected.');
    log('');
    log('  Possible reasons:');
    log('    - No changes in module source directories');
    log('    - Changes only in non-module files (root scripts, etc.)');
    log('    - Use --include-shared to include sibling shared-libs changes (SHARED_PROJECT_NAME)');
    const envelope = envErrorJson({
      subcommand: 'changed',
      projectRoot,
      durationMs: Date.now() - startTime,
      message: 'No modules with uncommitted changes detected.',
      code: 'no_changed_modules',
    });
    // envErrorJson sets exit_code from EXIT.ENV_ERROR; clean zero-set is
    // exit 0 per BACKLOG line 105 ("zero detected modules → no_changed_modules
    // + exit_code:0"). Override.
    envelope.exit_code = EXIT.SUCCESS;
    envelope.changed = {
      detected_modules: [],
      staged_only: opts.stagedOnly,
      base_ref: 'HEAD',
    };
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // 6. Banner: detected modules
  // ---------------------------------------------------------------
  log('Modules with changes:');
  for (const mod of detectedFiltered) {
    const count = fileCounts.get(mod) || 0;
    log(`  :${mod} (${count} files)`);
  }
  log('');

  // ---------------------------------------------------------------
  // 7. --show-modules-only short-circuit
  // ---------------------------------------------------------------
  if (opts.showModulesOnly) {
    log('[NOTICE] Dry run - no tests executed.');
    const envelope = buildJsonReport({
      subcommand: 'changed',
      projectRoot,
      exitCode: EXIT.SUCCESS,
      durationMs: Date.now() - startTime,
      parsed: {
        tests: { total: 0, passed: 0, failed: 0, skipped: 0 },
        modules: detectedFiltered,
        skipped: [],
        coverage: { tool: 'auto', missed_lines: null },
        errors: [],
        warnings: [],
        changed: {
          detected_modules: detectedFiltered,
          staged_only: opts.stagedOnly,
          base_ref: 'HEAD',
        },
      },
    });
    return { envelope, exitCode: EXIT.SUCCESS };
  }

  // ---------------------------------------------------------------
  // 8. In-process delegate to runParallel (sub-entry 5: subprocess hop
  //    eliminated). The orchestrator hands runParallel the resolved
  //    --module-filter and merges the returned envelope's parsed shape
  //    back, augmented with the changed:{} field.
  // ---------------------------------------------------------------
  const moduleFilter = detectedFiltered.join(',');
  log(`Running tests on: ${moduleFilter}`);
  log('');

  const runParallelFn = runParallelInjection || runParallel;
  const parallelArgs = buildParallelArgs(opts, moduleFilter);
  const { envelope: parallelEnvelope, exitCode } = await runParallelFn({
    projectRoot,
    args: parallelArgs,
    env,
    log,
  });

  // ---------------------------------------------------------------
  // 9. Build envelope from parallel result + changed:{} augmentation.
  //    We rebuild via buildJsonReport so the `subcommand` field flips
  //    from 'parallel' back to 'changed' and the changed:{} field is
  //    added at the top level.
  // ---------------------------------------------------------------
  const envelope = buildJsonReport({
    subcommand: 'changed',
    projectRoot,
    exitCode,
    durationMs: Date.now() - startTime,
    parsed: {
      tests: parallelEnvelope.tests,
      modules: parallelEnvelope.modules,
      skipped: parallelEnvelope.skipped,
      coverage: parallelEnvelope.coverage,
      errors: parallelEnvelope.errors,
      warnings: parallelEnvelope.warnings,
      changed: {
        detected_modules: detectedFiltered,
        staged_only: opts.stagedOnly,
        base_ref: 'HEAD',
      },
    },
  });

  return { envelope, exitCode };
}

export {
  parseArgs,
  parsePorcelain,
  buildModulePrefixIndex,
  mapFileToModule,
  buildParallelArgs,
};

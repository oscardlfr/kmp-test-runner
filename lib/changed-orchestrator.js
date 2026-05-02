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
// Subprocess dispatch: per BACKLOG sub-entry 5 note, PR2 keeps the parallel
// suite as a subprocess. Once sub-entry 5 lands, this orchestrator flips to
// `import { runParallel } from './parallel-orchestrator.js'` for in-process
// dispatch. PRODUCT.md "logic in Node, plumbing in shell".

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildJsonReport,
  envErrorJson,
  parseScriptOutput,
  applyErrorCodeDiscriminators,
  EXIT,
} from './cli.js';
import { discoverIncludedModules } from './orchestrator-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');

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

// Build the parallel-coverage-suite command + args for the OS we're on.
// Returns { cmd, args } that the spawn callable can dispatch.
function pickSuiteCommand(opts, moduleFilter, suiteScriptOverride) {
  const isWindows = process.platform === 'win32';
  const suitePath = suiteScriptOverride
    || (isWindows
        ? path.join(SCRIPTS_DIR, 'ps1', 'run-parallel-coverage-suite.ps1')
        : path.join(SCRIPTS_DIR, 'sh', 'run-parallel-coverage-suite.sh'));
  const suiteArgs = [];
  // The ps1 wrapper uses PascalCase params; the sh wrapper uses kebab-case.
  // For PR2 we keep both shapes — the cli.js `translateFlagForPowerShell`
  // already exists for this. Inline minimally here.
  if (isWindows) {
    suiteArgs.push('-File', suitePath, '-ProjectRoot', opts.projectRoot, '-ModuleFilter', moduleFilter);
    if (opts.minMissedLines)    suiteArgs.push('-MinMissedLines', String(opts.minMissedLines));
    if (opts.testType)          suiteArgs.push('-TestType', opts.testType);
    if (opts.includeShared)     suiteArgs.push('-IncludeShared');
    if (opts.coverageTool)      suiteArgs.push('-CoverageTool', opts.coverageTool);
    if (opts.excludeCoverage)   suiteArgs.push('-ExcludeCoverage', opts.excludeCoverage);
    if (opts.testFilter)        suiteArgs.push('-TestFilter', opts.testFilter);
    if (opts.excludeModules)    suiteArgs.push('-ExcludeModules', opts.excludeModules);
    if (opts.includeUntested)   suiteArgs.push('-IncludeUntested');
    if (opts.ignoreJdkMismatch) suiteArgs.push('-IgnoreJdkMismatch');
    return { cmd: 'powershell', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...suiteArgs] };
  }
  suiteArgs.push(suitePath, '--project-root', opts.projectRoot, '--module-filter', moduleFilter);
  if (opts.minMissedLines)    suiteArgs.push('--min-missed-lines', String(opts.minMissedLines));
  if (opts.testType)          suiteArgs.push('--test-type', opts.testType);
  if (opts.includeShared)     suiteArgs.push('--include-shared');
  if (opts.coverageTool)      suiteArgs.push('--coverage-tool', opts.coverageTool);
  if (opts.excludeCoverage)   suiteArgs.push('--exclude-coverage', opts.excludeCoverage);
  if (opts.testFilter)        suiteArgs.push('--test-filter', opts.testFilter);
  if (opts.excludeModules)    suiteArgs.push('--exclude-modules', opts.excludeModules);
  if (opts.includeUntested)   suiteArgs.push('--include-untested');
  if (opts.ignoreJdkMismatch) suiteArgs.push('--ignore-jdk-mismatch');
  return { cmd: 'bash', args: suiteArgs };
}

// Main entrypoint
export async function runChanged({
  projectRoot,
  args = [],
  env = process.env,
  spawn = spawnSync,
  log = () => {},
  // Test-only override: directly target a fake parallel-suite path.
  suiteScriptOverride = null,
}) {
  const startTime = Date.now();
  const opts = parseArgs(args);
  opts.projectRoot = projectRoot;

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
  // 8. Dispatch to parallel coverage suite (subprocess; PR5 → in-process)
  // ---------------------------------------------------------------
  const moduleFilter = detectedFiltered.join(',');
  log(`Running tests on: ${moduleFilter}`);
  log('');

  const { cmd, args: suiteArgs } = pickSuiteCommand(opts, moduleFilter, suiteScriptOverride);
  const result = spawn(cmd, suiteArgs, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...env },
  });
  const exitCode = (result && typeof result.status === 'number') ? result.status : 1;
  const capturedStdout = (result && result.stdout) || '';
  const capturedStderr = (result && result.stderr) || '';

  // Pipe banners through to the user's terminal.
  if (capturedStdout) {
    for (const line of capturedStdout.split(/\r?\n/)) {
      if (line) log(line);
    }
  }

  // ---------------------------------------------------------------
  // 9. Parse parallel-suite output via lib/cli.js parser (legacy chain
  //    until sub-entry 5 in-process dispatch).
  // ---------------------------------------------------------------
  const parsed = parseScriptOutput(capturedStdout, capturedStderr, suiteArgs, 'parallel');

  // applyErrorCodeDiscriminators upgrades generic codes (task_not_found,
  // unsupported_class_version, instrumented_setup_failed) into the parsed.errors
  // structure based on output regex. The legacy parser may have already
  // surfaced some — running this as a final pass is idempotent.
  const stateForDiscrim = { errors: parsed.errors || [] };
  applyErrorCodeDiscriminators(capturedStdout, capturedStderr, stateForDiscrim);
  parsed.errors = stateForDiscrim.errors;

  // ---------------------------------------------------------------
  // 10. Augment parsed with changed:{} field
  // ---------------------------------------------------------------
  parsed.changed = {
    detected_modules: detectedFiltered,
    staged_only: opts.stagedOnly,
    base_ref: 'HEAD',
  };

  // ---------------------------------------------------------------
  // 11. Build envelope
  // ---------------------------------------------------------------
  const envelope = buildJsonReport({
    subcommand: 'changed',
    projectRoot,
    exitCode,
    durationMs: Date.now() - startTime,
    parsed,
  });

  return { envelope, exitCode };
}

export {
  parseArgs,
  parsePorcelain,
  buildModulePrefixIndex,
  mapFileToModule,
};

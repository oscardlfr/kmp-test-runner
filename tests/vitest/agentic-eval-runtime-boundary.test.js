// tests/vitest/agentic-eval-runtime-boundary.test.js
// Static, source-text checks proving the dependency direction the runtime-adapter refactor
// requires: lifecycle/gates/graders/audits/CLI depend only on runtimes/contract.mjs (or, for
// matrix-runner.mjs, additionally the Claude singleton default); nothing outside
// runtimes/claude-code.mjs (and the launcher/auth/env internal chain those files already form)
// may import stream-parser.mjs, condition-launcher.mjs, auth-preflight.mjs or env-builder.mjs;
// and no core module reaches into a provider-native event shape or a legacy conditionResult
// field directly. Reads real source files as text -- never imports them -- so this test never
// itself becomes a new consumer of the modules it is policing.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTIC_DIR = join(__dirname, '..', '..', 'tools', 'agentic-eval');

function read(relPath) {
  return readFileSync(join(AGENTIC_DIR, relPath), 'utf8');
}

// Post-review hardening (round 1): a static, hand-maintained file list means a newly added .mjs
// file that ITSELF violates the boundary (imports stream-parser.mjs directly, say) stays invisible
// to every check below unless someone remembers to add it here too -- CI stays green on a real
// violation. A real recursive walk closes that gap; fs.readdirSync's own `recursive: true` option
// needs Node 20.1+ (package.json declares >=18), so this walks manually instead. Covers the WHOLE
// tools/agentic-eval/ tree, including runtimes/ -- previously a separately-manifested, hand-listed
// exception (see the boundary-repo-wide describe block below, which now needs no such carve-out).
function walkMjsFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMjsFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      results.push(relative(baseDir, fullPath).split(sep).join('/'));
    }
  }
  return results;
}

const ALL_AGENTIC_MJS_FILES = walkMjsFiles(AGENTIC_DIR);

it('the recursive walk actually found files (catches a walker regression that would silently pass every "no violation" check below by finding nothing)', () => {
  expect(ALL_AGENTIC_MJS_FILES.length).toBeGreaterThan(25);
  expect(ALL_AGENTIC_MJS_FILES).toContain('cli.mjs');
  expect(ALL_AGENTIC_MJS_FILES).toContain('stream-parser.mjs');
  expect(ALL_AGENTIC_MJS_FILES).toContain('runtimes/contract.mjs');
  expect(ALL_AGENTIC_MJS_FILES).toContain('runtimes/claude-code.mjs');
});

it('ALL_AGENTIC_MJS_FILES sanity: every discovered file actually exists and reads cleanly', () => {
  for (const file of ALL_AGENTIC_MJS_FILES) {
    expect(() => read(file)).not.toThrow();
  }
});

const CORE_CONSUMERS = ['cli.mjs', 'matrix-runner.mjs', 'cell-integrity.mjs', 'graders.mjs', 'accepted-run-audit.mjs', 'junit-evidence.mjs'];
const RUNTIME_ONLY_MODULES = ['stream-parser.mjs', 'condition-launcher.mjs', 'auth-preflight.mjs', 'env-builder.mjs'];
// The internal launcher/auth/env chain those 4 modules already form among themselves, plus the
// one new adapter file -- the ONLY importers RUNTIME_ONLY_MODULES may ever gain.
const ALLOWED_IMPORTERS_OF_RUNTIME_ONLY_MODULES = new Set([
  'condition-launcher.mjs', // imports env-builder.mjs
  'auth-preflight.mjs', // imports condition-launcher.mjs
  'runtimes/claude-code.mjs', // the sole new consumer -- now walked at its real nested path
]);

function importsFromRelative(src, moduleFile) {
  const escaped = moduleFile.replace(/\./g, '\\.');
  return new RegExp(`from\\s+['"]\\.\\/${escaped}['"]`).test(src)
    || new RegExp(`from\\s+['"]\\.\\.\\/${escaped}['"]`).test(src)
    || new RegExp(`from\\s+['"]\\.\\/runtimes\\/\\.\\.\\/${escaped}['"]`).test(src);
}

describe('boundary -- the six core consumers never import a runtime-only module directly', () => {
  for (const consumer of CORE_CONSUMERS) {
    for (const runtimeModule of RUNTIME_ONLY_MODULES) {
      it(`${consumer} does not import ./${runtimeModule}`, () => {
        const src = read(consumer);
        expect(importsFromRelative(src, runtimeModule)).toBe(false);
      });
    }
  }
});

describe('boundary -- matrix-runner.mjs depends on the Claude runtime singleton, not launcher/parser directly', () => {
  it('imports runtimes/claude-code.mjs', () => {
    const src = read('matrix-runner.mjs');
    expect(/from\s+['"]\.\/runtimes\/claude-code\.mjs['"]/.test(src)).toBe(true);
  });

  it('does not import runtimes/contract.mjs\'s runtime-only dependencies via any other path', () => {
    const src = read('matrix-runner.mjs');
    for (const runtimeModule of RUNTIME_ONLY_MODULES) {
      expect(importsFromRelative(src, runtimeModule)).toBe(false);
    }
  });
});

// Not all 6 CORE_CONSUMERS literally import a symbol from contract.mjs -- the architectural
// requirement is that none of them ever import a RUNTIME_ONLY_MODULE (proven by the describe block
// above) and that every one of them works exclusively off the already-validated observation shape,
// not that each one calls a contract.mjs generic helper. cell-integrity.mjs (deliberately
// self-contained -- see its own doc comment) and junit-evidence.mjs (its own migration only ever
// needed a plain `b.preDispatchBlock?.recognized` field read, never a generic helper) satisfy the
// architecture transitively, via the shape of the data other, already-migrated consumers pass them
// -- confirmed by direct inspection of both files' current import lists.
const CONSUMERS_THAT_IMPORT_CONTRACT = CORE_CONSUMERS.filter((c) => c !== 'cell-integrity.mjs' && c !== 'junit-evidence.mjs');
describe('boundary -- every core consumer that needs a contract.mjs generic helper imports it', () => {
  for (const consumer of CONSUMERS_THAT_IMPORT_CONTRACT) {
    it(`${consumer} imports ./runtimes/contract.mjs`, () => {
      const src = read(consumer);
      expect(/from\s+['"]\.\/runtimes\/contract\.mjs['"]/.test(src)).toBe(true);
    });
  }
});

describe('boundary -- RUNTIME_ONLY_MODULES gain no new importers repo-wide', () => {
  for (const runtimeModule of RUNTIME_ONLY_MODULES) {
    it(`only the allowed internal chain (+ runtimes/claude-code.mjs) imports ./${runtimeModule}`, () => {
      const actualImporters = [];
      for (const file of ALL_AGENTIC_MJS_FILES) {
        if (file === runtimeModule) continue; // a module never "imports" itself
        const src = read(file);
        if (importsFromRelative(src, runtimeModule)) actualImporters.push(file);
      }
      // runtimes/claude-code.mjs itself lives under tools/agentic-eval/runtimes/, outside
      // ALL_AGENTIC_MJS_FILES's flat top-level manifest -- checked directly, separately, below.
      for (const importer of actualImporters) {
        expect(ALLOWED_IMPORTERS_OF_RUNTIME_ONLY_MODULES.has(importer)).toBe(true);
      }
    });
  }

  // env-builder.mjs is deliberately excluded from the DIRECT-import requirement below --
  // condition-launcher.mjs (frozen, byte-identical) already imports it and calls buildEvalEnv
  // internally as part of buildSharedEnv's own construction (confirmed by direct inspection: `const
  // baseEnv = buildEvalEnv(process.env);`), so its allowlist-filtering security guarantee reaches
  // claude-code.mjs -- and hence every real spawn -- transitively through condition-launcher.mjs,
  // which claude-code.mjs DOES import directly (proven by the loop below). Requiring a second,
  // redundant direct import here would prove nothing about the seam that a transitive one doesn't
  // already prove just as strongly.
  it('runtimes/claude-code.mjs imports the other three runtime-only modules directly (it is the composition seam)', () => {
    const src = read(join('runtimes', 'claude-code.mjs'));
    for (const runtimeModule of RUNTIME_ONLY_MODULES.filter((m) => m !== 'env-builder.mjs')) {
      const escaped = runtimeModule.replace(/\./g, '\\.');
      expect(new RegExp(`from\\s+['"]\\.\\.\\/${escaped}['"]`).test(src)).toBe(true);
    }
  });

  it('condition-launcher.mjs (which claude-code.mjs imports directly) is the module that actually reaches env-builder.mjs -- the transitive path is real, not assumed', () => {
    const claudeCodeSrc = read(join('runtimes', 'claude-code.mjs'));
    expect(/from\s+['"]\.\.\/condition-launcher\.mjs['"]/.test(claudeCodeSrc)).toBe(true);
    const conditionLauncherSrc = read('condition-launcher.mjs');
    expect(/from\s+['"]\.\/env-builder\.mjs['"]/.test(conditionLauncherSrc)).toBe(true);
    expect(/buildEvalEnv\(/.test(conditionLauncherSrc)).toBe(true);
  });

  it('runtimes/contract.mjs imports none of the four runtime-only modules -- it stays runtime-agnostic', () => {
    const src = read(join('runtimes', 'contract.mjs'));
    for (const runtimeModule of RUNTIME_ONLY_MODULES) {
      expect(importsFromRelative(src, runtimeModule)).toBe(false);
      const escaped = runtimeModule.replace(/\./g, '\\.');
      expect(new RegExp(`from\\s+['"]\\.\\.\\/${escaped}['"]`).test(src)).toBe(false);
    }
  });
});

describe('boundary -- no legacy raw-event field reaches a core consumer', () => {
  const legacyFieldRefs = ['conditionResult.events', 'runA.events', 'runB.events', 'spawnResult.rawStdout'];
  for (const consumer of CORE_CONSUMERS) {
    for (const ref of legacyFieldRefs) {
      it(`${consumer} does not reference "${ref}"`, () => {
        const src = read(consumer);
        expect(src.includes(ref)).toBe(false);
      });
    }
  }
});

describe('boundary -- no direct provider-native key access in a core consumer', () => {
  const providerNativePatterns = [
    { label: '.is_error', re: /\.is_error\b/ },
    { label: '.num_turns', re: /\.num_turns\b/ },
    { label: '.permissionMode', re: /\.permissionMode\b/ },
    { label: '.mcp_servers', re: /\.mcp_servers\b/ },
    { label: '.tool_use_result', re: /\.tool_use_result\b/ },
    { label: '.message.content', re: /\.message\.content\b/ },
    // Quoted-literal-scoped, not a blanket word sweep -- cli.mjs legitimately carries prose
    // comments describing this wire subtype (e.g. "a hook_response with unparseable output JSON
    // produces neither an allow nor a deny decision") when explaining WHY a check exists; only an
    // actual string-literal comparison against the raw subtype value is the real violation.
    { label: "'hook_started'", re: /['"]hook_started['"]/ },
    { label: "'hook_response'", re: /['"]hook_response['"]/ },
  ];
  for (const consumer of CORE_CONSUMERS) {
    for (const { label, re } of providerNativePatterns) {
      it(`${consumer} does not access "${label}"`, () => {
        const src = read(consumer);
        expect(re.test(src)).toBe(false);
      });
    }
  }
});

describe('boundary -- no anticipated multi-runtime scaffolding exists yet', () => {
  // Scoped to actual code constructs (import specifiers, id string literals, class/adapter
  // names), never a blanket word-boundary sweep -- this codebase's own comments legitimately
  // reference "Codex" as the code-review tool used on past PRs (see cli.mjs's "post-Codex-audit
  // fix (PR #418, ...)" comments), which has nothing to do with a Codex RUNTIME ADAPTER. A bare
  // /\bcodex\b/i check false-positives on that pre-existing, unrelated prose.
  const forbiddenAcrossAll = [
    { label: 'a runtime-selector switch/if', re: /runtime\s*===\s*['"]claude-code['"]/ },
    { label: 'a --runtime CLI flag', re: /--runtime\b/ },
    { label: 'a --execution-profile CLI flag', re: /--execution-profile\b/ },
    { label: 'a --provider CLI flag', re: /--provider\b/ },
    { label: 'a registry.json reference', re: /registry\.json/ },
    { label: 'a schema-v6 marker', re: /schema[-_ ]?v?6\b/i },
    { label: 'a Codex runtime adapter construct', re: /codex-code\.mjs|runtimes\/codex|CodexRuntimeAdapter|id:\s*['"]codex['"]/i },
    { label: 'a Copilot runtime adapter construct', re: /copilot-code\.mjs|runtimes\/copilot|CopilotRuntimeAdapter|id:\s*['"]copilot['"]/i },
    { label: 'an Antigravity runtime adapter construct', re: /antigravity-code\.mjs|runtimes\/antigravity|AntigravityRuntimeAdapter|id:\s*['"]antigravity['"]/i },
  ];
  for (const file of [...ALL_AGENTIC_MJS_FILES, join('runtimes', 'contract.mjs'), join('runtimes', 'claude-code.mjs')]) {
    for (const { label, re } of forbiddenAcrossAll) {
      it(`${file} contains no ${label}`, () => {
        let src;
        try {
          src = read(file);
        } catch {
          return; // runtimes/*.mjs may not exist yet pre-Stage-2 -- covered once they do
        }
        expect(re.test(src)).toBe(false);
      });
    }
  }
});

describe('boundary -- runtimes/contract.mjs adapter validator rejects an ad hoc runtime switch by construction', () => {
  it('the contract module never imports node:child_process directly (spawning stays inside the adapter, not the generic contract)', () => {
    const src = read(join('runtimes', 'contract.mjs'));
    expect(src.includes("from 'node:child_process'")).toBe(false);
  });
});

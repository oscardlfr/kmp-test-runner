// SPDX-License-Identifier: MIT
// lib/parsers/junit-xml.js — gradle/AGP JUnit-XML walking + per-testcase
// failure extraction. Pure functions. Re-exported from
// parallel-orchestrator.js for back-compat with tests that import these
// names directly.
//
// NOT used by android-orchestrator.js — that orchestrator parses gradle
// stdout (regex-on-text) instead of walking XML files on disk; semantics
// are irreconcilable (different input source, different timing model,
// different output shapes).

import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Oversized-XML guard
// ---------------------------------------------------------------------------
// forEachJunitXml reads every TEST-*.xml whole; a pathological report (huge
// <system-out> CDATA) can reach hundreds of MB and spike RAM across a
// multi-module walk. Files above the cap are skipped and reported through the
// optional anomaly collector so callers can surface a `junit_xml_oversized`
// warning instead of silently undercounting. Tunable via KMP_JUNIT_XML_MAX_MB
// (positive integer, MB) — mirrors orchestrator-utils.js#resolveMaxBuffer's
// env-knob shape.
export const DEFAULT_JUNIT_XML_MAX_MB = 32;

// Warn-once latch for a malformed env value: the resolver runs once per
// junit walk (N tasks per leg), so an unguarded warn would repeat per task.
let warnedBadMaxMbEnv = false;

export function resolveJunitXmlMaxBytes(env = process.env) {
  const raw = env && env.KMP_JUNIT_XML_MAX_MB;
  if (raw !== undefined && raw !== null && raw !== '') {
    const mb = Number(raw);
    if (Number.isInteger(mb) && mb > 0) return mb * 1024 * 1024;
    if (!warnedBadMaxMbEnv) {
      warnedBadMaxMbEnv = true;
      process.stderr.write(
        `[WARN] KMP_JUNIT_XML_MAX_MB='${raw}' is not a positive integer — using default ${DEFAULT_JUNIT_XML_MAX_MB} MB\n`,
      );
    }
  }
  return DEFAULT_JUNIT_XML_MAX_MB * 1024 * 1024;
}

// Test-only: reset the warn-once latch so env-knob cases can assert the warn.
export function _resetJunitXmlWarnLatch() {
  warnedBadMaxMbEnv = false;
}

// Translate an optional caller-provided anomaly collector (side-channel
// array — same pattern as update-orchestrator's probe_errors) into
// forEachJunitXml opts. Collected entries: { file, size, maxBytes }.
function collectorOpts(anomalies) {
  if (!anomalies) return {};
  return { onOversized: (info) => { anomalies.push(info); } };
}

// ---------------------------------------------------------------------------
// Junit-XML walk for individual test count (closes WS-8 additively)
// ---------------------------------------------------------------------------
// task path: `:foo:bar:baz` -> module dir `foo/bar`, task short name `baz`.
// XML location: <projectRoot>/<modulePath>/build/test-results/<taskShort>/TEST-*.xml
//
// Stale-XML guard (added 2026-05-03 after the EINVAL incident exposed
// ~10K junit XMLs from prior bash-wrapper-era runs being counted as if
// produced this run): when `sinceMs` is provided, only files with
// `mtime >= sinceMs` are counted. Default 0 keeps backward compat for
// any external caller (this function is exported for tests).
//
// `anomalies` (optional array) collects oversized-XML skip records so the
// caller can convert them into envelope warnings (see result-rollup.js).
function junitTestCountFor(projectRoot, taskColonPath, sinceMs = 0, anomalies = null) {
  let count = 0;
  forEachJunitXml(projectRoot, taskColonPath, sinceMs, (xml) => {
    // Match <testcase ...> occurrences (self-closing or with body). Cheap
    // regex parse — no XML parser needed since gradle's junit XML is simple.
    const matches = xml.match(/<testcase\b/g);
    if (matches) count += matches.length;
  }, collectorOpts(anomalies));
  return count;
}

// Walk every JUnit-XML file produced by `taskColonPath` across both the
// gradle-default path (`build/test-results/<task>/`) AND AGP's
// instrumented path (`build/outputs/androidTest-results/connected/
// <sourceSet>/`). The latter is where AGP writes results for
// `androidConnectedCheck`, `connected${Variant}AndroidTest`, and the
// KMP `androidConnectedCheck` aggregator. Pre-2026-05-09 the parser only
// walked the legacy path -> instrumented failures vanished from
// `modules[].test_failures[]` even though XML existed on disk (OBS-A
// surfaced on a private benchmark module's `androidConnectedCheck` task).
function forEachJunitXml(projectRoot, taskColonPath, sinceMs, visit, opts = {}) {
  const maxBytes = opts.maxBytes ?? resolveJunitXmlMaxBytes();
  const segs = taskColonPath.replace(/^:/, '').split(':');
  if (segs.length < 2) return;
  const taskShort = segs.pop();
  const modPath = path.join(projectRoot, ...segs);

  const candidateDirs = [
    // Legacy gradle JvmTestTask / KotlinTest output.
    path.join(modPath, 'build', 'test-results', taskShort),
  ];
  // Umbrella `test` task (dispatched for flavored androidUnit with no --flavor):
  // it has no JUnit output of its own — it aggregates the per-variant unit-test
  // tasks (test${Flavor}${BuildType}UnitTest), whose XML lands in sibling
  // test-results/<variant>UnitTest/ dirs, NOT test-results/test/. Collect every
  // *UnitTest result dir so the umbrella's counts + failures reflect what ran.
  // The sinceMs guard below scopes these to THIS run's fresh XML. JVM/KMP `test`
  // tasks write directly to test-results/test/ and have no *UnitTest siblings,
  // so this is a no-op for them.
  if (taskShort === 'test') {
    const trRoot = path.join(modPath, 'build', 'test-results');
    if (existsSync(trRoot)) {
      let trEntries;
      try { trEntries = readdirSync(trRoot, { withFileTypes: true }); } catch { trEntries = []; }
      for (const ent of trEntries) {
        if (ent.isDirectory() && /UnitTest$/.test(ent.name)) {
          candidateDirs.push(path.join(trRoot, ent.name));
        }
      }
    }
  }
  // AGP instrumented output. The intermediate <sourceSet> dir is variable
  // (`androidMain`, `freeDebug`, etc.) so we walk one level deeper.
  const agpRoot = path.join(modPath, 'build', 'outputs', 'androidTest-results', 'connected');
  if (existsSync(agpRoot)) {
    let agpEntries;
    try { agpEntries = readdirSync(agpRoot, { withFileTypes: true }); } catch { agpEntries = []; }
    for (const ent of agpEntries) {
      if (ent.isDirectory()) candidateDirs.push(path.join(agpRoot, ent.name));
    }
  }

  for (const dir of candidateDirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith('TEST-') || !e.name.endsWith('.xml')) continue;
      const filePath = path.join(dir, e.name);
      // The stat is UNCONDITIONAL (pre-L2 it ran only when sinceMs > 0): the
      // size guard below must also cover cacheRespected paths that pass
      // sinceMs=0. Do not fold it back behind the sinceMs gate.
      let st;
      try { st = statSync(filePath); } catch { continue; }
      if (sinceMs > 0 && st.mtimeMs < sinceMs) continue;
      // Oversized-XML guard: skip the whole-file read and report through the
      // collector so the caller can warn instead of silently undercounting.
      if (st.size > maxBytes) {
        if (opts.onOversized) opts.onOversized({ file: filePath, size: st.size, maxBytes });
        continue;
      }
      let xml;
      try { xml = readFileSync(filePath, 'utf8'); } catch (err) {
        if (opts.onReadError) opts.onReadError({ file: filePath, error: err });
        continue;
      }
      visit(xml, filePath);
    }
  }
}

// Capture per-test failures from JUnit XML so
// envelope.modules[].test_failures gives consumers a structured view of
// what failed without re-parsing build/test-results/*/TEST-*.xml. Pre-fix
// only the dedicated `kmp-test android` orchestrator emitted testFailures
// (via stdout regex); `parallel --test-type jvm/desktop/macos/ios/androidUnit`
// surfaced only `errors[].code:'module_failed'` (module-level) and required
// agents to walk the file system to discriminate.
//
// Mirrors junitTestCountFor's stale-XML guard semantics (sinceMs filter).
// XML schema: gradle's junit-style XMLReport task emits one TEST-<class>.xml
// per test class; failed test cases have <failure type=... message=...>...
// </failure> or <error type=... message=...>...</error> children. Skipped
// cases have <skipped>...</skipped> and are NOT counted as failures here.
function junitTestFailuresFor(projectRoot, taskColonPath, sinceMs = 0, anomalies = null) {
  const out = [];
  forEachJunitXml(projectRoot, taskColonPath, sinceMs, (xml) => {
    extractTestcaseFailures(xml, out);
  }, collectorOpts(anomalies));
  return out;
}

// Cheap regex extraction — gradle/junit XML is flat enough that we don't
// need a real XML parser. Only <testcase> with a non-self-closing body can
// contain <failure> / <error>, so passing tests are skipped automatically.
function extractTestcaseFailures(xml, out) {
  // Lookbehind `(?<!\/)>` skips self-closing `<testcase ... />` blocks —
  // those represent passing tests and have no body to scan. Without the
  // guard the regex would consume self-closing + non-self-closing pairs
  // greedily and mis-attribute failures from inner blocks to outer names.
  const tcRe = /<testcase\b([^>]*)(?<!\/)>([\s\S]*?)<\/testcase>/g;
  let tm;
  while ((tm = tcRe.exec(xml)) !== null) {
    const attrs = tm[1];
    const body = tm[2];
    const fm = body.match(/<(failure|error)\b([^>]*?)\/>|<(failure|error)\b([^>]*?)>([\s\S]*?)<\/\3>/);
    if (!fm) continue;
    const verb = fm[1] || fm[3];
    const failAttrs = fm[2] || fm[4] || '';
    const failBody = fm[5] || '';
    const nameMatch = attrs.match(/\bname="([^"]*)"/);
    const classMatch = attrs.match(/\bclassname="([^"]*)"/);
    const typeMatch = failAttrs.match(/\btype="([^"]*)"/);
    const msgMatch = failAttrs.match(/\bmessage="([^"]*)"/);
    const name = nameMatch ? nameMatch[1] : null;
    const cls  = classMatch ? classMatch[1] : null;
    const type = typeMatch ? typeMatch[1] : null;
    let cause = msgMatch ? decodeXmlEntities(msgMatch[1]) : null;
    if (!cause && failBody) {
      cause = decodeXmlEntities(failBody.trim()).split('\n')[0] || null;
    }
    if (!cause && type) cause = type;
    out.push({
      test: cls && name ? `${cls}.${name}` : (name || cls || '<unknown>'),
      cause: cause || (verb === 'error' ? 'error' : 'failure'),
      type: type ?? null,
    });
  }
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export {
  junitTestCountFor,
  forEachJunitXml,
  junitTestFailuresFor,
  extractTestcaseFailures,
  decodeXmlEntities,
};

#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/sync-versions.js — keep release version pins in lockstep with
// package.json across the four files that ship a hardcoded version:
//
//   • package.json                            "version": "X.Y.Z"
//   • gradle-plugin/build.gradle.kts          version = "X.Y.Z"
//   • README.md                               plugin DSL sample
//   • CLAUDE.md                               npm + Gradle plugin + GH release lines
//
// Designed to be invoked via:
//   1. `npm run sync-versions`           — manual sync after editing package.json
//   2. `npm version <newver>`            — auto via the `version` lifecycle script
//                                          (see package.json scripts)
//   3. `node tools/sync-versions.js --check` — CI guard (exits 1 on drift)
//   4. `node tools/sync-versions.js --dry-run` — show planned changes
//
// Source of truth: package.json `version`. Every target reads its current value
// and is rewritten only when it differs from the source. A target whose regex
// doesn't match exits with code 1 (fail loudly) — the file changed shape and
// needs human review, not a silent no-op.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

// One target = one (file, regex with single capture group, replacement template).
// Each target's regex MUST capture the version digits in $1 so we can detect
// drift (matched-but-different) vs file-shape change (didn't match at all).
export function buildTargets(version, repoRoot = REPO_ROOT) {
  return [
    {
      label: "gradle-plugin/build.gradle.kts",
      path: join(repoRoot, "gradle-plugin", "build.gradle.kts"),
      pattern: /^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m,
      template: `version = "${version}"`,
    },
    {
      label: "README.md (plugin DSL sample)",
      path: join(repoRoot, "README.md"),
      pattern: /id\("io\.github\.oscardlfr\.kmp-test-runner"\) version "([0-9]+\.[0-9]+\.[0-9]+)"/,
      template: `id("io.github.oscardlfr.kmp-test-runner") version "${version}"`,
    },
    {
      label: "CLAUDE.md (npm package line)",
      path: join(repoRoot, "CLAUDE.md"),
      pattern: /npm: `kmp-test-runner@([0-9]+\.[0-9]+\.[0-9]+)`/,
      template: `npm: \`kmp-test-runner@${version}\``,
    },
    {
      label: "CLAUDE.md (Gradle plugin line)",
      path: join(repoRoot, "CLAUDE.md"),
      pattern: /Gradle plugin: `io\.github\.oscardlfr\.kmp-test-runner:([0-9]+\.[0-9]+\.[0-9]+)`/,
      template: `Gradle plugin: \`io.github.oscardlfr.kmp-test-runner:${version}\``,
    },
    {
      label: "CLAUDE.md (GitHub Releases line)",
      path: join(repoRoot, "CLAUDE.md"),
      pattern: /GitHub Releases: `v([0-9]+\.[0-9]+\.[0-9]+)`/,
      template: `GitHub Releases: \`v${version}\``,
    },
  ];
}

export async function readPackageVersion(repoRoot = REPO_ROOT) {
  const raw = await readFile(join(repoRoot, "package.json"), "utf8");
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+/.test(pkg.version)) {
    throw new Error(`package.json: version "${pkg.version}" is not a valid semver`);
  }
  return pkg.version;
}

async function inspectTarget(target) {
  let content;
  try {
    content = await readFile(target.path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return { ok: false, reason: "missing", current: null, content: null };
    }
    throw err;
  }
  const match = content.match(target.pattern);
  if (!match) {
    return { ok: false, reason: "no-match", current: null, content };
  }
  return { ok: true, current: match[1], content };
}

export async function syncVersions({ mode = "apply", repoRoot = REPO_ROOT } = {}) {
  const version = await readPackageVersion(repoRoot);
  const targets = buildTargets(version, repoRoot);
  const report = { version, changes: [], drifts: [], failures: [] };

  for (const target of targets) {
    const inspect = await inspectTarget(target);
    if (!inspect.ok) {
      report.failures.push({ label: target.label, path: target.path, reason: inspect.reason });
      continue;
    }
    if (inspect.current === version) continue;
    report.drifts.push({ label: target.label, from: inspect.current, to: version });
    if (mode === "apply") {
      const next = inspect.content.replace(target.pattern, target.template);
      await writeFile(target.path, next, "utf8");
      report.changes.push({ label: target.label, from: inspect.current, to: version });
    }
  }
  return report;
}

function formatReport(report, { mode }) {
  const lines = [];
  lines.push(`package.json version: ${report.version}`);
  if (report.failures.length > 0) {
    lines.push("");
    lines.push("FAILURES (target file missing or regex did not match):");
    for (const f of report.failures) {
      lines.push(`  X ${f.label} (${f.reason}) -- ${f.path}`);
    }
  }
  if (report.drifts.length === 0) {
    if (report.failures.length === 0) lines.push("All targets in sync -- no changes needed.");
  } else {
    lines.push("");
    if (mode === "check") lines.push("Targets out of sync (--check fails):");
    else if (mode === "dry-run") lines.push("Planned changes (--dry-run, not written):");
    else lines.push("Applied changes:");
    for (const d of report.drifts) {
      const marker = mode === "apply" ? "+" : "*";
      lines.push(`  ${marker} ${d.label}: ${d.from} -> ${d.to}`);
    }
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = { mode: "apply" };
  for (const a of argv) {
    if (a === "--check") args.mode = "check";
    else if (a === "--dry-run") args.mode = "dry-run";
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

const HELP = `tools/sync-versions.js -- sync release version pins to package.json

Usage:
  node tools/sync-versions.js                   apply: write target files in place
  node tools/sync-versions.js --check           verify-only: exit 1 if any drift
  node tools/sync-versions.js --dry-run         preview: print planned changes, no write
  node tools/sync-versions.js --help            this help

Targets:
  gradle-plugin/build.gradle.kts
  README.md (plugin DSL sample)
  CLAUDE.md (npm + Gradle plugin + GitHub Releases lines)

Source of truth: package.json "version".
`;

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const runMode = args.mode === "apply" ? "apply" : "verify";
  const report = await syncVersions({ mode: runMode });
  process.stdout.write(formatReport(report, { mode: args.mode }) + "\n");
  if (report.failures.length > 0) process.exit(1);
  if (args.mode === "check" && report.drifts.length > 0) process.exit(1);
  process.exit(0);
}

const isMain = process.argv[1] && (process.argv[1] === __filename || process.argv[1].endsWith("sync-versions.js"));
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`sync-versions: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}

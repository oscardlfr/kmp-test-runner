#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/validate-plugin.mjs -- Claude Code plugin manifest gate.
//
// Asserts .claude-plugin/plugin.json:
//   1. Exists and parses as valid JSON.
//   2. Has every REQUIRED entry (name + recommended-required metadata).
//   3. `name` is kebab-case (matches /^[a-z0-9]+(-[a-z0-9]+)*$/, length <= 64).
//   4. `version` is semver AND equals package.json `version`.
//   5. `license` equals package.json `license` ("MIT").
//   6. `description` has no PR/bug refs (/#\d{2,}|PR \d+|bug \d+/i) -- the
//      same WHY-content-only rule production code follows.
//   7. Every `skills[]` entry is a relative path starting with "./" AND
//      resolves to a directory containing at least one <name>/SKILL.md.
//   8. `$schema`, `homepage`, `repository` are URL-shaped strings; `keywords`
//      is an array of strings.
//
// Private-pattern enforcement is delegated to tools/decouple-audit.mjs,
// which already scans every committed file including this new manifest.
//
// Usage:
//   node tools/validate-plugin.mjs           # exit 0 on pass, 1 on validation
//                                            # failure, 2 on runtime error
//   node tools/validate-plugin.mjs --help    # this help
//
// CI: extends the existing `skills-validate` job in
// .github/workflows/ci.yml. Required-check name unchanged; the job grows
// one extra step. 10-job branch-protection budget preserved.

import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

const MANIFEST_REL = ".claude-plugin/plugin.json";
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BAD_REF_RE = /#\d{2,}|\bPR\s+\d+|\bbug\s+\d+/i;
const URL_RE = /^https?:\/\/[^\s]+$/;

export function buildExpectedFields(pkg) {
  return {
    name: "kmp-test-runner",
    version: pkg.version,
    license: pkg.license,
  };
}

export function validateManifest(manifest, pkg) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== "object") {
    errors.push({ field: "(root)", message: "manifest is not a JSON object" });
    return { errors, warnings };
  }

  // 1. name -- only hard-required field per spec.
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    errors.push({ field: "name", message: "missing required field 'name'" });
  } else {
    if (manifest.name.length > 64) {
      errors.push({ field: "name", message: `name "${manifest.name}" exceeds 64 chars` });
    }
    if (!KEBAB_RE.test(manifest.name)) {
      errors.push({ field: "name", message: `name "${manifest.name}" is not kebab-case (a-z0-9 + hyphens only)` });
    }
  }

  // 2. version -- recommended-required for stable releases. Cross-file invariant.
  if (typeof manifest.version !== "string") {
    errors.push({ field: "version", message: "missing field 'version' (required for stable releases per project policy)" });
  } else {
    if (!SEMVER_RE.test(manifest.version)) {
      errors.push({ field: "version", message: `version "${manifest.version}" is not valid semver` });
    }
    if (pkg && typeof pkg.version === "string" && manifest.version !== pkg.version) {
      errors.push({
        field: "version",
        message: `version drift: plugin.json has "${manifest.version}" but package.json has "${pkg.version}". Run 'node tools/sync-versions.js' to fix.`,
      });
    }
  }

  // 3. description -- recommended-required + no PR/bug refs.
  if (typeof manifest.description !== "string" || manifest.description.length < 20) {
    errors.push({ field: "description", message: "missing or too-short 'description' (>=20 chars expected)" });
  } else if (BAD_REF_RE.test(manifest.description)) {
    errors.push({
      field: "description",
      message: "description contains PR/bug refs (e.g. '#123', 'PR 5', 'bug 7') -- WHY-content only per project policy",
    });
  }

  // 4. license -- recommended-required + cross-file invariant.
  if (typeof manifest.license !== "string") {
    errors.push({ field: "license", message: "missing 'license' field" });
  } else if (pkg && typeof pkg.license === "string" && manifest.license !== pkg.license) {
    errors.push({
      field: "license",
      message: `license drift: plugin.json has "${manifest.license}" but package.json has "${pkg.license}"`,
    });
  }

  // 5. URL-shaped metadata.
  for (const key of ["homepage", "repository", "$schema"]) {
    if (manifest[key] != null && (typeof manifest[key] !== "string" || !URL_RE.test(manifest[key]))) {
      errors.push({ field: key, message: `'${key}' must be a URL string (got: ${JSON.stringify(manifest[key])})` });
    }
  }

  // 6. author + keywords shape.
  if (manifest.author != null) {
    const okString = typeof manifest.author === "string";
    const okObject =
      typeof manifest.author === "object" &&
      manifest.author !== null &&
      typeof manifest.author.name === "string";
    if (!okString && !okObject) {
      errors.push({ field: "author", message: "'author' must be a string or {name: string, ...} object" });
    }
  }
  if (manifest.keywords != null) {
    if (!Array.isArray(manifest.keywords) || manifest.keywords.some((k) => typeof k !== "string")) {
      errors.push({ field: "keywords", message: "'keywords' must be an array of strings" });
    }
  }

  // 7. skills[] shape -- each entry starts with "./".
  if (manifest.skills != null) {
    const arr = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
    arr.forEach((entry, i) => {
      if (typeof entry !== "string") {
        errors.push({ field: `skills[${i}]`, message: `skills[${i}] must be a string path` });
        return;
      }
      if (!entry.startsWith("./")) {
        errors.push({ field: `skills[${i}]`, message: `skills[${i}] "${entry}" must start with "./" per plugin spec` });
      }
      if (isAbsolute(entry)) {
        errors.push({ field: `skills[${i}]`, message: `skills[${i}] "${entry}" must be relative, not absolute` });
      }
    });
  }

  return { errors, warnings };
}

export async function resolveSkillPaths(manifest, repoRoot) {
  if (manifest.skills == null) return { skillsFound: [], errors: [] };
  const arr = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills];
  const skillsFound = [];
  const errors = [];
  for (const entry of arr) {
    if (typeof entry !== "string" || !entry.startsWith("./")) continue;
    const rel = entry.replace(/^\.\//, "").replace(/\/$/, "");
    const dirAbs = join(repoRoot, rel);
    let dirStat;
    try {
      dirStat = await stat(dirAbs);
    } catch {
      errors.push({ entry, message: `skills entry "${entry}" does not exist at ${dirAbs}` });
      continue;
    }
    if (!dirStat.isDirectory()) {
      errors.push({ entry, message: `skills entry "${entry}" is not a directory` });
      continue;
    }
    const subs = await readdir(dirAbs, { withFileTypes: true });
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const skillMdAbs = join(dirAbs, sub.name, "SKILL.md");
      try {
        const s = await stat(skillMdAbs);
        if (s.isFile()) skillsFound.push({ entry, name: sub.name, path: skillMdAbs });
      } catch {
        /* not a skill dir; ignore */
      }
    }
  }
  if (skillsFound.length === 0 && arr.length > 0) {
    errors.push({ entry: arr.join(","), message: "no <name>/SKILL.md resolved under any skills[] entry" });
  }
  return { skillsFound, errors };
}

export async function runValidator({ repoRoot = REPO_ROOT } = {}) {
  const manifestAbs = join(repoRoot, MANIFEST_REL);
  let manifestRaw;
  try {
    manifestRaw = await readFile(manifestAbs, "utf8");
  } catch (err) {
    return { ok: false, errors: [{ field: "(file)", message: `cannot read ${MANIFEST_REL}: ${err.message}` }], summary: `[validate-plugin] FAIL -- ${MANIFEST_REL} unreadable.` };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    return { ok: false, errors: [{ field: "(parse)", message: `JSON parse error in ${MANIFEST_REL}: ${err.message}` }], summary: `[validate-plugin] FAIL -- ${MANIFEST_REL} not valid JSON.` };
  }
  let pkg = {};
  try {
    pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  } catch {
    /* tests without a package.json get pkg = {} -- no cross-file invariants apply */
  }

  const { errors, warnings } = validateManifest(manifest, pkg);
  const resolution = await resolveSkillPaths(manifest, repoRoot);
  const allErrors = errors.concat(resolution.errors.map((e) => ({ field: "skills(resolve)", message: e.message })));

  const ok = allErrors.length === 0;
  const summary = ok
    ? `[validate-plugin] OK -- manifest "${manifest.name}@${manifest.version}" validated; ${resolution.skillsFound.length} skill(s) resolved.`
    : `[validate-plugin] FAIL -- ${allErrors.length} error(s):\n` +
      allErrors.map((e) => `  X ${e.field}: ${e.message}`).join("\n");
  return { ok, errors: allErrors, warnings, summary, skillsFound: resolution.skillsFound };
}

const HELP = `tools/validate-plugin.mjs -- Claude Code plugin manifest gate

Usage:
  node tools/validate-plugin.mjs           # exit 0 on pass, 1 on fail
  node tools/validate-plugin.mjs --help    # this help

CI: extends the existing skills-validate job in .github/workflows/ci.yml.
`;

const isMain = process.argv[1] && process.argv[1].endsWith("validate-plugin.mjs");
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  runValidator()
    .then((r) => {
      process.stdout.write(r.summary + "\n");
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`validate-plugin: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}

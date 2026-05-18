import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildExpectedFields,
  validateManifest,
  resolveSkillPaths,
  runValidator,
} from "../../tools/validate-plugin.mjs";

const REAL_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const VALIDATE_SCRIPT = path.join(REAL_REPO_ROOT, "tools", "validate-plugin.mjs");

function makeFakeRepo({ manifest, pkg, skills = [{ name: "kmp-test-runner", body: "---\nname: kmp-test-runner\ndescription: x\n---\n" }] }) {
  const dir = mkdtempSync(path.join(tmpdir(), "validate-plugin-test-"));
  if (pkg) writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  if (manifest) {
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  }
  if (Array.isArray(skills)) {
    mkdirSync(path.join(dir, ".skills"), { recursive: true });
    for (const s of skills) {
      mkdirSync(path.join(dir, ".skills", s.name), { recursive: true });
      writeFileSync(path.join(dir, ".skills", s.name, "SKILL.md"), s.body, "utf8");
    }
  }
  return dir;
}

let scratchDir = null;
afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
  }
});

const GOOD_MANIFEST = {
  $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
  name: "kmp-test-runner",
  version: "0.10.0",
  description: "Parallel test runner for KMP and Android Gradle projects via the kmp-test CLI. Long enough to clear the 20-char floor.",
  author: { name: "oscardlfr", url: "https://github.com/oscardlfr" },
  homepage: "https://github.com/oscardlfr/kmp-test-runner#readme",
  repository: "https://github.com/oscardlfr/kmp-test-runner",
  license: "MIT",
  keywords: ["kmp", "android"],
  skills: ["./.skills/"],
};
const GOOD_PKG = { version: "0.10.0", license: "MIT" };

describe("buildExpectedFields", () => {
  it("derives name + version + license from package.json", () => {
    const r = buildExpectedFields({ version: "1.2.3", license: "Apache-2.0" });
    expect(r.name).toBe("kmp-test-runner");
    expect(r.version).toBe("1.2.3");
    expect(r.license).toBe("Apache-2.0");
  });
});

describe("validateManifest -- happy path", () => {
  it("returns zero errors for a well-formed manifest", () => {
    const r = validateManifest(GOOD_MANIFEST, GOOD_PKG);
    expect(r.errors).toEqual([]);
  });
});

describe("validateManifest -- regression guards (each must fail pre-fix)", () => {
  it("rejects missing 'name'", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, name: undefined }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "name")).toBe(true);
  });
  it("rejects non-kebab-case 'name'", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, name: "KMP_Test_Runner" }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "name" && /kebab-case/.test(e.message))).toBe(true);
  });
  it("rejects name longer than 64 chars", () => {
    const longName = "x".repeat(65).split("").join("-").slice(0, 70);
    const r = validateManifest({ ...GOOD_MANIFEST, name: longName }, GOOD_PKG);
    expect(r.errors.some((e) => /exceeds 64/.test(e.message))).toBe(true);
  });
  it("rejects version drift vs package.json", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, version: "0.0.0" }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "version" && /drift/.test(e.message))).toBe(true);
  });
  it("rejects non-semver version", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, version: "v9" }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "version" && /semver/.test(e.message))).toBe(true);
  });
  it("rejects description shorter than 20 chars", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, description: "short" }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "description")).toBe(true);
  });
  it("rejects 'PR 5' ref in description (WHY-content only rule)", () => {
    const r = validateManifest(
      { ...GOOD_MANIFEST, description: "Packages the agentskills.io skill (PR 5 of 5)." },
      GOOD_PKG,
    );
    expect(r.errors.some((e) => e.field === "description")).toBe(true);
  });
  it("rejects '#123' ref in description", () => {
    const r = validateManifest(
      { ...GOOD_MANIFEST, description: "Packages the skill, see issue #123 for context background." },
      GOOD_PKG,
    );
    expect(r.errors.some((e) => e.field === "description")).toBe(true);
  });
  it("rejects license drift vs package.json", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, license: "Apache-2.0" }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "license" && /drift/.test(e.message))).toBe(true);
  });
  it("rejects non-URL homepage", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, homepage: "not-a-url" }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "homepage")).toBe(true);
  });
  it("rejects skills[] entry missing leading './'", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, skills: [".skills/"] }, GOOD_PKG);
    expect(r.errors.some((e) => /skills\[0\]/.test(e.field))).toBe(true);
  });
  it("rejects skills[] entry with absolute path", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, skills: ["/abs/skills"] }, GOOD_PKG);
    expect(r.errors.some((e) => /skills\[0\]/.test(e.field))).toBe(true);
  });
  it("rejects keywords containing a non-string", () => {
    const r = validateManifest({ ...GOOD_MANIFEST, keywords: ["ok", 123] }, GOOD_PKG);
    expect(r.errors.some((e) => e.field === "keywords")).toBe(true);
  });
});

describe("resolveSkillPaths -- walks synthetic directories", () => {
  it("finds the single skill under ./.skills/", async () => {
    scratchDir = makeFakeRepo({ manifest: GOOD_MANIFEST, pkg: GOOD_PKG });
    const r = await resolveSkillPaths(GOOD_MANIFEST, scratchDir);
    expect(r.errors).toEqual([]);
    expect(r.skillsFound.length).toBe(1);
    expect(r.skillsFound[0].name).toBe("kmp-test-runner");
  });
  it("reports missing skills entry", async () => {
    scratchDir = makeFakeRepo({ manifest: GOOD_MANIFEST, pkg: GOOD_PKG, skills: [] });
    rmSync(path.join(scratchDir, ".skills"), { recursive: true, force: true });
    const r = await resolveSkillPaths(GOOD_MANIFEST, scratchDir);
    expect(r.errors.length).toBeGreaterThan(0);
  });
  it("returns zero skills if directory contains no <name>/SKILL.md", async () => {
    scratchDir = makeFakeRepo({ manifest: GOOD_MANIFEST, pkg: GOOD_PKG, skills: [] });
    // .skills/ is empty (no subdirs) -- arr has 1 entry but skillsFound is empty
    const r = await resolveSkillPaths(GOOD_MANIFEST, scratchDir);
    expect(r.skillsFound.length).toBe(0);
    expect(r.errors.some((e) => /no <name>\/SKILL\.md resolved/.test(e.message))).toBe(true);
  });
});

describe("runValidator -- synthetic temp-dir fixtures", () => {
  it("exits ok on a well-formed fixture", async () => {
    scratchDir = makeFakeRepo({ manifest: GOOD_MANIFEST, pkg: GOOD_PKG });
    const r = await runValidator({ repoRoot: scratchDir });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.skillsFound.length).toBe(1);
  });
  it("reports unreadable manifest", async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), "validate-plugin-noop-"));
    // No .claude-plugin/plugin.json on disk
    const r = await runValidator({ repoRoot: scratchDir });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /unreadable|cannot read/i.test(e.message))).toBe(true);
  });
  it("reports JSON parse error", async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), "validate-plugin-badjson-"));
    mkdirSync(path.join(scratchDir, ".claude-plugin"), { recursive: true });
    writeFileSync(path.join(scratchDir, ".claude-plugin", "plugin.json"), "{not-json", "utf8");
    const r = await runValidator({ repoRoot: scratchDir });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /JSON parse/.test(e.message))).toBe(true);
  });
  it("reports multiple errors at once", async () => {
    scratchDir = makeFakeRepo({
      manifest: { name: "BadName", version: "0.0.0", description: "x", license: "Apache" },
      pkg: GOOD_PKG,
    });
    const r = await runValidator({ repoRoot: scratchDir });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(1);
  });
});

describe("runValidator -- CLI shape (live repo)", () => {
  it("exits 0 on the live manifest", () => {
    const result = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
      cwd: REAL_REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[validate-plugin] OK");
  });
  it("--help exits 0 with usage", () => {
    const result = spawnSync(process.execPath, [VALIDATE_SCRIPT, "--help"], {
      cwd: REAL_REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const MANIFEST_PATH = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const SKILL_MD_PATH = path.join(REPO_ROOT, ".skills", "kmp-test-runner", "SKILL.md");

// Live-repo regression coverage for .claude-plugin/plugin.json. These tests
// guard the manifest's shape + cross-file invariants against accidental
// drift in PR refactors. Pure-function tests of validateManifest itself
// live in validate-plugin.test.js (synthetic fixtures).
describe("plugin manifest -- file presence + JSON parse", () => {
  it("plugin.json exists at .claude-plugin/", () => {
    expect(statSync(MANIFEST_PATH).isFile()).toBe(true);
  });
  it("plugin.json parses as JSON", () => {
    expect(() => JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))).not.toThrow();
  });
});

describe("plugin manifest -- required field shape", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  it("name === 'kmp-test-runner' (matches npm + repo + skill)", () => {
    expect(manifest.name).toBe("kmp-test-runner");
  });
  it("version is semver", () => {
    expect(manifest.version).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
  it("description is present and substantive", () => {
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(20);
  });
  it("author is present as object with name", () => {
    expect(manifest.author).toBeDefined();
    expect(typeof manifest.author.name).toBe("string");
  });
  it("homepage + repository are https URLs to oscardlfr/kmp-test-runner", () => {
    expect(manifest.homepage).toMatch(/^https:/);
    expect(manifest.homepage).toMatch(/oscardlfr\/kmp-test-runner/);
    expect(manifest.repository).toMatch(/^https:/);
    expect(manifest.repository).toMatch(/oscardlfr\/kmp-test-runner/);
  });
  it("license is MIT", () => {
    expect(manifest.license).toBe("MIT");
  });
  it("keywords is non-empty array of strings", () => {
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect(manifest.keywords.length).toBeGreaterThan(0);
    for (const k of manifest.keywords) expect(typeof k).toBe("string");
    expect(manifest.keywords).toContain("kotlin-multiplatform");
  });
  it("skills is array of './'-prefixed paths", () => {
    expect(Array.isArray(manifest.skills)).toBe(true);
    expect(manifest.skills.length).toBeGreaterThan(0);
    for (const s of manifest.skills) expect(s.startsWith("./")).toBe(true);
  });
});

describe("plugin manifest -- cross-file invariants", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  it("version equals package.json version (pinned by sync-versions)", () => {
    expect(manifest.version).toBe(pkg.version);
  });
  it("license equals package.json license", () => {
    expect(manifest.license).toBe(pkg.license);
  });
  it("skills[] resolves to the existing .skills/kmp-test-runner/SKILL.md", () => {
    expect(statSync(SKILL_MD_PATH).isFile()).toBe(true);
  });
});

describe("plugin manifest -- bug-id refs (project WHY-only rule)", () => {
  const raw = readFileSync(MANIFEST_PATH, "utf8");
  it("contains no '#NNN' or 'PR N' or 'bug N' refs in any field", () => {
    expect(raw).not.toMatch(/#\d{2,}/);
    expect(raw).not.toMatch(/\bPR\s+\d+\b/i);
    expect(raw).not.toMatch(/\bbug\s+\d+\b/i);
  });
  // Private-pattern enforcement (home-directory paths, private project names)
  // is delegated to tools/decouple-audit.mjs, which scans every committed
  // file repo-wide. A local assertion here would have to embed the literal
  // patterns it asserts absence of, self-triggering the audit.
});

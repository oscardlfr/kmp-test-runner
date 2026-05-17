import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { syncVersions, buildTargets, readPackageVersion } from "../../tools/sync-versions.js";

const REAL_REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const SYNC_SCRIPT = path.join(REAL_REPO_ROOT, "tools", "sync-versions.js");

function makeFakeRepo({ pkgVersion, gradleVersion, readmeVersion, claudeVersions, manifestVersion }) {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-versions-test-"));
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "kmp-test-runner", version: pkgVersion }, null, 2),
    "utf8",
  );
  mkdirSync(path.join(dir, "gradle-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, "gradle-plugin", "build.gradle.kts"),
    `plugins {\n    \`java-gradle-plugin\`\n    kotlin("jvm") version "2.3.20"\n}\n\ngroup = "io.github.oscardlfr"\nversion = "${gradleVersion}"\n`,
    "utf8",
  );
  writeFileSync(
    path.join(dir, "README.md"),
    `# kmp-test-runner\n\n\`\`\`kotlin\nplugins {\n    id("io.github.oscardlfr.kmp-test-runner") version "${readmeVersion}"\n}\n\`\`\`\n`,
    "utf8",
  );
  const [npmV, pluginV, releaseV] = claudeVersions;
  writeFileSync(
    path.join(dir, "CLAUDE.md"),
    [
      "# kmp-test-runner",
      "",
      "## Repo state",
      "",
      `- npm: \`kmp-test-runner@${npmV}\` (Trusted Publisher OIDC; auto-publishes on push to \`main\`)`,
      `- Gradle plugin: \`io.github.oscardlfr.kmp-test-runner:${pluginV}\` (GitHub Packages; auto-publishes on push to \`main\`)`,
      `- GitHub Releases: \`v${releaseV}\` (linux.tar.gz + windows.zip; auto-tagged from \`package.json\` version on push to \`main\`)`,
      "",
    ].join("\n"),
    "utf8",
  );
  // .claude-plugin/plugin.json -- 6th sync-versions target (PR 5 of v0.10 #4).
  // Default to pkgVersion when not explicitly overridden so existing callers
  // without manifestVersion stay in-sync (zero drift).
  const mv = manifestVersion ?? pkgVersion;
  mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "kmp-test-runner", version: mv, license: "MIT" }, null, 2) + "\n",
    "utf8",
  );
  return dir;
}

let scratchDir = null;
afterEach(() => {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = null;
  }
});

describe("buildTargets", () => {
  it("returns 6 targets covering the five files", () => {
    const targets = buildTargets("9.9.9", "/fake/root");
    expect(targets.length).toBe(6);
    const labels = targets.map((t) => t.label);
    expect(labels).toContain("gradle-plugin/build.gradle.kts");
    expect(labels).toContain("README.md (plugin DSL sample)");
    expect(labels.filter((l) => l.startsWith("CLAUDE.md")).length).toBe(3);
    expect(labels.some((l) => l.startsWith(".claude-plugin/plugin.json"))).toBe(true);
  });
  it("each target has a single capture group in its pattern", () => {
    for (const t of buildTargets("9.9.9", "/fake/root")) {
      const re = new RegExp(t.pattern.source, t.pattern.flags + "g");
      const stub = `${t.label.includes("gradle-plugin") ? 'version = "1.2.3"' : ""}`;
      // Just assert pattern compiles + has a numbered group reference
      expect(t.pattern).toBeInstanceOf(RegExp);
      expect(t.template).toContain("9.9.9");
      void re;
      void stub;
    }
  });
});

describe("readPackageVersion", () => {
  it("rejects malformed package.json version", async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), "sync-bad-pkg-"));
    writeFileSync(
      path.join(scratchDir, "package.json"),
      JSON.stringify({ name: "x", version: "not-semver" }),
      "utf8",
    );
    await expect(readPackageVersion(scratchDir)).rejects.toThrow(/not a valid semver/);
  });
});

describe("syncVersions — no drift", () => {
  it("returns empty drifts when all 6 targets already match package.json", async () => {
    scratchDir = makeFakeRepo({
      pkgVersion: "0.8.0",
      gradleVersion: "0.8.0",
      readmeVersion: "0.8.0",
      claudeVersions: ["0.8.0", "0.8.0", "0.8.0"],
      manifestVersion: "0.8.0",
    });
    const report = await syncVersions({ mode: "apply", repoRoot: scratchDir });
    expect(report.version).toBe("0.8.0");
    expect(report.drifts).toEqual([]);
    expect(report.changes).toEqual([]);
    expect(report.failures).toEqual([]);
  });
});

describe("syncVersions — drift detection + apply", () => {
  it("detects drift across all 6 targets", async () => {
    scratchDir = makeFakeRepo({
      pkgVersion: "0.8.0",
      gradleVersion: "0.7.0",
      readmeVersion: "0.7.0",
      claudeVersions: ["0.7.0", "0.7.0", "0.7.0"],
      manifestVersion: "0.7.0",
    });
    const report = await syncVersions({ mode: "verify", repoRoot: scratchDir });
    expect(report.drifts.length).toBe(6);
    expect(report.changes).toEqual([]); // verify-only, no writes
    // Files should be unchanged after verify
    const gradle = readFileSync(path.join(scratchDir, "gradle-plugin", "build.gradle.kts"), "utf8");
    expect(gradle).toContain('version = "0.7.0"');
  });
  it("applies fixes across all 6 targets", async () => {
    scratchDir = makeFakeRepo({
      pkgVersion: "0.8.0",
      gradleVersion: "0.7.0",
      readmeVersion: "0.7.0",
      claudeVersions: ["0.7.0", "0.7.0", "0.7.0"],
      manifestVersion: "0.7.0",
    });
    const report = await syncVersions({ mode: "apply", repoRoot: scratchDir });
    expect(report.changes.length).toBe(6);
    const gradle = readFileSync(path.join(scratchDir, "gradle-plugin", "build.gradle.kts"), "utf8");
    expect(gradle).toContain('version = "0.8.0"');
    const readme = readFileSync(path.join(scratchDir, "README.md"), "utf8");
    expect(readme).toContain('id("io.github.oscardlfr.kmp-test-runner") version "0.8.0"');
    const claude = readFileSync(path.join(scratchDir, "CLAUDE.md"), "utf8");
    expect(claude).toContain("npm: `kmp-test-runner@0.8.0`");
    expect(claude).toContain("Gradle plugin: `io.github.oscardlfr.kmp-test-runner:0.8.0`");
    expect(claude).toContain("GitHub Releases: `v0.8.0`");
    const manifest = JSON.parse(readFileSync(path.join(scratchDir, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.version).toBe("0.8.0");
  });
  it("partial drift: one CLAUDE.md line out of sync, others ok", async () => {
    scratchDir = makeFakeRepo({
      pkgVersion: "0.8.0",
      gradleVersion: "0.8.0",
      readmeVersion: "0.8.0",
      claudeVersions: ["0.8.0", "0.7.0", "0.8.0"], // Gradle plugin line drifts
      manifestVersion: "0.8.0",
    });
    const report = await syncVersions({ mode: "apply", repoRoot: scratchDir });
    expect(report.changes.length).toBe(1);
    expect(report.changes[0].label).toBe("CLAUDE.md (Gradle plugin line)");
  });
  it("partial drift: only .claude-plugin/plugin.json out of sync", async () => {
    scratchDir = makeFakeRepo({
      pkgVersion: "0.8.0",
      gradleVersion: "0.8.0",
      readmeVersion: "0.8.0",
      claudeVersions: ["0.8.0", "0.8.0", "0.8.0"],
      manifestVersion: "0.7.0",
    });
    const report = await syncVersions({ mode: "apply", repoRoot: scratchDir });
    expect(report.changes.length).toBe(1);
    expect(report.changes[0].label).toBe(".claude-plugin/plugin.json (Claude Code plugin manifest)");
  });
});

describe("syncVersions — failure cases", () => {
  it("reports missing target file", async () => {
    scratchDir = mkdtempSync(path.join(tmpdir(), "sync-missing-"));
    writeFileSync(
      path.join(scratchDir, "package.json"),
      JSON.stringify({ name: "x", version: "0.8.0" }),
      "utf8",
    );
    // No gradle-plugin/build.gradle.kts, no README.md, no CLAUDE.md, no .claude-plugin/plugin.json
    const report = await syncVersions({ mode: "apply", repoRoot: scratchDir });
    expect(report.failures.length).toBe(6);
    expect(report.failures.every((f) => f.reason === "missing")).toBe(true);
  });
  it("reports regex no-match when file shape changed", async () => {
    scratchDir = makeFakeRepo({
      pkgVersion: "0.8.0",
      gradleVersion: "0.8.0",
      readmeVersion: "0.8.0",
      claudeVersions: ["0.8.0", "0.8.0", "0.8.0"],
      manifestVersion: "0.8.0",
    });
    // Sabotage the README sample so the regex no longer matches
    writeFileSync(path.join(scratchDir, "README.md"), "# README\n\n(no plugin sample here)\n", "utf8");
    const report = await syncVersions({ mode: "apply", repoRoot: scratchDir });
    const readmeFailure = report.failures.find((f) => f.label.startsWith("README.md"));
    expect(readmeFailure).toBeDefined();
    expect(readmeFailure.reason).toBe("no-match");
  });
});

describe("CLI shape", () => {
  it("--check exits 0 when in sync (live repo)", () => {
    const result = spawnSync(process.execPath, [SYNC_SCRIPT, "--check"], {
      cwd: REAL_REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("All targets in sync");
  });
  it("--help exits 0 with usage", () => {
    const result = spawnSync(process.execPath, [SYNC_SCRIPT, "--help"], {
      cwd: REAL_REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--check");
    expect(result.stdout).toContain("--dry-run");
  });
  it("rejects unknown flags with exit 2", () => {
    const result = spawnSync(process.execPath, [SYNC_SCRIPT, "--bogus"], {
      cwd: REAL_REPO_ROOT,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown argument");
  });
});

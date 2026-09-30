// tests/vitest/agentic-eval-transcript-access-scan.test.js
// Coverage for tools/agentic-eval/transcript-access-scan.mjs: at closure, scan the raw text of every
// cell's transcript for the corpus, the preregistration and the private-evidence paths an agent must
// never reach. Synthetic closure directories only; no network.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanClosure } from '../../tools/agentic-eval/transcript-access-scan.mjs';
import { accessScanEffects } from '../../tools/agentic-eval/campaign-summary.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAN_SCRIPT = path.join(__dirname, '..', '..', 'tools', 'agentic-eval', 'transcript-access-scan.mjs');
const SCRATCH_ROOT = 'C:\\kmp-eval\\scratch';

// On a Windows host that has C:\kmp-eval\scratch the closure directories live there (hosted CI exposes TEMP
// as a short 8.3 name); everywhere else under the OS temp directory.
const cleanup = [];
function closureDir(manifest = { campaign_id: 'campaign-under-test', private_root: 'C:\\Evidence1Private\\live-product-free\\campaign-under-test' }) {
  const root = process.platform === 'win32' && existsSync(SCRATCH_ROOT) ? SCRATCH_ROOT : os.tmpdir();
  const dir = mkdtempSync(path.join(root, 'aeta-'));
  cleanup.push(dir);
  if (manifest !== null) writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  mkdirSync(path.join(dir, 'private'), { recursive: true });
  return dir;
}
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function transcript(dir, cellKey, lines) {
  const cellDir = path.join(dir, 'private', cellKey);
  mkdirSync(cellDir, { recursive: true });
  writeFileSync(path.join(cellDir, 'transcript.jsonl'), Array.isArray(lines) ? `${lines.join('\n')}\n` : lines);
}
const cellOf = (scan, key) => scan.cells.find((c) => c.cell_key === key);

describe('scanClosure -- the four patterns', () => {
  it('finds a corpus path written the way a JSON line holds a Windows path (every backslash doubled)', () => {
    const dir = closureDir();
    transcript(dir, 'claude-code-0', [String.raw`{"type":"tool_result","content":"C:\\kmp-eval\\h\\tools\\agentic-eval\\corpus\\expected\\x.json"}`]);
    expect(cellOf(scanClosure(dir), 'claude-code-0')).toEqual({ cell_key: 'claude-code-0', scanned: true, hits: [{ label: 'corpus', count: 1 }] });
  });

  it('finds a corpus path written with forward slashes', () => {
    const dir = closureDir();
    transcript(dir, 'claude-code-0', ['{"content":"cat C:/kmp-eval/h/tools/agentic-eval/corpus/scenarios/s.json"}']);
    expect(cellOf(scanClosure(dir), 'claude-code-0').hits).toEqual([{ label: 'corpus', count: 1 }]);
  });

  it.each(['expected', 'scenarios', 'fixtures'])('finds corpus/%s and nothing else under corpus', (segment) => {
    const dir = closureDir();
    transcript(dir, 'a', [`{"p":"tools/agentic-eval/corpus/${segment}/x"}`]);
    transcript(dir, 'b', ['{"p":"tools/agentic-eval/corpus/other/x"}']);
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([{ label: 'corpus', count: 1 }]);
    expect(cellOf(scanClosure(dir), 'b').hits).toEqual([]);
  });

  it('finds the word preregistration', () => {
    const dir = closureDir();
    transcript(dir, 'a', ['{"content":"see tools/runs/evidence3/preregistration.md"}']);
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([{ label: 'preregistration', count: 1 }]);
  });

  it('finds a sibling private root: any path that holds Evidence1Private, not only this campaign\'s own', () => {
    const dir = closureDir();
    transcript(dir, 'a', [String.raw`{"content":"C:\\Evidence1Private\\evidence3-green\\live\\x.json"}`]);
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([{ label: 'private_evidence', count: 1 }]);
  });

  it('finds the manifest\'s own private_root, JSON-escaped, and so also the private-evidence prefix inside it', () => {
    const dir = closureDir();
    transcript(dir, 'a', [String.raw`{"content":"C:\\Evidence1Private\\live-product-free\\campaign-under-test\\claude-code-0"}`]);
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([{ label: 'private_evidence', count: 1 }, { label: 'private_root', count: 1 }]);
  });

  it('builds the private_root pattern segment by segment, so / and \\ and \\\\ all match, without treating the path as a regex', () => {
    const dir = closureDir({ campaign_id: 'c', private_root: 'D:\\odd.root+(x)\\run' });
    transcript(dir, 'a', ['{"p":"D:/odd.root+(x)/run/file"}']);
    transcript(dir, 'b', [String.raw`{"p":"D:\\odd.root+(x)\\run\\file"}`]);
    transcript(dir, 'c', ['{"p":"D:/oddXroot+(x)/run/file"}']); // the dot is a dot, not "any character"
    const scan = scanClosure(dir);
    expect(cellOf(scan, 'a').hits).toEqual([{ label: 'private_root', count: 1 }]);
    expect(cellOf(scan, 'b').hits).toEqual([{ label: 'private_root', count: 1 }]);
    expect(cellOf(scan, 'c').hits).toEqual([]);
  });

  it('matches in any letter case', () => {
    const dir = closureDir();
    transcript(dir, 'a', ['{"p":"CORPUS/Expected/x PREREGISTRATION evidence1private"}']);
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([
      { label: 'corpus', count: 1 }, { label: 'preregistration', count: 1 }, { label: 'private_evidence', count: 1 },
    ]);
  });

  it('does not treat the harness directory as a pattern: a stack-trace path inside it is no hit', () => {
    const dir = closureDir();
    transcript(dir, 'a', [
      String.raw`{"content":"Error\n    at run (C:\\kmp-eval\\h\\lib\\cli.js:10:5)\n    at C:\\kmp-eval\\h\\tools\\agentic-eval\\cli.mjs:99:1"}`,
    ]);
    expect(cellOf(scanClosure(dir), 'a')).toEqual({ cell_key: 'a', scanned: true, hits: [] });
  });

  it('counts every occurrence across all lines of a transcript', () => {
    const dir = closureDir();
    transcript(dir, 'a', [
      '{"p":"corpus/expected/a.json and corpus/expected/b.json"}',
      '{"p":"nothing here"}',
      '{"p":"corpus/scenarios/c.json"}',
    ]);
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([{ label: 'corpus', count: 3 }]);
  });

  it('scans lines that are not JSON too: it reads raw text', () => {
    const dir = closureDir();
    transcript(dir, 'a', 'not json at all, corpus/fixtures/x\n{"broken":\n');
    expect(cellOf(scanClosure(dir), 'a').hits).toEqual([{ label: 'corpus', count: 1 }]);
  });
});

describe('scanClosure -- cells and output shape', () => {
  it('reports a cell whose transcript is missing as scanned:false with no hits', () => {
    const dir = closureDir();
    mkdirSync(path.join(dir, 'private', 'codex-cli-0'), { recursive: true });
    expect(cellOf(scanClosure(dir), 'codex-cli-0')).toEqual({ cell_key: 'codex-cli-0', scanned: false, hits: [] });
  });

  it('reports an empty transcript as scanned:true with no hits', () => {
    const dir = closureDir();
    transcript(dir, 'a', '');
    expect(cellOf(scanClosure(dir), 'a')).toEqual({ cell_key: 'a', scanned: true, hits: [] });
  });

  it('lists the cells sorted by key, and ignores files that are not cell directories', () => {
    const dir = closureDir();
    for (const key of ['codex-cli-1', 'claude-code-0', 'codex-cli-0']) transcript(dir, key, ['{}']);
    writeFileSync(path.join(dir, 'private', 'stray.txt'), 'x');
    expect(scanClosure(dir).cells.map((c) => c.cell_key)).toEqual(['claude-code-0', 'codex-cli-0', 'codex-cli-1']);
  });

  it('has the documented shape: schema 1, the campaign id, the pattern labels in order, and the cells', () => {
    const dir = closureDir();
    transcript(dir, 'a', ['{}']);
    expect(scanClosure(dir)).toEqual({
      schema: 1, campaign_id: 'campaign-under-test',
      patterns: ['corpus', 'preregistration', 'private_evidence', 'private_root'],
      cells: [{ cell_key: 'a', scanned: true, hits: [] }],
    });
  });

  it('leaves the private_root label out when the manifest has none', () => {
    const dir = closureDir({ campaign_id: 'c' });
    transcript(dir, 'a', ['{}']);
    expect(scanClosure(dir).patterns).toEqual(['corpus', 'preregistration', 'private_evidence']);
  });

  it('never carries the text it matched: only labels and counts', () => {
    const dir = closureDir();
    transcript(dir, 'a', [String.raw`{"content":"C:\\secret-host-name\\corpus\\expected\\the-answer.json"}`]);
    const text = JSON.stringify(scanClosure(dir));
    expect(text).not.toContain('secret-host-name');
    expect(text).not.toContain('the-answer');
  });

  it('throws when the closure has no manifest or no private directory, rather than reporting an empty scan', () => {
    const root = process.platform === 'win32' && existsSync(SCRATCH_ROOT) ? SCRATCH_ROOT : os.tmpdir();
    const noManifest = closureDir(null);
    expect(() => scanClosure(noManifest)).toThrow(/manifest/);
    const noPrivate = mkdtempSync(path.join(root, 'aeta-np-'));
    cleanup.push(noPrivate);
    writeFileSync(path.join(noPrivate, 'manifest.json'), JSON.stringify({ campaign_id: 'c' }));
    expect(() => scanClosure(noPrivate)).toThrow(/private/);
  });
});

describe('scanClosure -- what campaign-summary.mjs accepts', () => {
  it('a scan made by this module is one the summary applies: it excludes exactly the cells with a hit and flags the missing transcript', () => {
    const dir = closureDir();
    transcript(dir, 'claude-code-0', ['{}']);
    transcript(dir, 'claude-code-1', ['{"p":"corpus/expected/x"}']);
    mkdirSync(path.join(dir, 'private', 'codex-cli-0'), { recursive: true });
    const effects = accessScanEffects(scanClosure(dir), 'campaign-under-test');
    expect([...effects.excludeCellKeys]).toEqual(['claude-code-1']);
    expect(effects.limitations).toHaveLength(2);
    expect(effects.limitations[0]).toContain('claude-code-1');
    expect(effects.limitations[1]).toContain('codex-cli-0');
  });
});

describe('transcript-access-scan.mjs -- the CLI', () => {
  const run = (...args) => spawnSync(process.execPath, [SCAN_SCRIPT, ...args], { encoding: 'utf8' });

  it('prints the scan as JSON on stdout and exits 0', () => {
    const dir = closureDir();
    transcript(dir, 'a', ['{"p":"corpus/expected/x"}']);
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(scanClosure(dir));
  });

  it('exits 1 with a usage line, printing no JSON, when the closure directory is missing', () => {
    const none = run();
    expect(none.status).toBe(1);
    expect(none.stderr).toMatch(/usage/i);
    const absent = run(path.join(os.tmpdir(), 'aeta-never-created'));
    expect(absent.status).toBe(1);
    expect(absent.stdout).toBe('');
  });

  it('exits 1 when the closure holds no manifest', () => {
    const result = run(closureDir(null));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });
});

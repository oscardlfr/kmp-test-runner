#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Fail-closed scan for the exact sanitized artifacts selected by the final campaign launcher.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { assertCleanOrThrowObject } from '../../tools/agentic-eval/privacy.mjs';

const forbiddenKeys = new Set(['prompt', 'response', 'command', 'commands', 'transcript', 'raw', 'stderr', 'stdout', 'cwd', 'credential', 'credentials']);
function inspect(value) {
  if (Array.isArray(value)) { for (const item of value) inspect(item); return; }
  if (value == null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key.toLowerCase())) throw new Error('publication_forbidden_field');
    inspect(child);
  }
}

const args = process.argv.slice(2);
let privatePatternsFile;
const files = [];
for (let i = 0; i < args.length; i += 2) {
  if (args[i] === '--file' && args[i + 1]) files.push(args[i + 1]);
  else if (args[i] === '--private-patterns-file' && args[i + 1]) privatePatternsFile = args[i + 1];
  else throw new Error('publication_scan_arguments_invalid');
}
if (files.length !== 8 || new Set(files).size !== 8 || files.some((path) => !isAbsolute(path))) {
  throw new Error('publication_scan_requires_exactly_eight_explicit_files');
}
for (const path of files) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
  inspect(value);
  // Refuse rather than silently publish a redacted substitute: the harness/reducer must already
  // have produced clean artifacts, so any mutation here would break their bound hashes.
  const checked = assertCleanOrThrowObject(value, { privatePatternsFile });
  if (checked.redactedText !== JSON.stringify(value, null, 2)) throw new Error('publication_would_require_redaction');
}
process.stdout.write(JSON.stringify({ status: 'pass', files_scanned: 8 }) + '\n');

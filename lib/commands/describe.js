// SPDX-License-Identifier: MIT
// lib/commands/describe.js — `kmp-test describe` subcommand wrapper.
//
// Refactor PR-09: pure dispatch shim around runDescribe({...}). The
// orchestrator at lib/describe-orchestrator.js owns the actual logic;
// invalid-regex `--module-filter` validation happens INSIDE runDescribe
// (see describe-orchestrator.js:217-230), so parse() here is a pass-through.

import path from 'node:path';
import { runDescribe, formatDescribeText } from '../orchestrators/describe-orchestrator.js';
import { emitJson } from '../envelope/builder.js';
import { getProjectRoot } from '../parsers/argv.js';

function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run({ args, jsonMode }) {
  const projectRoot = path.resolve(getProjectRoot(args));
  const { envelope, exitCode } = runDescribe({ projectRoot, args });
  if (jsonMode) emitJson(envelope);
  else process.stdout.write(formatDescribeText(envelope));
  return exitCode;
}

export { parse, run };

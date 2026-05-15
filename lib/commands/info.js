// SPDX-License-Identifier: MIT
// lib/commands/info.js — `kmp-test info` subcommand wrapper.
//
// Refactor PR-09: pure dispatch shim around runInfo({...}). The orchestrator
// at lib/info-orchestrator.js owns the actual logic; this module exists so
// cli.js#main can route through a uniform `parse(args) + run({...})` table
// across all 9 subcommands.

import path from 'node:path';
import { runInfo, formatInfoText } from '../orchestrators/info-orchestrator.js';
import { emitJson } from '../envelope/builder.js';
import { getProjectRoot } from '../parsers/argv.js';

// info has no enum/int validation — `--no-adb` is the only flag and it's
// boolean. Always returns ok.
function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run({ args, jsonMode }) {
  const projectRoot = path.resolve(getProjectRoot(args));
  const { envelope, exitCode } = runInfo({ projectRoot, args });
  if (jsonMode) emitJson(envelope);
  else process.stdout.write(formatInfoText(envelope.info));
  return exitCode;
}

export { parse, run };

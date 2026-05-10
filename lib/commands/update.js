// SPDX-License-Identifier: MIT
// lib/commands/update.js — `kmp-test update` subcommand wrapper.
//
// Refactor PR-09: dispatch shim around runUpdate({...}). The orchestrator at
// lib/update-orchestrator.js is async (uses fetch); this module returns the
// ASYNC_DEFERRED sentinel so cli.js#main + bin/kmp-test.js skip their sync
// process.exit and let the .then() callback below fire it once the install
// resolves. Same pattern v0.9 step 3 used inline in cli.js.

import path from 'node:path';
import { runUpdate, formatUpdateText } from '../update-orchestrator.js';
import { EXIT, ASYNC_DEFERRED } from '../envelope/exit-codes.js';
import { emitJson } from '../envelope/builder.js';
import { getProjectRoot } from '../parsers/argv.js';

function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run({ args, jsonMode }) {
  const projectRoot = path.resolve(getProjectRoot(args));
  runUpdate({ projectRoot, args }).then(
    ({ envelope, exitCode }) => {
      if (jsonMode) emitJson(envelope);
      else process.stdout.write(formatUpdateText(envelope));
      process.exit(exitCode);
    },
    (err) => {
      process.stderr.write(`kmp-test update: ${err && err.stack || err}\n`);
      process.exit(EXIT.ENV_ERROR);
    },
  );
  return ASYNC_DEFERRED;
}

export { parse, run };

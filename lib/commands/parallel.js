// SPDX-License-Identifier: MIT
// lib/commands/parallel.js — `kmp-test parallel` subcommand wrapper.
//
// Refactor PR-09: thin shim around dispatchScriptCommand. Pre-spawn enum/int
// validation lives in cli.js#main() (shared across the 5 script-backed subs),
// so parse() here is a no-op contract pass-through.

import { dispatchScriptCommand } from '../runners/script-dispatcher.js';

function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run(ctx) {
  return dispatchScriptCommand({ ...ctx, sub: 'parallel' });
}

export { parse, run };

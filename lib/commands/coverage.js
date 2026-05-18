// SPDX-License-Identifier: MIT
// lib/commands/coverage.js — `kmp-test coverage` subcommand wrapper.
//
// Thin shim around dispatchScriptCommand. Pre-spawn enum/int validation lives
// in cli.js#main() (shared across the 5 script-backed subs).

import { dispatchScriptCommand } from '../runners/script-dispatcher.js';

function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run(ctx) {
  return dispatchScriptCommand({ ...ctx, sub: 'coverage' });
}

export { parse, run };

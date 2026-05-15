// SPDX-License-Identifier: MIT
// lib/commands/changed.js — `kmp-test changed` subcommand wrapper.
//
// Refactor PR-09: thin shim around dispatchScriptCommand. Pre-spawn enum/int
// validation lives in cli.js#main() (shared across the 5 script-backed subs).

import { dispatchScriptCommand } from '../runners/script-dispatcher.js';

function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run(ctx) {
  return dispatchScriptCommand({ ...ctx, sub: 'changed' });
}

export { parse, run };

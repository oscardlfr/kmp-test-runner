// SPDX-License-Identifier: MIT
// lib/commands/benchmark.js — `kmp-test benchmark` subcommand wrapper.
//
// Refactor PR-09: thin shim around dispatchScriptCommand. Benchmark's
// adaptive outer-timeout (smoke=2100s / main=3600s / stress=5400s) is keyed
// on `sub === 'benchmark'` inside dispatchScriptCommand — passing the sub
// here ensures that branch fires.

import { dispatchScriptCommand } from '../runners/script-dispatcher.js';

function parse(_args) {
  return { ok: true, errors: [], parsed: {} };
}

function run(ctx) {
  return dispatchScriptCommand({ ...ctx, sub: 'benchmark' });
}

export { parse, run };

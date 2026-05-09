#!/usr/bin/env node
import { main } from '../lib/cli.js';
const code = main();
// -42 = ASYNC_DEFERRED sentinel: the `update` subcommand kicked off an async
// orchestrator that owns process.exit via its own .then callback. Skip the
// sync exit here so the runtime keeps the event loop alive for the fetch.
if (code !== -42) process.exit(code);

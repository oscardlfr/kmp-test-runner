// SPDX-License-Identifier: MIT
// Test helpers: normalize platform-specific spawn-call shapes.
// On Windows, lib/orchestrator-utils.js#spawnGradle wraps gradle dispatches
// in the system shell to bypass the Node 18.20.2+ EINVAL block on direct
// .bat invocations. These helpers give vitest assertions a unified view.

const SHELL_RE = /(^|[\\/])cmd(\.exe)?$/i;

export function isGradleCall(call) {
  if (!call) return false;
  const cmd = String(call.cmd || '');
  if (/gradlew/i.test(cmd)) return true;
  if (SHELL_RE.test(cmd) && Array.isArray(call.args)) {
    return call.args.some(a => /gradlew/i.test(String(a)));
  }
  return false;
}

export function effectiveGradleArgs(call) {
  if (!call || !Array.isArray(call.args)) return [];
  if (/gradlew/i.test(String(call.cmd))) return call.args;
  // Wrapped shape from spawnGradle on Windows. The cmdLine sits at args[3]
  // and looks like `""<gradlewPath>" arg1 arg2 ..."` (always-quoted path,
  // outer wrapper consumed by cmd.exe /s /c strip rule). We peel the outer
  // wrap and the path-quote pair, then tokenize the rest respecting any
  // remaining inline-quoted args.
  let cmdLine = call.args[3] || '';
  // Strip the outer wrap (first + last char if both `"`).
  if (cmdLine.startsWith('"') && cmdLine.endsWith('"')) {
    cmdLine = cmdLine.slice(1, -1);
  }
  // Now `"<gradlewPath>" arg1 arg2 ...` — strip the path token.
  let rest;
  if (cmdLine.startsWith('"')) {
    const closing = cmdLine.indexOf('"', 1);
    rest = closing === -1 ? '' : cmdLine.slice(closing + 1).replace(/^\s+/, '');
  } else {
    const idx = cmdLine.search(/\s/);
    rest = idx === -1 ? '' : cmdLine.slice(idx + 1);
  }
  if (!rest) return [];
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  let mm;
  while ((mm = re.exec(rest)) !== null) {
    tokens.push(mm[1] !== undefined ? mm[1] : mm[2]);
  }
  return tokens;
}

export function isStopCall(call) {
  if (!isGradleCall(call)) return false;
  const args = effectiveGradleArgs(call);
  return args.length === 1 && args[0] === '--stop';
}

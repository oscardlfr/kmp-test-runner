#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// tools/agentic-eval/policy-config.mjs -- builds and validates the KMP_EVAL_ALLOWED_* policy
// values passed to policy-hook.mjs, and computes the policy SHA-256 recorded in every run
// record (Round 6 item 18).
//
// The validation here mirrors policy-hook.mjs's own parsePolicyList() exactly on purpose --
// this module is where the harness constructs the env values BEFORE they ever reach the hook,
// so a config bug should be caught here, at construction time, not discovered only via the
// hook's own fail-closed denial. The concrete regression this guards: `JSON.parse()` of a bare
// JSON *string* (not an array) does not throw, and `new Set(aString)` silently iterates it
// character-by-character -- so `KMP_EVAL_ALLOWED_GRADLE_TASKS='"build"'` would otherwise let a
// single-letter task slip through undetected.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRADLE_TASK_ENTRY_RE = /^[A-Za-z0-9_:.-]+$/;
const KMPTEST_SUBCOMMAND_ENTRY_RE = /^[a-z]+$/;

function validateEntryList(list, entryRe, fieldName) {
  const errors = [];
  if (!Array.isArray(list)) {
    errors.push({ field: fieldName, message: 'must be an array' });
    return errors;
  }
  const seen = new Set();
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push({ field: fieldName, message: `entry ${JSON.stringify(entry)} must be a non-empty string` });
      continue;
    }
    if (!entryRe.test(entry)) {
      errors.push({ field: fieldName, message: `entry "${entry}" does not match the expected grammar` });
      continue;
    }
    if (seen.has(entry)) {
      errors.push({ field: fieldName, message: `duplicate entry "${entry}"` });
      continue;
    }
    seen.add(entry);
  }
  return errors;
}

/**
 * @param {{allowedGradleTasks: string[], allowedKmpTestSubcommands: string[]}} lists
 * @returns {{errors: Array<{field:string,message:string}>, envValues: Record<string,string>|null}}
 */
export function buildPolicyEnvValues({ allowedGradleTasks, allowedKmpTestSubcommands }) {
  const errors = [
    ...validateEntryList(allowedGradleTasks, GRADLE_TASK_ENTRY_RE, 'allowedGradleTasks'),
    ...validateEntryList(allowedKmpTestSubcommands, KMPTEST_SUBCOMMAND_ENTRY_RE, 'allowedKmpTestSubcommands'),
  ];
  if (errors.length > 0) return { errors, envValues: null };
  return {
    errors,
    envValues: {
      KMP_EVAL_ALLOWED_GRADLE_TASKS: JSON.stringify(allowedGradleTasks),
      KMP_EVAL_ALLOWED_KMPTEST_SUBCOMMANDS: JSON.stringify(allowedKmpTestSubcommands),
    },
  };
}

let cachedPolicySha = null;
/**
 * SHA-256 of policy-hook.mjs's own current source content -- recorded in every run so a
 * silent policy-code change between runs is detectable without diffing the file by hand.
 * Cached per-process (the file doesn't change mid-run); pass {fresh:true} to force a re-read.
 */
export function computePolicySha256({ fresh = false } = {}) {
  if (cachedPolicySha != null && !fresh) return cachedPolicySha;
  const hookPath = join(__dirname, 'policy-hook.mjs');
  const content = readFileSync(hookPath);
  cachedPolicySha = createHash('sha256').update(content).digest('hex');
  return cachedPolicySha;
}

export { GRADLE_TASK_ENTRY_RE, KMPTEST_SUBCOMMAND_ENTRY_RE };

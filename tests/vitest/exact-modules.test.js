import { describe, expect, it } from 'vitest';
import { parseExactModules, resolveExactModules } from '../../lib/orchestrators/exact-modules.js';

describe('--modules resolution', () => {
  const model = { ':core:data': {}, ':feature:data': {}, ':lint': {}, ':core:domain': {}, ':other:core:data': {} };

  it('accepts full and bare Gradle paths, deduplicating by canonical name in first-seen order', () => {
    const parsed = parseExactModules(':core:data, lint, :core:domain, :core:data');
    expect(parsed.errors).toEqual([]);
    expect(resolveExactModules(parsed.names, model)).toEqual({
      names: ['core:data', 'lint', 'core:domain'], errors: [],
    });
  });

  it('rejects empty entries, unknown names and ambiguous short names', () => {
    expect(parseExactModules(':lint,').errors[0].code).toBe('invalid_modules');
    expect(parseExactModules('').errors[0].code).toBe('invalid_modules');
    const result = resolveExactModules(['missing', 'data'], model);
    expect(result.errors).toMatchObject([
      { code: 'unknown_module', module: 'missing' },
      { code: 'ambiguous_module', module: 'data', candidates: [':core:data', ':feature:data', ':other:core:data'] },
    ]);
    expect(resolveExactModules([':core:data'], model).names).toEqual(['core:data']);
  });
});

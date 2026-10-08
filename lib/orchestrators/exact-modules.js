// Resolve a user-supplied list against the complete project model, before
// test-type and exclusion filters narrow the dispatch set.
export function parseExactModules(value) {
  if (value === null || value === undefined) return { names: null, errors: [] };
  const names = String(value).split(',').map(name => name.trim());
  if (names.some(name => !name)) {
    return { names: null, errors: [{
      code: 'invalid_modules',
      flag: '--modules',
      message: '--modules requires non-empty comma-separated Gradle module names',
    }] };
  }
  return { names, errors: [] };
}

export function resolveExactModules(requested, modelModules) {
  if (requested === null) return { names: null, errors: [] };
  const available = Object.keys(modelModules || {}).map(name => name.replace(/^:/, ''));
  const names = [];
  const errors = [];
  const seen = new Set();
  for (const input of requested) {
    const bare = input.replace(/^:/, '');
    const matches = available.filter(name => name === bare
      || (!input.startsWith(':') && name.endsWith(':' + bare)));
    if (matches.length === 0) {
      errors.push({ code: 'unknown_module', module: input, message: `--modules: unknown Gradle module '${input}'` });
    } else if (matches.length > 1) {
      errors.push({ code: 'ambiguous_module', module: input,
        candidates: matches.map(name => ':' + name).sort(),
        message: `--modules: '${input}' matches multiple Gradle modules; use a full :path`,
      });
    } else if (!seen.has(matches[0])) {
      seen.add(matches[0]);
      names.push(matches[0]);
    }
  }
  return { names, errors };
}

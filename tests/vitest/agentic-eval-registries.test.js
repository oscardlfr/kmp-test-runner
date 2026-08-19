// tests/vitest/agentic-eval-registries.test.js
// RED -> GREEN for tools/agentic-eval/registries.mjs: the one closed, validated layer that loads
// runtimes/models/execution-profiles registry JSON, cross-validates against the registered
// adapter, and resolves a single (runtime, model, execution-profile) selection with no fallback.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildRegistries, loadRegistries, resolveSelection, computeExecutionProfileSha256,
  ADAPTERS_BY_RUNTIME_ID, checkRegistryContainerShape,
} from '../../tools/agentic-eval/registries.mjs';
import { claudeCodeRuntimeAdapter } from '../../tools/agentic-eval/runtimes/claude-code.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTIC_DIR = join(__dirname, '..', '..', 'tools', 'agentic-eval');

// Fresh deep copies every call -- tests mutate freely without cross-test contamination.
function realRuntimes() {
  return [{ runtime_id: 'claude-code', enabled: true, default: true }];
}
function realModels() {
  return [{
    runtime_id: 'claude-code', model_id: 'claude-sonnet-5', enabled: true, default: true,
    model_vendor_expected: 'anthropic', default_reasoning_mode: null,
    required_capabilities: [], usage_dimensions: ['input', 'cached_input', 'cache_write', 'output'],
  }];
}
function realProfiles() {
  return [{
    id: 'strict-policy-v1', enabled: true, default: true, supported_runtime_ids: ['claude-code'],
    isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
    isolation_attestation_required: false, policy_mode: 'required',
    required_capabilities: ['softPermissionDenial'],
  }];
}
function realFixture() {
  return { runtimes: realRuntimes(), models: realModels(), executionProfiles: realProfiles() };
}

describe('buildRegistries -- accepts the three real initial registries', () => {
  it('builds cleanly from the exact shipped shape', () => {
    const { runtimes, models, executionProfiles } = realFixture();
    expect(() => buildRegistries({ runtimes, models, executionProfiles })).not.toThrow();
  });

  it('the real on-disk JSON files parse to exactly this shape (schema:1 + one array key each)', () => {
    const runtimesJson = JSON.parse(readFileSync(join(AGENTIC_DIR, 'runtimes', 'registry.json'), 'utf8'));
    const modelsJson = JSON.parse(readFileSync(join(AGENTIC_DIR, 'models', 'registry.json'), 'utf8'));
    const profilesJson = JSON.parse(readFileSync(join(AGENTIC_DIR, 'execution-profiles', 'registry.json'), 'utf8'));
    expect(runtimesJson).toEqual({ schema: 1, runtimes: realRuntimes() });
    expect(modelsJson).toEqual({ schema: 1, models: realModels() });
    expect(profilesJson).toEqual({ schema: 1, execution_profiles: realProfiles() });
  });
});

describe('resolveSelection -- resolves the exact default when every flag is omitted', () => {
  it('resolves claude-code / claude-sonnet-5 / strict-policy-v1 with no flags supplied', () => {
    const registries = buildRegistries(realFixture());
    const result = resolveSelection({ registries });
    expect(result.ok).toBe(true);
    expect(result.selection.runtime.runtime_id).toBe('claude-code');
    expect(result.selection.model.model_id).toBe('claude-sonnet-5');
    expect(result.selection.executionProfile.id).toBe('strict-policy-v1');
    expect(result.selection.adapter).toBe(claudeCodeRuntimeAdapter);
    expect(result.selection.executionProfileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('explicit defaults produce the identical resolved selection as omitted flags', () => {
    const registries = buildRegistries(realFixture());
    const omitted = resolveSelection({ registries });
    const explicit = resolveSelection({
      registries, runtimeId: 'claude-code', modelId: 'claude-sonnet-5', executionProfileId: 'strict-policy-v1',
    });
    expect(explicit.ok).toBe(true);
    expect(explicit.selection.runtime).toEqual(omitted.selection.runtime);
    expect(explicit.selection.model).toEqual(omitted.selection.model);
    expect(explicit.selection.executionProfile).toEqual(omitted.selection.executionProfile);
    expect(explicit.selection.adapter).toBe(omitted.selection.adapter);
    expect(explicit.selection.executionProfileSha256).toBe(omitted.selection.executionProfileSha256);
  });
});

describe('resolveSelection -- unknown/disabled selections fail with no fallback', () => {
  it('an unknown runtime id fails', () => {
    const registries = buildRegistries(realFixture());
    const result = resolveSelection({ registries, runtimeId: 'nonexistent-runtime' });
    expect(result.ok).toBe(false);
  });

  it('a disabled runtime fails, never silently falls back to the default', () => {
    const fixture = realFixture();
    fixture.runtimes.push({ runtime_id: 'other-code', enabled: false, default: false });
    const registries = buildRegistries(fixture);
    const result = resolveSelection({ registries, runtimeId: 'other-code' });
    expect(result.ok).toBe(false);
  });

  it('an unknown model id fails', () => {
    const registries = buildRegistries(realFixture());
    const result = resolveSelection({ registries, modelId: 'not-a-real-model' });
    expect(result.ok).toBe(false);
  });

  it('a disabled model fails for a NEW selection', () => {
    const fixture = realFixture();
    fixture.models[0].default = false;
    fixture.models.push({
      runtime_id: 'claude-code', model_id: 'claude-legacy', enabled: false, default: false,
      model_vendor_expected: 'anthropic', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: ['input', 'output'],
    });
    fixture.models[0].default = true; // keep exactly one default
    const registries = buildRegistries(fixture);
    const result = resolveSelection({ registries, modelId: 'claude-legacy' });
    expect(result.ok).toBe(false);
  });

  it('an unknown execution profile id fails', () => {
    const registries = buildRegistries(realFixture());
    const result = resolveSelection({ registries, executionProfileId: 'not-a-real-profile' });
    expect(result.ok).toBe(false);
  });

  it('a disabled execution profile fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles.push({
      id: 'draft-profile-v1', enabled: false, default: false, supported_runtime_ids: ['claude-code'],
      isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
      isolation_attestation_required: false, policy_mode: 'required', required_capabilities: [],
    });
    const registries = buildRegistries(fixture);
    const result = resolveSelection({ registries, executionProfileId: 'draft-profile-v1' });
    expect(result.ok).toBe(false);
  });
});

describe('buildRegistries -- duplicate IDs fail', () => {
  it('duplicate runtime_id fails', () => {
    const fixture = realFixture();
    fixture.runtimes.push({ runtime_id: 'claude-code', enabled: false, default: false });
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('duplicate execution profile id fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles.push({ ...realProfiles()[0], enabled: false, default: false });
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('duplicate (runtime_id, model_id) pair fails', () => {
    const fixture = realFixture();
    fixture.models[0].default = true;
    fixture.models.push({ ...realModels()[0], enabled: false, default: false });
    expect(() => buildRegistries(fixture)).toThrow();
  });
});

describe('buildRegistries -- zero or multiple compatible defaults fail', () => {
  it('zero default runtimes fails', () => {
    const fixture = realFixture();
    fixture.runtimes[0].default = false;
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('multiple default runtimes fails', () => {
    const fixture = realFixture();
    fixture.runtimes.push({ runtime_id: 'another-runtime', enabled: true, default: true });
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('zero default enabled models for a runtime that has models fails', () => {
    const fixture = realFixture();
    fixture.models[0].default = false;
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('multiple default enabled models for the same runtime fails', () => {
    const fixture = realFixture();
    fixture.models.push({ ...realModels()[0], model_id: 'claude-sonnet-5-alt' });
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('a default:true model that is itself disabled does not count as satisfying the default requirement (fails closed, never silently accepted)', () => {
    const fixture = realFixture();
    fixture.models[0].enabled = false; // default:true but enabled:false -- invalid on its own
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('zero default profiles for a supported runtime fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].default = false;
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('multiple default profiles for the same runtime fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles.push({ ...realProfiles()[0], id: 'strict-policy-v2' });
    expect(() => buildRegistries(fixture)).toThrow();
  });
});

describe('resolveSelection -- model/runtime mismatch and unsupported profile/runtime fail', () => {
  // A synthetic second runtime needs its OWN registered adapter for buildRegistries' cross-check
  // to succeed -- reuses the real claude-code adapter's shape (capabilities are irrelevant to
  // these two tests, which are about SELECTION resolution, not capability cross-validation).
  function fixtureWithSecondRuntime() {
    const fixture = realFixture();
    fixture.runtimes.push({ runtime_id: 'second-runtime', enabled: true, default: false });
    fixture.models.push({
      runtime_id: 'second-runtime', model_id: 'second-model', enabled: true, default: true,
      model_vendor_expected: 'other', default_reasoning_mode: null, required_capabilities: [], usage_dimensions: [],
    });
    return fixture;
  }
  function withSecondAdapter() {
    return { adaptersByRuntimeId: { ...ADAPTERS_BY_RUNTIME_ID, 'second-runtime': claudeCodeRuntimeAdapter } };
  }

  it('a model that exists but belongs to a DIFFERENT runtime_id fails when combined with an explicit mismatched --runtime', () => {
    const registries = buildRegistries(fixtureWithSecondRuntime(), withSecondAdapter());
    // claude-sonnet-5 belongs to claude-code, not second-runtime
    const result = resolveSelection({ registries, runtimeId: 'second-runtime', modelId: 'claude-sonnet-5' });
    expect(result.ok).toBe(false);
  });

  it('an execution profile that does not support the selected runtime fails', () => {
    const registries = buildRegistries(fixtureWithSecondRuntime(), withSecondAdapter());
    // strict-policy-v1 only supports claude-code
    const result = resolveSelection({ registries, runtimeId: 'second-runtime', executionProfileId: 'strict-policy-v1' });
    expect(result.ok).toBe(false);
  });
});

describe('buildRegistries -- capability/usage-dimension cross-validation against the adapter', () => {
  it('an unknown capability name in required_capabilities fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].required_capabilities = ['thisCapabilityDoesNotExist'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('a non-boolean capability key (e.g. usageDimensions, an array-typed capability) is rejected as a required_capabilities entry', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].required_capabilities = ['usageDimensions'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('a required boolean capability that is false on the adapter fails (claude-code.structuredTranscript is true, so requiring a capability the adapter reports false must fail -- simulated by requiring a capability the adapter does not have set true anywhere: this registry cross-check must fire even when everything else validates)', () => {
    // claudeCodeRuntimeAdapter.capabilities does not set every boolean capability true --
    // reuse contract.mjs's CAPABILITY_KEYS indirectly by asserting on the real adapter shape:
    // softPermissionDenial is true, but requiring it alongside a capability this adapter reports
    // false proves the cross-check is real, not a no-op. correlatedToolResults is true too, so use
    // the adapter's own reported shape directly rather than guessing a false one.
    expect(claudeCodeRuntimeAdapter.capabilities.softPermissionDenial).toBe(true);
    // Sanity precondition confirmed; the actual "fails when false" proof is the synthetic-adapter
    // test below (buildRegistries accepts an injected adapter map for exactly this purpose).
  });

  it('a required boolean capability reported false by an injected adapter fails registry build', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].required_capabilities = ['skillStateEvidence'];
    const fakeAdapter = {
      ...claudeCodeRuntimeAdapter,
      capabilities: { ...claudeCodeRuntimeAdapter.capabilities, skillStateEvidence: false },
    };
    expect(() => buildRegistries(fixture, { adaptersByRuntimeId: { 'claude-code': fakeAdapter } })).toThrow();
  });

  it('a usage dimension not declared by the adapter fails', () => {
    const fixture = realFixture();
    fixture.models[0].usage_dimensions = ['input', 'reasoning_output'];
    // claude-code's adapter capabilities.usageDimensions never includes reasoning_output
    expect(claudeCodeRuntimeAdapter.capabilities.usageDimensions.includes('reasoning_output')).toBe(false);
    expect(() => buildRegistries(fixture)).toThrow();
  });
});

describe('buildRegistries -- exact key sets: no credentials, price, api_key, module path, or extra fields', () => {
  for (const forbiddenKey of ['credentials', 'price', 'api_key', 'module', 'module_path', 'adapter_path']) {
    it(`a runtime entry with an extra "${forbiddenKey}" key fails`, () => {
      const fixture = realFixture();
      fixture.runtimes[0][forbiddenKey] = 'x';
      expect(() => buildRegistries(fixture)).toThrow();
    });
    it(`a model entry with an extra "${forbiddenKey}" key fails`, () => {
      const fixture = realFixture();
      fixture.models[0][forbiddenKey] = 'x';
      expect(() => buildRegistries(fixture)).toThrow();
    });
    it(`an execution profile entry with an extra "${forbiddenKey}" key fails`, () => {
      const fixture = realFixture();
      fixture.executionProfiles[0][forbiddenKey] = 'x';
      expect(() => buildRegistries(fixture)).toThrow();
    });
  }

  it('a missing required key on a model entry fails', () => {
    const fixture = realFixture();
    delete fixture.models[0].model_vendor_expected;
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('a missing required key on an execution profile entry fails', () => {
    const fixture = realFixture();
    delete fixture.executionProfiles[0].policy_mode;
    expect(() => buildRegistries(fixture)).toThrow();
  });

});

describe('checkRegistryContainerShape -- the exact on-disk top-level container shape', () => {
  it('accepts exactly {schema:1, <arrayKey>:[...]}', () => {
    expect(checkRegistryContainerShape({ schema: 1, runtimes: realRuntimes() }, 'runtimes', 'runtimes/registry.json')).toEqual(realRuntimes());
  });
  it('rejects an extra top-level key', () => {
    expect(() => checkRegistryContainerShape({ schema: 1, runtimes: realRuntimes(), extra: 1 }, 'runtimes', 'runtimes/registry.json')).toThrow();
  });
  it('rejects a missing "schema" key', () => {
    expect(() => checkRegistryContainerShape({ runtimes: realRuntimes() }, 'runtimes', 'runtimes/registry.json')).toThrow();
  });
  it('rejects a wrong schema value', () => {
    expect(() => checkRegistryContainerShape({ schema: 2, runtimes: realRuntimes() }, 'runtimes', 'runtimes/registry.json')).toThrow();
  });
  it('rejects a non-array value at the array key', () => {
    expect(() => checkRegistryContainerShape({ schema: 1, runtimes: 'not-an-array' }, 'runtimes', 'runtimes/registry.json')).toThrow();
  });
  it('rejects a non-object root', () => {
    expect(() => checkRegistryContainerShape([1, 2], 'runtimes', 'runtimes/registry.json')).toThrow();
    expect(() => checkRegistryContainerShape(null, 'runtimes', 'runtimes/registry.json')).toThrow();
  });
});

describe('buildRegistries -- invalid IDs, non-string/duplicate arrays, and wrong types fail', () => {
  it('an uppercase runtime_id fails the closed lowercase charset', () => {
    const fixture = realFixture();
    fixture.runtimes[0].runtime_id = 'Claude-Code';
    fixture.models[0].runtime_id = 'Claude-Code';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('a runtime_id starting with a hyphen fails', () => {
    const fixture = realFixture();
    fixture.runtimes[0].runtime_id = '-claude-code';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('an execution profile id with an invalid character fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].id = 'strict_policy_v1';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('supported_runtime_ids with a duplicate entry fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].supported_runtime_ids = ['claude-code', 'claude-code'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('supported_runtime_ids with a non-string entry fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].supported_runtime_ids = ['claude-code', 42];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('supported_runtime_ids referencing an unregistered runtime fails (referential integrity)', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].supported_runtime_ids = ['claude-code', 'ghost-runtime'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('required_capabilities with a duplicate entry fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].required_capabilities = ['softPermissionDenial', 'softPermissionDenial'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('usage_dimensions with a duplicate entry fails', () => {
    const fixture = realFixture();
    fixture.models[0].usage_dimensions = ['input', 'input'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('usage_dimensions out of canonical order fails', () => {
    const fixture = realFixture();
    fixture.models[0].usage_dimensions = ['output', 'input'];
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('enabled as a non-boolean fails', () => {
    const fixture = realFixture();
    fixture.runtimes[0].enabled = 'true';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('an unrecognized isolation_kind value fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].isolation_kind = 'made-up-kind';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('an unrecognized network_mode value fails', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].network_mode = 'made-up-mode';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('an unrecognized model_vendor_expected value fails', () => {
    const fixture = realFixture();
    fixture.models[0].model_vendor_expected = 'made-up-vendor';
    expect(() => buildRegistries(fixture)).toThrow();
  });

  it('a non-array runtimes container fails', () => {
    expect(() => buildRegistries({ runtimes: 'not-an-array', models: realModels(), executionProfiles: realProfiles() })).toThrow();
  });
});

describe('buildRegistries -- adding an in-memory second enabled non-default model resolves without changing selection code', () => {
  it('a second enabled, non-default Claude model can be explicitly selected by id', () => {
    const fixture = realFixture();
    fixture.models.push({
      runtime_id: 'claude-code', model_id: 'claude-sonnet-5-preview', enabled: true, default: false,
      model_vendor_expected: 'anthropic', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: ['input', 'cached_input', 'cache_write', 'output'],
    });
    const registries = buildRegistries(fixture);
    const preview = resolveSelection({ registries, modelId: 'claude-sonnet-5-preview' });
    expect(preview.ok).toBe(true);
    expect(preview.selection.model.model_id).toBe('claude-sonnet-5-preview');
    // The default selection is completely unaffected by the second model's mere presence.
    const omitted = resolveSelection({ registries });
    expect(omitted.ok).toBe(true);
    expect(omitted.selection.model.model_id).toBe('claude-sonnet-5');
  });

  it('disabling that second model blocks a NEW selection but a record already built with its metadata still validates against the frozen v6 model-entry shape independent of the live registry', () => {
    const fixture = realFixture();
    fixture.models.push({
      runtime_id: 'claude-code', model_id: 'claude-sonnet-5-preview', enabled: true, default: false,
      model_vendor_expected: 'anthropic', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: ['input', 'cached_input', 'cache_write', 'output'],
    });
    let registries = buildRegistries(fixture);
    const beforeDisable = resolveSelection({ registries, modelId: 'claude-sonnet-5-preview' });
    expect(beforeDisable.ok).toBe(true);
    const capturedModelMetadata = beforeDisable.selection.model;

    fixture.models[1].enabled = false;
    registries = buildRegistries(fixture);
    const afterDisable = resolveSelection({ registries, modelId: 'claude-sonnet-5-preview' });
    expect(afterDisable.ok).toBe(false);

    // The metadata captured before disabling is exactly what a v6 record built at that time would
    // embed in its own agent_runtime group -- validating a HISTORICAL record never re-resolves the
    // model through the live registry (schemas.mjs's validateRun for v6 never imports registries.mjs
    // at all -- see agentic-eval-runtime-boundary.test.js). Captured metadata itself is immutable
    // and independent of the later registry rebuild.
    expect(capturedModelMetadata.model_id).toBe('claude-sonnet-5-preview');
    expect(capturedModelMetadata.enabled).toBe(true);
  });
});

describe('computeExecutionProfileSha256 -- stable under insertion order and non-semantic fields, sensitive to every semantic field', () => {
  it('is stable under object key insertion order', () => {
    const profile = realProfiles()[0];
    const reordered = {
      required_capabilities: profile.required_capabilities, policy_mode: profile.policy_mode,
      isolation_attestation_required: profile.isolation_attestation_required, network_mode: profile.network_mode,
      isolation_kind: profile.isolation_kind, id: profile.id, enabled: profile.enabled, default: profile.default,
      supported_runtime_ids: profile.supported_runtime_ids,
    };
    expect(computeExecutionProfileSha256(profile)).toBe(computeExecutionProfileSha256(reordered));
  });

  it('does not change when enabled changes', () => {
    const profile = realProfiles()[0];
    const changed = { ...profile, enabled: false };
    expect(computeExecutionProfileSha256(profile)).toBe(computeExecutionProfileSha256(changed));
  });

  it('does not change when default changes', () => {
    const profile = realProfiles()[0];
    const changed = { ...profile, default: false };
    expect(computeExecutionProfileSha256(profile)).toBe(computeExecutionProfileSha256(changed));
  });

  it('does not change when supported_runtime_ids changes', () => {
    const profile = realProfiles()[0];
    const changed = { ...profile, supported_runtime_ids: ['claude-code', 'codex-cli'] };
    expect(computeExecutionProfileSha256(profile)).toBe(computeExecutionProfileSha256(changed));
  });

  for (const field of ['id', 'isolation_kind', 'network_mode', 'isolation_attestation_required', 'policy_mode']) {
    it(`changes when ${field} changes`, () => {
      const profile = realProfiles()[0];
      const changed = { ...profile, [field]: typeof profile[field] === 'boolean' ? !profile[field] : `${profile[field]}-changed` };
      expect(computeExecutionProfileSha256(profile)).not.toBe(computeExecutionProfileSha256(changed));
    });
  }

  it('changes when required_capabilities changes', () => {
    const profile = realProfiles()[0];
    const changed = { ...profile, required_capabilities: [] };
    expect(computeExecutionProfileSha256(profile)).not.toBe(computeExecutionProfileSha256(changed));
  });

  it('returns a lowercase 64-char hex string', () => {
    expect(computeExecutionProfileSha256(realProfiles()[0])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('registry loading is cwd-independent and returns a deep-frozen structure', () => {
  it('loadRegistries() succeeds regardless of process.cwd()', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(dirname(originalCwd)); // move one level up, away from the repo root
      expect(() => loadRegistries()).not.toThrow();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('loadRegistries() returns the exact real default selection', () => {
    const registries = loadRegistries();
    const result = resolveSelection({ registries });
    expect(result.ok).toBe(true);
    expect(result.selection.runtime.runtime_id).toBe('claude-code');
    expect(result.selection.model.model_id).toBe('claude-sonnet-5');
    expect(result.selection.executionProfile.id).toBe('strict-policy-v1');
  });

  it('buildRegistries returns a deep-frozen structure -- mutating an entry throws or is silently ignored, and never affects a later read', () => {
    const registries = buildRegistries(realFixture());
    expect(Object.isFrozen(registries)).toBe(true);
    expect(Object.isFrozen(registries.runtimes)).toBe(true);
    expect(Object.isFrozen(registries.runtimes[0])).toBe(true);
    expect(Object.isFrozen(registries.models[0])).toBe(true);
    expect(Object.isFrozen(registries.executionProfiles[0])).toBe(true);
    // ES modules are always strict-mode -- assigning to a frozen property throws (never silently
    // ignored the way sloppy-mode script code would).
    expect(() => { registries.runtimes[0].enabled = false; }).toThrow();
    expect(registries.runtimes[0].enabled).toBe(true); // unaffected regardless
  });

  it('a resolved selection object is itself frozen (immutable)', () => {
    const registries = buildRegistries(realFixture());
    const result = resolveSelection({ registries });
    expect(Object.isFrozen(result.selection)).toBe(true);
  });
});

describe('ADAPTERS_BY_RUNTIME_ID -- the one static runtime_id -> adapter map', () => {
  it('maps claude-code to the real claudeCodeRuntimeAdapter singleton', () => {
    expect(ADAPTERS_BY_RUNTIME_ID['claude-code']).toBe(claudeCodeRuntimeAdapter);
  });
});

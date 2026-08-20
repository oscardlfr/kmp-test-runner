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
    // second-runtime needs its OWN default execution profile too (every enabled runtime must have
    // exactly one) -- deliberately a DIFFERENT profile than strict-policy-v1 (which only supports
    // claude-code), so the "an execution profile that does not support the selected runtime fails"
    // test below still exercises exactly what it claims: requesting a profile that is valid but
    // does not support the runtime, not a runtime with no default profile at all.
    fixture.executionProfiles.push({
      id: 'second-runtime-profile', enabled: true, default: true, supported_runtime_ids: ['second-runtime'],
      isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
      isolation_attestation_required: false, policy_mode: 'required', required_capabilities: [],
    });
    return fixture;
  }
  // A permissive test double, not the real claudeCodeRuntimeAdapter -- these 2 tests are about
  // SELECTION resolution across runtimes (a model/profile that does not belong to/support the
  // requested runtime), never about supportsModelConfiguration/supportsExecutionProfile gating
  // (covered directly, against the REAL adapter, in the P1 architectural review describe block
  // below). The real adapter's own supportsExecutionProfile only accepts the literal
  // strict-policy-v1 shape, which 'second-runtime-profile' (a distinct id, by design) could never
  // satisfy regardless of this test's own intent.
  // Codex round 3, Finding 2: registered under 'second-runtime' but built by spreading
  // claudeCodeRuntimeAdapter, whose OWN .id is 'claude-code' -- getAdapterForRuntimeId now
  // requires adapter.id to equal the key it is registered under, so this double must declare its
  // own id explicitly or it would be (correctly) rejected as a mismatched binding, exactly the
  // class of wiring bug that check exists to catch.
  function withSecondAdapter() {
    const permissiveAdapter = {
      ...claudeCodeRuntimeAdapter,
      id: 'second-runtime',
      supportsModelConfiguration: () => true,
      supportsExecutionProfile: () => true,
    };
    return { adaptersByRuntimeId: { ...ADAPTERS_BY_RUNTIME_ID, 'second-runtime': permissiveAdapter } };
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
  // Codex round 2, Finding 6: every OTHER test in this describe block computes its own expected
  // value via canonicalJsonSha256 (or via computeExecutionProfileSha256 itself) -- a real,
  // deterministic proof of stability/sensitivity, but one that would keep passing even if
  // canonicalJsonSha256's own algorithm silently drifted, since both sides of each comparison
  // would drift together. This value is fixed as a LITERAL string, deliberately NOT recomputed
  // here -- schemas.mjs's v6 execution_profile validator recomputes and compares against exactly
  // this same hash for every committed v6 record, so a future algorithm change must be a deliberate
  // schema/versioning decision, never an invisible side effect of an unrelated refactor.
  it('the real shipped strict-policy-v1 profile hashes to exactly this frozen literal value', () => {
    const profile = realProfiles()[0];
    expect(profile.id).toBe('strict-policy-v1');
    expect(computeExecutionProfileSha256(profile)).toBe('1d1a6a0a606540b57b5bd2c271a4c58b25b02cd8eab3e84d4af07127a3e37585');
  });


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

  it('has a null prototype -- an ordinary Object.prototype-having literal would resolve an Object.prototype member name (e.g. "constructor") via inheritance instead of correctly reporting "absent"', () => {
    expect(Object.getPrototypeOf(ADAPTERS_BY_RUNTIME_ID)).toBe(null);
  });
});

describe('buildRegistries -- adapter lookups are own-property-safe, never resolved via Object.prototype inheritance (P1 architectural review)', () => {
  // "constructor" is the one Object.prototype member name that is ALSO a syntactically valid
  // lowercase-only ID_RE id -- every other inherited name (toString, valueOf, hasOwnProperty,
  // isPrototypeOf, propertyIsEnumerable, toLocaleString) is camelCase and already fails checkId's
  // regex before ever reaching an adapter lookup, so it isn't a real reachable case to test here.
  it('a self-consistent registry naming runtime_id "constructor", validated against an EMPTY adaptersByRuntimeId override, must be rejected -- not silently resolve to Object.prototype.constructor', () => {
    const runtimes = [{ runtime_id: 'constructor', enabled: true, default: true }];
    const models = [{
      runtime_id: 'constructor', model_id: 'x', enabled: true, default: true,
      model_vendor_expected: 'other', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: [],
    }];
    const executionProfiles = [{
      id: 'p1', enabled: true, default: true, supported_runtime_ids: ['constructor'],
      isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
      isolation_attestation_required: false, policy_mode: 'required',
      required_capabilities: [],
    }];
    expect(() => buildRegistries({ runtimes, models, executionProfiles }, { adaptersByRuntimeId: {} })).toThrow();
  });
});

// P1 architectural review (Codex round 2): the registry previously accepted ANY well-shaped model
// (e.g. default_reasoning_mode:"max") or execution profile (e.g. a sandbox+restricted-network+
// attestation-required profile), never checking whether the SELECTED adapter actually implements
// that configuration -- buildInvocation only ever receives {prompt, model, settingsPath}, so none
// of those treatments were ever really applied; a resulting record would be signed as if they had
// been. Both buildRegistries (every ENABLED entry) and resolveSelection (the final resolved
// selection, covering a registries object injected by a test that never went through
// buildRegistries at all) now consult the adapter's own supportsModelConfiguration/
// supportsExecutionProfile.
describe('buildRegistries/resolveSelection -- an enabled model/execution-profile the adapter does not actually support is rejected (P1 architectural review)', () => {
  it('a second enabled model with default_reasoning_mode:null is accepted and independently resolvable', () => {
    const fixture = realFixture();
    fixture.models.push({
      runtime_id: 'claude-code', model_id: 'claude-sonnet-5-preview', enabled: true, default: false,
      model_vendor_expected: 'anthropic', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: ['input', 'cached_input', 'cache_write', 'output'],
    });
    expect(() => buildRegistries(fixture)).not.toThrow();
    const registries = buildRegistries(fixture);
    const result = resolveSelection({ registries, modelId: 'claude-sonnet-5-preview' });
    expect(result.ok).toBe(true);
    expect(result.selection.model.model_id).toBe('claude-sonnet-5-preview');
  });

  it('an enabled model with a non-null default_reasoning_mode is rejected -- claudeCodeRuntimeAdapter never applies it (buildInvocation never receives it)', () => {
    const fixture = realFixture();
    fixture.models.push({
      runtime_id: 'claude-code', model_id: 'claude-sonnet-5-max', enabled: true, default: false,
      model_vendor_expected: 'anthropic', default_reasoning_mode: 'max',
      required_capabilities: [], usage_dimensions: ['input', 'cached_input', 'cache_write', 'output'],
    });
    expect(() => buildRegistries(fixture)).toThrow(/claude-sonnet-5-max/);
  });

  it('the real strict-policy-v1 shape (exactly as shipped) is accepted', () => {
    const fixture = realFixture();
    expect(() => buildRegistries(fixture)).not.toThrow();
    const registries = buildRegistries(fixture);
    const result = resolveSelection({ registries });
    expect(result.ok).toBe(true);
    expect(result.selection.executionProfile.id).toBe('strict-policy-v1');
  });

  it('a mutated strict-policy-v1 (e.g. a different isolation_kind) is rejected, even under its same id', () => {
    const fixture = realFixture();
    fixture.executionProfiles[0].isolation_kind = 'external-sandbox';
    expect(() => buildRegistries(fixture)).toThrow(/strict-policy-v1/);
  });

  it('an enabled sandboxed-unrestricted-v1 profile is rejected even though its required_capabilities are satisfied by the adapter -- capability satisfaction alone is not the same as the adapter actually implementing the profile', () => {
    const fixture = realFixture();
    fixture.executionProfiles.push({
      id: 'sandboxed-unrestricted-v1', enabled: true, default: false, supported_runtime_ids: ['claude-code'],
      isolation_kind: 'runtime-native-sandbox', network_mode: 'restricted',
      isolation_attestation_required: false, policy_mode: 'not_applicable', required_capabilities: [],
    });
    // The capability cross-check alone would pass (required_capabilities:[] trivially satisfied) --
    // proving the NEW rejection is genuinely from supportsExecutionProfile, not incidentally from
    // the pre-existing capability check.
    expect(() => buildRegistries(fixture)).toThrow(/sandboxed-unrestricted-v1/);
  });

  it('the same unsupported profile, disabled, can still remain in the registry (kept for history) but is never selectable', () => {
    const fixture = realFixture();
    fixture.executionProfiles.push({
      id: 'sandboxed-unrestricted-v1', enabled: false, default: false, supported_runtime_ids: ['claude-code'],
      isolation_kind: 'runtime-native-sandbox', network_mode: 'restricted',
      isolation_attestation_required: false, policy_mode: 'not_applicable', required_capabilities: [],
    });
    expect(() => buildRegistries(fixture)).not.toThrow();
    const registries = buildRegistries(fixture);
    const result = resolveSelection({ registries, executionProfileId: 'sandboxed-unrestricted-v1' });
    expect(result.ok).toBe(false);
  });

  it('resolveSelection independently re-checks supportsModelConfiguration/supportsExecutionProfile against a registries object that never went through buildRegistries at all (a raw test-injected fixture)', () => {
    const rawRegistries = {
      runtimes: realRuntimes(),
      models: [{
        runtime_id: 'claude-code', model_id: 'claude-sonnet-5-max', enabled: true, default: true,
        model_vendor_expected: 'anthropic', default_reasoning_mode: 'max',
        required_capabilities: [], usage_dimensions: [],
      }],
      executionProfiles: realProfiles(),
    };
    const result = resolveSelection({ registries: rawRegistries });
    expect(result.ok).toBe(false);
  });

  it('an adapter missing supportsModelConfiguration/supportsExecutionProfile fails the adapter contract (validateRuntimeAdapter), never silently treated as "supports everything"', async () => {
    const { validateRuntimeAdapter } = await import('../../tools/agentic-eval/runtimes/contract.mjs');
    const incompleteAdapter = { ...claudeCodeRuntimeAdapter };
    delete incompleteAdapter.supportsModelConfiguration;
    delete incompleteAdapter.supportsExecutionProfile;
    const result = validateRuntimeAdapter(incompleteAdapter);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.field === 'supportsModelConfiguration')).toBe(true);
    expect(result.errors.some((e) => e.field === 'supportsExecutionProfile')).toBe(true);
  });
});

describe('buildRegistries -- every enabled runtime needs its own adapter/default-model/default-profile, derived from the runtimes array itself, never merely from which runtime_ids happen to appear in models/executionProfiles (P1 architectural review)', () => {
  it('an enabled runtime with ZERO models and ZERO execution profiles referencing it is rejected, not silently accepted for lack of anything to check', () => {
    const runtimes = [
      { runtime_id: 'claude-code', enabled: true, default: true },
      { runtime_id: 'orphan-runtime', enabled: true, default: false },
    ];
    const { models, executionProfiles } = realFixture(); // both reference claude-code only
    expect(() => buildRegistries({ runtimes, models, executionProfiles })).toThrow(/orphan-runtime/);
  });

  it('an enabled runtime with a model present but zero default-enabled models is still rejected even though it appears in the models array', () => {
    const runtimes = [
      { runtime_id: 'claude-code', enabled: true, default: true },
      { runtime_id: 'no-default-model', enabled: true, default: false },
    ];
    const models = [
      ...realModels(),
      {
        runtime_id: 'no-default-model', model_id: 'x', enabled: true, default: false,
        model_vendor_expected: 'other', default_reasoning_mode: null,
        required_capabilities: [], usage_dimensions: [],
      },
    ];
    const executionProfiles = [
      ...realProfiles(),
      {
        id: 'p2', enabled: true, default: true, supported_runtime_ids: ['no-default-model'],
        isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
        isolation_attestation_required: false, policy_mode: 'required',
        required_capabilities: [],
      },
    ];
    expect(() => buildRegistries({ runtimes, models, executionProfiles }, { adaptersByRuntimeId: { 'claude-code': claudeCodeRuntimeAdapter, 'no-default-model': claudeCodeRuntimeAdapter } })).toThrow(/no-default-model/);
  });
});

// Codex round 3, Finding 2: getAdapterForRuntimeId previously returned WHATEVER object was
// registered under a runtime_id key, never checking that the adapter's own self-reported `.id`
// actually equals that key, nor running the adapter through validateRuntimeAdapter's full
// contract check at the point of lookup (only defineRuntimeAdapter, at module-load time for the
// ONE real default export, ever did that). A future wiring bug -- registering the wrong adapter
// object under a runtime_id -- would silently resolve and label a session under a DIFFERENT
// runtime than the one whose adapter is actually driving it, potentially after live sessions were
// already spent. Both buildRegistries (via its 3 lookup sites) and resolveSelection (its own
// separate lookup) share the ONE getAdapterForRuntimeId accessor, so fixing it there closes the
// gap everywhere at once.
describe('getAdapterForRuntimeId -- an adapter registered under a runtime_id must own-report that SAME id, and must pass the full adapter contract (Codex round 3, Finding 2)', () => {
  function mismatchedIdFixture() {
    const fixture = realFixture();
    fixture.runtimes.push({ runtime_id: 'second-runtime', enabled: true, default: false });
    fixture.models.push({
      runtime_id: 'second-runtime', model_id: 'second-model', enabled: true, default: true,
      model_vendor_expected: 'other', default_reasoning_mode: null, required_capabilities: [], usage_dimensions: [],
    });
    fixture.executionProfiles.push({
      id: 'second-runtime-profile', enabled: true, default: true, supported_runtime_ids: ['second-runtime'],
      isolation_kind: 'runtime-policy-hooks', network_mode: 'runtime-default',
      isolation_attestation_required: false, policy_mode: 'required', required_capabilities: [],
    });
    return fixture;
  }

  it('buildRegistries rejects a runtime whose registered adapter self-reports a DIFFERENT id -- a wiring bug, never silently accepted', () => {
    // Otherwise a fully well-formed adapter (passes validateRuntimeAdapter on its own) -- the
    // ONLY defect is that its own .id ('claude-code') does not match the key it is registered
    // under ('second-runtime'). Proves the rejection is genuinely from the id<->key binding
    // check, not incidentally from some other contract violation.
    const wronglyBoundAdapter = { ...claudeCodeRuntimeAdapter, supportsModelConfiguration: () => true, supportsExecutionProfile: () => true };
    expect(wronglyBoundAdapter.id).toBe('claude-code');
    expect(() => buildRegistries(mismatchedIdFixture(), {
      adaptersByRuntimeId: { ...ADAPTERS_BY_RUNTIME_ID, 'second-runtime': wronglyBoundAdapter },
    })).toThrow(/second-runtime/);
  });

  // Codex round 3 audit (P2, test-coverage precision): the prior version of this test named
  // itself "resolveSelection ALSO rejects the same mismatched binding" but never called
  // resolveSelection at all, and built a CORRECTLY-bound adapter (id:'second-runtime', matching
  // its own key) -- its one assertion (`registries` is truthy) was true regardless of whether the
  // Finding 2 fix existed.
  //
  // resolveSelection's own adapter lookup (unlike buildRegistries') always goes through the REAL,
  // frozen ADAPTERS_BY_RUNTIME_ID -- it has never accepted a caller-injected map, so a synthetic
  // 'second-runtime' selection can never actually succeed through resolveSelection regardless of
  // what the `registries` argument itself contains (getAdapterForRuntimeId(ADAPTERS_BY_RUNTIME_ID,
  // 'second-runtime') is unconditionally undefined -- the real map has exactly one entry). Neither
  // a mismatched NOR a correctly-bound synthetic runtime is a reachable case at this specific
  // boundary; the only genuinely testable instance of "resolveSelection's returned adapter
  // satisfies adapter.id === runtime.runtime_id" is the one real production resolution.
  it("resolveSelection's own returned adapter satisfies adapter.id === runtime.runtime_id on the real production resolution -- the same binding invariant getAdapterForRuntimeId enforces internally, observed end to end (a synthetic non-default runtime is not a reachable case here: resolveSelection's own adapter lookup always uses the real ADAPTERS_BY_RUNTIME_ID, which has exactly the one claude-code entry)", () => {
    const result = resolveSelection({});
    expect(result.ok).toBe(true);
    expect(result.selection.adapter.id).toBe(result.selection.runtime.runtime_id);
    expect(result.selection.adapter.id).toBe('claude-code');
  });

  it('an adapter missing a required contract method, registered under a runtime_id, is treated as "no adapter registered" -- validateRuntimeAdapter now runs at lookup time, not just at defineRuntimeAdapter time', () => {
    const malformedAdapter = { ...claudeCodeRuntimeAdapter, id: 'second-runtime' };
    delete malformedAdapter.redactRuntimeDiagnostics;
    expect(() => buildRegistries(mismatchedIdFixture(), {
      adaptersByRuntimeId: { ...ADAPTERS_BY_RUNTIME_ID, 'second-runtime': malformedAdapter },
    })).toThrow(/second-runtime/);
  });
});

// Codex round 3, Finding 3: Claude Code's own supportsModelConfiguration checked ONLY
// default_reasoning_mode, never runtime_id or model_vendor_expected -- a model entry claiming
// runtime_id:'claude-code' but model_vendor_expected:'openai' (nonsensical: Claude Code serving
// an OpenAI-branded model) was accepted and resolved. Separately, resolveSelection's own
// "independent re-validation" of a caller-injected registries object only ever re-ran the 2
// adapter-support predicates, never buildRegistries' full shape/capability/vocabulary validation
// -- a raw registries object naming an unknown required_capabilities/usage_dimensions value could
// still resolve successfully. Both close via the SAME mechanism: resolveSelection now routes any
// registries object it does not already recognize as fully validated back through buildRegistries
// itself, tracked by a WeakSet so an already-validated object is never gratuitously rebuilt.
describe('supportsModelConfiguration/resolveSelection -- full-fidelity validation, not a second partial check (Codex round 3, Finding 3)', () => {
  it("Claude Code's supportsModelConfiguration rejects model_vendor_expected:'openai' even with runtime_id:'claude-code' and default_reasoning_mode:null", () => {
    const entry = {
      runtime_id: 'claude-code', model_id: 'claude-sonnet-5', enabled: true, default: true,
      model_vendor_expected: 'openai', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: [],
    };
    expect(claudeCodeRuntimeAdapter.supportsModelConfiguration(entry)).toBe(false);
  });

  it("Claude Code's supportsModelConfiguration rejects a runtime_id other than 'claude-code', even with an otherwise-valid vendor/reasoning", () => {
    const entry = {
      runtime_id: 'some-other-runtime', model_id: 'x', enabled: true, default: true,
      model_vendor_expected: 'anthropic', default_reasoning_mode: null,
      required_capabilities: [], usage_dimensions: [],
    };
    expect(claudeCodeRuntimeAdapter.supportsModelConfiguration(entry)).toBe(false);
  });

  it("Claude Code's supportsModelConfiguration still accepts the real shipped model entry (runtime_id:'claude-code', model_vendor_expected:'anthropic', default_reasoning_mode:null)", () => {
    expect(claudeCodeRuntimeAdapter.supportsModelConfiguration(realModels()[0])).toBe(true);
  });

  it('resolveSelection rejects a raw (never buildRegistries-validated) registries object whose model carries an unknown required_capabilities value', () => {
    const rawRegistries = {
      runtimes: realRuntimes(),
      models: [{ ...realModels()[0], required_capabilities: ['not-a-capability'] }],
      executionProfiles: realProfiles(),
    };
    const result = resolveSelection({ registries: rawRegistries });
    expect(result.ok).toBe(false);
  });

  it('resolveSelection rejects a raw registries object whose model carries an unknown usage_dimensions value', () => {
    const rawRegistries = {
      runtimes: realRuntimes(),
      models: [{ ...realModels()[0], usage_dimensions: ['not-a-dimension'] }],
      executionProfiles: realProfiles(),
    };
    const result = resolveSelection({ registries: rawRegistries });
    expect(result.ok).toBe(false);
  });

  it('resolveSelection still resolves correctly given a raw, otherwise-valid registries object (full revalidation succeeds, not just "always reject unrecognized")', () => {
    const rawRegistries = { runtimes: realRuntimes(), models: realModels(), executionProfiles: realProfiles() };
    const result = resolveSelection({ registries: rawRegistries });
    expect(result.ok).toBe(true);
    expect(result.selection.model.model_id).toBe('claude-sonnet-5');
  });

  // Codex round 3 audit (P2, test-coverage precision): the prior version of this test only ever
  // inspected the WeakSet's own membership via a test-only introspection export
  // (__isKnownValidatedRegistries) -- proof that the MARKER exists, never proof that the fast
  // path (an already-validated registries object, trusted as-is) and the slow path (a raw
  // registries object, revalidated inline) actually produce the SAME observable resolution. The
  // WeakSet is an implementation detail; what a caller can actually observe -- and what this test
  // now compares directly -- is the selection resolveSelection returns.
  it('resolveSelection produces the IDENTICAL selection whether given an already-built (fast path) registries object or an equivalent raw one revalidated on the fly (slow path) -- runtime, model, execution profile, hash, and adapter all agree', () => {
    const alreadyBuilt = buildRegistries(realFixture());
    const rawEquivalent = { runtimes: realRuntimes(), models: realModels(), executionProfiles: realProfiles() };

    const fastPathResult = resolveSelection({ registries: alreadyBuilt });
    const slowPathResult = resolveSelection({ registries: rawEquivalent });

    expect(fastPathResult.ok).toBe(true);
    expect(slowPathResult.ok).toBe(true);
    expect(fastPathResult.selection.runtime).toEqual(slowPathResult.selection.runtime);
    expect(fastPathResult.selection.model).toEqual(slowPathResult.selection.model);
    expect(fastPathResult.selection.executionProfile).toEqual(slowPathResult.selection.executionProfile);
    expect(fastPathResult.selection.executionProfileSha256).toBe(slowPathResult.selection.executionProfileSha256);
    // The adapter itself is a shared singleton (claudeCodeRuntimeAdapter) regardless of which
    // path resolved it -- reference-identical, not merely structurally equal.
    expect(fastPathResult.selection.adapter).toBe(slowPathResult.selection.adapter);
  });
});

// Codex round 3, Finding 4: callAdapterSupportCheck previously received the STILL-MUTABLE entry
// objects (the raw input models[i]/executionProfiles[i], before any cloning/freezing) -- an
// adapter's own supportsModelConfiguration/supportsExecutionProfile implementation could mutate
// its own `entry` parameter as a side effect, and since the final clone+freeze happened AFTER
// every predicate call, that mutation would be exactly what got published. Fixed by building and
// freezing the final candidate FIRST, then passing only those frozen entries to any predicate.
// Reproduction below mirrors Codex's own exact scenario: the adapter catches its own
// (frozen-object) mutation exception and still returns true, so buildRegistries genuinely
// ACCEPTS the entry (never throws) -- the guarantee under test is narrower and more precise than
// "rejects": whatever gets PUBLISHED must be the ORIGINAL, unmutated value, because the frozen
// candidate rejected the write before the adapter's own return value was ever consulted.
describe('buildRegistries -- an adapter cannot mutate an entry after it has been validated (Codex round 3, Finding 4)', () => {
  it('a supportsModelConfiguration that mutates a TOP-LEVEL field of its entry and returns true never gets that mutation published, and the CALLER\'S OWN original input is untouched', () => {
    const fixture = realFixture();
    const mutatingAdapter = {
      ...claudeCodeRuntimeAdapter,
      supportsModelConfiguration(entry) {
        try { entry.default_reasoning_mode = 'mutated-after-validation'; } catch { /* frozen: expected -- the write never takes effect */ }
        return true;
      },
    };
    const originalEntry = fixture.models[0];
    const registries = buildRegistries(fixture, { adaptersByRuntimeId: { 'claude-code': mutatingAdapter } });
    // The PUBLISHED value is never the mutated one -- the frozen candidate rejected the write
    // before the adapter's own (caught) exception ever had a chance to take effect.
    expect(registries.models[0].default_reasoning_mode).toBeNull();
    // The caller's own original object (never cloned until INSIDE buildRegistries) must never
    // have been touched either.
    expect(originalEntry.default_reasoning_mode).toBeNull();
  });

  it('a supportsExecutionProfile that mutates a NESTED ARRAY field (required_capabilities) of its entry never gets that mutation published, and the caller\'s own original array is untouched', () => {
    const fixture = realFixture();
    const originalCapabilities = fixture.executionProfiles[0].required_capabilities;
    const mutatingAdapter = {
      ...claudeCodeRuntimeAdapter,
      supportsExecutionProfile(entry) {
        try { entry.required_capabilities.push('mutated-after-validation'); } catch { /* frozen: expected -- the push never takes effect */ }
        return true;
      },
    };
    const registries = buildRegistries(fixture, { adaptersByRuntimeId: { 'claude-code': mutatingAdapter } });
    expect(registries.executionProfiles[0].required_capabilities).toEqual(['softPermissionDenial']);
    expect(originalCapabilities).toEqual(['softPermissionDenial']);
  });

  it('a well-behaved (non-mutating) adapter is completely unaffected by receiving frozen entries -- reading a frozen object is unremarkable', () => {
    const fixture = realFixture();
    const readOnlyAdapter = {
      ...claudeCodeRuntimeAdapter,
      supportsModelConfiguration(entry) { return entry.default_reasoning_mode === null; },
      supportsExecutionProfile(entry) { return entry.id === 'strict-policy-v1'; },
    };
    expect(() => buildRegistries(fixture, { adaptersByRuntimeId: { 'claude-code': readOnlyAdapter } })).not.toThrow();
  });
});

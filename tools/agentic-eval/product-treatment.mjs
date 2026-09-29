// SPDX-License-Identifier: MIT

/** Applies the measured product treatment to a prepared runtime invocation. */
export function applyExplicitProductTreatment({
  invocation, condition, runtimeId, targetPluginName, targetSkillName,
}) {
  if (condition === 'no-skill') return invocation;
  if (condition !== 'current-skill') throw new Error('unsupported_product_treatment_condition');
  if (invocation == null || typeof invocation !== 'object' || typeof invocation.stdinText !== 'string') {
    throw new Error('product_treatment_requires_stdin_prompt');
  }

  if (runtimeId === 'claude-code') {
    if (!targetPluginName || !targetSkillName) throw new Error('claude_product_treatment_requires_skill_identity');
    const skillReference = `${targetPluginName}:${targetSkillName}`;
    return {
      ...invocation,
      // A user-invoked /skill expands before the model runs and does not emit
      // the Skill tool_use event that the benchmark measures. Ask the model
      // to invoke the installed skill through its exposed Skill tool instead.
      stdinText: `Before any Bash call, invoke the Skill tool with skill "${skillReference}". Wait for its result and apply its decision protocol to the task below. If the Skill tool cannot load that exact skill, stop without running tests; do not reconstruct it from memory.\n\n${invocation.stdinText}`,
      runtimeContext: {
        ...(invocation.runtimeContext ?? {}),
        productTreatmentDelivery: 'claude-model-skill-tool',
      },
    };
  } else if (runtimeId === 'codex-cli') {
    if (!targetSkillName) throw new Error('codex_product_treatment_requires_skill_identity');
    return {
      ...invocation,
      stdinText: `$${targetSkillName}\n\n${invocation.stdinText}`,
      runtimeContext: {
        ...(invocation.runtimeContext ?? {}),
        productTreatmentDelivery: 'codex-skill-reference',
      },
    };
  } else {
    throw new Error('unsupported_product_treatment_runtime');
  }
}

import { describe, expect, it } from 'vitest';
import { applyExplicitProductTreatment } from '../../tools/agentic-eval/product-treatment.mjs';

const TASK = 'Run the requested KMP test task and report the terminal JSON envelope.';

describe('applyExplicitProductTreatment', () => {
  it('leaves the free-baseline invocation byte-for-byte untouched', () => {
    const invocation = { argv: ['runtime', '-'], stdinText: TASK, runtimeContext: { stable: true } };
    expect(applyExplicitProductTreatment({
      invocation, condition: 'no-skill', runtimeId: 'codex-cli',
      targetPluginName: 'kmp-test-runner', targetSkillName: 'kmp-test-runner',
    })).toBe(invocation);
  });

  it('asks Claude to invoke the installed skill through the observable Skill tool before Bash', () => {
    const invocation = { argv: ['claude', '-p', '--output-format', 'stream-json', '--plugin-dir', 'snapshot'], stdinText: TASK, runtimeContext: { stable: true } };
    const treated = applyExplicitProductTreatment({
      invocation, condition: 'current-skill', runtimeId: 'claude-code',
      targetPluginName: 'kmp-test-runner', targetSkillName: 'kmp-test-runner',
    });
    expect(treated).not.toBe(invocation);
    expect(treated.argv).toEqual(invocation.argv);
    expect(treated.stdinText).toMatch(/^Before any Bash call, invoke the Skill tool with skill "kmp-test-runner:kmp-test-runner"\./);
    expect(treated.stdinText).not.toContain('/kmp-test-runner:kmp-test-runner');
    expect(treated.stdinText).not.toContain('A coherent non-dry-run kmp-test JSON envelope is terminal');
    expect(treated.stdinText).toContain(TASK);
    expect(treated.stdinText).not.toMatch(/23 missed|threshold 15|one test|four individual/i);
    expect(treated.runtimeContext).toEqual({ stable: true, productTreatmentDelivery: 'claude-model-skill-tool' });
  });

  it('fails before spawn when the Claude plugin skill identity is missing', () => {
    expect(() => applyExplicitProductTreatment({
      invocation: { argv: ['claude'], stdinText: TASK },
      condition: 'current-skill', runtimeId: 'claude-code',
      targetPluginName: 'kmp-test-runner',
    })).toThrow(/claude_product_treatment_requires_skill_identity/);
  });

  it('explicitly invokes the Codex skill without changing runtime context', () => {
    const runtimeContext = { stable: true };
    const invocation = { argv: ['codex', 'exec', '-'], stdinText: TASK, runtimeContext };
    const treated = applyExplicitProductTreatment({
      invocation, condition: 'current-skill', runtimeId: 'codex-cli',
      targetPluginName: 'kmp-test-runner', targetSkillName: 'kmp-test-runner',
    });
    expect(treated.stdinText).toMatch(/^\$kmp-test-runner\b/);
    expect(treated.stdinText).not.toContain('A coherent non-dry-run kmp-test JSON envelope is terminal');
    expect(treated.stdinText).toBe(`$kmp-test-runner\n\n${TASK}`);
    expect(treated.runtimeContext).toEqual({ stable: true, productTreatmentDelivery: 'codex-skill-reference' });
  });

  it('fails closed for a product condition on an unsupported runtime', () => {
    expect(() => applyExplicitProductTreatment({
      invocation: { argv: [], stdinText: TASK }, condition: 'current-skill', runtimeId: 'future-runtime',
      targetPluginName: 'kmp-test-runner', targetSkillName: 'kmp-test-runner',
    })).toThrow(/unsupported_product_treatment_runtime/);
  });
});

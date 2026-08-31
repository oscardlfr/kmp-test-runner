import { describe, expect, it } from 'vitest';
import { formatFailureDiagnostics } from '../../lib/runners/script-dispatcher.js';

describe('bounded JSON failure diagnostics', () => {
  it('removes every envelope block, including an incomplete trailing block', () => {
    const block = '__KMP_TEST_ENVELOPE_V1_BEGIN__\n{"secret":"ENVELOPE_PRIVATE"}\n__KMP_TEST_ENVELOPE_V1_END__';
    const text = `BUILD FAILED\n${block}\n${block}\n__KMP_TEST_ENVELOPE_V1_BEGIN__\nENVELOPE_PRIVATE`;
    const result = formatFailureDiagnostics(text, 'Could not GET synthetic endpoint');
    expect(result).toContain('BUILD FAILED');
    expect(result).toContain('Could not GET synthetic endpoint');
    expect(result).not.toMatch(/ENVELOPE_PRIVATE|__KMP_TEST_ENVELOPE/);
  });

  it('bounds both streams in bytes, preserves their tails, and labels truncation', () => {
    const result = formatFailureDiagnostics('x'.repeat(100000) + '\nSTDOUT_END', '\u00e1'.repeat(100000) + '\nSTDERR_END');
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(65536);
    expect(result).toContain('STDOUT_END');
    expect(result).toContain('STDERR_END');
    expect(result).toContain('truncated');
    expect(result).not.toContain('\ufffd');
  });

  it('emits nothing when no diagnostics survived and handles buffer streams', () => {
    expect(formatFailureDiagnostics('', '')).toBe('');
    expect(formatFailureDiagnostics(null, undefined)).toBe('');
    expect(formatFailureDiagnostics(Buffer.from('BUILD FAILED'), Buffer.from('SSLHandshakeException'))).toContain('SSLHandshakeException');
  });
});

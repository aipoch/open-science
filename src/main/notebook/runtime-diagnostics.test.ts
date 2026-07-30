import { describe, expect, it } from 'vitest'

import { boundedRuntimeDiagnostic, runtimeChildProcessErrorFields } from './runtime-diagnostics'

describe('runtime diagnostics', () => {
  it('redacts credentials and preserves both ends of long installer output', () => {
    const diagnostic = boundedRuntimeDiagnostic(
      `FETCH https://user:password@example.test/channel?token=secret\n` +
        `${'x'.repeat(20_000)}\nsolver-tail-marker`
    )
    const serialized = JSON.stringify(diagnostic)

    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('token=secret')
    expect(serialized).toContain('[redacted]')
    expect(serialized).toContain('solver-tail-marker')
    expect(diagnostic.truncated).toBe(true)
  })

  it('retains Node child-process exit diagnostics that Error serialization drops', () => {
    const fields = runtimeChildProcessErrorFields(
      Object.assign(new Error('Command failed'), {
        code: 3221225781,
        signal: null,
        killed: false,
        stdout: 'runtime output',
        stderr: 'api_key=secret missing libgcc_s_seh-1.dll'
      })
    )

    expect(fields).toMatchObject({
      error: 'Command failed',
      code: 3221225781,
      signal: null,
      killed: false,
      stdout: { text: 'runtime output', truncated: false },
      stderr: {
        text: 'api_key=[redacted] missing libgcc_s_seh-1.dll',
        truncated: false
      }
    })
  })
})

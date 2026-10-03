import { describe, expect, it } from 'vitest'

import { classifyWindowsLaunchDiagnostic } from './windows-launch-diagnostics'

describe('Windows launch diagnostics', () => {
  it('classifies the Electron NUL initialization failure into a stable category', () => {
    expect(
      classifyWindowsLaunchDiagnostic({
        platform: 'win32',
        stderr: 'Unable to open nul device needed for initialization, aborting startup.'
      })
    ).toBe('nul-initialization-unavailable')
  })

  it('recognizes the supported Electron workaround marker without exposing raw text', () => {
    expect(
      classifyWindowsLaunchDiagnostic({
        platform: 'win32',
        stderr: 'Electron initialization failed; try starting with --no-stdio-init.'
      })
    ).toBe('nul-initialization-unavailable')
  })

  it.each([
    { platform: 'linux' as const, stderr: 'Unable to open nul device needed for initialization.' },
    { platform: 'win32' as const, stderr: 'Access is denied.' },
    { platform: 'win32' as const, stderr: undefined }
  ])('does not classify unrelated or non-Windows diagnostics', (input) => {
    expect(classifyWindowsLaunchDiagnostic(input)).toBe('unknown')
  })
})

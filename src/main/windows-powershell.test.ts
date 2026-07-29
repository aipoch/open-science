import { describe, expect, it } from 'vitest'

import { resolveWindowsPowerShellExecutable } from './windows-powershell'

describe('resolveWindowsPowerShellExecutable', () => {
  it('uses SystemRoot when PATH does not contain Windows system directories', () => {
    expect(
      resolveWindowsPowerShellExecutable({
        SystemRoot: 'D:\\Windows',
        PATH: 'C:\\Users\\sunsh\\bin'
      })
    ).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  })

  it('uses WINDIR when SystemRoot is unavailable', () => {
    expect(resolveWindowsPowerShellExecutable({ WINDIR: 'E:\\Windows' })).toBe(
      'E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    )
  })

  it('falls back to PATH lookup when neither Windows root variable is available', () => {
    expect(resolveWindowsPowerShellExecutable({})).toBe('powershell.exe')
  })
})

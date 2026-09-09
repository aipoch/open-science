import { describe, expect, it } from 'vitest'
import { parsePowerShellSearchCommands } from './powershell-search-parser'
import { assertShellSearchScope } from './shell-search-scope'

describe.skipIf(process.platform !== 'win32')('Windows PowerShell search preflight', () => {
  it('parses literals, arrays, aliases, and unresolved variables without executing substitutions', async () => {
    expect(
      await parsePowerShellSearchCommands(
        "gci -LiteralPath '.', '..' -Recurse; Write-Output $(throw 'must never run')"
      )
    ).toEqual(
      expect.arrayContaining([
        { name: 'gci', arguments: ['-LiteralPath', '.', '..', '-Recurse'] },
        { name: 'Write-Output', arguments: [null] }
      ])
    )
  })

  it.each([
    "Get-ChildItem -LiteralPath 'C:\\' -Recurse",
    'gci .. -Recurse',
    'Get-ChildItem HKLM:\\ -Recurse',
    'Get-ChildItem C:.. -Recurse',
    'Get-ChildItem FileSystem::C:\\ -Recurse',
    'Get-ChildItem -Path $env:USERPROFILE -Recurse',
    'Set-Location ..; gci . -Recurse',
    'cmd /c "dir /s C:\\"',
    'Remove-Item Alias:where; where /r C:\\ chart.png',
    'where.exe /r C:\\ chart.png'
  ])('rejects unsafe discovery without running the command: %s', async (source) => {
    await expect(assertShellSearchScope(source, process.cwd())).rejects.toThrow(
      /search scope denied/i
    )
  })

  it.each([
    'Get-ChildItem -LiteralPath . -Recurse -Filter chart.png',
    'gci -LiteralPath . -File',
    "Get-ChildItem . | where Name -like '*.csv'",
    'where.exe /r . chart.png',
    "Write-Output 'Get-ChildItem C:\\ is documentation'"
  ])('retains scoped discovery and ordinary output: %s', async (source) => {
    await expect(assertShellSearchScope(source, process.cwd())).resolves.toBeUndefined()
  })
})

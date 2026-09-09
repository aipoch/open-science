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
    'New-Item -ItemType SymbolicLink -Path ./escape -Target C:\\; gci ./escape',
    'ni -Type Junction -Path ./escape -Target C:\\; gci ./escape',
    'New-Item Alias:x -Value Get-ChildItem; x C:\\ -Recurse',
    'ni Alias:x -Value Get-ChildItem; x C:\\ -Recurse',
    'Microsoft.PowerShell.Management\\Set-Item Function:x { Get-ChildItem C:\\ }; x',
    'Copy-Item Alias:gci Alias:x; x C:\\ -Recurse',
    'Set-Location Alias:; New-Item x -Value Get-ChildItem; x C:\\ -Recurse',
    "Start-Process powershell.exe -ArgumentList '-Command','Get-ChildItem C:\\' -Wait",
    "saps powershell.exe -ArgumentList '-Command','Get-ChildItem C:\\' -Wait",
    "start powershell.exe -ArgumentList '-Command','Get-ChildItem C:\\' -Wait",
    'rg --ignore-file ../outside/ignore needle .',
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
    'New-Item ./data -ItemType Directory',
    "Get-ChildItem . | where Name -like '*.csv'",
    'where.exe /r . chart.png',
    'rg --ignore-file ./ignore needle .',
    "Write-Output 'Get-ChildItem C:\\ is documentation'"
  ])('retains scoped discovery and ordinary output: %s', async (source) => {
    await expect(assertShellSearchScope(source, process.cwd())).resolves.toBeUndefined()
  })
})

import { analyzePowerShellCodeRisk } from '@aipoch/notebook-code-risk'
import { describe, expect, it } from 'vitest'
import { parsePowerShellSearchCommands } from './powershell-search-parser'

describe.skipIf(process.platform !== 'win32')('Windows PowerShell command parsing', () => {
  it('locates multiline mutation evidence without executing submitted code', async () => {
    const source =
      'Write-Output "Remove-Item is data"\r\n\r\nRemove-Item target.txt\r\n[System.IO.File]::Delete("target.txt")\r\nWrite-Output hello > target.txt'
    expect(
      await analyzePowerShellCodeRisk(source, (code, signal) =>
        parsePowerShellSearchCommands(code, signal, '5.1', true)
      )
    ).toEqual(
      expect.arrayContaining([
        { operation: 'Remove-Item', source: 'Remove-Item target.txt', line: 3 },
        { operation: '@member:Delete', source: '[System.IO.File]::Delete("target.txt")', line: 4 },
        { operation: '@overwrite', source: '> target.txt', line: 5 }
      ])
    )
  })
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
  ])('parses discovery and mutation syntax without running the command: %s', async (source) => {
    expect(await parsePowerShellSearchCommands(source)).not.toBeNull()
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
    expect(await parsePowerShellSearchCommands(source)).not.toBeNull()
  })
})

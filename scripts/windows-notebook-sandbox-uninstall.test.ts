import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Notebook uninstall host invocation', () => {
  it.each(['profile', 'profile with spaces'])('removes resources under %s', (profile) => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-'))
    roots.push(root)
    const script = resolve('build/windows-notebook-sandbox-uninstall.ps1')
    const host = resolve(
      `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
    )
    const ownershipRoot = join(root, profile, '0f3cd2a44c3d4e4e9f1e2a5b')
    // Load the existing invocation function without running the script's destructive lifecycle.
    // Replace only UAC with an ordinary native launch: argument serialization remains the real
    // Windows PowerShell Start-Process implementation, and the real host validates its arguments.
    // The empty fixture has no owned resources, so the host's remove command is a safe no-op.
    const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('ConvertTo-WindowsArgument', 'Invoke-OwnedHost') }, $true)
Invoke-Expression (($definitions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)
function Test-CurrentUserIsAdministrator { return $false }
function Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru, $WindowStyle)
  if ($Verb -ne 'RunAs') { throw 'Expected the non-administrator uninstall path.' }
  $process = Microsoft.PowerShell.Management\\Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WindowStyle Hidden -Wait -PassThru -RedirectStandardError ${quote(join(root, 'stderr.txt'))}
  [Console]::Error.Write([System.IO.File]::ReadAllText(${quote(join(root, 'stderr.txt'))}))
  return $process
}
$HostPath = ${quote(host)}
$installationId = '0f3cd2a44c3d4e4e9f1e2a5b'
$ownershipRoot = ${quote(ownershipRoot)}
exit (Invoke-OwnedHost 'remove')
`
    const result = spawnSync(
      join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64')
      ],
      { encoding: 'utf8', timeout: 15_000 }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(0)
  })
})

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Notebook uninstall host invocation', () => {
  it.each(['missing', 'empty'])('does not elevate for %s ownership state', (state) => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-empty-'))
    roots.push(root)
    const configRoot = join(root, 'config with spaces')
    const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    if (state === 'empty') mkdirSync(ownershipRoot, { recursive: true })
    const elevationMarker = join(root, 'elevation-requested')
    const result = runUninstallWithoutElevation(configRoot, elevationMarker)
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(existsSync(elevationMarker)).toBe(false)
  })

  it.each(['receipt.json', 'creating.json'])(
    'preserves invalid %s and fails without elevation',
    (name) => {
      const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-invalid-'))
      roots.push(root)
      const configRoot = join(root, 'config')
      const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
      mkdirSync(ownershipRoot, { recursive: true })
      const record = join(ownershipRoot, name)
      writeFileSync(record, '{invalid')
      const elevationMarker = join(root, 'elevation-requested')
      const result = runUninstallWithoutElevation(configRoot, elevationMarker)
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Notebook isolation preparation exited')
      expect(existsSync(record)).toBe(true)
      expect(existsSync(elevationMarker)).toBe(false)
    }
  )

  it('does not treat unknown ownership content as an empty profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-unknown-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    mkdirSync(ownershipRoot, { recursive: true })
    const record = join(ownershipRoot, 'unknown-state.json')
    writeFileSync(record, '{}')
    const elevationMarker = join(root, 'elevation-requested')
    const result = runUninstallWithoutElevation(configRoot, elevationMarker)
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Unexpected elevation request')
    expect(existsSync(record)).toBe(true)
    expect(existsSync(elevationMarker)).toBe(true)
  })

  it.each(['profile', 'profile with spaces'])('removes resources under %s', (profile) => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-'))
    roots.push(root)
    const script = resolve('build/windows-notebook-sandbox-uninstall.ps1')
    const host = resolve(
      `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
    )
    const ownershipRoot = join(root, profile, '0f3cd2a44c3d4e4e9f1e2a5b')
    // Load the existing invocation function without running the script's destructive lifecycle.
    // Select the owned-state branch, replacing UAC with an ordinary native launch using the same
    // serialized command line. No real protected resources are created by this quoting test.
    // Retain the Process handle from launch: Start-Process can lose a short-lived redirected child.
    // The real host still validates the production argument quoting.
    // The empty fixture has no owned resources, so the host's remove command is a safe no-op.
    const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in @('ConvertTo-WindowsArgument', 'Invoke-OwnedHost') }, $true)
Invoke-Expression (($definitions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine)
function Test-CurrentUserIsAdministrator { return $false }
function Test-OwnershipState { return $true }
function Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru, $WindowStyle)
  if ($Verb -ne 'RunAs') { throw 'Expected the non-administrator uninstall path.' }
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $FilePath
  $start.Arguments = $ArgumentList -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($start)
  try {
    [Console]::Error.Write($process.StandardError.ReadToEnd())
    $process.WaitForExit()
    return [PSCustomObject]@{ ExitCode = $process.ExitCode }
  } finally { $process.Dispose() }
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

  it('reports the missing host and ownership locations when cleanup cannot be retried', () => {
    const root = mkdtempSync(join(tmpdir(), 'notebook-uninstall-missing-host-'))
    roots.push(root)
    const script = resolve('build/windows-notebook-sandbox-uninstall.ps1')
    const sandboxRoot = join(root, 'resources', 'notebook-network-sandbox', 'windows')
    const configRoot = join(root, 'config')
    const ownershipRoot = join(configRoot, 'notebook-sandbox', '0f3cd2a44c3d4e4e9f1e2a5b')
    mkdirSync(ownershipRoot, { recursive: true })
    writeFileSync(join(ownershipRoot, 'receipt.json'), '{}')
    const result = spawnSync(
      join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-SandboxRoot',
        sandboxRoot
      ],
      {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, OPEN_SCIENCE_CONFIG_ROOT: configRoot }
      }
    )
    expect(result.error).toBeUndefined()
    expect(result.status, result.stdout).toBe(1)
    const diagnostics = result.stderr.replace(/\r?\n\s*/g, '')
    expect(diagnostics).toContain('host is missing while owned resources still require cleanup')
    expect(diagnostics).toContain(`sandboxRoot=${sandboxRoot}`)
    expect(diagnostics).toContain(`ownershipRoot=${ownershipRoot}`)
    expect(diagnostics).toContain('receipt=True')
  })
})

function runUninstallWithoutElevation(
  configRoot: string,
  elevationMarker: string
): SpawnSyncReturns<string> {
  const script = resolve('build/windows-notebook-sandbox-uninstall.ps1')
  const sandboxRoot = join(dirname(configRoot), 'sandbox')
  const hostDirectory = join(sandboxRoot, process.arch)
  mkdirSync(hostDirectory, { recursive: true })
  copyFileSync(
    resolve(
      `packages/notebook-network-sandbox/vendor/windows/${process.arch}/notebook-appcontainer-host.exe`
    ),
    join(hostDirectory, 'notebook-appcontainer-host.exe')
  )
  // Run the complete product lifecycle with the actual native host. Select the ordinary-user
  // branch even on elevated CI; intercept UAC so no test can change real protected resources.
  const command = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  Set-Content -LiteralPath ${quote(elevationMarker)} -Value $Verb
  throw 'Unexpected elevation request for the isolated uninstall fixture.'
}
try {
  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile(${quote(script)}, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw 'Uninstall script has parse errors' }
  $identity = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-CurrentUserIsAdministrator' }, $true)
  if (-not $identity) { throw 'Missing uninstall identity boundary' }
  $source = Get-Content -LiteralPath ${quote(script)} -Raw
  $source = $source.Substring(0, $identity.Extent.StartOffset) + 'function Test-CurrentUserIsAdministrator { return $false }' + $source.Substring($identity.Extent.EndOffset)
  & ([ScriptBlock]::Create($source)) -SandboxRoot ${quote(sandboxRoot)}
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`
  return spawnSync(
    join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        OPEN_SCIENCE_CONFIG_ROOT: configRoot,
        OPEN_SCIENCE_E2E_STORAGE_ROOT: ''
      }
    }
  )
}

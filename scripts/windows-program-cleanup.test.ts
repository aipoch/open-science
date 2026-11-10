import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const powershell = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/powershell.exe'
)
const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
let root: string
let script: string

beforeAll(() => {
  if (process.platform !== 'win32') return
  root = mkdtempSync(join(tmpdir(), 'program-cleanup-diagnostics-'))
  script = join(root, 'windows-program-cleanup.ps1')
  writeFileSync(script, readFileSync(resolve('build/windows-program-cleanup.ps1')))
  createRequire(import.meta.url)('../build/compile-windows-install-publication.cjs')(
    resolve('build/windows-install-publication.cs'),
    join(root, 'windows-install-publication.dll')
  )
}, 30_000)

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function run(command: string): SpawnSyncReturns<Buffer> {
  return spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(command, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 30_000 }
  )
}

describe.skipIf(process.platform !== 'win32')('Windows program cleanup diagnostics', () => {
  it('continues an upgrade after a controlled lock is released during the first retry wait', () => {
    const stage = join(root, 'transient-stage')
    mkdirSync(stage)
    const path = join(stage, 'busy.dll')
    const report = join(root, 'transient.json')
    writeFileSync(path, 'old program bytes')
    const command = `& ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade; exit $LASTEXITCODE`
    const encoded = Buffer.from(command, 'utf16le').toString('base64')
    const result = run(`
$stream=[IO.File]::Open(${quote(path)},'Open','Read','ReadWrite,Delete')
try {
  $child=Start-Process ${quote(powershell)} -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'
  $timer=[Diagnostics.Stopwatch]::StartNew(); $observed=$false
  while (!$child.HasExited -and $timer.Elapsed.TotalSeconds -lt 20) {
    try { $r=[IO.File]::ReadAllText(${quote(report)}) | ConvertFrom-Json; if ($r.attempts[0].retryDelaySeconds -eq 1) { $observed=$true; break } } catch {}
    Start-Sleep -Milliseconds 20
  }
  if (!$observed) { throw 'First retry was not observed while the lock was held.' }
} finally { $stream.Dispose() }
if (!$child.WaitForExit(20000)) { $child.Kill(); throw 'Cleanup did not finish.' }; exit $child.ExitCode`)
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(0)
    expect(readdirSync(stage)).toEqual([])
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.status).toBe('succeeded')
    expect(diagnostic.attempts).toHaveLength(2)
    expect(diagnostic.attempts[0]).toMatchObject({
      status: 'failed',
      deletionCancellation: 'succeeded',
      attributeRestoration: 'succeeded',
      retryDelaySeconds: 1
    })
    expect(diagnostic.attempts[1].status).toBe('succeeded')
  }, 30_000)

  it('prevents replacement of the staging directory while an upgrade waits to retry', () => {
    const stage = join(root, 'protected-stage')
    const replacement = join(root, 'replacement-stage')
    mkdirSync(stage)
    mkdirSync(replacement)
    const path = join(stage, 'busy.dll')
    const report = join(root, 'protected.json')
    const observed = join(root, 'replacement-result.json')
    writeFileSync(path, 'old program bytes')
    writeFileSync(join(replacement, 'keep.txt'), 'replacement bytes')
    const command = `& ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade; exit $LASTEXITCODE`
    const encoded = Buffer.from(command, 'utf16le').toString('base64')
    const result = run(`
$stream=[IO.File]::Open(${quote(path)},'Open','Read','ReadWrite,Delete')
try {
  $child=Start-Process ${quote(powershell)} -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'
  $timer=[Diagnostics.Stopwatch]::StartNew(); $ready=$false
  while (!$child.HasExited -and $timer.Elapsed.TotalSeconds -lt 20) {
    try { $r=[IO.File]::ReadAllText(${quote(report)}) | ConvertFrom-Json; if ($r.attempts[0].retryDelaySeconds -eq 1) { $ready=$true; break } } catch {}
    Start-Sleep -Milliseconds 20
  }
  if (!$ready) { throw 'Retry wait was not observed.' }
  # The occupied leaf itself also prevents directory rename. Release it before probing the
  # root protection, while the helper is still sleeping, so that cannot mask a missing guard.
  $stream.Dispose(); $stream=$null
  $blocked=$false
  try {
    [IO.Directory]::Move(${quote(stage)},${quote(`${stage}-old`)})
    [IO.Directory]::Move(${quote(replacement)},${quote(stage)})
  } catch { $blocked=$true }
  [IO.File]::WriteAllText(${quote(observed)},(ConvertTo-Json @{ replacementBlocked=$blocked }))
} finally { if ($stream) { $stream.Dispose() } }
if (!$child.WaitForExit(20000)) { $child.Kill(); throw 'Cleanup did not finish.' }; exit $child.ExitCode`)
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(0)
    expect(JSON.parse(readFileSync(observed, 'utf8')).replacementBlocked).toBe(true)
    expect(readFileSync(join(replacement, 'keep.txt'), 'utf8')).toBe('replacement bytes')
    expect(readdirSync(stage)).toEqual([])
  }, 30_000)

  it('keeps the real locked file and reports its native error and successful cancellation', () => {
    const stage = join(root, 'staged 中文')
    mkdirSync(stage)
    const path = join(stage, 'busy.dll')
    const report = join(root, 'locked.json')
    writeFileSync(path, 'old program bytes')
    const result = run(
      `$stream=[IO.File]::Open(${quote(path)},'Open','Read','ReadWrite,Delete'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)}; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
    )
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe('old program bytes')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic).toMatchObject({
      status: 'failed',
      phase: 'remove-staged-program-files',
      deletionCancellation: 'succeeded',
      attributeRestoration: 'succeeded'
    })
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'open-delete-handle',
          path: `\\\\?\\${path}`,
          nativeErrorCode: 32,
          exceptionType: 'System.ComponentModel.Win32Exception'
        })
      ])
    )
    expect(diagnostic.attempts).toHaveLength(1)
    expect(diagnostic.attempts[0].retryDelaySeconds).toBe(0)
  }, 30_000)

  it('bounds a persistent upgrade lock to four attempts with actual 1/2/3 second waits', () => {
    const stage = join(root, 'persistent-stage')
    mkdirSync(stage)
    const path = join(stage, 'busy.dll')
    const report = join(root, 'persistent.json')
    writeFileSync(path, 'unchanged bytes')
    const started = Date.now()
    const result = run(
      `$stream=[IO.File]::Open(${quote(path)},'Open','Read','ReadWrite,Delete'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
    )
    expect(result.error).toBeUndefined()
    expect(result.status, String(result.stderr)).toBe(2)
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(readFileSync(path, 'utf8')).toBe('unchanged bytes')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(
      diagnostic.attempts.map((attempt: { retryDelaySeconds: number }) => attempt.retryDelaySeconds)
    ).toEqual([1, 2, 3, 0])
    const times = diagnostic.attempts.map((attempt: { timestamp: string }) =>
      Date.parse(attempt.timestamp)
    )
    for (let index = 1; index < times.length; index++) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(index * 1000 - 100)
      expect(times[index] - times[index - 1]).toBeLessThan(index * 1000 + 5000)
    }
  }, 30_000)

  it.each(['native-nonsharing-branch', 'hresult-only-branch', 'unknown-recovery'] as const)(
    'does not retry a sharing failure with an unsafe aggregate (%s)',
    (fault) => {
      const fixture = join(root, fault)
      const stage = join(fixture, 'stage')
      mkdirSync(stage, { recursive: true })
      const busy = join(stage, 'busy.dll')
      writeFileSync(busy, 'busy bytes')
      let source = readFileSync(resolve('build/windows-install-publication.cs'), 'utf8')
      if (fault === 'unknown-recovery') {
        source = source.replace(
          'aggregate.Data["deletionCancellation"] = cancellationSucceeded ? "succeeded" : "failed";',
          'aggregate.Data["deletionCancellation"] = "unknown";'
        )
      } else {
        const extra =
          fault === 'native-nonsharing-branch'
            ? 'NativeCleanupError(5, "second-failure", directory)'
            : 'CleanupError(new IOException("No native Win32 evidence", unchecked((int)0x80070020)), "second-failure", directory)'
        source = source.replace(
          'errors.Add(failure);',
          `errors.Add(failure); errors.Add(${extra});`
        )
      }
      const injectedSource = join(fixture, 'injected.cs')
      writeFileSync(injectedSource, source)
      createRequire(import.meta.url)('../build/compile-windows-install-publication.cjs')(
        injectedSource,
        join(fixture, 'windows-install-publication.dll')
      )
      const cleanup = join(fixture, 'windows-program-cleanup.ps1')
      writeFileSync(cleanup, readFileSync(script))
      const report = join(fixture, 'report.json')
      const result = run(
        `$stream=[IO.File]::Open(${quote(busy)},'Open','Read','ReadWrite,Delete'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(cleanup)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
      )
      expect(result.status, String(result.stderr)).toBe(2)
      const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
      expect(diagnostic.attempts).toHaveLength(1)
      expect(diagnostic.attempts[0].retryDelaySeconds).toBe(0)
      expect(diagnostic.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ nativeErrorCode: 32 })])
      )
      if (fault === 'hresult-only-branch') {
        expect(diagnostic.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              operation: 'second-failure',
              hresult: '0x80070020',
              nativeErrorCode: null
            })
          ])
        )
      }
      expect(readFileSync(busy, 'utf8')).toBe('busy bytes')
    },
    30_000
  )

  it('reports an invalid staging directory once without retrying even in upgrade mode', () => {
    const report = join(root, 'invalid-staging.json')
    const result = run(
      `& ${quote(script)} -StagingPath ${quote(join(root, 'not-present'))} -ReportPath ${quote(report)} -Upgrade; exit $LASTEXITCODE`
    )
    expect(result.status, String(result.stderr)).toBe(2)
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.attempts).toHaveLength(1)
    expect(diagnostic.deletionCancellation).toBe('unknown')
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'hold-staging-directory' }),
        expect.objectContaining({ nativeErrorCode: 2 })
      ])
    )
  }, 30_000)

  it('finishes an uncontended upgrade on its immediate attempt', () => {
    const stage = join(root, 'uncontended-stage')
    mkdirSync(stage)
    writeFileSync(join(stage, 'old.dll'), 'old program bytes')
    const report = join(root, 'uncontended.json')
    const result = run(
      `& ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade; exit $LASTEXITCODE`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    expect(readdirSync(stage)).toEqual([])
    expect(String(result.stdout)).not.toContain('retry')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.status).toBe('succeeded')
    expect(diagnostic.attempts).toHaveLength(1)
    expect(diagnostic.attempts[0].retryDelaySeconds).toBe(0)
  }, 30_000)

  it('explains a denied staging-directory hold without retrying or changing old files', () => {
    const stage = join(root, 'unreadable-stage')
    mkdirSync(stage)
    const path = join(stage, 'keep.dll')
    const report = join(root, 'unreadable.json')
    writeFileSync(path, 'preserved bytes')
    const result = run(`
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force
$original=Get-Acl -LiteralPath ${quote(stage)}
$acl=Get-Acl -LiteralPath ${quote(stage)}
$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.AccessControl.FileSystemRights]::ListDirectory,[Security.AccessControl.AccessControlType]::Deny)
$acl.AddAccessRule($rule)
try {
  Set-Acl -LiteralPath ${quote(stage)} -AclObject $acl
  & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade
  $code=$LASTEXITCODE
} finally { Set-Acl -LiteralPath ${quote(stage)} -AclObject $original }
exit $code`)
    expect(result.status, String(result.stderr)).toBe(2)
    expect(readFileSync(path, 'utf8')).toBe('preserved bytes')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.attempts).toHaveLength(1)
    expect(diagnostic.deletionCancellation).toBe('unknown')
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'hold-staging-directory' }),
        expect.objectContaining({ nativeErrorCode: 5 })
      ])
    )
    const finalized = run(
      `& ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action finalize -ReportPath ${quote(report)} -LogDirectory ${quote(join(root, 'unreadable-logs'))} -ExitCode 2`
    )
    expect(finalized.status, String(finalized.stderr)).toBe(0)
    const message = finalized.stdout.toString('utf16le')
    expect(message).toContain('Windows denied access to an application file.')
    expect(message).toContain('unreadable-stage')
    expect(message).toContain('Restoration of old files could not be confirmed.')
    expect(message).toContain('contact support before removing them')
    expect(message).not.toContain('An application file is in use.')
    const restored = run(
      `& ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action record -ReportPath ${quote(report)} -MoveBack succeeded; & ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action finalize -ReportPath ${quote(report)} -LogDirectory ${quote(join(root, 'unreadable-logs'))} -ExitCode 2`
    )
    expect(restored.status, String(restored.stderr)).toBe(0)
    const restoredMessage = restored.stdout.toString('utf16le')
    expect(restoredMessage).toContain('Windows denied access to an application file.')
    expect(restoredMessage).toContain('Check access permissions and security software records.')
    expect(restoredMessage).not.toContain('Restoration of old files could not be confirmed.')
  }, 30_000)

  it('does not retry a real access denial or lose bytes and attributes after cancellation', () => {
    const stage = join(root, 'denied-stage')
    mkdirSync(stage)
    const first = join(stage, 'a-first.dll')
    const denied = join(stage, 'z-denied.dll')
    const report = join(root, 'denied.json')
    writeFileSync(first, 'first bytes')
    writeFileSync(denied, 'denied bytes')
    const result = run(`
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -Force
$original=Get-Acl -LiteralPath ${quote(denied)}
$acl=Get-Acl -LiteralPath ${quote(denied)}
$rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.AccessControl.FileSystemRights]::WriteAttributes,[Security.AccessControl.AccessControlType]::Deny)
$acl.AddAccessRule($rule)
[IO.File]::SetAttributes(${quote(first)},[IO.FileAttributes]::ReadOnly)
[IO.File]::SetAttributes(${quote(denied)},[IO.FileAttributes]::ReadOnly)
try {
  Set-Acl -LiteralPath ${quote(denied)} -AclObject $acl
  & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(script)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade
  $code=$LASTEXITCODE
  if (!([IO.File]::GetAttributes(${quote(first)}) -band [IO.FileAttributes]::ReadOnly)) { throw 'First file lost its readonly attribute.' }
} finally {
  Set-Acl -LiteralPath ${quote(denied)} -AclObject $original
  [IO.File]::SetAttributes(${quote(first)},[IO.FileAttributes]::Normal)
  [IO.File]::SetAttributes(${quote(denied)},[IO.FileAttributes]::Normal)
}
exit $code`)
    expect(result.status, String(result.stderr)).toBe(2)
    expect(readFileSync(first, 'utf8')).toBe('first bytes')
    expect(readFileSync(denied, 'utf8')).toBe('denied bytes')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.attempts).toHaveLength(1)
    expect(diagnostic).toMatchObject({
      deletionCancellation: 'succeeded',
      attributeRestoration: 'succeeded'
    })
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'open-attribute-handle', nativeErrorCode: 5 })
      ])
    )
  }, 30_000)

  it('saves a durable diagnostic after recovery without losing the original failure', () => {
    const reports = join(root, 'reports')
    mkdirSync(reports)
    const report = join(reports, 'cleanup-attempt-2.json')
    writeFileSync(
      report,
      JSON.stringify({
        status: 'failed',
        phase: 'remove-staged-program-files',
        deletionCancellation: 'succeeded',
        attributeRestoration: 'succeeded',
        fileMoveBack: 'unknown',
        errors: [
          {
            operation: 'open-delete-handle',
            path: '\\\\?\\C:\\staging\\busy.dll',
            nativeErrorCode: 32,
            message: 'The process cannot access the file.'
          }
        ]
      })
    )
    const diagnostics = resolve('build/windows-install-diagnostics.ps1')
    const saved = join(root, 'saved-logs')
    const result = run(
      `& ${quote(diagnostics)} -Action record -ReportPath ${quote(report)} -MoveBack succeeded; & ${quote(diagnostics)} -Action finalize -ReportPath ${quote(report)} -ReportsDirectory ${quote(reports)} -LogDirectory ${quote(saved)} -ExitCode 2 -AppVersion 1.2.0 -Language 1033`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    const message = result.stdout.toString('utf16le')
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic.errors[0].nativeErrorCode).toBe(32)
    expect(diagnostic.fileMoveBack).toBe('succeeded')
    expect(message).toContain('An application file is in use.')
    const files = readdirSync(saved)
    expect(files).toHaveLength(1)
    const text = readFileSync(join(saved, files[0]), 'utf8')
    expect(text).toContain('busy.dll')
    expect(text).toContain('fileMoveBack')
    expect(text).toContain('1.2.0')
  }, 30_000)

  it('keeps the original error when persistent logging is unavailable and reports recovery failure first', () => {
    const report = join(root, 'recovery-failed.json')
    writeFileSync(
      report,
      JSON.stringify({
        status: 'failed',
        phase: 'remove-staged-program-files',
        deletionCancellation: 'failed',
        attributeRestoration: 'succeeded',
        fileMoveBack: 'failed',
        errors: [
          { operation: 'open-delete-handle', path: 'C:\\staging\\busy.dll', nativeErrorCode: 32 }
        ]
      })
    )
    const blockedLogDirectory = join(root, 'not-a-directory')
    writeFileSync(blockedLogDirectory, 'preserve')
    const result = run(
      `& ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action finalize -ReportPath ${quote(report)} -LogDirectory ${quote(blockedLogDirectory)} -ExitCode 2`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    const message = result.stdout.toString('utf16le')
    expect(message).toContain('Old files were not fully restored.')
    expect(message).toContain('The diagnostic could not be saved.')
    expect(message).not.toContain('Diagnostic:')
    expect(JSON.parse(readFileSync(report, 'utf8')).errors[0].nativeErrorCode).toBe(32)
  }, 30_000)

  it('retains every original and recovery branch when deletion cancellation and attribute restoration fail', () => {
    const fixture = join(root, 'injected-recovery-failure')
    const stage = join(fixture, 'stage')
    mkdirSync(stage, { recursive: true })
    const first = join(stage, 'a-first.dll')
    const busy = join(stage, 'z-busy.dll')
    writeFileSync(first, 'first bytes')
    writeFileSync(busy, 'busy bytes')
    const source = readFileSync(resolve('build/windows-install-publication.cs'), 'utf8')
      .replace('if (!SetFileInformationByHandle(entry.Handle, 4, ref keep, 1))', 'if (true)')
      .replace(
        'NativeCleanupError(Marshal.GetLastWin32Error(), "cancel-deletion", entry.Path)',
        'NativeCleanupError(5, "cancel-deletion", entry.Path)'
      )
      .replace(
        'try { SetAttributes(entry.AttributeHandle, entry.OriginalAttributes); }',
        'try { throw new Win32Exception(5); }'
      )
    const injectedSource = join(fixture, 'injected.cs')
    writeFileSync(injectedSource, source)
    // Inject only at the existing helper boundary. No production flag can enable these faults.
    createRequire(import.meta.url)('../build/compile-windows-install-publication.cjs')(
      injectedSource,
      join(fixture, 'windows-install-publication.dll')
    )
    const cleanup = join(fixture, 'windows-program-cleanup.ps1')
    writeFileSync(cleanup, readFileSync(script))
    const report = join(fixture, 'report.json')
    const result = run(
      `[IO.File]::SetAttributes(${quote(first)},[IO.FileAttributes]::ReadOnly); $stream=[IO.File]::Open(${quote(busy)},'Open','Read','ReadWrite,Delete'); try { & ${quote(powershell)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(cleanup)} -StagingPath ${quote(stage)} -ReportPath ${quote(report)} -Upgrade; $code=$LASTEXITCODE } finally { $stream.Dispose() }; exit $code`
    )
    expect(result.status, String(result.stderr)).toBe(2)
    const diagnostic = JSON.parse(readFileSync(report, 'utf8'))
    expect(diagnostic).toMatchObject({
      deletionCancellation: 'failed',
      attributeRestoration: 'failed'
    })
    expect(diagnostic.attempts).toHaveLength(1)
    expect(diagnostic.attempts[0].retryDelaySeconds).toBe(0)
    expect(diagnostic.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'open-delete-handle', nativeErrorCode: 32 }),
        expect.objectContaining({
          operation: 'cancel-deletion',
          nativeErrorCode: 5,
          path: `\\\\?\\${first}`
        }),
        expect.objectContaining({
          operation: 'restore-attributes',
          nativeErrorCode: 5,
          path: `\\\\?\\${first}`
        })
      ])
    )
  }, 30_000)

  it('uses the selected installer language and Pro branding for a missing final report', () => {
    const result = run(
      `& ${quote(resolve('build/windows-install-diagnostics.ps1'))} -Action finalize -ReportPath ${quote(join(root, 'missing.json'))} -LogDirectory ${quote(join(root, 'localized-log'))} -Language 2052 -ProductName 'Open-Science Pro' -ExitCode 2`
    )
    expect(result.status, String(result.stderr)).toBe(0)
    const message = result.stdout.toString('utf16le')
    expect(message).toContain('Open-Science Pro 未能完成更新。')
    expect(message).toContain('无法确认旧应用文件是否已恢复。')
    expect(message).toContain('错误来源：uninstaller；结果：2。')
    expect(message).not.toContain('文件正在被占用')
  }, 30_000)
})

const compiler = process.env.NSIS_TEST_COMPILER ?? process.env.OPEN_SCIENCE_MAKENSIS
describe.skipIf(process.platform !== 'win32' || !compiler)(
  'native parent/child cleanup diagnostics',
  () => {
    it.each([
      'failed',
      'recovered',
      'missing-child-report',
      'visible-failed',
      'upgrade-failed',
      'upgrade-transient'
    ] as const)(
      'keeps attempts fresh and delivers the final result with durable evidence (%s)',
      (outcome) => {
        const recovered = outcome === 'recovered' || outcome === 'upgrade-transient'
        const upgrade = outcome.startsWith('upgrade-')
        const fixture = join(root, outcome)
        const install = join(fixture, 'app 中文')
        mkdirSync(join(install, 'resources'), { recursive: true })
        const app = join(install, 'open-science.exe')
        writeFileSync(app, 'application bytes')
        writeFileSync(join(install, 'resources/library.dll'), 'library bytes')
        const helper = join(fixture, 'out/windows-installer/ia32/windows-install-publication.dll')
        mkdirSync(dirname(helper), { recursive: true })
        writeFileSync(helper, readFileSync(join(root, 'windows-install-publication.dll')))
        const compile = (name: string, body: string): string => {
          const executable = join(fixture, `${name}.exe`)
          const source = `${executable}.nsi`
          writeFileSync(
            source,
            `\uFEFFUnicode true
Name "Isolated diagnostics"
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
OutFile "${executable}"
InstallDir "${install}"
!include LogicLib.nsh
!include FileFunc.nsh
!define BUILD_RESOURCES_DIR "${resolve('build')}"
!define PROJECT_DIR "${fixture}"
!define VERSION "1.2.0-fixture"
LoadLanguageFile "\${NSISDIR}/Contrib/Language files/English.nlf"
${body}`
          )
          const result = spawnSync(compiler!, ['/V2', source], {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 30_000
          })
          expect(result.status, result.stdout + result.stderr).toBe(0)
          return executable
        }
        const child = join(fixture, 'child.exe')
        const generator = compile(
          'generate',
          `
!define BUILD_UNINSTALLER
!define isUpdated '"$9" == "1"'
!define APP_EXECUTABLE_FILENAME "open-science.exe"
!define UNINSTALL_FILENAME "Uninstall open-science.exe"
!include "${resolve('build/windows-program-cleanup.nsh')}"
Section
WriteUninstaller "${child}"
SectionEnd
Section "un.fixture"
\${GetParameters} $R0
ClearErrors
\${GetOptions} $R0 "--updated" $R1
\${if} \${Errors}
StrCpy $9 "0"
\${else}
StrCpy $9 "1"
\${endif}
!insertmacro customRemoveFiles
SectionEnd`
        )
        expect(spawnSync(generator, ['/S'], { windowsHide: true, timeout: 30_000 }).status).toBe(0)
        const finalReport = join(fixture, 'final.json')
        const logDirectory = join(fixture, 'logs')
        const resultFile = join(fixture, 'result.txt')
        const parent = compile(
          'parent',
          `
!include "${resolve('build/windows-install-diagnostics.nsh')}"
${outcome === 'visible-failed' ? 'SilentInstall normal' : ''}
Function .onInit
InitPluginsDir
StrCpy $installDiagnosticDirectory "${logDirectory}"
StrCpy $cleanupUninstallArguments "${upgrade ? '--updated' : ''}"
${outcome === 'upgrade-transient' ? '' : `System::Call 'kernel32::CreateFile(t "${app}", i 0x80000000, i 7, p 0, i 3, i 0, p 0) p.R6'`}
!insertmacro beginCleanupAttempt
${outcome === 'upgrade-transient' ? `FileOpen $8 "${join(fixture, 'active-report.txt')}" w\nFileWrite $8 "$cleanupReport"\nFileClose $8` : ''}
ExecWait '"${child}" /S $0 _?=$INSTDIR' $R0
CopyFiles /SILENT "$cleanupReport" "${join(fixture, 'first.json')}"
${outcome === 'recovered' ? "System::Call 'kernel32::CloseHandle(p R6)'" : ''}
${outcome === 'upgrade-transient' ? '' : '!insertmacro beginCleanupAttempt'}
${outcome === 'upgrade-transient' ? '' : outcome === 'missing-child-report' ? `ClearErrors\nExecWait '"${join(fixture, 'missing-child.exe')}" /S $0 _?=$INSTDIR' $R0\n\${if} \${Errors}\nStrCpy $R0 "launch-failed"\n\${endif}` : `ExecWait '"${child}" /S $0 _?=$INSTDIR' $R0`}
CopyFiles /SILENT "$cleanupReport" "${finalReport}"
FileOpen $8 "${resultFile}" w
FileWrite $8 "$R0"
FileClose $8
${!recovered ? "System::Call 'kernel32::CloseHandle(p R6)'" : ''}
\${if} $R0 != 0
Call showCleanupFailure
CopyFiles /SILENT "$installDiagnosticMessagePath" "${join(fixture, 'notice.txt')}"
SetErrorLevel 2
Quit
\${endif}
SetErrorLevel 0
Quit
FunctionEnd
Section
SectionEnd`
        )
        let result: ReturnType<typeof spawnSync>
        if (outcome === 'upgrade-transient') {
          result = run(`
$stream=[IO.File]::Open(${quote(app)},'Open','Read','ReadWrite,Delete')
try {
  $child=Start-Process ${quote(parent)} -WindowStyle Hidden -PassThru -ArgumentList '/S'
  $timer=[Diagnostics.Stopwatch]::StartNew(); $observed=$false
  while (!$child.HasExited -and $timer.Elapsed.TotalSeconds -lt 20) {
    try {
      $path=[IO.File]::ReadAllText(${quote(join(fixture, 'active-report.txt'))})
      $report=[IO.File]::ReadAllText($path) | ConvertFrom-Json
      if ($report.attempts[0].retryDelaySeconds -eq 1) { $observed=$true; break }
    } catch {}
    Start-Sleep -Milliseconds 20
  }
  if (!$observed) { throw 'Native child retry was not observed.' }
} finally { $stream.Dispose() }
if (!$child.WaitForExit(20000)) { $child.Kill(); throw 'Native parent did not exit.' }; exit $child.ExitCode`)
        } else if (outcome === 'visible-failed') {
          const observed = join(fixture, 'dialogs.json')
          result = run(`Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FixtureDialogs {
  public static HashSet<string> Observed = new HashSet<string>();
  static HashSet<IntPtr> Dismissed = new HashSet<IntPtr>();
  delegate bool Callback(IntPtr window, IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr value);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window, Callback callback, IntPtr value);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr word, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr window, int id);
  public static string[] Dismiss(uint process) {
    var found = new List<string>();
    EnumWindows(delegate(IntPtr window, IntPtr value) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner != process) return true;
      string text = "";
      EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
        var buffer = new StringBuilder(2048); GetWindowText(child, buffer, buffer.Capacity);
        text += buffer.ToString() + "\\n"; return true;
      }, IntPtr.Zero);
      Observed.Add(text);
      if (text.Contains("could not finish updating.")) {
        // Windows can assign IDCANCEL to a message box's single localized OK button.
        var id = GetDlgItem(window, 1) != IntPtr.Zero ? 1 : 2;
        if (GetDlgItem(window, id) != IntPtr.Zero) {
          if (Dismissed.Add(window)) found.Add(text);
          // Enumeration can observe a dialog during creation. Retry delivery until it closes.
          PostMessage(window, 0x111, new IntPtr(id), IntPtr.Zero);
        }
      }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$start=[Diagnostics.ProcessStartInfo]::new(${quote(parent)}); $start.UseShellExecute=$false; $start.WindowStyle='Hidden'; $process=[Diagnostics.Process]::Start($start); $dialogs=@(); $timer=[Diagnostics.Stopwatch]::StartNew(); while (!$process.HasExited -and $timer.Elapsed.TotalSeconds -lt 25) { $dialogs += [FixtureDialogs]::Dismiss($process.Id); Start-Sleep -Milliseconds 25 }; [IO.File]::WriteAllText(${quote(observed)},(ConvertTo-Json -InputObject @($dialogs))); if (!$process.HasExited) { $process.Kill(); throw ('Fixture did not exit: ' + ([FixtureDialogs]::Observed -join '|')) }; exit $process.ExitCode`)
          expect(result.error).toBeUndefined()
          expect(result.status, String(result.stderr)).toBe(2)
          const dialogs = JSON.parse(readFileSync(observed, 'utf8'))
          expect(dialogs).toHaveLength(1)
          expect(dialogs[0]).toContain('An application file is in use.')
          expect(dialogs[0]).toContain('open-science.exe')
          expect(dialogs[0]).toContain('Diagnostic:')
          expect(dialogs[0]).toContain(join(logDirectory, readdirSync(logDirectory)[0]))
        } else {
          result = spawnSync(parent, ['/S'], { windowsHide: true, timeout: 30_000 })
        }
        expect(result.error).toBeUndefined()
        expect(result.status, String(result.stderr)).toBe(recovered ? 0 : 2)
        const first = JSON.parse(readFileSync(join(fixture, 'first.json'), 'utf8'))
        expect(first).toMatchObject(
          outcome === 'upgrade-transient'
            ? { status: 'succeeded' }
            : { status: 'failed', fileMoveBack: 'succeeded' }
        )
        expect(first.attempts).toHaveLength(
          outcome === 'upgrade-failed' ? 4 : outcome === 'upgrade-transient' ? 2 : 1
        )
        expect(outcome === 'upgrade-transient' ? first.attempts[0].errors : first.errors).toEqual(
          expect.arrayContaining([expect.objectContaining({ nativeErrorCode: 32 })])
        )
        if (outcome === 'missing-child-report') {
          expect(readFileSync(resultFile, 'utf8')).toBe('launch-failed')
          const notice = readFileSync(join(fixture, 'notice.txt'), 'utf16le')
          expect(notice).toContain('Error source: uninstaller; result: launch-failed.')
          expect(notice).toContain('Restoration of old files could not be confirmed.')
          expect(notice).not.toContain('An application file is in use.')
        } else {
          expect(JSON.parse(readFileSync(finalReport, 'utf8')).status).toBe(
            recovered ? 'succeeded' : 'failed'
          )
        }
        if (recovered) {
          expect(readdirSync(fixture)).not.toContain('logs')
        } else {
          const logs = readdirSync(logDirectory)
          expect(logs).toHaveLength(1)
          const diagnostic = readFileSync(join(logDirectory, logs[0]), 'utf8')
          expect(diagnostic).toContain('1.2.0-fixture')
          expect(diagnostic).toContain('cleanup-attempt-1.json')
          expect(diagnostic).toContain('open-science.exe')
          expect(readFileSync(app, 'utf8')).toBe('application bytes')
          expect(readFileSync(join(install, 'resources/library.dll'), 'utf8')).toBe('library bytes')
          if (outcome === 'missing-child-report')
            expect(diagnostic).toContain('Final child report missing')
        }
      },
      90_000
    )
  }
)

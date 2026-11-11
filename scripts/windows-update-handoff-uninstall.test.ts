import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('Windows update presentation uninstall', () => {
  it.each(
    [
      'unknown',
      'no-storage',
      'partial',
      'active',
      'inherited-read',
      'inherited-write',
      'untrusted-active-helper',
      'untrusted-other-installation',
      'untrusted-hidden-helper',
      'hidden-owner',
      'locked-helper',
      'inventory-failure',
      'foreign',
      'other-installation',
      'reused-parent',
      'reused-helper',
      'reused-successor',
      'reused-uninstaller-parent'
    ].flatMap((scenario) =>
      ['Open-Science/UpdateHandoffs', 'Open-Science-UpdateHandoffs'].map((storage) => [
        scenario,
        storage
      ])
    )
  )(
    'handles %s operations in %s without terminating processes or deleting unknown content',
    (scenario, storage) => {
      const createdRoot = mkdtempSync(join(tmpdir(), 'update-uninstall-'))
      roots.push(createdRoot)
      let root = createdRoot
      if (scenario === 'other-installation') {
        // Windows runners may supply TEMP through an 8.3 alias. Enumeration can expand it.
        const shortPath = spawnSync(
          join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${createdRoot.replaceAll("'", "''")}').ShortPath`
          ],
          { encoding: 'utf8', timeout: 10_000 }
        )
        expect(shortPath.status, shortPath.stderr).toBe(0)
        root = shortPath.stdout.trim()
        expect(root).not.toBe('')
      }
      const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
      const acl = spawnSync(
        'icacls.exe',
        [
          root,
          '/inheritance:r',
          '/grant:r',
          `${identity}:(OI)(CI)F`,
          '*S-1-5-18:(OI)(CI)F',
          '*S-1-5-32-544:(OI)(CI)F',
          ...(scenario === 'inherited-read'
            ? ['*S-1-5-32-545:(OI)(CI)R']
            : scenario === 'inherited-write' || scenario.startsWith('untrusted-')
              ? ['*S-1-5-32-545:(OI)(CI)W']
              : [])
        ],
        { encoding: 'utf8', timeout: 10_000 }
      )
      expect(acl.error, acl.stderr || acl.stdout).toBeUndefined()
      expect(acl.status, acl.stderr || acl.stdout).toBe(0)
      const operations = join(root, storage)
      const operationId = randomUUID()
      const directory = join(operations, operationId)
      const install = join(root, 'installation')
      mkdirSync(directory, { recursive: true })
      mkdirSync(install)
      writeFileSync(
        join(directory, 'request.json'),
        JSON.stringify({
          schema: 1,
          operationId,
          parentPid:
            scenario === 'active' || scenario === 'hidden-owner'
              ? 2001
              : scenario === 'reused-parent'
                ? process.pid
                : scenario === 'reused-uninstaller-parent'
                  ? 2001
                  : 2147483647,
          ...(scenario === 'reused-helper' ? { helperPid: process.pid } : {}),
          ...(scenario === 'reused-successor' ? { successorPid: process.pid } : {}),
          applicationPath: join(
            scenario.endsWith('other-installation') ? root : install,
            'application.exe'
          ),
          installerPath: scenario === 'active' ? process.execPath : join(root, 'installer.exe')
        })
      )
      if (scenario !== 'partial') writeFileSync(join(directory, 'helper.exe'), 'owned fixture')
      writeFileSync(join(directory, 'closed.receipt.tmp'), 'owned partial receipt')
      if (scenario.startsWith('reused-')) {
        // A completed historical PID now belongs to this unrelated Node test process.
        for (const stage of ['installed', 'ready', 'closed'])
          writeFileSync(join(directory, `${stage}.receipt`), `${operationId}\r\n${stage}\r\n`)
      }
      if (scenario === 'foreign') writeFileSync(join(directory, 'unrelated-file'), 'preserve')
      if (scenario === 'no-storage') rmSync(operations, { recursive: true })
      const script = readFileSync(resolve('build/windows-update-handoff-uninstall.ps1'), 'utf8')
      // Redirect only the fixed managed root; exercise the production ownership/process/removal code.
      const redirected = script.replace(
        "[Environment]::GetFolderPath('ApplicationData')",
        `'${root.replaceAll("'", "''")}'`
      )
      expect(redirected).not.toBe(script)
      const target = join(root, 'uninstall.ps1')
      // The cleanup script excludes its own ancestor chain. Model an active owner with a
      // non-ancestor WMI record so this fixture continues to exercise the active guard.
      const processInventory =
        scenario === 'untrusted-hidden-helper' || scenario === 'hidden-owner'
          ? `@(
  [pscustomobject]@{ ProcessId = 2001; ParentProcessId = 0; ExecutablePath = $null; Name = 'helper.exe' }
)`
          : scenario === 'untrusted-active-helper' || scenario.endsWith('other-installation')
            ? `@(
  [pscustomobject]@{ ProcessId = 2001; ParentProcessId = 0; ExecutablePath = '${join(directory, 'helper.exe').replaceAll("'", "''")}' }
)`
            : scenario === 'active'
              ? `@(
  [pscustomobject]@{ ProcessId = 2001; ParentProcessId = 0; ExecutablePath = '${process.execPath.replaceAll("'", "''")}' }
)`
              : scenario === 'reused-uninstaller-parent'
                ? `@(
  [pscustomobject]@{ ProcessId = $PID; ParentProcessId = 2001; ExecutablePath = $null }
  [pscustomobject]@{ ProcessId = 2001; ParentProcessId = 0; ExecutablePath = $null }
)`
                : undefined
      writeFileSync(
        target,
        scenario === 'no-storage' || scenario === 'inventory-failure'
          ? redirected.replace(
              "$ErrorActionPreference = 'Stop'",
              "$ErrorActionPreference = 'Stop'\nfunction Get-CimInstance { throw 'No storage should not require WMI' }"
            )
          : processInventory
            ? redirected.replace(
                '$processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)',
                `$processes = ${processInventory}`
              )
            : redirected
      )
      copyFileSync(
        resolve('build/windows-runtime-cache-uninstall.ps1'),
        join(root, 'windows-runtime-cache-uninstall.ps1')
      )
      const run = (stage: string, scriptPath = target): ReturnType<typeof spawnSync> => {
        const started = Date.now()
        const result = spawnSync(
          join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-InstallPath',
            install
          ],
          { encoding: 'utf8', timeout: 30_000 }
        )
        expect(
          result.error,
          `${stage} after ${Date.now() - started} ms\n${result.stderr || result.stdout}`
        ).toBeUndefined()
        return result
      }
      // Keep a real handle denying deletion; the production removal must preserve request.json.
      const lockPath = join(directory, 'helper.exe')
      const lockedTarget = join(root, 'locked-uninstall.ps1')
      if (scenario === 'locked-helper') {
        writeFileSync(
          lockedTarget,
          `$lock = [IO.File]::Open('${lockPath.replaceAll("'", "''")}', 'Open', 'Read', 'Read')\ntry { & '${target.replaceAll("'", "''")}' -InstallPath '${install.replaceAll("'", "''")}' } finally { $lock.Dispose() }`
        )
      }
      const result = run('initial uninstall', scenario === 'locked-helper' ? lockedTarget : target)
      if (
        scenario === 'active' ||
        scenario === 'untrusted-active-helper' ||
        scenario === 'untrusted-other-installation'
      ) {
        expect(result.status).toBe(2)
        expect(result.stdout).toContain('still active')
      } else if (scenario === 'inventory-failure') {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('No storage should not require WMI')
      } else if (scenario === 'hidden-owner') {
        expect(result.status).toBe(1)
        expect(result.stdout).toContain('Could not inspect a recorded owner')
      } else expect(result.status, result.stderr || result.stdout).toBe(0)
      const removed =
        scenario === 'no-storage' ||
        scenario === 'unknown' ||
        scenario === 'partial' ||
        scenario === 'inherited-read' ||
        scenario.startsWith('reused-')
      expect(existsSync(directory)).toBe(!removed)
      if (removed) {
        const retry = run('idempotent uninstall')
        expect(retry.status, retry.stderr || retry.stdout).toBe(0)
      }
      if (scenario === 'foreign')
        expect(readFileSync(join(directory, 'unrelated-file'), 'utf8')).toBe('preserve')
      if (
        scenario === 'inherited-write' ||
        scenario === 'untrusted-hidden-helper' ||
        scenario === 'locked-helper'
      ) {
        expect(result.stdout).toContain('Retained update records')
        expect(result.stdout).toContain(operations)
        expect(readFileSync(join(directory, 'helper.exe'), 'utf8')).toBe('owned fixture')
        expect(existsSync(join(directory, 'request.json'))).toBe(true)
      }
      expect(process.kill(process.pid, 0)).toBe(true)
    },
    // Cover ACL setup (10 s), both bounded PowerShell calls (30 s each), and fixture assertions.
    // The default 15 s test limit can expire even when every child completes within its budget.
    75_000
  )
})

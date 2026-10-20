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
      'foreign',
      'other-installation',
      'reused-parent',
      'reused-helper',
      'reused-successor'
    ].flatMap((scenario) =>
      ['Open-Science/UpdateHandoffs', 'Open-Science-UpdateHandoffs'].map((storage) => [
        scenario,
        storage
      ])
    )
  )(
    'handles %s operations in %s without terminating processes or deleting unknown content',
    (scenario, storage) => {
      const root = mkdtempSync(join(tmpdir(), 'update-uninstall-'))
      roots.push(root)
      const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\')
      const acl = spawnSync(
        'icacls.exe',
        [
          root,
          '/inheritance:r',
          '/grant:r',
          `${identity}:(OI)(CI)F`,
          '*S-1-5-18:(OI)(CI)F',
          '*S-1-5-32-544:(OI)(CI)F'
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
            scenario === 'active' || scenario === 'reused-parent' ? process.pid : 2147483647,
          ...(scenario === 'reused-helper' ? { helperPid: process.pid } : {}),
          ...(scenario === 'reused-successor' ? { successorPid: process.pid } : {}),
          applicationPath: join(
            scenario === 'other-installation' ? root : install,
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
      writeFileSync(
        target,
        scenario === 'no-storage'
          ? redirected.replace(
              "$ErrorActionPreference = 'Stop'",
              "$ErrorActionPreference = 'Stop'\nfunction Get-CimInstance { throw 'No storage should not require WMI' }"
            )
          : redirected
      )
      copyFileSync(
        resolve('build/windows-runtime-cache-uninstall.ps1'),
        join(root, 'windows-runtime-cache-uninstall.ps1')
      )
      const run = (stage: string): ReturnType<typeof spawnSync> => {
        const started = Date.now()
        const result = spawnSync(
          join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            target,
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
      const result = run('initial uninstall')
      if (scenario === 'active') {
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('still active')
      } else expect(result.status, result.stderr || result.stdout).toBe(0)
      const removed =
        scenario === 'no-storage' ||
        scenario === 'unknown' ||
        scenario === 'partial' ||
        scenario.startsWith('reused-')
      expect(existsSync(directory)).toBe(!removed)
      if (removed) {
        const retry = run('idempotent uninstall')
        expect(retry.status, retry.stderr || retry.stdout).toBe(0)
      }
      if (scenario === 'foreign')
        expect(readFileSync(join(directory, 'unrelated-file'), 'utf8')).toBe('preserve')
      expect(process.kill(process.pid, 0)).toBe(true)
    },
    // Cover ACL setup (10 s), both bounded PowerShell calls (30 s each), and fixture assertions.
    // The default 15 s test limit can expire even when every child completes within its budget.
    75_000
  )
})

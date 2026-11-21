import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { processBirthIdentity } from '../src/main/process-birth-identity'

import { runUninstallHelper, uninstallHelperExecutable } from './fixtures/windows-uninstall-helper'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'win32')(
  'uninstalls only prepared packages owned by this executable',
  () => {
    const temp = mkdtempSync(join(tmpdir(), 'prepared-uninstall-'))
    roots.push(temp)
    // Test TEMP can be writable by other accounts; reproduce the private LocalAppData cache.
    const acl = spawnSync('icacls.exe', [
      temp,
      '/inheritance:r',
      '/grant:r',
      `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F'
    ])
    expect(acl.status).toBe(0)
    const cache = join(temp, 'sdk')
    const prepared = join(cache, 'open-science-prepared')
    const outside = join(temp, 'unrelated')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'unrelated')
    const executable = join(realpathSync.native(temp), 'app.exe')
    writeFileSync(executable, '')
    const seed = (owner: string, marker: string): string => {
      const sha512 = createHash('sha512').update(marker).digest('base64')
      const id = createHash('sha256')
        .update(owner.toLowerCase() + '\0' + sha512)
        .digest('hex')
        .slice(0, 32)
      const stage = join(prepared, id)
      mkdirSync(join(stage, 'payload'), { recursive: true })
      writeFileSync(
        join(stage, marker),
        JSON.stringify({ executable: owner, version: '2.0.0', sha512, fileName: 'setup.exe' })
      )
      return stage
    }
    const ready = seed(executable, 'ready.json')
    const claimed = seed(executable, 'installing.json')
    const timedOut = seed(executable, 'scan-timed-out.json')
    const other = seed(join(outside, 'app.exe'), 'ready.json')
    const deep = join(ready, 'payload', 'a'.repeat(100), 'b'.repeat(100))
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, 'file'), '')
    symlinkSync(outside, join(ready, 'payload', 'junction'), 'junction')
    writeFileSync(join(cache, 'installer.exe'), 'SDK delta basis')

    const result = runUninstallHelper([
      'prepared-updates',
      '--cache',
      cache,
      '--executable',
      executable
    ])
    expect(result.status, result.stderr).toBe(0)
    expect([ready, claimed, timedOut].filter(existsSync), result.stderr).toEqual([])
    expect(existsSync(join(other, 'ready.json'))).toBe(true)
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('unrelated')
    expect(readFileSync(join(cache, 'installer.exe'), 'utf8')).toBe('SDK delta basis')
  }
)

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
      'hidden-owner-birth',
      'reused-hidden-birth',
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
                  : scenario.endsWith('-birth')
                    ? process.pid
                    : 2147483647,
          // Cross-producer identity: the token written by Electron main must match the helper's.
          ...(scenario === 'hidden-owner-birth'
            ? { parentBirthToken: processBirthIdentity(process.pid) }
            : scenario === 'reused-hidden-birth'
              ? { parentBirthToken: 'windows-creation-time:1' }
              : {}),
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
      if (scenario === 'hidden-owner-birth')
        expect(processBirthIdentity(process.pid)).toMatch(/^windows-creation-time:\d+$/)

      // The helper reads its injected inventory from a file. "self" is the helper's own process, so
      // the ancestor exclusion covers the same chain the script modeled with $PID.
      const inventory = processInventory(scenario, directory)
      const inventoryPath = inventory ? join(createdRoot, 'processes.json') : undefined
      if (inventory && inventoryPath) writeFileSync(inventoryPath, JSON.stringify(inventory))
      const env = {
        ...process.env,
        OPEN_SCIENCE_HELPER_TEST_APPDATA: root,
        ...(scenario === 'inventory-failure'
          ? { OPEN_SCIENCE_HELPER_TEST_PROCESSES: 'throw' }
          : inventoryPath
            ? { OPEN_SCIENCE_HELPER_TEST_PROCESSES: inventoryPath }
            : {})
      }
      const run = (stage: string): ReturnType<typeof runUninstallHelper> => {
        const started = Date.now()
        const result = runUninstallHelper(['update-handoff', '--install-path', install], env)
        expect(
          result.error,
          `${stage} after ${Date.now() - started} ms\n${result.stderr || result.stdout}`
        ).toBeUndefined()
        return result
      }
      // Keep a real handle denying deletion; the production removal must preserve request.json.
      const lockPath = join(directory, 'helper.exe')
      const result =
        scenario === 'locked-helper'
          ? runLocked(lockPath, ['update-handoff', '--install-path', install], env)
          : run('initial uninstall')
      if (
        scenario === 'active' ||
        scenario === 'untrusted-active-helper' ||
        scenario === 'untrusted-other-installation'
      ) {
        expect(result.status).toBe(2)
        expect(result.stdout).toContain('still active')
      } else if (scenario === 'inventory-failure') {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Injected process inventory failure')
      } else if (scenario === 'hidden-owner' || scenario === 'hidden-owner-birth') {
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
    // Cover ACL setup (10 s), both bounded helper calls, and fixture assertions.
    75_000
  )
})

// Scenarios that need a fabricated process inventory. Absent means the helper enumerates for real.
function processInventory(scenario: string, directory: string): object[] | undefined {
  const record = (
    processId: number | string,
    executablePath: string | null,
    parent = 0
  ): Record<string, unknown> => ({
    ProcessId: processId,
    ParentProcessId: parent,
    ExecutablePath: executablePath
  })
  if (scenario === 'untrusted-hidden-helper' || scenario === 'hidden-owner')
    return [record(2001, null)]
  if (scenario === 'untrusted-active-helper' || scenario.endsWith('other-installation'))
    return [record(2001, join(directory, 'helper.exe'))]
  if (scenario === 'active') return [record(2001, process.execPath)]
  if (scenario.endsWith('-birth')) return [record(process.pid, null)]
  if (scenario === 'reused-uninstaller-parent')
    return [record('self', null, 2001), record(2001, null)]
  return undefined
}

// Hold a read handle that denies deletion for the whole helper run, then release it.
function runLocked(
  lockPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ReturnType<typeof runUninstallHelper> {
  const powershell = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`
  const command = `
$lock = [IO.File]::Open(${quote(lockPath)}, 'Open', 'Read', 'Read')
try {
  & ${quote(uninstallHelperExecutable())} ${args.map(quote).join(' ')}
  exit $LASTEXITCODE
} finally { $lock.Dispose() }`
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
    { encoding: 'utf8', timeout: 30_000, env }
  )
}

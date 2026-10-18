import { PassThrough } from 'node:stream'
import { spawn, ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from '@aipoch/diagnostics/node'
import { startWindowsInstallProgress } from './windows-install-progress'
import { windowsUpdateHandoffRoot, windowsUpdateReceipt } from './windows-update-handoff'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn()
}))
let root: string
let invalidAck = false
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'update-helper-'))
  await mkdir(join(root, 'installation'))
  await writeFile(join(root, 'source.exe'), 'complete helper')
  invalidAck = false
  vi.mocked(spawn).mockImplementation((_file, _args, options) => {
    const child = Object.assign(new ChildProcess(), {
      pid: 271828,
      exitCode: null,
      signalCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn()
    })
    queueMicrotask(() =>
      child.stdout.write(
        JSON.stringify({
          token: invalidAck ? 'wrong-operation' : basename(String(options?.cwd)),
          pid: child.pid,
          visible: true
        }) + '\n'
      )
    )
    return child
  })
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})
const options = (): Parameters<typeof startWindowsInstallProgress>[0] => ({
  installerPath: join(root, 'installer.exe'),
  applicationPath: join(root, 'installation', 'application.exe'),
  helperPath: join(root, 'source.exe'),
  appData: root,
  profilePath: join(root, 'profile'),
  targetVersion: '1.0.2',
  startupOptions: {
    configRoot: root,
    dataRoot: root,
    profilePath: join(root, 'profile'),
    port: 44100,
    host: '127.0.0.1',
    credentialStore: 'os'
  },
  logDirectory: join(root, 'logs'),
  translate: (text) => text,
  log: { info: vi.fn(), warn: vi.fn() } as unknown as Logger
})

describe('Windows update progress owner', () => {
  it('publishes a complete private helper and pre-handoff cancellation marker', async () => {
    const progress = await startWindowsInstallProgress(options())
    const directory = join(windowsUpdateHandoffRoot(root), progress.operationId)
    expect(await readFile(join(directory, 'helper.exe'), 'utf8')).toBe('complete helper')
    progress.cancel()
    expect(await readFile(join(directory, 'cancel'), 'utf8')).toBe(progress.operationId)
    expect(await readFile(join(directory, 'aborted.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(progress.operationId, 'aborted')
    )
    expect((await readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
  it('reports uncertainty after handoff without cancelling the installation or dismissing the window', async () => {
    const progress = await startWindowsInstallProgress(options())
    const directory = join(windowsUpdateHandoffRoot(root), progress.operationId)
    progress.handoff()
    progress.cancel()
    expect(await readFile(join(directory, 'handoff.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(progress.operationId, 'handoff')
    )
    expect(await readFile(join(directory, 'unconfirmed.receipt'), 'utf8')).toBe(
      windowsUpdateReceipt(progress.operationId, 'unconfirmed')
    )
    expect(await readdir(directory)).not.toContain('cancel')
    expect(await readdir(directory)).not.toContain('aborted.receipt')
  })
  it('rejects a readiness acknowledgement for another attempt and dismisses only its own helper', async () => {
    invalidAck = true
    await expect(startWindowsInstallProgress(options())).rejects.toThrow(
      'Invalid update progress readiness'
    )
    const [operation] = await readdir(windowsUpdateHandoffRoot(root))
    expect(await readFile(join(windowsUpdateHandoffRoot(root), operation, 'cancel'), 'utf8')).toBe(
      operation
    )
  })
  it('removes a failed private copy so a later attempt can start cleanly', async () => {
    await expect(
      startWindowsInstallProgress({ ...options(), helperPath: join(root, 'missing.exe') })
    ).rejects.toThrow()
    expect(await readdir(windowsUpdateHandoffRoot(root))).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
    const progress = await startWindowsInstallProgress(options())
    expect(await readdir(windowsUpdateHandoffRoot(root))).toEqual([progress.operationId])
  })
})

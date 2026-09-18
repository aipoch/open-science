import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NotebookRuntimeService } from '../notebook/runtime-service'
import { ShellProcessOwnershipRegistry } from '../notebook/shell-process-ownership.windows-posix'
import { BackendShutdownCoordinator } from '../lifecycle-shutdown'
import { withReproducibilityNotebookLifecycle } from '../artifacts/reproducibility-notebook-lifecycle'
import { clearApplicationShutdownTrigger } from '../application-shutdown-trigger'
import { ElectronUpdaterStrategy } from './electron-updater-strategy'
import { createDurableInstallGate } from './strategy'

vi.mock('electron-updater', () => ({
  autoUpdater: {},
  AppImageUpdater: class {},
  DebUpdater: class {},
  CancellationToken: class {
    cancel(): void {
      /* No download cancellation in this fixture. */
    }
  }
}))

it.each(['confirmed', 'changed', 'runtime-blocked', 'new-record', 'claimed', 'corrupt'] as const)(
  'recovers the reported old launch records through the update gate: %s',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-shell-update-'))
    const registry = new ShellProcessOwnershipRegistry(root)
    const runIds = ['notebook-run-1789176064440-3', 'second-reported-launch']
    for (const runId of runIds)
      registry.beginLaunch({
        runId,
        projectId: 'fixture',
        sessionId: 'fixture',
        platform: 'win32'
      })
    const receipts = runIds.map((id) => join(root, 'shell-process-ownership', `${id}.json`))
    const originals = await Promise.all(receipts.map((path) => readFile(path)))
    const notebook = new NotebookRuntimeService({
      configRoot: root,
      dataRoot: root,
      projectId: 'fixture'
    })
    const durability = vi.fn(async () => true)
    let runtimeReaped = true
    const coordinator = new BackendShutdownCoordinator({
      runtime: {
        shutdownForQuit: async () => ({ reaped: true }),
        shutdownForUpdateGate: async () => ({ reaped: runtimeReaped })
      },
      notebook: withReproducibilityNotebookLifecycle(notebook, () => undefined),
      sideChat: { shutdown: async () => {}, suspendAll: async () => {} }
    })
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn()
    })
    const strategy = new ElectronUpdaterStrategy({
      updater,
      platform: 'win32',
      arch: 'x64',
      currentVersion: '0.28.0',
      broadcast: vi.fn(),
      installGate: createDurableInstallGate(
        (options) => coordinator.runForUpdateGate(undefined, options),
        durability
      ),
      fetchImpl: vi.fn(async () => {
        throw new Error('offline fixture')
      })
    })
    try {
      updater.downloadUpdate.mockImplementation(async () => {
        updater.emit('update-downloaded', { version: '0.29.0' })
      })
      updater.emit('update-available', { version: '0.29.0' })
      await strategy.download()
      const refused = await strategy.apply()
      expect(refused).toMatchObject({
        state: 'ready',
        error: 'Could not fully stop background processes before updating. Please try again.'
      })
      expect(updater.quitAndInstall).not.toHaveBeenCalled()
      expect(durability).not.toHaveBeenCalled()
      expect(await Promise.all(receipts.map((path) => readFile(path)))).toEqual(originals)
      const token = refused.legacyShellRecovery?.token ?? 'missing-recovery-offer'
      if (mode === 'changed') await writeFile(receipts[0], `${originals[0].toString()}\n`)
      if (mode === 'runtime-blocked') runtimeReaped = false
      if (mode === 'new-record')
        registry.beginLaunch({
          runId: 'unexpected-new-launch',
          projectId: 'fixture',
          sessionId: 'fixture',
          platform: 'win32'
        })
      if (mode === 'claimed')
        await writeFile(
          receipts[0],
          JSON.stringify({
            ...JSON.parse(originals[0].toString()),
            pid: process.pid,
            processStartIdentity: 'unknown'
          })
        )
      if (mode === 'corrupt') await writeFile(receipts[0], '{')
      const beforeConfirmation = await Promise.all(receipts.map((path) => readFile(path)))
      await strategy.apply({ legacyShellRecoveryToken: token })
      if (mode !== 'confirmed') {
        expect(updater.quitAndInstall).not.toHaveBeenCalled()
        expect(durability).not.toHaveBeenCalled()
        expect(await Promise.all(receipts.map((path) => readFile(path)))).toEqual(
          beforeConfirmation
        )
      } else {
        expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
        expect(durability).toHaveBeenCalledOnce()
        expect(await readdir(join(root, 'shell-process-ownership'))).toEqual([])
        const backupRoot = join(root, 'shell-process-ownership-backups')
        const backups = await readdir(backupRoot)
        expect(backups).toHaveLength(1)
        expect(
          await Promise.all(
            runIds.map((id) => readFile(join(backupRoot, backups[0], `${id}.json`)))
          )
        ).toEqual(originals)
      }
    } finally {
      await notebook.dispose()
      clearApplicationShutdownTrigger()
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
)

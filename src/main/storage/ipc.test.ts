import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

import type { Logger } from '../logger'
import { DEFAULT_UPLOAD_PROJECT_ID } from '../../shared/uploads'
import { STAGING_UPLOAD_SESSION_ID, UPLOADS_DIR } from '../uploads/storage-helpers'

// Capture ipcMain.handle registrations; stub dialog/BrowserWindow/app so handlers can be invoked
// directly without a real Electron runtime. isPackaged: true means dataFolderName() === 'OpenScience'.
const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
const showOpenDialog = vi.fn()
const sentWindows: {
  webContents: { send: ReturnType<typeof vi.fn> }
  isDestroyed: () => boolean
}[] = []
const appRelaunch = vi.fn()
const appExit = vi.fn()
const appQuit = vi.fn()
const openPath = vi.fn<(path: string) => Promise<string>>().mockResolvedValue('')
// Home is mutable so a few tests can point it at a real temp dir (legacy-in-place detection reads
// the config root under home); it defaults to /home/user so every other test is unaffected.
const electronHome = { path: '/home/user' }

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { getAllWindows: () => sentWindows },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
  shell: { openPath: (path: string) => openPath(path) },
  app: {
    getPath: () => electronHome.path,
    isPackaged: true,
    relaunch: appRelaunch,
    exit: appExit,
    quit: appQuit
  }
}))

vi.mock('./remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))

const { initDataRoot } = await import('../storage-root')
const { createStorageCommandOwner } = await import('./command-owner')
const { registerStorageIpcHandlers } = await import('./ipc')
const {
  clearMigrationPending,
  installMigrationQuitGuard,
  isMigrationInProgress,
  isMigrationPending,
  waitForDataRootWriters,
  withDataRootWrite
} = await import('./migration-state')
const { clearApplicationShutdownTrigger, currentApplicationShutdownTrigger } =
  await import('../application-shutdown-trigger')
const { readMigrationMarker, writeMigrationMarker } = await import('./migration-marker')
const { DataRootCleanupJournal } = await import('./data-root-cleanup')

// Writes the verified staging marker a completed copy phase would leave, so commit/discard gates pass.
const seedVerifiedMarker = async (targetDir: string, source: string): Promise<void> => {
  await mkdir(targetDir, { recursive: true })
  await writeMigrationMarker(targetDir, {
    version: 1,
    token: 'tok-ipc',
    source,
    target: targetDir,
    createdAt: Date.now(),
    status: 'verified',
    inventory: {
      dirs: [],
      fileCount: 0,
      totalBytes: 0,
      digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    }
  })
}

const invoke = (channel: string, payload?: unknown): Promise<unknown> =>
  Promise.resolve(handlers.get(channel)!({ sender: { id: 1 } }, payload))

// Real fs calls inside validateNewDataRoot/classifyDataRoot need an actual event-loop turn, not
// just a microtask flush, before the mocked runtime.disconnect() (the next await) is reached.
const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type MigrationQuitGuardApp = Parameters<typeof installMigrationQuitGuard>[0]
const makeMigrationQuitGuardApp = (): MigrationQuitGuardApp & {
  fireBeforeQuit: () => { prevented: boolean }
} => {
  let listener: ((event: { preventDefault: () => void }) => void) | undefined
  const quit = vi.fn()
  return {
    on: ((event: string, fn: (event: { preventDefault: () => void }) => void) => {
      if (event === 'before-quit') listener = fn
    }) as MigrationQuitGuardApp['on'],
    quit,
    fireBeforeQuit: () => {
      let prevented = false
      listener?.({ preventDefault: () => (prevented = true) })
      return { prevented }
    }
  }
}

type FakeDeps = Parameters<typeof registerStorageIpcHandlers>[0]

const fakeDeps = (overrides: Partial<FakeDeps> = {}): FakeDeps => ({
  runtime: {
    disconnect: vi.fn().mockResolvedValue(undefined),
    shutdownForQuit: vi.fn().mockResolvedValue({ reaped: true })
  },
  notebook: {
    shutdownAll: vi.fn().mockResolvedValue({ reaped: true }),
    dispose: vi.fn().mockResolvedValue({ reaped: true }),
    getActiveNotebookSessions: vi.fn().mockReturnValue([])
  },
  getActivePromptSessions: vi.fn().mockReturnValue([]),
  getActiveSideChatSessions: vi.fn().mockReturnValue([]),
  getActiveDelegatedSessions: vi.fn().mockReturnValue([]),
  hasActiveReviewerWork: vi.fn().mockReturnValue(false),
  settingsService: {
    setDataRoot: vi.fn().mockResolvedValue(undefined),
    dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
    getStoredSettings: vi.fn().mockResolvedValue({})
  },
  cleanupRuntimeCache: vi.fn(() => true),
  prepareDataRootHandoff: vi.fn().mockResolvedValue(true),
  validateNewDataRoot: vi.fn().mockResolvedValue({ ok: true }),
  cleanupJournal: new DataRootCleanupJournal(join(currentParent, 'config')),
  relaunch: vi.fn(),
  ...overrides
})

const fakeDiagnosticLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
})

const diagnosticRecords = (logger: Logger): Record<string, unknown>[] =>
  [logger.debug, logger.info, logger.warn, logger.error].flatMap((method) =>
    (method as Mock).mock.calls.map((call) => call[1] as Record<string, unknown>)
  )

// Data folder name mirrors dataFolderName() for a packaged build (see the electron mock above).
const dataRootFor = (parent: string): string => join(parent, 'OpenScience')

let currentParent: string
let dataRoot: string
let targetParent: string
let target: string

beforeEach(async () => {
  handlers.clear()
  showOpenDialog.mockReset()
  appRelaunch.mockClear()
  appExit.mockClear()
  appQuit.mockClear()
  openPath.mockClear()
  sentWindows.length = 0
  currentParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-current-'))
  dataRoot = dataRootFor(currentParent)
  await mkdir(dataRoot)
  targetParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-target-'))
  target = dataRootFor(targetParent)
})

afterEach(async () => {
  initDataRoot(undefined)
  // migration-state is a module singleton; reset it so a pending write-gate can't leak between tests.
  clearMigrationPending()
  clearApplicationShutdownTrigger()
  await rm(currentParent, { recursive: true, force: true })
  await rm(targetParent, { recursive: true, force: true })
})

describe('storage IPC handlers', () => {
  it('shares migration state between legacy IPC and direct owner calls', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    const owner = createStorageCommandOwner(deps)
    registerStorageIpcHandlers(deps, owner)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    await expect(owner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })

    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      previousDataRoot: dataRoot
    })
    expect(deps.runtime.disconnect).toHaveBeenCalledOnce()
    expect(deps.notebook.shutdownAll).toHaveBeenCalledOnce()
    expect(deps.prepareDataRootHandoff).toHaveBeenCalledWith({ surface: 'electron-renderer' }, true)
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('does not mutate the old runtime after cleanup is durably deferred', async () => {
    class DeferredCleanupJournal extends DataRootCleanupJournal {
      override async markCommitted(expectedToken: string): Promise<boolean> {
        await super.markCommitted(expectedToken)
        return true
      }
    }

    initDataRoot(dataRoot)
    const cleanupRuntimeCache = vi.fn(() => true)
    const cleanupJournal = new DeferredCleanupJournal(join(currentParent, 'config'))
    const deps = fakeDeps({ cleanupRuntimeCache, cleanupJournal })
    const owner = createStorageCommandOwner(deps)

    await expect(owner.migrate({ parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    cleanupRuntimeCache.mockClear()
    await expect(owner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: true
    })

    expect(cleanupRuntimeCache).not.toHaveBeenCalled()
    await expect(cleanupJournal.hasPending()).resolves.toBe(true)
  })

  it('refuses a recovered commit when the source changed after verification', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    await mkdir(join(dataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(dataRoot, 'artifacts', 'new-after-restart.txt'), 'new')
    const deps = fakeDeps()
    const restartedOwner = createStorageCommandOwner(deps)

    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'The staged copy changed after verification. Run the move again.'
    })

    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it.each(['copying', 'verified'] as const)(
    'discards a %s marker after the command owner is recreated',
    async (status) => {
      initDataRoot(dataRoot)
      await seedVerifiedMarker(target, dataRoot)
      const marker = await readMigrationMarker(target)
      await writeMigrationMarker(target, { ...marker!, status })
      const restartedOwner = createStorageCommandOwner(fakeDeps())

      await expect(restartedOwner.discardMigratedCopy({ parent: targetParent })).resolves.toEqual({
        ok: true
      })

      expect(existsSync(target)).toBe(false)
    }
  )

  it('recovers a verified staged copy after the command owner is recreated', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const deps = fakeDeps()

    // Recreating the owner models a fresh main process after the copy verified but before the user
    // chose Restart now. The verified marker is durable, so the staged copy should remain resolvable.
    const restartedOwner = createStorageCommandOwner(deps)
    await expect(readMigrationMarker(target)).resolves.toMatchObject({
      status: 'verified',
      source: dataRoot,
      target
    })
    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })

    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      previousDataRoot: dataRoot
    })
    expect(deps.runtime.disconnect).toHaveBeenCalledOnce()
    expect(deps.notebook.shutdownAll).toHaveBeenCalledOnce()
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('does not lock staged-copy resolution after a malformed recovered commit request', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:commit-and-relaunch', { parent: null })).resolves.toMatchObject({
      ok: false
    })
    await expect(invoke('storage:discard-migrated-copy', { parent: null })).resolves.toMatchObject({
      ok: false
    })
    await expect(
      invoke('storage:discard-migrated-copy', { parent: targetParent })
    ).resolves.toEqual({ ok: true })
    expect(existsSync(target)).toBe(false)
  })

  it('keeps a recovered marker and clears the write gate when writers cannot be paused', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const pauseDataRootWriters = vi.fn().mockRejectedValue(new Error('busy'))
    const notifyDataRootHandoffAborted = vi.fn()
    const deps = { ...fakeDeps({ pauseDataRootWriters }), notifyDataRootHandoffAborted }
    const restartedOwner = createStorageCommandOwner(deps)

    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'Could not pause running work to finish moving your data safely. Please try again.'
    })

    expect(await readMigrationMarker(target)).toMatchObject({ status: 'verified' })
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
    expect(notifyDataRootHandoffAborted).toHaveBeenCalledOnce()
  })

  it('blocks recovered commit while delegated work is still running', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const pauseDataRootWriters = vi.fn()
    const deps = fakeDeps({
      getActiveDelegatedSessions: vi
        .fn()
        .mockReturnValue([{ projectId: 'project-1', sessionId: 'session-1' }]),
      pauseDataRootWriters
    })
    const restartedOwner = createStorageCommandOwner(deps)

    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error:
        'Subagents are still running. Return to their tasks and stop them before finishing the move.'
    })

    expect(pauseDataRootWriters).not.toHaveBeenCalled()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
  })

  it('registers every storage channel', () => {
    registerStorageIpcHandlers(fakeDeps())

    for (const channel of [
      'storage:get-status',
      'storage:get-info',
      'storage:reveal-app-storage',
      'storage:detect-active',
      'storage:pick-directory',
      'storage:migrate',
      'storage:cancel-migrate',
      'storage:validate-data-root',
      'storage:inspect-data-root',
      'storage:set-data-root-and-relaunch',
      'storage:dismiss-legacy-move-prompt'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
  })

  it('get-status returns data-root state without usage fields', async () => {
    initDataRoot(undefined)
    registerStorageIpcHandlers(fakeDeps())

    const status = await invoke('storage:get-status')

    expect(status).toEqual({
      dataRoot: join('/home/user', 'OpenScience'),
      isDefault: true,
      defaultDataRoot: join('/home/user', 'OpenScience'),
      defaultParent: '/home/user',
      dataRootMissing: false,
      legacyDataMovePrompt: false,
      cleanupPending: false
    })
    expect(status).not.toHaveProperty('usage')
    expect(status).not.toHaveProperty('availableBytes')
  })

  it('reveals the main-resolved config root without accepting a renderer path', async () => {
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:reveal-app-storage', '/untrusted/path')).resolves.toEqual({
      revealed: true
    })
    expect(openPath).toHaveBeenCalledWith(join('/home/user', '.open-science'))
  })

  it('converts a rejected reveal into a renderer-safe failure result', async () => {
    openPath.mockRejectedValueOnce(new Error('shell unavailable'))
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:reveal-app-storage')).resolves.toEqual({
      revealed: false,
      error: 'shell unavailable'
    })
  })

  it('get-info reports isDefault true when the data root falls back to the computed default', async () => {
    initDataRoot(undefined)
    registerStorageIpcHandlers(fakeDeps())

    const info = (await invoke('storage:get-info')) as {
      dataRoot: string
      isDefault: boolean
      defaultDataRoot: string
      defaultParent: string
      canAutoSelectDataDrive: boolean
    }

    expect(info.isDefault).toBe(true)
    // The default root is `<home>/OpenScience` (home mocked to /home/user), reproducible from home.
    // Derive with join so the assertion holds on Windows (backslashes), not just POSIX.
    expect(info.defaultDataRoot).toBe(join('/home/user', 'OpenScience'))
    expect(info.defaultParent).toBe('/home/user')
    expect(info.canAutoSelectDataDrive).toBe(true)
  })

  it('get-info permits auto-selection when startup created only the empty upload scaffold', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-upload-scaffold-home-'))
    electronHome.path = home
    try {
      await mkdir(
        join(
          home,
          'OpenScience',
          UPLOADS_DIR,
          DEFAULT_UPLOAD_PROJECT_ID,
          STAGING_UPLOAD_SESSION_ID
        ),
        { recursive: true }
      )
      initDataRoot(undefined)
      registerStorageIpcHandlers(fakeDeps())

      const info = (await invoke('storage:get-info')) as { canAutoSelectDataDrive: boolean }

      expect(info.canAutoSelectDataDrive).toBe(true)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('get-info suppresses auto-selection when the upload scaffold contains a staged file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-staged-upload-home-'))
    electronHome.path = home
    try {
      const staging = join(
        home,
        'OpenScience',
        UPLOADS_DIR,
        DEFAULT_UPLOAD_PROJECT_ID,
        STAGING_UPLOAD_SESSION_ID
      )
      await mkdir(staging, { recursive: true })
      await writeFile(join(staging, 'transfer.part'), 'pending upload')
      initDataRoot(undefined)
      registerStorageIpcHandlers(fakeDeps())

      const info = (await invoke('storage:get-info')) as { canAutoSelectDataDrive: boolean }

      expect(info.canAutoSelectDataDrive).toBe(false)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('get-info fails closed when default-root emptiness cannot be proven', async () => {
    initDataRoot(undefined)
    const logger = fakeDiagnosticLogger()
    const deps = fakeDeps({
      logger,
      hasAnyExistingPath: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('denied'), { code: 'EIO' }))
    })
    registerStorageIpcHandlers(deps)

    const info = (await invoke('storage:get-info')) as { canAutoSelectDataDrive: boolean }

    expect(info.canAutoSelectDataDrive).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'data root status detection failed',
      expect.objectContaining({ errorCategory: 'system' })
    )
  })

  it('get-info suppresses auto-selection when an interrupted onboarding already built a runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-runtime-home-'))
    electronHome.path = home
    try {
      await mkdir(join(home, 'OpenScience', 'runtime'), { recursive: true })
      initDataRoot(undefined)
      registerStorageIpcHandlers(fakeDeps())

      const info = (await invoke('storage:get-info')) as { canAutoSelectDataDrive: boolean }

      expect(info.canAutoSelectDataDrive).toBe(false)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('get-info flags legacyDataMovePrompt for an unconfigured install with data in the config root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-legacy-home-'))
    electronHome.path = home
    try {
      // Legacy layout: user data sits directly in the hidden config root, no OpenScience folder yet.
      await mkdir(join(home, '.open-science', 'artifacts'), { recursive: true })
      initDataRoot(undefined) // unconfigured -> resolves to the legacy config root
      registerStorageIpcHandlers(fakeDeps()) // getStoredSettings -> {} (unset, never dismissed)

      const info = (await invoke('storage:get-info')) as {
        legacyDataMovePrompt: boolean
        dataRoot: string
        canAutoSelectDataDrive: boolean
      }

      expect(info.dataRoot).toBe(join(home, '.open-science'))
      expect(info.legacyDataMovePrompt).toBe(true)
      expect(info.canAutoSelectDataDrive).toBe(false)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('get-info flags legacyDataMovePrompt when a legacy config root contains only workspaces', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-legacy-workspace-home-'))
    electronHome.path = home
    try {
      await mkdir(join(home, '.open-science', 'workspaces', 'session-1'), { recursive: true })
      initDataRoot(undefined)
      registerStorageIpcHandlers(fakeDeps())

      const info = (await invoke('storage:get-info')) as {
        legacyDataMovePrompt: boolean
        dataRoot: string
        canAutoSelectDataDrive: boolean
      }

      expect(info.dataRoot).toBe(join(home, '.open-science'))
      expect(info.legacyDataMovePrompt).toBe(true)
      expect(info.canAutoSelectDataDrive).toBe(false)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('keeps legacy Notebook evidence visible to data-root onboarding', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-legacy-evidence-home-'))
    electronHome.path = home
    try {
      await mkdir(join(home, '.open-science', 'notebook-file-evidence', 'project-1'), {
        recursive: true
      })
      initDataRoot(undefined)
      registerStorageIpcHandlers(fakeDeps())

      const info = (await invoke('storage:get-info')) as {
        legacyDataMovePrompt: boolean
        dataRoot: string
        canAutoSelectDataDrive: boolean
      }

      expect(info.dataRoot).toBe(join(home, '.open-science'))
      expect(info.legacyDataMovePrompt).toBe(true)
      expect(info.canAutoSelectDataDrive).toBe(false)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('get-info clears legacyDataMovePrompt once the prompt has been dismissed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ds-legacy-home-'))
    electronHome.path = home
    try {
      await mkdir(join(home, '.open-science', 'artifacts'), { recursive: true })
      initDataRoot(undefined)
      const deps = fakeDeps()
      vi.mocked(deps.settingsService.getStoredSettings).mockResolvedValue({
        legacyDataMovePromptDismissedAt: 123
      })
      registerStorageIpcHandlers(deps)

      const info = (await invoke('storage:get-info')) as {
        legacyDataMovePrompt: boolean
        canAutoSelectDataDrive: boolean
      }

      expect(info.legacyDataMovePrompt).toBe(false)
      expect(info.canAutoSelectDataDrive).toBe(false)
    } finally {
      electronHome.path = '/home/user'
      initDataRoot(undefined)
      await rm(home, { recursive: true, force: true })
    }
  })

  it('dismiss-legacy-move-prompt persists via settingsService.dismissLegacyDataMovePrompt', async () => {
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await invoke('storage:dismiss-legacy-move-prompt')

    expect(deps.settingsService.dismissLegacyDataMovePrompt).toHaveBeenCalledTimes(1)
  })

  it('reports a legacy-move prompt dismissal persistence failure to the renderer', async () => {
    const deps = fakeDeps()
    vi.mocked(deps.settingsService.dismissLegacyDataMovePrompt).mockRejectedValue(
      new Error('settings write failed')
    )
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:dismiss-legacy-move-prompt')).rejects.toThrow(
      'settings write failed'
    )
  })

  it('get-info reports isDefault false and real usage/availableBytes for a relocated data root', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    const info = (await invoke('storage:get-info')) as {
      dataRoot: string
      isDefault: boolean
      defaultDataRoot: string
      defaultParent: string
      usage: { totalBytes: number }
      availableBytes: number
    }

    expect(info.dataRoot).toBe(dataRoot)
    expect(info.isDefault).toBe(false)
    // Even from a custom root, the default and its parent are reported so Settings can offer a
    // one-click return to `<home>/OpenScience` and show the destination.
    expect(info.defaultDataRoot).toBe(join('/home/user', 'OpenScience'))
    expect(info.defaultParent).toBe('/home/user')
    expect(info.usage.totalBytes).toBe(0)
    expect(info.availableBytes).toBeGreaterThan(0)
  })

  it('get-info reports dataRootMissing false for a fresh install (unset dataRoot, default dir absent)', async () => {
    initDataRoot(undefined)
    registerStorageIpcHandlers(fakeDeps())

    const info = (await invoke('storage:get-info')) as { dataRootMissing: boolean }

    expect(info.dataRootMissing).toBe(false)
  })

  it('get-info reports dataRootMissing false when the configured dataRoot directory exists', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockResolvedValue(undefined),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({ dataRoot })
      }
    })
    registerStorageIpcHandlers(deps)

    const info = (await invoke('storage:get-info')) as { dataRootMissing: boolean }

    expect(info.dataRootMissing).toBe(false)
  })

  it('get-info reports dataRootMissing true when the configured dataRoot directory is gone', async () => {
    initDataRoot(target)
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockResolvedValue(undefined),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({ dataRoot: target })
      }
    })
    registerStorageIpcHandlers(deps)

    const info = (await invoke('storage:get-info')) as { dataRootMissing: boolean }

    expect(info.dataRootMissing).toBe(true)
  })

  it('detect-active maps agent, Side Chat, delegated, and notebook sources', async () => {
    const deps = fakeDeps({
      getActivePromptSessions: vi.fn().mockReturnValue([{ projectId: 'p', sessionId: 'agent-1' }]),
      getActiveSideChatSessions: vi
        .fn()
        .mockReturnValue([{ projectId: 'p', sessionId: 'side-chat-parent' }]),
      getActiveDelegatedSessions: vi
        .fn()
        .mockReturnValue([{ projectId: 'p', sessionId: 'delegated-1' }]),
      notebook: {
        shutdownAll: vi.fn().mockResolvedValue({ reaped: true }),
        dispose: vi.fn().mockResolvedValue({ reaped: true }),
        getActiveNotebookSessions: vi.fn().mockReturnValue([{ projectId: 'p', sessionId: 'nb-1' }])
      }
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:detect-active')).resolves.toEqual([
      { projectId: 'p', sessionId: 'delegated-1', kind: 'delegated' },
      { projectId: 'p', sessionId: 'agent-1', kind: 'agent' },
      { projectId: 'p', sessionId: 'side-chat-parent', kind: 'agent' },
      { projectId: 'p', sessionId: 'nb-1', kind: 'notebook' }
    ])
  })

  it('detect-active calls the notebook service as a method, preserving its `this` binding', async () => {
    // Regression: the real notebook runtime service is a class whose getActiveNotebookSessions reads
    // `this.sessions`. The handler must invoke it as a method — extracting it as a bare function
    // reference drops `this` and throws "Cannot read properties of undefined (reading 'values')".
    class FakeNotebookService {
      private sessions = new Map([['nb-1', { projectId: 'p', sessionId: 'nb-1' }]])
      shutdownAll = vi.fn().mockResolvedValue({ reaped: true })
      dispose = vi.fn().mockResolvedValue({ reaped: true })
      getActiveNotebookSessions(): { projectId: string; sessionId: string }[] {
        return Array.from(this.sessions.values())
      }
    }
    const deps = fakeDeps({
      getActivePromptSessions: vi.fn().mockReturnValue([]),
      notebook: new FakeNotebookService()
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:detect-active')).resolves.toEqual([
      { projectId: 'p', sessionId: 'nb-1', kind: 'notebook' }
    ])
  })

  it('pick-directory returns the injected value without touching the native dialog', async () => {
    const deps = fakeDeps({ showOpenDialog: vi.fn().mockResolvedValue('/picked/path') })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:pick-directory')).resolves.toBe('/picked/path')
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('pick-directory falls back to the native dialog and returns null on cancel', async () => {
    showOpenDialog.mockResolvedValue({ filePaths: [] })
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:pick-directory')).resolves.toBeNull()
    expect(showOpenDialog).toHaveBeenCalledWith({
      properties: ['openDirectory', 'createDirectory']
    })
  })

  it('pick-directory returns null instead of rejecting when the native dialog throws', async () => {
    showOpenDialog.mockRejectedValue(new Error('dialog unavailable'))
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:pick-directory')).resolves.toBeNull()
  })

  it('pick-directory returns null when the injected showOpenDialog throws', async () => {
    const logger = fakeDiagnosticLogger()
    const deps = fakeDeps({
      showOpenDialog: vi.fn().mockRejectedValue(new Error('picker-secret')),
      logger
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:pick-directory')).resolves.toBeNull()
    expect(showOpenDialog).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('directory picker failed', {
      errorCategory: 'error'
    })
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain('picker-secret')
  })

  it('keeps the picker fallback authoritative when the diagnostic sink throws', async () => {
    const sinkFailure = (): never => {
      throw new Error('sink unavailable')
    }
    registerStorageIpcHandlers(
      fakeDeps({
        showOpenDialog: vi.fn().mockRejectedValue(new Error('picker failed')),
        logger: {
          debug: sinkFailure,
          info: sinkFailure,
          warn: sinkFailure,
          error: sinkFailure
        }
      })
    )

    await expect(invoke('storage:pick-directory')).resolves.toBeNull()
  })

  it('migrate copies into the target without committing (no setDataRoot, no relaunch)', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    expect(deps.runtime.disconnect).toHaveBeenCalledTimes(1)
    // Phase 1 is copy-only: the pointer is not flipped and the app does not restart until the user
    // clicks "Restart now" (storage:commit-and-relaunch).
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('marks migration handoff preparation as user-confirmed', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({
      prepareDataRootHandoff,
      runDataRootMigration,
      validateNewDataRoot: vi.fn().mockResolvedValue({ ok: true })
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })

    expect(prepareDataRootHandoff).toHaveBeenCalledWith({ surface: 'electron-renderer' }, true)
  })

  it('rejects a stale migration request while delegated work is running without interrupting it', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      getActiveDelegatedSessions: vi
        .fn()
        .mockReturnValue([{ projectId: 'p', sessionId: 'delegated-1' }])
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'Subagents are still running. Return to their tasks and stop them before moving data.'
    })
    expect(deps.runtime.disconnect).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('rechecks delegated work after migration handoff preparation', async () => {
    initDataRoot(dataRoot)
    const getActiveDelegatedSessions = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValue([{ projectId: 'project-1', sessionId: 'delegated-race' }])
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({ getActiveDelegatedSessions, runDataRootMigration })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'Subagents are still running. Return to their tasks and stop them before moving data.'
    })

    expect(runDataRootMigration).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('does not start a migration copy when handoff durability cannot be confirmed', async () => {
    initDataRoot(dataRoot)
    const runDataRootMigration = vi.fn()
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(false)
    const deps = fakeDeps({ runDataRootMigration, prepareDataRootHandoff })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'Could not prepare the app to switch data locations safely. Please try again.'
    })

    expect(prepareDataRootHandoff).toHaveBeenCalledOnce()
    expect(runDataRootMigration).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('does not enter handoff teardown while reviewer work is active', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({
      hasActiveReviewerWork: vi.fn().mockReturnValue(true),
      prepareDataRootHandoff,
      runDataRootMigration
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A review is still running. Stop it before moving data.'
    })

    expect(prepareDataRootHandoff).not.toHaveBeenCalled()
    expect(runDataRootMigration).not.toHaveBeenCalled()
  })

  it('rechecks reviewer work after migration target validation', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({
      hasActiveReviewerWork: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      prepareDataRootHandoff,
      runDataRootMigration
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A review is still running. Stop it before moving data.'
    })

    expect(prepareDataRootHandoff).not.toHaveBeenCalled()
    expect(runDataRootMigration).not.toHaveBeenCalled()
  })

  it('rechecks reviewer work after migration handoff preparation', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({
      hasActiveReviewerWork: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      prepareDataRootHandoff,
      runDataRootMigration
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A review is still running. Stop it before moving data.'
    })

    expect(prepareDataRootHandoff).toHaveBeenCalledOnce()
    expect(runDataRootMigration).not.toHaveBeenCalled()
  })

  it('rejects an invalid migration target before preparing the handoff', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const deps = fakeDeps({ prepareDataRootHandoff, validateNewDataRoot: undefined })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:migrate', { parent: join(currentParent, 'missing-parent') })
    ).resolves.toMatchObject({ ok: false })

    expect(prepareDataRootHandoff).not.toHaveBeenCalled()
    expect(deps.runtime.disconnect).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('reserves command and lifecycle migration guards while handoff preparation is pending', async () => {
    initDataRoot(dataRoot)
    let resolveFirstPreparation: ((ready: boolean) => void) | undefined
    const prepareDataRootHandoff = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveFirstPreparation = resolve
          })
      )
      .mockResolvedValue(false)
    const runDataRootMigration = vi.fn()
    const deps = fakeDeps({ prepareDataRootHandoff, runDataRootMigration })
    registerStorageIpcHandlers(deps)

    const first = invoke('storage:migrate', { parent: targetParent })
    await vi.waitFor(() => expect(prepareDataRootHandoff).toHaveBeenCalledOnce())
    expect(isMigrationInProgress()).toBe(true)
    expect(isMigrationPending()).toBe(false)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A migration is already in progress.'
    })

    resolveFirstPreparation?.(false)
    await first
    expect(prepareDataRootHandoff).toHaveBeenCalledOnce()
    expect(runDataRootMigration).not.toHaveBeenCalled()
    expect(isMigrationInProgress()).toBe(false)
  })

  it('honors cancellation while migration target validation is pending', async () => {
    initDataRoot(dataRoot)
    let finishValidation: ((result: { ok: true }) => void) | undefined
    const validateNewDataRoot = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishValidation = resolve
        })
    )
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({
      validateNewDataRoot,
      prepareDataRootHandoff,
      runDataRootMigration
    })
    registerStorageIpcHandlers(deps)

    const migration = invoke('storage:migrate', { parent: targetParent })
    await vi.waitFor(() => expect(validateNewDataRoot).toHaveBeenCalledOnce())
    await invoke('storage:cancel-migrate')
    finishValidation?.({ ok: true })

    await expect(migration).resolves.toEqual({
      ok: false,
      error: 'migration cancelled',
      cancelled: true
    })
    expect(prepareDataRootHandoff).not.toHaveBeenCalled()
    expect(runDataRootMigration).not.toHaveBeenCalled()
  })

  it('honors cancellation while migration handoff preparation is pending', async () => {
    initDataRoot(dataRoot)
    let finishPreparation: ((ready: boolean) => void) | undefined
    const prepareDataRootHandoff = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPreparation = resolve
        })
    )
    const runDataRootMigration = vi.fn().mockResolvedValue({ ok: true })
    const deps = fakeDeps({ prepareDataRootHandoff, runDataRootMigration })
    registerStorageIpcHandlers(deps)

    const migration = invoke('storage:migrate', { parent: targetParent })
    await vi.waitFor(() => expect(prepareDataRootHandoff).toHaveBeenCalledOnce())
    await invoke('storage:cancel-migrate')
    finishPreparation?.(true)

    await expect(migration).resolves.toEqual({
      ok: false,
      error: 'migration cancelled',
      cancelled: true
    })
    expect(runDataRootMigration).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('uses the shared prepared runner when exporting runtime locks for migration', async () => {
    initDataRoot(dataRoot)
    const runner = {
      initialPath: '/resources/micromamba.exe',
      resolve: vi.fn().mockResolvedValue('/local-tools/micromamba-compat.exe')
    }
    const exportLocks = vi.fn().mockResolvedValue([])
    const deps = fakeDeps({ micromambaRunner: runner, exportRuntimeLocks: exportLocks })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })

    expect(runner.resolve).toHaveBeenCalledOnce()
    expect(exportLocks).toHaveBeenCalledWith(dataRoot, target, {
      mm: '/local-tools/micromamba-compat.exe',
      capture: expect.any(Function)
    })
  })

  it('correlates production copy and commit diagnostics without logging the marker token', async () => {
    initDataRoot(dataRoot)
    const logger = fakeDiagnosticLogger()
    const deps = fakeDeps({ logger })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    const markerToken = (await readMigrationMarker(target))?.token
    expect(markerToken).toBeTruthy()

    await expect(invoke('storage:commit-and-relaunch', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })

    const completed = diagnosticRecords(logger).filter((record) => record.outcome === 'completed')
    expect(completed.map((record) => record.operation)).toEqual([
      'data-root-copy',
      'data-root-commit'
    ])
    expect(new Set(completed.map((record) => record.operationId)).size).toBe(2)
    expect(new Set(completed.map((record) => record.correlationId)).size).toBe(1)
    expect(completed[0]?.correlationId).toEqual(expect.any(String))
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain(markerToken)
  })

  it('commit-and-relaunch refuses a recovered marker staged from another data root', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, join(dataRoot, 'other'))
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:commit-and-relaunch', { parent: targetParent })
    ).resolves.toMatchObject({ ok: false })
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('commit-and-relaunch returns {ok:false} and does NOT relaunch when no verified copy exists', async () => {
    initDataRoot(dataRoot)
    // No marker seeded: the commit gate refuses, nothing is persisted, and the app must not restart.
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    const outcome = (await invoke('storage:commit-and-relaunch', { parent: targetParent })) as {
      ok: boolean
    }

    expect(outcome.ok).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('commit-and-relaunch keeps the old root when handoff durability cannot be confirmed', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(false)
    const deps = fakeDeps({ prepareDataRootHandoff })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:commit-and-relaunch', { parent: targetParent })
    ).resolves.toMatchObject({ ok: false })

    expect(prepareDataRootHandoff).toHaveBeenCalledOnce()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
    expect(existsSync(target)).toBe(true)
  })

  it('does not enter recovered-commit teardown while reviewer work is active', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const deps = fakeDeps({
      hasActiveReviewerWork: vi.fn().mockReturnValue(true),
      prepareDataRootHandoff
    })
    const restartedOwner = createStorageCommandOwner(deps)

    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A review is still running. Stop it before finishing the move.'
    })

    expect(prepareDataRootHandoff).not.toHaveBeenCalled()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('rechecks reviewer work immediately before recovered pointer commit', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const deps = fakeDeps({
      hasActiveReviewerWork: vi
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false)
        .mockReturnValue(true),
      prepareDataRootHandoff,
      pauseDataRootWriters: vi.fn().mockResolvedValue(undefined)
    })
    const restartedOwner = createStorageCommandOwner(deps)

    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A review is still running. Stop it before finishing the move.'
    })

    expect(prepareDataRootHandoff).toHaveBeenCalledOnce()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('reserves the lifecycle guard while a recovered commit prepares', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    let finishPreparation: ((ready: boolean) => void) | undefined
    const prepareDataRootHandoff = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPreparation = resolve
        })
    )
    const deps = fakeDeps({ prepareDataRootHandoff })
    const restartedOwner = createStorageCommandOwner(deps)

    const commit = restartedOwner.commitAndRelaunch({ parent: targetParent })
    await vi.waitFor(() => expect(prepareDataRootHandoff).toHaveBeenCalledOnce())
    try {
      expect(isMigrationInProgress()).toBe(true)
      expect(isMigrationPending()).toBe(false)
    } finally {
      finishPreparation?.(false)
    }

    await expect(commit).resolves.toMatchObject({ ok: false })
    expect(isMigrationInProgress()).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
  })

  it('cancels a recovered commit before quit-anyway reissues quit', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    let finishPreparation: ((ready: boolean) => void) | undefined
    const prepareDataRootHandoff = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPreparation = resolve
        })
    )
    const deps = fakeDeps({ prepareDataRootHandoff })
    const restartedOwner = createStorageCommandOwner(deps)
    const guardApp = makeMigrationQuitGuardApp()
    installMigrationQuitGuard(guardApp, () => true)

    const commit = restartedOwner.commitAndRelaunch({ parent: targetParent })
    await vi.waitFor(() => expect(prepareDataRootHandoff).toHaveBeenCalledOnce())
    const { prevented } = guardApp.fireBeforeQuit()
    const quitWasReissuedBeforePreparationSettled = vi.mocked(guardApp.quit).mock.calls.length > 0
    finishPreparation?.(true)

    await expect(commit).resolves.toMatchObject({ ok: false })
    await vi.waitFor(() => expect(guardApp.quit).toHaveBeenCalledOnce())
    expect(prevented).toBe(true)
    expect(quitWasReissuedBeforePreparationSettled).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('clears recovered writer gates before quit-anyway reissues quit', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    let finishPause: (() => void) | undefined
    const pauseDataRootWriters = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPause = resolve
        })
    )
    const deps = fakeDeps({ pauseDataRootWriters })
    const restartedOwner = createStorageCommandOwner(deps)
    const guardApp = makeMigrationQuitGuardApp()
    installMigrationQuitGuard(guardApp, () => true)

    const commit = restartedOwner.commitAndRelaunch({ parent: targetParent })
    await vi.waitFor(() => expect(pauseDataRootWriters).toHaveBeenCalledOnce())
    expect(isMigrationInProgress()).toBe(true)
    expect(isMigrationPending()).toBe(true)

    const { prevented } = guardApp.fireBeforeQuit()
    expect(prevented).toBe(true)
    expect(guardApp.quit).not.toHaveBeenCalled()
    finishPause?.()

    await expect(commit).resolves.toMatchObject({ ok: false, cancelled: true })
    await vi.waitFor(() => expect(guardApp.quit).toHaveBeenCalledOnce())
    expect(isMigrationInProgress()).toBe(false)
    expect(isMigrationPending()).toBe(false)
    expect(await readMigrationMarker(target)).toMatchObject({ status: 'verified' })
  })

  it('keeps a committed recovered handoff non-cancellable after quit-anyway', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    let finishPointerWrite: (() => void) | undefined
    const setDataRoot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPointerWrite = resolve
        })
    )
    const deps = fakeDeps({
      settingsService: {
        setDataRoot,
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    const restartedOwner = createStorageCommandOwner(deps)
    const guardApp = makeMigrationQuitGuardApp()
    installMigrationQuitGuard(guardApp, () => true)

    const commit = restartedOwner.commitAndRelaunch({ parent: targetParent })
    await vi.waitFor(() => expect(setDataRoot).toHaveBeenCalledOnce())
    guardApp.fireBeforeQuit()
    expect(guardApp.quit).not.toHaveBeenCalled()
    finishPointerWrite?.()

    await expect(commit).resolves.toEqual({ ok: true, cleanupPending: false })
    await vi.waitFor(() => expect(guardApp.quit).toHaveBeenCalledOnce())
    expect(deps.relaunch).toHaveBeenCalledOnce()
    expect(isMigrationPending()).toBe(true)
  })

  it('rechecks delegated work after recovered commit preparation', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
    const getActiveDelegatedSessions = vi
      .fn()
      .mockReturnValueOnce([])
      .mockReturnValue([{ projectId: 'project-1', sessionId: 'delegated-race' }])
    const deps = fakeDeps({
      getActiveDelegatedSessions,
      pauseDataRootWriters: vi.fn().mockResolvedValue(undefined)
    })
    const restartedOwner = createStorageCommandOwner(deps)

    await expect(restartedOwner.commitAndRelaunch({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error:
        'Subagents are still running. Return to their tasks and stop them before finishing the move.'
    })

    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('commit-and-relaunch delegates production cleanup to the orderly app quit lifecycle', async () => {
    initDataRoot(dataRoot)
    // No injected relaunch: exercise the real app.relaunch -> app.quit handoff.
    const cleanupRuntimeCache = vi.fn(() => true)
    const deps = fakeDeps({ relaunch: undefined, cleanupRuntimeCache })
    appQuit.mockImplementationOnce(() => {
      expect(currentApplicationShutdownTrigger()).toBe('migration-relaunch')
    })
    registerStorageIpcHandlers(deps)

    // Stage a verified copy first (two-phase flow) so the commit actually switches over and relaunches.
    // migrate itself interrupts the notebook (shutdownAll), so clear the mocks to prove the commit
    // leaves terminal cleanup to app-lifecycle.
    await invoke('storage:migrate', { parent: targetParent })
    vi.mocked(deps.notebook.shutdownAll).mockClear()
    vi.mocked(deps.runtime.shutdownForQuit).mockClear()

    await expect(invoke('storage:commit-and-relaunch', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })

    expect(deps.runtime.shutdownForQuit).not.toHaveBeenCalled()
    expect(deps.notebook.dispose).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).not.toHaveBeenCalled()
    expect(appRelaunch).toHaveBeenCalledTimes(1)
    expect(appQuit).toHaveBeenCalledTimes(1)
    expect(appExit).not.toHaveBeenCalled()
    expect(cleanupRuntimeCache).toHaveBeenCalledWith(join(dataRoot, 'runtime'))
  })

  it('set-data-root-and-relaunch pauses writers and delegates final cleanup to app quit', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      relaunch: undefined,
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })

    expect(deps.runtime.shutdownForQuit).not.toHaveBeenCalled()
    expect(deps.notebook.dispose).not.toHaveBeenCalled()
    expect(deps.notebook.shutdownAll).toHaveBeenCalledOnce()
    expect(appRelaunch).toHaveBeenCalledTimes(1)
    expect(appQuit).toHaveBeenCalledTimes(1)
    expect(appExit).not.toHaveBeenCalled()
  })

  it('commit-and-relaunch returns switchoverFailed and does NOT relaunch when setDataRoot throws', async () => {
    initDataRoot(dataRoot)
    const cleanupRuntimeCache = vi.fn(() => true)
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockRejectedValue(new Error('disk full')),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      },
      cleanupRuntimeCache
    })
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })
    cleanupRuntimeCache.mockClear()

    const outcome = (await invoke('storage:commit-and-relaunch', { parent: targetParent })) as {
      ok: boolean
      switchoverFailed?: boolean
    }

    expect(outcome.ok).toBe(false)
    expect(outcome.switchoverFailed).toBe(true)
    expect(deps.relaunch).not.toHaveBeenCalled()
    expect(cleanupRuntimeCache).not.toHaveBeenCalled()
  })

  it('commit-and-relaunch invokes settingsService.setDataRoot as a method, preserving its `this`', async () => {
    initDataRoot(dataRoot)
    // Regression: the real settings service is a class whose setDataRoot reads `this.repository`.
    // The commit handler must pass it wrapped, not as a bare reference — otherwise the pointer flip
    // throws on undefined `this` and surfaces to the user as switchoverFailed.
    const persisted: string[] = []
    const previousRoots: Array<string | undefined> = []
    class FakeSettingsService {
      private repository = { save: (path: string): void => void persisted.push(path) }
      setDataRoot(path: string, options?: { previousDataRoot?: string }): Promise<void> {
        previousRoots.push(options?.previousDataRoot)
        this.repository.save(path)
        return Promise.resolve()
      }
      dismissLegacyDataMovePrompt = vi.fn().mockResolvedValue(undefined)
      getStoredSettings = vi.fn().mockResolvedValue({})
    }
    const deps = fakeDeps({ settingsService: new FakeSettingsService() })
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    await expect(invoke('storage:commit-and-relaunch', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    expect(previousRoots).toEqual([dataRoot])
    expect(persisted).toEqual([target])
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('discard-migrated-copy removes a marker-confirmed staged copy and leaves settings untouched', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(dataRoot, 'artifacts'), { recursive: true })
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    await invoke('storage:discard-migrated-copy', { parent: targetParent })

    expect(existsSync(target)).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('discard-migrated-copy refuses (leaves the folder) when there is no staging marker', async () => {
    initDataRoot(dataRoot)
    // A folder that merely shares the name but was never staged by us must not be deleted.
    await mkdir(join(target, 'artifacts'), { recursive: true })
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await invoke('storage:discard-migrated-copy', { parent: targetParent })

    expect(existsSync(target)).toBe(true)
  })

  it('serializes commit and discard so one resolved migration cannot delete both copies', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(dataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(dataRoot, 'artifacts', 'keep.txt'), 'must survive')

    let releaseSetDataRoot: (() => void) | undefined
    let signalSetDataRootStarted!: () => void
    const setDataRootStarted = new Promise<void>((resolve) => {
      signalSetDataRootStarted = resolve
    })
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseSetDataRoot = resolve
              signalSetDataRootStarted()
            })
        ),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    const commitPromise = invoke('storage:commit-and-relaunch', { parent: targetParent })
    // Wait for the commit to own the resolution lock; a fixed delay flakes when coverage instrumentation
    // slows filesystem work and can otherwise leave the mocked persistence promise unresolved.
    await setDataRootStarted
    await invoke('storage:discard-migrated-copy', { parent: targetParent })
    releaseSetDataRoot?.()
    await commitPromise

    expect(existsSync(join(target, 'artifacts', 'keep.txt'))).toBe(true)
  })

  it('serializes discard and commit when discard wins the resolution race', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(dataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(dataRoot, 'artifacts', 'keep.txt'), 'must survive')
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    const discardPromise = invoke('storage:discard-migrated-copy', { parent: targetParent })
    const commitOutcome = await invoke('storage:commit-and-relaunch', { parent: targetParent })
    await discardPromise

    expect(commitOutcome).toEqual({ ok: false, error: 'A migration is already being resolved.' })
    expect(existsSync(join(dataRoot, 'artifacts', 'keep.txt'))).toBe(true)
    expect(existsSync(target)).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
  })

  it('leaves the write-gate pending after a successful copy (blocks writes until commit/discard)', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    expect(isMigrationPending()).toBe(false)
    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    // The copy succeeded but nothing is committed yet, so the gate stays up.
    expect(isMigrationPending()).toBe(true)
  })

  it('rejects a second migrate while a verified copy is waiting for commit or discard', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true,
      cleanupPending: false
    })
    const secondOutcome = await invoke('storage:migrate', { parent: currentParent })

    expect(secondOutcome).toEqual({
      ok: false,
      error: 'A completed migration is waiting to be committed or discarded.'
    })
    expect(isMigrationPending()).toBe(true)

    await invoke('storage:discard-migrated-copy', { parent: targetParent })
    expect(existsSync(target)).toBe(false)
  })

  it('allows a later migration while cleanup from an earlier move remains queued', async () => {
    initDataRoot(target)
    await mkdir(target)
    const alternateParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-alternate-'))
    const alternateTarget = dataRootFor(alternateParent)
    const cleanupJournal = new DataRootCleanupJournal(join(currentParent, 'config'))
    await cleanupJournal.stage({
      token: 'pending-cleanup',
      source: dataRoot,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const runDataRootMigration = vi.fn<NonNullable<FakeDeps['runDataRootMigration']>>(
      async (_deps, parent, options) => {
        await mkdir(alternateTarget)
        options.onVerified?.({ token: 'next-migration', target: dataRootFor(parent) })
        return { ok: true }
      }
    )
    const deps = fakeDeps({ cleanupJournal, runDataRootMigration })
    registerStorageIpcHandlers(deps)

    try {
      await expect(invoke('storage:migrate', { parent: alternateParent })).resolves.toEqual({
        ok: true,
        cleanupPending: false
      })
      expect(runDataRootMigration).toHaveBeenCalledOnce()
      await expect(cleanupJournal.hasPending()).resolves.toBe(true)
    } finally {
      await rm(alternateParent, { recursive: true, force: true })
    }
  })

  it('discard lifts the write-gate after a staged copy is thrown away', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await invoke('storage:migrate', { parent: targetParent }) // stages a verified copy, gate up
    expect(isMigrationPending()).toBe(true)

    await invoke('storage:discard-migrated-copy', { parent: targetParent })

    expect(isMigrationPending()).toBe(false)
  })

  it('resolves a staged-copy deletion failure without leaving the write-gate pending', async () => {
    initDataRoot(dataRoot)
    const discardStagedCopy = vi.fn().mockRejectedValue(new Error('copy locked'))
    const runDataRootMigration: NonNullable<FakeDeps['runDataRootMigration']> = async (
      _deps,
      _parent,
      options
    ) => {
      await mkdir(target)
      options.onVerified?.({ token: 'tok-ipc', target })
      return { ok: true }
    }
    const deps = fakeDeps({ discardStagedCopy, runDataRootMigration })
    registerStorageIpcHandlers(deps)

    await invoke('storage:migrate', { parent: targetParent })
    expect(isMigrationPending()).toBe(true)

    const outcome = await invoke('storage:discard-migrated-copy', { parent: targetParent })

    expect(outcome).toEqual({
      ok: true,
      cleanupWarning: 'The unused data copy could not be removed.'
    })
    expect(isMigrationPending()).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('resolves a staged-copy validation refusal without leaving the write-gate pending', async () => {
    initDataRoot(dataRoot)
    const discardStagedCopy = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Refused: not a completed, matching staged copy.'
    })
    const runDataRootMigration: NonNullable<FakeDeps['runDataRootMigration']> = async (
      _deps,
      _parent,
      options
    ) => {
      await mkdir(target)
      options.onVerified?.({ token: 'tok-ipc', target })
      return { ok: true }
    }
    registerStorageIpcHandlers(fakeDeps({ discardStagedCopy, runDataRootMigration }))

    await invoke('storage:migrate', { parent: targetParent })
    const outcome = await invoke('storage:discard-migrated-copy', { parent: targetParent })

    expect(outcome).toEqual({
      ok: true,
      cleanupWarning: 'Refused: not a completed, matching staged copy.'
    })
    expect(isMigrationPending()).toBe(false)
    expect(existsSync(target)).toBe(true)
  })

  it('commit discards the orphan staged copy and lifts the write-gate when the switchover fails', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockRejectedValue(new Error('disk full')),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    registerStorageIpcHandlers(deps)

    await invoke('storage:migrate', { parent: targetParent }) // stages a verified copy, gate up
    expect(isMigrationPending()).toBe(true)

    const outcome = (await invoke('storage:commit-and-relaunch', { parent: targetParent })) as {
      switchoverFailed?: boolean
    }

    expect(outcome.switchoverFailed).toBe(true)
    // The UI can't retry, so the app must not soft-lock: the staged copy is discarded and the gate lifts.
    expect(isMigrationPending()).toBe(false)
    expect(existsSync(target)).toBe(false)
  })

  it('rejects a concurrent migrate call while one is already in flight', async () => {
    initDataRoot(dataRoot)
    let releaseDisconnect: (() => void) | undefined
    const deps = fakeDeps({
      runtime: {
        disconnect: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseDisconnect = resolve
            })
        ),
        shutdownForQuit: vi.fn().mockResolvedValue(undefined)
      }
    })
    registerStorageIpcHandlers(deps)

    const first = invoke('storage:migrate', { parent: targetParent })
    await tick()

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'A migration is already in progress.'
    })

    releaseDisconnect?.()
    await expect(first).resolves.toEqual({ ok: true, cleanupPending: false })
  })

  it('rejects a pointer-only switch while a migration copy is in flight', async () => {
    initDataRoot(dataRoot)
    const alternateParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-alternate-'))
    await mkdir(join(dataRootFor(alternateParent), 'artifacts'), { recursive: true })
    let releaseDisconnect: (() => void) | undefined
    const deps = fakeDeps({
      runtime: {
        disconnect: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseDisconnect = resolve
            })
        ),
        shutdownForQuit: vi.fn().mockResolvedValue(undefined)
      }
    })
    registerStorageIpcHandlers(deps)

    try {
      const migratePromise = invoke('storage:migrate', { parent: targetParent })
      await tick()

      await expect(
        invoke('storage:set-data-root-and-relaunch', { parent: alternateParent })
      ).resolves.toEqual({ ok: false, error: 'A data-root change is already in progress.' })
      expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
      expect(deps.relaunch).not.toHaveBeenCalled()

      releaseDisconnect?.()
      await migratePromise
    } finally {
      releaseDisconnect?.()
      await rm(alternateParent, { recursive: true, force: true })
    }
  })

  it('rejects a pointer-only switch while a verified copy awaits resolution', async () => {
    initDataRoot(dataRoot)
    const alternateParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-alternate-'))
    await mkdir(join(dataRootFor(alternateParent), 'artifacts'), { recursive: true })
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    try {
      await invoke('storage:migrate', { parent: targetParent })

      await expect(
        invoke('storage:set-data-root-and-relaunch', { parent: alternateParent })
      ).resolves.toEqual({
        ok: false,
        error: 'A data-root change is already in progress.'
      })
      expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
      expect(deps.relaunch).not.toHaveBeenCalled()
    } finally {
      await rm(alternateParent, { recursive: true, force: true })
    }
  })

  it('allows a pointer-only switch while cleanup from an earlier move remains queued', async () => {
    initDataRoot(target)
    await mkdir(target)
    const alternateParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-alternate-'))
    await mkdir(join(dataRootFor(alternateParent), 'artifacts'), { recursive: true })
    const cleanupJournal = new DataRootCleanupJournal(join(currentParent, 'config'))
    await cleanupJournal.stage({
      token: 'pending-cleanup',
      source: dataRoot,
      target,
      dirs: ['artifacts'],
      createdAt: 1
    })
    const deps = fakeDeps({ cleanupJournal })
    registerStorageIpcHandlers(deps)

    try {
      await expect(
        invoke('storage:set-data-root-and-relaunch', { parent: alternateParent })
      ).resolves.toEqual({ ok: true })
      expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(dataRootFor(alternateParent), {
        completeOnboarding: false,
        previousDataRoot: target
      })
      expect(deps.relaunch).toHaveBeenCalledOnce()
      await expect(cleanupJournal.hasPending()).resolves.toBe(true)
    } finally {
      await rm(alternateParent, { recursive: true, force: true })
    }
  })

  it('rejects a pointer-only switch while a migration commit is in progress', async () => {
    initDataRoot(dataRoot)
    const alternateParent = await mkdtemp(join(tmpdir(), 'ds-storage-ipc-alternate-'))
    await mkdir(join(dataRootFor(alternateParent), 'artifacts'), { recursive: true })
    let releaseCommit: (() => void) | undefined
    let markCommitStarted: (() => void) | undefined
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve
    })
    let setDataRootCalls = 0
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn(async () => {
          setDataRootCalls += 1
          if (setDataRootCalls === 1) {
            markCommitStarted?.()
            await new Promise<void>((resolve) => {
              releaseCommit = resolve
            })
          }
        }),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    registerStorageIpcHandlers(deps)

    try {
      await invoke('storage:migrate', { parent: targetParent })
      const commitPromise = invoke('storage:commit-and-relaunch', { parent: targetParent })
      await commitStarted

      await expect(
        invoke('storage:set-data-root-and-relaunch', { parent: alternateParent })
      ).resolves.toEqual({ ok: false, error: 'A data-root change is already in progress.' })
      expect(deps.settingsService.setDataRoot).toHaveBeenCalledTimes(1)

      releaseCommit?.()
      await commitPromise
    } finally {
      releaseCommit?.()
      await rm(alternateParent, { recursive: true, force: true })
    }
  })

  it('rejects commit during copying without clearing the write gate', async () => {
    initDataRoot(dataRoot)
    let releaseDisconnect: (() => void) | undefined
    let markDisconnectStarted: (() => void) | undefined
    const disconnectStarted = new Promise<void>((resolve) => {
      markDisconnectStarted = resolve
    })
    const deps = fakeDeps({
      runtime: {
        disconnect: vi.fn(() => {
          markDisconnectStarted?.()
          return new Promise<void>((resolve) => {
            releaseDisconnect = resolve
          })
        }),
        shutdownForQuit: vi.fn().mockResolvedValue(undefined)
      }
    })
    registerStorageIpcHandlers(deps)

    const migratePromise = invoke('storage:migrate', { parent: targetParent })
    await disconnectStarted
    const commitOutcome = await invoke('storage:commit-and-relaunch', { parent: targetParent })
    const pendingAfterCommit = isMigrationPending()

    releaseDisconnect?.()
    await migratePromise

    expect(commitOutcome).toEqual({ ok: false, error: 'A migration copy is still in progress.' })
    expect(pendingAfterCommit).toBe(true)
  })

  it('cancel-migrate aborts the in-flight migration, surfacing a cancelled result', async () => {
    initDataRoot(dataRoot)
    let releaseDisconnect: (() => void) | undefined
    const deps = fakeDeps({
      runtime: {
        disconnect: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseDisconnect = resolve
            })
        ),
        shutdownForQuit: vi.fn().mockResolvedValue(undefined)
      }
    })
    registerStorageIpcHandlers(deps)

    const migratePromise = invoke('storage:migrate', { parent: targetParent })
    await tick()
    await invoke('storage:cancel-migrate')
    releaseDisconnect?.()

    await expect(migratePromise).resolves.toMatchObject({ ok: false, cancelled: true })
    expect(deps.relaunch).not.toHaveBeenCalled()
    // A cancelled copy leaves the app on the old root, so the write-gate is lifted.
    expect(isMigrationPending()).toBe(false)
  })

  it('treats cancel during the verify-to-staged transition as a cancelled migration', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(dataRoot, 'artifacts'), { recursive: true })
    await writeFile(join(dataRoot, 'artifacts', 'keep.txt'), 'content')
    let cancelled = false
    const deps = fakeDeps({
      broadcastProgress: (progress) => {
        if (!cancelled && progress.phase === 'verify') {
          cancelled = true
          void invoke('storage:cancel-migrate')
        }
      }
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toMatchObject({
      ok: false,
      cancelled: true
    })
    expect(existsSync(target)).toBe(false)
    expect(isMigrationPending()).toBe(false)
  })

  it('cancel-migrate is a no-op once a copy has completed (only commit/discard may resolve it)', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await invoke('storage:migrate', { parent: targetParent }) // copy completes; gate up, staged
    expect(isMigrationPending()).toBe(true)

    await invoke('storage:cancel-migrate') // late cancel must NOT clear the gate or drop the copy

    expect(isMigrationPending()).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it("validate-data-root returns validateNewDataRoot's ok result for a parent with no OpenScience subdir", async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:validate-data-root', { parent: targetParent })).resolves.toEqual({
      ok: true
    })
  })

  it("validate-data-root surfaces validateNewDataRoot's error without throwing", async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:validate-data-root', { parent: currentParent })).resolves.toEqual({
      ok: false,
      error: 'The new location is the same as the current one.'
    })
  })

  it('inspect-data-root returns move and the derived dataRoot for a parent with no OpenScience subdir', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'move',
      dataRoot: target,
      targetWasAbsent: true,
      targetAvailableBytes: expect.any(Number)
    })
  })

  it('inspect-data-root distinguishes an existing runtime-only move target', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(target, 'runtime'), { recursive: true })
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'move',
      dataRoot: target,
      targetWasAbsent: false,
      targetAvailableBytes: expect.any(Number)
    })
  })

  it('inspects a missing target using its parent filesystem capacity and omits failed probes', async () => {
    initDataRoot(dataRoot)
    const availableBytes = vi.fn().mockResolvedValue(123_456)
    const deps = fakeDeps({ availableBytes })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'move',
      dataRoot: target,
      targetWasAbsent: true,
      targetAvailableBytes: 123_456
    })
    expect(availableBytes).toHaveBeenCalledWith(targetParent)

    availableBytes.mockRejectedValueOnce(new Error('statfs unavailable'))
    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'move',
      dataRoot: target,
      targetWasAbsent: true
    })
  })

  it('inspects and switches to a replacement when the configured data root is missing', async () => {
    initDataRoot(dataRoot)
    await rm(dataRoot, { recursive: true })
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'move',
      dataRoot: target,
      targetWasAbsent: true,
      targetAvailableBytes: expect.any(Number)
    })
    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      completeOnboarding: false,
      previousDataRoot: dataRoot
    })
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('inspect-data-root returns adopt when the derived target already holds our data', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    const availableBytes = vi.fn().mockResolvedValue(654_321)
    const deps = fakeDeps({ availableBytes })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'adopt',
      dataRoot: target,
      targetAvailableBytes: 654_321
    })
    expect(availableBytes).toHaveBeenCalledWith(target)
  })

  it('inspect-data-root returns invalid with a reason and the derived dataRoot for an unusable parent', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:inspect-data-root', { parent: currentParent })).resolves.toEqual({
      kind: 'invalid',
      dataRoot,
      error: 'The new location is the same as the current one.'
    })
  })

  it('inspect-data-root resolves an invalid result for a malformed request', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:inspect-data-root', {})).resolves.toMatchObject({
      kind: 'invalid',
      dataRoot: '',
      error: expect.any(String)
    })
  })

  it('set-data-root-and-relaunch persists the derived target and relaunches on a move parent', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      completeOnboarding: false,
      previousDataRoot: dataRoot
    })
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('set-data-root-and-relaunch creates the derived target directory for a fresh empty folder', async () => {
    // Regression: onboarding to a brand-new empty folder persisted settings.dataRoot but never
    // created `<parent>/OpenScience`, so the next launch's startup guard read the configured-but-
    // absent root as deleted and wrongly showed "Data folder not found". The handler must mkdir the
    // target so the recorded root actually exists on disk.
    initDataRoot(dataRoot)
    expect(existsSync(target)).toBe(false)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent, markOnboarding: true })
    ).resolves.toEqual({ ok: true })

    expect(existsSync(target)).toBe(true)
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      completeOnboarding: true,
      previousDataRoot: dataRoot
    })
  })

  it('set-data-root-and-relaunch creates the target before persisting the pointer', async () => {
    // Ordering guard: if the folder can't be created the pointer must not be recorded, otherwise the
    // app would relaunch into the same missing-folder state the fix is meant to prevent.
    initDataRoot(dataRoot)
    const setDataRoot = vi.fn().mockImplementation(async () => {
      // The directory must already exist by the time the pointer is persisted.
      expect(existsSync(target)).toBe(true)
    })
    const deps = fakeDeps({
      settingsService: {
        setDataRoot,
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    registerStorageIpcHandlers(deps)

    await invoke('storage:set-data-root-and-relaunch', { parent: targetParent })

    expect(setDataRoot).toHaveBeenCalledTimes(1)
  })

  it('set-data-root-and-relaunch persists the derived target and relaunches on an adopt parent (no move, no engine)', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      completeOnboarding: false,
      previousDataRoot: dataRoot
    })
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('set-data-root-and-relaunch keeps the old root when handoff durability cannot be confirmed', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(false)
    const deps = fakeDeps({
      prepareDataRootHandoff,
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({
      ok: false,
      error: 'Could not prepare the app to switch data locations safely. Please try again.'
    })

    expect(prepareDataRootHandoff).toHaveBeenCalledOnce()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('passes the requesting Web renderer through to the data-root durability gate', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(false)
    const owner = createStorageCommandOwner(
      fakeDeps({
        prepareDataRootHandoff,
        classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
      })
    )

    const target = { surface: 'web-renderer', lifecycleClientId: 'web:client-a' } as const
    await owner.setDataRootAndRelaunch({ parent: targetParent }, target)

    expect(prepareDataRootHandoff).toHaveBeenCalledWith(target, false)
  })

  it('set-data-root-and-relaunch refuses delegated work before preparing the handoff', async () => {
    initDataRoot(dataRoot)
    const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
    const deps = fakeDeps({
      getActiveDelegatedSessions: vi
        .fn()
        .mockReturnValue([{ projectId: 'project-1', sessionId: 'delegated-1' }]),
      prepareDataRootHandoff,
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toMatchObject({ ok: false })

    expect(prepareDataRootHandoff).not.toHaveBeenCalled()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'root-agent prompt',
      overrides: {
        getActivePromptSessions: vi
          .fn()
          .mockReturnValue([{ projectId: 'project-1', sessionId: 'agent-1' }])
      }
    },
    {
      label: 'notebook execution',
      overrides: {
        notebook: {
          shutdownAll: vi.fn().mockResolvedValue({ reaped: true }),
          dispose: vi.fn().mockResolvedValue({ reaped: true }),
          getActiveNotebookSessions: vi
            .fn()
            .mockReturnValue([{ projectId: 'project-1', sessionId: 'notebook-1' }])
        }
      }
    },
    {
      label: 'review',
      overrides: {
        hasActiveReviewerWork: vi.fn().mockReturnValue(true)
      }
    }
  ])(
    'set-data-root-and-relaunch preserves active $label before handoff teardown',
    async ({ overrides }) => {
      initDataRoot(dataRoot)
      const prepareDataRootHandoff = vi.fn().mockResolvedValue(true)
      const deps = fakeDeps({
        ...overrides,
        prepareDataRootHandoff,
        classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
      })
      registerStorageIpcHandlers(deps)

      await expect(
        invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
      ).resolves.toMatchObject({ ok: false })

      expect(prepareDataRootHandoff).not.toHaveBeenCalled()
      expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
      expect(deps.relaunch).not.toHaveBeenCalled()
    }
  )

  it('reserves the lifecycle guard before direct handoff classification awaits', async () => {
    initDataRoot(dataRoot)
    let finishClassification: ((result: { kind: 'invalid'; error: string }) => void) | undefined
    const classifyDataRoot = vi.fn(
      () =>
        new Promise<{ kind: 'invalid'; error: string }>((resolve) => {
          finishClassification = resolve
        })
    )
    const deps = fakeDeps({ classifyDataRoot })
    registerStorageIpcHandlers(deps)

    const handoff = invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    await vi.waitFor(() => expect(classifyDataRoot).toHaveBeenCalledOnce())
    try {
      expect(isMigrationInProgress()).toBe(true)
      expect(isMigrationPending()).toBe(false)
    } finally {
      finishClassification?.({ kind: 'invalid', error: 'not usable' })
      await handoff
    }

    expect(isMigrationInProgress()).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
  })

  it('cancels a direct handoff before quit-anyway reissues quit', async () => {
    initDataRoot(dataRoot)
    let finishPreparation: ((ready: boolean) => void) | undefined
    const prepareDataRootHandoff = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishPreparation = resolve
        })
    )
    const deps = fakeDeps({
      prepareDataRootHandoff,
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    const owner = createStorageCommandOwner(deps)
    const guardApp = makeMigrationQuitGuardApp()
    installMigrationQuitGuard(guardApp, () => true)

    const handoff = owner.setDataRootAndRelaunch({ parent: targetParent })
    await vi.waitFor(() => expect(prepareDataRootHandoff).toHaveBeenCalledOnce())
    const { prevented } = guardApp.fireBeforeQuit()
    const quitWasReissuedBeforePreparationSettled = vi.mocked(guardApp.quit).mock.calls.length > 0
    finishPreparation?.(true)

    await expect(handoff).resolves.toMatchObject({ ok: false })
    await vi.waitFor(() => expect(guardApp.quit).toHaveBeenCalledOnce())
    expect(prevented).toBe(true)
    expect(quitWasReissuedBeforePreparationSettled).toBe(false)
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('keeps a committed direct handoff non-cancellable after quit-anyway', async () => {
    initDataRoot(dataRoot)
    let finishPointerWrite: (() => void) | undefined
    const setDataRoot = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPointerWrite = resolve
        })
    )
    const deps = fakeDeps({
      settingsService: {
        setDataRoot,
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      },
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    const owner = createStorageCommandOwner(deps)
    const guardApp = makeMigrationQuitGuardApp()
    installMigrationQuitGuard(guardApp, () => true)

    const handoff = owner.setDataRootAndRelaunch({ parent: targetParent })
    await vi.waitFor(() => expect(setDataRoot).toHaveBeenCalledOnce())
    guardApp.fireBeforeQuit()
    expect(guardApp.quit).not.toHaveBeenCalled()
    finishPointerWrite?.()

    await expect(handoff).resolves.toEqual({ ok: true })
    await vi.waitFor(() => expect(guardApp.quit).toHaveBeenCalledOnce())
    expect(deps.relaunch).toHaveBeenCalledOnce()
    expect(isMigrationPending()).toBe(true)
  })

  it('holds the write gate from direct handoff preparation through relaunch', async () => {
    initDataRoot(dataRoot)
    const setDataRoot = vi.fn(async () => {
      expect(isMigrationPending()).toBe(true)
    })
    const relaunch = vi.fn(() => {
      expect(isMigrationPending()).toBe(true)
      expect(isMigrationInProgress()).toBe(false)
    })
    const deps = fakeDeps({
      settingsService: {
        setDataRoot,
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      },
      relaunch,
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })

    expect(setDataRoot).toHaveBeenCalledOnce()
    expect(relaunch).toHaveBeenCalledOnce()
    expect(isMigrationPending()).toBe(true)
  })

  it('drains existing writer leases before a direct pointer switch', async () => {
    initDataRoot(dataRoot)
    let finishWriter: (() => void) | undefined
    const activeWrite = withDataRootWrite(
      () =>
        new Promise<void>((resolve) => {
          finishWriter = resolve
        })
    )
    const pauseDataRootWriters = vi.fn(() => waitForDataRootWriters())
    const deps = fakeDeps({
      pauseDataRootWriters,
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    const handoff = invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    try {
      await vi.waitFor(() => expect(isMigrationPending()).toBe(true))
      await tick(25)
      expect(pauseDataRootWriters).toHaveBeenCalledOnce()
      expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    } finally {
      finishWriter?.()
      await activeWrite
    }

    await expect(handoff).resolves.toEqual({ ok: true })
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledOnce()
  })

  it('restores renderer preparation when a direct handoff fails after durability', async () => {
    initDataRoot(dataRoot)
    const notifyDataRootHandoffAborted = vi.fn()
    const deps = {
      ...fakeDeps({
        pauseDataRootWriters: vi.fn().mockRejectedValue(new Error('busy')),
        classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
      }),
      notifyDataRootHandoffAborted
    }
    const owner = createStorageCommandOwner(deps)

    await expect(owner.setDataRootAndRelaunch({ parent: targetParent })).resolves.toMatchObject({
      ok: false
    })

    expect(notifyDataRootHandoffAborted).toHaveBeenCalledOnce()
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
  })

  it('restores renderer preparation when a migration copy fails after durability', async () => {
    initDataRoot(dataRoot)
    const notifyDataRootHandoffAborted = vi.fn()
    const deps = {
      ...fakeDeps({
        runDataRootMigration: vi.fn().mockResolvedValue({ ok: false, error: 'copy failed' })
      }),
      notifyDataRootHandoffAborted
    }
    const owner = createStorageCommandOwner(deps)

    await expect(owner.migrate({ parent: targetParent })).resolves.toEqual({
      ok: false,
      error: 'copy failed'
    })

    expect(notifyDataRootHandoffAborted).toHaveBeenCalledOnce()
    expect(isMigrationPending()).toBe(false)
  })

  it.each([
    {
      label: 'delegated work',
      overrides: {
        getActiveDelegatedSessions: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValue([{ projectId: 'project-1', sessionId: 'delegated-race' }])
      }
    },
    {
      label: 'root-agent work',
      overrides: {
        getActivePromptSessions: vi
          .fn()
          .mockReturnValueOnce([])
          .mockReturnValue([{ projectId: 'project-1', sessionId: 'agent-race' }])
      }
    },
    {
      label: 'notebook work',
      overrides: {
        notebook: {
          shutdownAll: vi.fn().mockResolvedValue({ reaped: true }),
          dispose: vi.fn().mockResolvedValue({ reaped: true }),
          getActiveNotebookSessions: vi
            .fn()
            .mockReturnValueOnce([])
            .mockReturnValue([{ projectId: 'project-1', sessionId: 'notebook-race' }])
        }
      }
    },
    {
      label: 'reviewer work',
      overrides: {
        hasActiveReviewerWork: vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
      }
    }
  ])('rechecks $label after draining direct-switch writers', async ({ overrides }) => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      ...overrides,
      pauseDataRootWriters: vi.fn().mockResolvedValue(undefined),
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toMatchObject({ ok: false })

    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
    expect(isMigrationPending()).toBe(false)
  })

  it('forces the committed old process to exit when direct relaunch throws', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      relaunch: vi.fn(() => {
        throw new Error('restart scheduling failed')
      }),
      classifyDataRoot: vi.fn().mockResolvedValue({ kind: 'adopt' })
    })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: false, error: 'restart scheduling failed' })

    expect(deps.settingsService.setDataRoot).toHaveBeenCalledOnce()
    expect(appExit).toHaveBeenCalledWith(1)
    expect(isMigrationPending()).toBe(true)
  })

  it('diagnoses an adopted data root without retaining its path', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    const logger = fakeDiagnosticLogger()
    registerStorageIpcHandlers(fakeDeps({ logger }))

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })

    expect(diagnosticRecords(logger)).toContainEqual(
      expect.objectContaining({
        operation: 'data-root-selection',
        mode: 'adopt',
        outcome: 'completed'
      })
    )
    expect(JSON.stringify(diagnosticRecords(logger))).not.toContain(target)
  })

  it('set-data-root-and-relaunch commits onboarding with the data root when requested', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await invoke('storage:set-data-root-and-relaunch', {
      parent: targetParent,
      markOnboarding: true
    })

    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      completeOnboarding: true,
      previousDataRoot: dataRoot
    })
  })

  it('set-data-root-and-relaunch omits onboarding completion when markOnboarding is false', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await invoke('storage:set-data-root-and-relaunch', {
      parent: targetParent,
      markOnboarding: false
    })

    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target, {
      completeOnboarding: false,
      previousDataRoot: dataRoot
    })
  })

  it('set-data-root-and-relaunch persists both settings before relaunching', async () => {
    initDataRoot(dataRoot)
    const callOrder: string[] = []
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockImplementation(async (_path, options) => {
          callOrder.push(options?.completeOnboarding ? 'persistBoth' : 'persistDataRoot')
        }),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      },
      relaunch: vi.fn().mockImplementation(() => {
        callOrder.push('relaunch')
      })
    })
    registerStorageIpcHandlers(deps)

    await invoke('storage:set-data-root-and-relaunch', {
      parent: targetParent,
      markOnboarding: true
    })

    expect(callOrder).toEqual(['persistBoth', 'relaunch'])
  })

  it('set-data-root-and-relaunch rejects an invalid parent without setting, marking, or relaunching', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: currentParent, markOnboarding: true })
    ).resolves.toEqual({
      ok: false,
      error: 'The new location is the same as the current one.'
    })
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('broadcasts migration progress to all windows by default', async () => {
    initDataRoot(dataRoot)
    sentWindows.push({ webContents: { send: vi.fn() }, isDestroyed: () => false })
    registerStorageIpcHandlers(fakeDeps())

    await invoke('storage:migrate', { parent: targetParent })

    expect(sentWindows[0].webContents.send).toHaveBeenCalledWith(
      'storage:migrate-progress',
      expect.objectContaining({ phase: expect.any(String) })
    )
  })
})

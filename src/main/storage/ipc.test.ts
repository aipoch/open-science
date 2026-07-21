import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  app: { getPath: () => electronHome.path, isPackaged: true, relaunch: appRelaunch, exit: appExit }
}))

const { initDataRoot } = await import('../storage-root')
const { registerStorageIpcHandlers } = await import('./ipc')
const { clearMigrationPending, isMigrationPending } = await import('./migration-state')
const { writeMigrationMarker } = await import('./migration-marker')

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
  Promise.resolve(handlers.get(channel)!(undefined, payload))

// Real fs calls inside validateNewDataRoot/classifyDataRoot need an actual event-loop turn, not
// just a microtask flush, before the mocked runtime.disconnect() (the next await) is reached.
const tick = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type FakeDeps = Parameters<typeof registerStorageIpcHandlers>[0]

const fakeDeps = (overrides: Partial<FakeDeps> = {}): FakeDeps => ({
  runtime: {
    disconnect: vi.fn().mockResolvedValue(undefined),
    shutdownForQuit: vi.fn().mockResolvedValue({ reaped: true })
  },
  notebook: {
    shutdownAll: vi.fn().mockResolvedValue({ reaped: true }),
    getActiveNotebookSessions: vi.fn().mockReturnValue([])
  },
  getActivePromptSessions: vi.fn().mockReturnValue([]),
  settingsService: {
    setDataRoot: vi.fn().mockResolvedValue(undefined),
    markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
    dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
    getStoredSettings: vi.fn().mockResolvedValue({})
  },
  relaunch: vi.fn(),
  ...overrides
})

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
  await rm(currentParent, { recursive: true, force: true })
  await rm(targetParent, { recursive: true, force: true })
})

describe('storage IPC handlers', () => {
  it('registers every storage channel', () => {
    registerStorageIpcHandlers(fakeDeps())

    for (const channel of [
      'storage:get-info',
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

  it('get-info reports isDefault true when the data root falls back to the computed default', async () => {
    initDataRoot(undefined)
    registerStorageIpcHandlers(fakeDeps())

    const info = (await invoke('storage:get-info')) as {
      dataRoot: string
      isDefault: boolean
      defaultDataRoot: string
      defaultParent: string
    }

    expect(info.isDefault).toBe(true)
    // The default root is `<home>/OpenScience` (home mocked to /home/user), reproducible from home.
    // Derive with join so the assertion holds on Windows (backslashes), not just POSIX.
    expect(info.defaultDataRoot).toBe(join('/home/user', 'OpenScience'))
    expect(info.defaultParent).toBe('/home/user')
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
      }

      expect(info.dataRoot).toBe(join(home, '.open-science'))
      expect(info.legacyDataMovePrompt).toBe(true)
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
      }

      expect(info.dataRoot).toBe(join(home, '.open-science'))
      expect(info.legacyDataMovePrompt).toBe(true)
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

      const info = (await invoke('storage:get-info')) as { legacyDataMovePrompt: boolean }

      expect(info.legacyDataMovePrompt).toBe(false)
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
        markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
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
        markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({ dataRoot: target })
      }
    })
    registerStorageIpcHandlers(deps)

    const info = (await invoke('storage:get-info')) as { dataRootMissing: boolean }

    expect(info.dataRootMissing).toBe(true)
  })

  it('detect-active maps runtime and notebook session sources into ActiveSessionInfo', async () => {
    const deps = fakeDeps({
      getActivePromptSessions: vi
        .fn()
        .mockReturnValue([{ projectName: 'p', sessionId: 'agent-1' }]),
      notebook: {
        shutdownAll: vi.fn().mockResolvedValue(undefined),
        getActiveNotebookSessions: vi
          .fn()
          .mockReturnValue([{ projectName: 'p', sessionId: 'nb-1' }])
      }
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:detect-active')).resolves.toEqual([
      { projectId: 'p', sessionId: 'agent-1', kind: 'agent' },
      { projectId: 'p', sessionId: 'nb-1', kind: 'notebook' }
    ])
  })

  it('detect-active calls the notebook service as a method, preserving its `this` binding', async () => {
    // Regression: the real notebook runtime service is a class whose getActiveNotebookSessions reads
    // `this.sessions`. The handler must invoke it as a method — extracting it as a bare function
    // reference drops `this` and throws "Cannot read properties of undefined (reading 'values')".
    class FakeNotebookService {
      private sessions = new Map([['nb-1', { projectName: 'p', sessionId: 'nb-1' }]])
      shutdownAll = vi.fn().mockResolvedValue(undefined)
      getActiveNotebookSessions(): { projectName: string; sessionId: string }[] {
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
    const deps = fakeDeps({
      showOpenDialog: vi.fn().mockRejectedValue(new Error('picker failed'))
    })
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:pick-directory')).resolves.toBeNull()
    expect(showOpenDialog).not.toHaveBeenCalled()
  })

  it('migrate copies into the target without committing (no setDataRoot, no relaunch)', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({
      ok: true
    })
    expect(deps.runtime.disconnect).toHaveBeenCalledTimes(1)
    // Phase 1 is copy-only: the pointer is not flipped and the app does not restart until the user
    // clicks "Restart now" (storage:commit-and-relaunch).
    expect(deps.settingsService.setDataRoot).not.toHaveBeenCalled()
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('commit-and-relaunch refuses a verified marker not staged by this process', async () => {
    initDataRoot(dataRoot)
    await seedVerifiedMarker(target, dataRoot)
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

  it('commit-and-relaunch runs the production cleanup (shutdown backends, then relaunch+exit) with no relaunch override', async () => {
    initDataRoot(dataRoot)
    // No injected relaunch: exercise the real cleanRelaunch path (shutdownBackends -> app.relaunch ->
    // app.exit) instead of the test short-circuit.
    const deps = fakeDeps({ relaunch: undefined })
    registerStorageIpcHandlers(deps)

    // Stage a verified copy first (two-phase flow) so the commit actually switches over and relaunches.
    // migrate itself interrupts the notebook (shutdownAll), so clear the mocks to isolate the commit's
    // own cleanup below.
    await invoke('storage:migrate', { parent: targetParent })
    vi.mocked(deps.notebook.shutdownAll).mockClear()
    vi.mocked(deps.runtime.shutdownForQuit).mockClear()

    await expect(invoke('storage:commit-and-relaunch', { parent: targetParent })).resolves.toEqual({
      ok: true
    })

    expect(deps.runtime.shutdownForQuit).toHaveBeenCalledTimes(1)
    expect(deps.notebook.shutdownAll).toHaveBeenCalledTimes(1)
    expect(appRelaunch).toHaveBeenCalledTimes(1)
    expect(appExit).toHaveBeenCalledWith(0)
    // Backends are torn down before the relaunch is triggered.
    expect(vi.mocked(deps.runtime.shutdownForQuit).mock.invocationCallOrder[0]).toBeLessThan(
      appRelaunch.mock.invocationCallOrder[0]
    )
  })

  it('set-data-root-and-relaunch runs the production cleanup before relaunch+exit with no relaunch override', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({ relaunch: undefined })
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })

    expect(deps.runtime.shutdownForQuit).toHaveBeenCalledTimes(1)
    expect(deps.notebook.shutdownAll).toHaveBeenCalledTimes(1)
    expect(appRelaunch).toHaveBeenCalledTimes(1)
    expect(appExit).toHaveBeenCalledWith(0)
  })

  it('commit-and-relaunch returns switchoverFailed and does NOT relaunch when setDataRoot throws', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockRejectedValue(new Error('disk full')),
        markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    const outcome = (await invoke('storage:commit-and-relaunch', { parent: targetParent })) as {
      ok: boolean
      switchoverFailed?: boolean
    }

    expect(outcome.ok).toBe(false)
    expect(outcome.switchoverFailed).toBe(true)
    expect(deps.relaunch).not.toHaveBeenCalled()
  })

  it('commit-and-relaunch invokes settingsService.setDataRoot as a method, preserving its `this`', async () => {
    initDataRoot(dataRoot)
    // Regression: the real settings service is a class whose setDataRoot reads `this.repository`.
    // The commit handler must pass it wrapped, not as a bare reference — otherwise the pointer flip
    // throws on undefined `this` and surfaces to the user as switchoverFailed.
    const persisted: string[] = []
    class FakeSettingsService {
      private repository = { save: (path: string): void => void persisted.push(path) }
      setDataRoot(path: string): Promise<void> {
        this.repository.save(path)
        return Promise.resolve()
      }
      markOnboardingComplete = vi.fn().mockResolvedValue(undefined)
      dismissLegacyDataMovePrompt = vi.fn().mockResolvedValue(undefined)
      getStoredSettings = vi.fn().mockResolvedValue({})
    }
    const deps = fakeDeps({ settingsService: new FakeSettingsService() })
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    await expect(invoke('storage:commit-and-relaunch', { parent: targetParent })).resolves.toEqual({
      ok: true
    })
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
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseSetDataRoot = resolve
            })
        ),
        markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
        dismissLegacyDataMovePrompt: vi.fn().mockResolvedValue(undefined),
        getStoredSettings: vi.fn().mockResolvedValue({})
      }
    })
    registerStorageIpcHandlers(deps)
    await invoke('storage:migrate', { parent: targetParent })

    const commitPromise = invoke('storage:commit-and-relaunch', { parent: targetParent })
    await tick()
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
    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({ ok: true })
    // The copy succeeded but nothing is committed yet, so the gate stays up.
    expect(isMigrationPending()).toBe(true)
  })

  it('rejects a second migrate while a verified copy is waiting for commit or discard', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:migrate', { parent: targetParent })).resolves.toEqual({ ok: true })
    const secondOutcome = await invoke('storage:migrate', { parent: currentParent })

    expect(secondOutcome).toEqual({
      ok: false,
      error: 'A completed migration is waiting to be committed or discarded.'
    })
    expect(isMigrationPending()).toBe(true)

    await invoke('storage:discard-migrated-copy', { parent: targetParent })
    expect(existsSync(target)).toBe(false)
  })

  it('discard lifts the write-gate after a staged copy is thrown away', async () => {
    initDataRoot(dataRoot)
    registerStorageIpcHandlers(fakeDeps())

    await invoke('storage:migrate', { parent: targetParent }) // stages a verified copy, gate up
    expect(isMigrationPending()).toBe(true)

    await invoke('storage:discard-migrated-copy', { parent: targetParent })

    expect(isMigrationPending()).toBe(false)
  })

  it('commit discards the orphan staged copy and lifts the write-gate when the switchover fails', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockRejectedValue(new Error('disk full')),
        markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
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
    await expect(first).resolves.toEqual({ ok: true })
  })

  it('rejects commit during copying without clearing the write gate', async () => {
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
      dataRoot: target
    })
  })

  it('inspect-data-root returns adopt when the derived target already holds our data', async () => {
    initDataRoot(dataRoot)
    await mkdir(join(target, 'artifacts'), { recursive: true })
    registerStorageIpcHandlers(fakeDeps())

    await expect(invoke('storage:inspect-data-root', { parent: targetParent })).resolves.toEqual({
      kind: 'adopt',
      dataRoot: target
    })
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

  it('set-data-root-and-relaunch persists the derived target and relaunches on a move parent', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await expect(
      invoke('storage:set-data-root-and-relaunch', { parent: targetParent })
    ).resolves.toEqual({ ok: true })
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target)
    expect(deps.settingsService.markOnboardingComplete).not.toHaveBeenCalled()
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
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target)
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
        markOnboardingComplete: vi.fn().mockResolvedValue(undefined),
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
    expect(deps.settingsService.setDataRoot).toHaveBeenCalledWith(target)
    expect(deps.relaunch).toHaveBeenCalledTimes(1)
  })

  it('set-data-root-and-relaunch marks onboarding complete only when markOnboarding is true', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await invoke('storage:set-data-root-and-relaunch', {
      parent: targetParent,
      markOnboarding: true
    })

    expect(deps.settingsService.markOnboardingComplete).toHaveBeenCalledTimes(1)
  })

  it('set-data-root-and-relaunch does not mark onboarding when markOnboarding is false or omitted', async () => {
    initDataRoot(dataRoot)
    const deps = fakeDeps()
    registerStorageIpcHandlers(deps)

    await invoke('storage:set-data-root-and-relaunch', {
      parent: targetParent,
      markOnboarding: false
    })

    expect(deps.settingsService.markOnboardingComplete).not.toHaveBeenCalled()
  })

  it('set-data-root-and-relaunch calls setDataRoot, then markOnboardingComplete, then relaunch, in order', async () => {
    initDataRoot(dataRoot)
    const callOrder: string[] = []
    const deps = fakeDeps({
      settingsService: {
        setDataRoot: vi.fn().mockImplementation(async () => {
          callOrder.push('setDataRoot')
        }),
        markOnboardingComplete: vi.fn().mockImplementation(async () => {
          callOrder.push('markOnboardingComplete')
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

    expect(callOrder).toEqual(['setDataRoot', 'markOnboardingComplete', 'relaunch'])
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
    expect(deps.settingsService.markOnboardingComplete).not.toHaveBeenCalled()
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

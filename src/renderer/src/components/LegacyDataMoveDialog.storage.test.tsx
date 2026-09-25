// @vitest-environment jsdom
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({ home: '', packaged: true }))
vi.mock('electron', () => ({
  app: {
    getPath: () => electron.home,
    get isPackaged() {
      return electron.packaged
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  shell: {}
}))
vi.mock('../../../main/storage/remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))
import { LegacyDataMoveDialog } from './LegacyDataMoveDialog'
import { initDataRoot, resolveConfigRoot } from '../../../main/storage-root'
import { createStorageCommandOwner } from '../../../main/storage/command-owner'
import { clearMigrationPending } from '../../../main/storage/migration-state'

let fixture: string
let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'legacy-dialog-'))
  electron.home = fixture
  electron.packaged = true
  for (const name of [
    'OPEN_SCIENCE_CONFIG_ROOT',
    'OPEN_SCIENCE_STORAGE_ROOT',
    'OPEN_SCIENCE_E2E_STORAGE_ROOT'
  ])
    vi.stubEnv(name, '')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  clearMigrationPending()
  vi.unstubAllEnvs()
  await rm(fixture, { recursive: true, force: true })
})
const seed = async (path: string): Promise<void> => {
  await mkdir(join(path, 'workspaces'), { recursive: true })
  await writeFile(join(path, 'workspaces/history.json'), '{}')
}

it.each(['absent', 'existing', 'both', 'development', 'isolated'])(
  'uses the exact default through renderer and command owner (%s)',
  async (scenario) => {
    electron.packaged = scenario !== 'development'
    if (scenario === 'isolated') vi.stubEnv('OPEN_SCIENCE_CONFIG_ROOT', join(fixture, 'isolated'))
    const current = resolveConfigRoot()
    await seed(current)
    initDataRoot(current)
    const old = join(fixture, electron.packaged ? 'OpenScience' : 'OpenScience-DEV')
    await seed(old)
    const runCopy = vi.fn().mockResolvedValue({ ok: false, error: 'Copy boundary reached' })
    const owner = createStorageCommandOwner({
      runtime: { disconnect: vi.fn(), shutdownForQuit: vi.fn() },
      notebook: { shutdownAll: vi.fn(), dispose: vi.fn(), getActiveNotebookSessions: () => [] },
      getActivePromptSessions: () => [],
      getActiveSideChatSessions: () => [],
      getActiveDelegatedSessions: () => [],
      hasActiveReviewerWork: () => false,
      settingsService: {
        setDataRoot: vi.fn(),
        dismissLegacyDataMovePrompt: vi.fn(),
        getStoredSettings: async () => ({ dataRoot: current })
      },
      prepareDataRootHandoff: async () => true,
      runDataRootMigration: runCopy,
      availableBytes: async () => 1e12
    })
    const status = await owner.getStatus()
    if (scenario === 'existing' || scenario === 'both') await seed(status.defaultDataRoot)
    const inspect = vi.fn((parent: string) => owner.inspectDataRoot({ parent }))
    const migrate = vi.fn(
      (parent: string, selection?: Parameters<typeof owner.migrate>[0]['selection']) =>
        owner.migrate({ parent, selection })
    )
    Object.assign(window, {
      api: {
        storage: {
          inspectDataRoot: inspect,
          migrate,
          detectActive: async () => [],
          onProgress: () => () => {},
          cancelMigrate: vi.fn(),
          pickDirectory: vi.fn()
        }
      }
    })
    await act(async () => {
      root.render(
        <LegacyDataMoveDialog {...status} currentDataRoot={current} onDismiss={vi.fn()} />
      )
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain(status.defaultDataRoot))
    expect(inspect).toHaveBeenCalledWith(status.defaultDataRoot)
    await act(async () => {
      const button = Array.from(document.body.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Move to Open-Science')
      )!
      button.click()
    })
    if (['existing', 'both', 'isolated'].includes(scenario)) {
      expect(migrate).not.toHaveBeenCalled()
      expect(runCopy).not.toHaveBeenCalled()
      if (scenario === 'isolated')
        expect(document.body.textContent).toContain('outside the current data folder')
    } else {
      await vi.waitFor(() => expect(runCopy).toHaveBeenCalled())
      expect(runCopy.mock.calls[0][1]).toBe(status.defaultDataRoot)
      expect(migrate.mock.calls[0][0]).toBe(status.defaultDataRoot)
    }
  }
)

it.each(['copying', 'verified'] as const)(
  'closes a stale %s recovery dialog after another surface discarded its copy',
  async (recoveryStatus) => {
    const { StorageMigrationModal } = await import('../pages/settings/StorageMigrationModal')
    const { writeMigrationMarker } = await import('../../../main/storage/migration-marker')
    const current = join(fixture, 'current')
    const parent = join(fixture, 'destination')
    const target = join(parent, 'Open-Science')
    await mkdir(current)
    await mkdir(target, { recursive: true })
    initDataRoot(current)
    await writeMigrationMarker(target, {
      version: 1,
      token: 'stale-dialog',
      source: current,
      target,
      createdAt: Date.now(),
      status: recoveryStatus,
      inventory: {
        dirs: [],
        fileCount: 0,
        totalBytes: 0,
        digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      }
    })
    const owner = createStorageCommandOwner({
      runtime: { disconnect: vi.fn(), shutdownForQuit: vi.fn() },
      notebook: { shutdownAll: vi.fn(), dispose: vi.fn(), getActiveNotebookSessions: () => [] },
      getActivePromptSessions: () => [],
      getActiveSideChatSessions: () => [],
      getActiveDelegatedSessions: () => [],
      hasActiveReviewerWork: () => false,
      settingsService: {
        setDataRoot: vi.fn(),
        dismissLegacyDataMovePrompt: vi.fn(),
        getStoredSettings: async () => ({ dataRoot: current })
      }
    })
    expect(await owner.discardMigratedCopy({ parent })).toEqual({ ok: true })
    const discard = vi.fn((path: string) => owner.discardMigratedCopy({ parent: path }))
    Object.assign(window, {
      api: { storage: { detectActive: async () => [], discardMigratedCopy: discard } }
    })
    const close = vi.fn()
    await act(async () =>
      root.render(
        <StorageMigrationModal
          targetPath={target}
          recoveryStatus={recoveryStatus}
          onClose={close}
        />
      )
    )
    const button = Array.from(document.body.querySelectorAll('button')).find(
      (b) =>
        b.textContent ===
        (recoveryStatus === 'copying' ? 'Discard incomplete copy' : 'Discard copy')
    )!
    expect(button).toBeDefined()
    await act(async () => {
      button.click()
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    })
    expect(discard).toHaveBeenCalledOnce()
    expect(document.body.textContent).not.toContain('No matching staged data copy was found.')
  }
)

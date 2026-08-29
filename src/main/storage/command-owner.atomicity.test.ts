import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronHome = { path: '' }
const fsFaults = vi.hoisted(() => ({
  failSecondSettingsRename: false,
  settingsRenameCount: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()

  return {
    ...actual,
    rename: vi.fn(async (source, destination) => {
      if (String(destination).endsWith('settings.json')) {
        fsFaults.settingsRenameCount += 1
        if (fsFaults.failSecondSettingsRename && fsFaults.settingsRenameCount === 2) {
          throw Object.assign(new Error('injected second settings rename failure'), {
            code: 'EIO'
          })
        }
      }
      await actual.rename(source, destination)
    })
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => electronHome.path,
    isPackaged: true,
    relaunch: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn()
  },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() }
}))

vi.mock('./remote-data-root', () => ({
  inspectWindowsStoragePath: () => ({ isRemote: false, supportsHardLinks: true })
}))

const { initDataRoot } = await import('../storage-root')
const { SettingsDocumentStore } = await import('../settings/document-store')
const { SettingsRepository } = await import('../settings/repository')
const { SettingsPreferencesModule } = await import('../settings/preferences')
const { createStorageCommandOwner } = await import('./command-owner')

describe('storage command owner onboarding persistence', () => {
  let currentParent: string
  let currentDataRoot: string
  let targetParent: string
  let targetDataRoot: string

  beforeEach(async () => {
    currentParent = await mkdtemp(join(tmpdir(), 'storage-owner-current-'))
    currentDataRoot = join(currentParent, 'OpenScience')
    await mkdir(currentDataRoot)
    targetParent = await mkdtemp(join(tmpdir(), 'storage-owner-target-'))
    targetDataRoot = join(targetParent, 'OpenScience')
    electronHome.path = currentParent
    initDataRoot(currentDataRoot)
    fsFaults.failSecondSettingsRename = false
    fsFaults.settingsRenameCount = 0
  })

  afterEach(async () => {
    initDataRoot(undefined)
    await rm(currentParent, { recursive: true, force: true })
    await rm(targetParent, { recursive: true, force: true })
  })

  it('commits the initial data root and onboarding completion together', async () => {
    const store = new SettingsDocumentStore(join(currentParent, 'settings'))
    const repository = new SettingsRepository(store)
    const preferences = new SettingsPreferencesModule(repository, () => 1_234)
    // A split implementation reaches this second publish after dataRoot is already durable. The
    // combined mutation never performs it, so both fields survive together in the first document.
    fsFaults.failSecondSettingsRename = true

    const owner = createStorageCommandOwner({
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
      getActiveDelegatedSessions: vi.fn().mockReturnValue([]),
      hasActiveReviewerWork: vi.fn().mockReturnValue(false),
      settingsService: {
        setDataRoot: async (path, options) => {
          await preferences.setDataRoot(path, options)
        },
        dismissLegacyDataMovePrompt: () => preferences.dismissLegacyDataMovePrompt(),
        getStoredSettings: () => repository.getSettings()
      },
      relaunch: vi.fn()
    })

    const result = await owner.setDataRootAndRelaunch({
      parent: targetParent,
      markOnboarding: true
    })
    const persisted = await repository.getSettings()

    expect({
      result,
      persisted: {
        dataRoot: persisted.dataRoot,
        onboardingCompletedAt: persisted.onboardingCompletedAt
      }
    }).toEqual({
      result: { ok: true },
      persisted: {
        dataRoot: targetDataRoot,
        onboardingCompletedAt: 1_234
      }
    })
  })
})

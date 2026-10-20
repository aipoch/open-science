import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeService: vi.fn(),
  closeHeadless: vi.fn(),
  headlessActive: vi.fn(),
  closeDesktop: vi.fn(),
  closeBrowser: vi.fn(),
  stopBrowser: vi.fn(),
  removeQuitGuard: vi.fn(),
  recover: vi.fn()
}))
vi.mock('electron', () => ({ app: {}, dialog: {} }))
vi.mock('../projects/ipc', () => ({
  createDefaultProjectRepository: () => ({}),
  createDefaultPreviewStateRepository: () => ({})
}))
vi.mock('../session-package/service', () => ({
  SessionPackageService: class {
    close = mocks.closeService
    recover = mocks.recover
  }
}))
vi.mock('../session-package/browser-import', () => ({
  BrowserPackageImport: class {
    active = false
    stop = mocks.stopBrowser
    close = mocks.closeBrowser
  }
}))
vi.mock('../session-package/headless', () => ({
  SessionPackageHeadless: class {
    close = mocks.closeHeadless
    hasActiveTransfer = mocks.headlessActive
  }
}))
vi.mock('../session-package/desktop-composition', () => ({
  createSessionPackageDesktop: () => ({
    close: mocks.closeDesktop,
    hasActiveTransfer: () => false,
    operations: { active: false }
  })
}))
vi.mock('../session-package/inspection-worker', () => ({ createPackageInspector: vi.fn() }))
vi.mock('../session-package/inspection-worker-entry?nodeWorker', () => ({ default: vi.fn() }))
vi.mock('../session-package/quit-guard', () => ({
  installSessionPackageQuitGuard: () => mocks.removeQuitGuard
}))
vi.mock('../session-persistence/conversation-export', () => ({
  createConversationExportService: () => ({}),
  registerConversationExportIpcHandler: vi.fn()
}))
vi.mock('../storage/migration-state', () => ({
  runDataRootStartupRecovery: (operation: () => Promise<unknown>) => operation(),
  withDataRootWrite: (operation: () => Promise<unknown>) => operation(),
  isMigrationInProgress: () => false,
  isMigrationPending: () => false
}))
vi.mock('../storage-root', () => ({
  resolveConfigRoot: () => '/fixture/config',
  resolveDataRoot: () => '/fixture/data'
}))

import { composeSessionPackages, composeSessionPackageSurfaces } from './session-packages'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.closeService.mockResolvedValue(undefined)
  mocks.closeHeadless.mockResolvedValue(undefined)
  mocks.headlessActive.mockReturnValue(false)
  mocks.closeDesktop.mockResolvedValue(undefined)
  mocks.closeBrowser.mockResolvedValue(undefined)
  mocks.recover.mockResolvedValue(undefined)
})

async function setup(): Promise<{ dispose(): Promise<void>; isActive(): boolean }> {
  let dispose!: () => Promise<void>
  const composed = await composeSessionPackages({
    storedSettings: { pathsNormalizedAt: 1 },
    modules: {
      add: async (
        _input: unknown,
        build: () => { capability: unknown; dispose(): Promise<void> }
      ) => {
        const module = build()
        dispose = module.dispose
        return module.capability
      }
    }
  } as unknown as Parameters<typeof composeSessionPackages>[0])
  composeSessionPackageSurfaces({
    ...composed,
    declareElectronAdapter: vi.fn(),
    translate: (text: string) => text
  } as unknown as Parameters<typeof composeSessionPackageSurfaces>[0])
  return { dispose, isActive: () => composed.sessionPackageDesktopLifecycle.isActive() }
}

it('cancels both transfer surfaces and waits for their drain before closing the package service', async () => {
  const { dispose } = await setup()
  let finishHeadless!: () => void
  let finishDesktop!: () => void
  mocks.closeHeadless.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishHeadless = resolve
      })
  )
  mocks.closeDesktop.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishDesktop = resolve
      })
  )
  const closing = dispose()
  // Node transfer disposal does not install or own an Electron quit guard.
  expect(mocks.removeQuitGuard).not.toHaveBeenCalled()
  expect(mocks.closeHeadless).toHaveBeenCalledOnce()
  expect(mocks.closeDesktop).toHaveBeenCalledOnce()
  expect(mocks.closeService).not.toHaveBeenCalled()
  expect(mocks.stopBrowser).toHaveBeenCalledOnce()
  expect(mocks.closeBrowser).not.toHaveBeenCalled()
  finishHeadless()
  await Promise.resolve()
  expect(mocks.closeService).not.toHaveBeenCalled()
  finishDesktop()
  await closing
  expect(mocks.closeBrowser).toHaveBeenCalledOnce()
  expect(mocks.closeService).toHaveBeenCalledOnce()
})

it('drains the other surface after a cleanup failure and retains the backing service for a retry', async () => {
  const { dispose } = await setup()
  mocks.closeHeadless.mockRejectedValueOnce(new Error('Import cleanup is unverified'))
  let finishDesktop!: () => void
  mocks.closeDesktop.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishDesktop = resolve
      })
  )
  let finished = false
  const closing = dispose().finally(() => {
    finished = true
  })
  const rejected = expect(closing).rejects.toThrow(
    'Session package transfers did not finish closing'
  )
  await Promise.resolve()
  expect(finished).toBe(false)
  expect(mocks.closeDesktop).toHaveBeenCalledOnce()
  expect(mocks.closeService).not.toHaveBeenCalled()
  finishDesktop()
  await rejected
  expect(mocks.closeService).not.toHaveBeenCalled()
  await dispose()
  expect(mocks.closeService).toHaveBeenCalledOnce()
})

it('retains browser staging when the desktop queue cannot release its admitted sources', async () => {
  const { dispose } = await setup()
  mocks.closeDesktop.mockRejectedValueOnce(new Error('Queue source is still owned'))
  await expect(dispose()).rejects.toThrow('Session package transfers did not finish closing')
  expect(mocks.closeHeadless).toHaveBeenCalledOnce()
  expect(mocks.stopBrowser).toHaveBeenCalledOnce()
  expect(mocks.closeBrowser).not.toHaveBeenCalled()
  expect(mocks.closeService).not.toHaveBeenCalled()
  await dispose()
  expect(mocks.closeBrowser).toHaveBeenCalledOnce()
  expect(mocks.closeService).toHaveBeenCalledOnce()
})

it('keeps application handoff blocked while a headless package transfer is active', async () => {
  const lifecycle = await setup()
  expect(lifecycle.isActive()).toBe(false)
  mocks.headlessActive.mockReturnValue(true)
  expect(lifecycle.isActive()).toBe(true)
  mocks.headlessActive.mockReturnValue(false)
  expect(lifecycle.isActive()).toBe(false)
  await lifecycle.dispose()
})

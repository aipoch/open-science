import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeService: vi.fn(),
  closeHeadless: vi.fn(),
  closeDesktop: vi.fn(),
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
vi.mock('../session-package/headless', () => ({
  SessionPackageHeadless: class {
    close = mocks.closeHeadless
    hasActiveTransfer = (): boolean => false
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
  mocks.closeDesktop.mockResolvedValue(undefined)
  mocks.recover.mockResolvedValue(undefined)
})

async function setup(): Promise<{ dispose(): Promise<void> }> {
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
  return { dispose }
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
  finishHeadless()
  await Promise.resolve()
  expect(mocks.closeService).not.toHaveBeenCalled()
  finishDesktop()
  await closing
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

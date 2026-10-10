import { beforeEach, expect, it, vi } from 'vitest'

const capture = vi.hoisted(() => ({ strategy: vi.fn(), storage: vi.fn() }))
vi.mock('../update/runtime-strategy', () => ({ createRuntimeUpdateStrategy: capture.strategy }))
vi.mock('../update/command-owner', () => ({
  createUpdateCommandOwner: () => ({}),
  registerUpdateIpcHandlers: vi.fn()
}))
vi.mock('../update/scheduler', () => ({ startUpdateScheduler: vi.fn() }))
vi.mock('../storage/command-owner', () => ({ createStorageCommandOwner: capture.storage }))
vi.mock('../storage/ipc', () => ({ registerStorageIpcHandlers: vi.fn() }))
vi.mock('../storage/migration-state', () => ({
  isMigrationInProgress: () => false,
  isMigrationPending: () => false
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  errorLogFields: vi.fn()
}))

import { composeHandoff, composeStorageHandoff } from './handoff'

type Handoff = Parameters<typeof composeHandoff>[0]
type StorageHandoff = Parameters<typeof composeStorageHandoff>[0]

beforeEach(() => {
  vi.clearAllMocks()
})

async function setup(): Promise<{
  dependencies: Handoff
  composition: Awaited<ReturnType<typeof composeHandoff>>
  managed: {
    quiesce: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    environments: { prepareForDataRootHandoff: ReturnType<typeof vi.fn> }
  }
  order: string[]
  setActive(value: boolean): void
  releaseInstall: ReturnType<typeof vi.fn>
}> {
  const order: string[] = []
  let active = false
  const managed = {
    quiesce: vi.fn(async () => {
      order.push('managed-drained')
      active = false
    }),
    resume: vi.fn(),
    environments: {
      prepareForDataRootHandoff: vi.fn(async () => {
        order.push('environments-released')
      })
    }
  }
  const releaseInstall = vi.fn()
  const dependencies = {
    managedExecution: managed,
    declareElectronAdapter: vi.fn(),
    webSessionPersistenceFlush: { flush: vi.fn(), notifyAborted: vi.fn() },
    settingsService: { hasActiveInstall: () => false, holdInstallAdmission: () => releaseInstall },
    sessionPackageDesktopLifecycle: { close: vi.fn(), isActive: () => false },
    packageHandoffHeld: { current: false },
    getActiveDelegatedSessions: () => [],
    getActiveSideChatSessions: () => [],
    notebookLifecycle: {
      getActiveNotebookSessions: () => (active ? [{ projectId: 'p', sessionId: 's' }] : []),
      shutdownAll: vi.fn(async () => {
        await managed.quiesce()
        order.push('notebook-shutdown')
        return { reaped: true }
      }),
      dispose: vi.fn(async () => {
        await managed.quiesce()
        order.push('notebook-disposed')
        return { reaped: true }
      })
    },
    runtime: {
      getQuitBlockingPromptSessions: () => [],
      getActivePromptSessions: () => [],
      shutdownForQuit: vi.fn(async () => ({ reaped: true })),
      shutdownForUpdateGate: vi.fn(async () => ({ reaped: true }))
    },
    sideChatRuntime: {
      shutdown: vi.fn(async () => ({ reaped: true })),
      suspendAll: vi.fn(async () => ({ reaped: true })),
      resumeAfterHandoff: vi.fn()
    },
    translate: (text: string) => text,
    confirmRendererDurability: vi.fn(async () => {
      order.push('renderer-durable')
      return true
    }),
    notifyRendererDurabilityAborted: vi.fn(),
    modules: { add: async () => undefined }
  } as unknown as Handoff
  return {
    dependencies,
    composition: await composeHandoff(dependencies),
    managed,
    order,
    releaseInstall,
    setActive: (value) => {
      active = value
    }
  }
}

it('requires interruption confirmation, then releases managed environments before data-root handoff', async () => {
  const { composition, managed, order, setActive } = await setup()
  setActive(true)
  await expect(
    composition.durableDataRootHandoffGate({ surface: 'electron-renderer' }, false)
  ).resolves.toMatchObject({ completed: false, blockedBy: ['notebook'] })
  expect(managed.quiesce).not.toHaveBeenCalled()
  await expect(
    composition.durableDataRootHandoffGate({ surface: 'electron-renderer' }, true)
  ).resolves.toMatchObject({ completed: true, reaped: true })
  expect(order).toEqual([
    'managed-drained',
    'environments-released',
    'managed-drained',
    'notebook-shutdown',
    'renderer-durable'
  ])
})

it('aborts a data-root move when cleanup is unverified and reopens admission for a safe retry', async () => {
  const { dependencies, composition, managed, releaseInstall } = await setup()
  managed.environments.prepareForDataRootHandoff.mockRejectedValueOnce(
    new Error('Cleanup unverified')
  )
  composeStorageHandoff({
    ...dependencies,
    resumeManagedExecution: managed.resume,
    reviewerModelRuntimeShutdown: composition.reviewerModelRuntimeShutdown,
    durableDataRootHandoffGate: composition.durableDataRootHandoffGate
  } as unknown as StorageHandoff)
  const storage = capture.storage.mock.calls[0][0] as Parameters<
    typeof import('../storage/command-owner').createStorageCommandOwner
  >[0]
  await expect(
    storage.prepareDataRootHandoff!({ surface: 'electron-renderer' }, false)
  ).rejects.toThrow('Cleanup unverified')
  expect(dependencies.notebookLifecycle.shutdownAll).not.toHaveBeenCalled()
  expect(managed.resume).toHaveBeenCalledOnce()
  expect(releaseInstall).toHaveBeenCalledOnce()
  expect(dependencies.sideChatRuntime.resumeAfterHandoff).toHaveBeenCalledOnce()
})

it('drains managed Notebook work for updates and resumes it when installation is aborted', async () => {
  const { dependencies, managed, order, setActive, releaseInstall } = await setup()
  setActive(true)
  const options = capture.strategy.mock.calls[0][1] as NonNullable<
    Parameters<typeof import('../update/create-strategy').createUpdateStrategy>[1]
  >
  await expect(options.installGate!({ force: true })).resolves.toMatchObject({
    completed: true,
    reaped: true
  })
  expect(order).toEqual(['managed-drained', 'notebook-shutdown', 'renderer-durable'])
  expect(managed.environments.prepareForDataRootHandoff).not.toHaveBeenCalled()
  options.releaseInstallHandoff!()
  expect(managed.resume).toHaveBeenCalledOnce()
  expect(dependencies.packageHandoffHeld.current).toBe(false)
  expect(releaseInstall).toHaveBeenCalledOnce()
})

it('includes the managed Notebook owner in application quit teardown', async () => {
  const { composition, order, dependencies } = await setup()
  await expect(composition.shutdownCoordinator.runForQuit()).resolves.toMatchObject({
    completed: true,
    reaped: true
  })
  expect(order).toEqual(['managed-drained', 'notebook-disposed'])
  expect(dependencies.runtime.shutdownForQuit).toHaveBeenCalledOnce()
})

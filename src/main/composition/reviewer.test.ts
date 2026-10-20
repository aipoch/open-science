import { beforeEach, describe, expect, it, vi } from 'vitest'
import { composeApplicationRuntime } from '../application-runtime'

const mocks = vi.hoisted(() => ({
  shutdown: vi.fn(),
  createOwner: vi.fn(),
  register: vi.fn(),
  preview: vi.fn()
}))
vi.mock('../reviewer/model-runtime-owner', () => ({
  ReviewerModelRuntimeOwner: class {
    shutdown = mocks.shutdown
  }
}))
vi.mock('../reviewer/ipc', () => ({
  createReviewerCommandOwner: mocks.createOwner,
  registerReviewerIpcHandlers: mocks.register
}))
vi.mock('../reviewer/paged-preview-host', () => ({
  createReviewerHostPagedContentResolver: mocks.preview
}))
import { registerReviewerComposition } from './reviewer'

type Dependencies = Parameters<typeof registerReviewerComposition>[1]
const fixture = (): Dependencies => ({
  modelRuntime: { appVersion: 'test', captureModel: vi.fn(), resolveTarget: vi.fn() },
  options: {
    acpRuntime: {} as never,
    sessionReader: { loadSession: vi.fn(), findSessionById: vi.fn() }
  },
  previewResources: {
    acquireResolvedFile: vi.fn(),
    release: vi.fn(),
    inspect: vi.fn(),
    acquire: vi.fn(),
    readRange: vi.fn(),
    releaseOwner: vi.fn()
  },
  runtimeShutdownOwner: { current: undefined },
  declareElectronAdapter: vi.fn()
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.shutdown.mockResolvedValue({ reaped: true })
  mocks.createOwner.mockReturnValue({ run: vi.fn() })
  mocks.preview.mockReturnValue({ read: vi.fn() })
})

describe('Reviewer composition lifecycle', () => {
  it('shares one owner and preview resolver, defers adapter installation and disposes once', async () => {
    const dependencies = fixture()
    const runtime = await composeApplicationRuntime((modules) =>
      registerReviewerComposition(modules, dependencies)
    )
    const runtimeOwner = dependencies.runtimeShutdownOwner.current
    const options = mocks.createOwner.mock.calls[0][0]
    expect(options).toMatchObject({
      ...dependencies.options,
      modelRuntime: runtimeOwner,
      pagedContentResolver: mocks.preview.mock.results[0].value
    })
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(dependencies.previewResources)
    expect(mocks.createOwner).toHaveBeenCalledTimes(1)
    expect(mocks.register).not.toHaveBeenCalled()
    const [name, install] = vi.mocked(dependencies.declareElectronAdapter).mock.calls[0]
    expect(name).toBe('reviewer')
    install()
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(options, runtime.interfaces)
    await runtime.dispose()
    await runtime.dispose()
    expect(mocks.shutdown).toHaveBeenCalledTimes(1)
    expect(dependencies.runtimeShutdownOwner.current).toBeUndefined()
  })

  it('rolls back the model runtime if command owner construction fails', async () => {
    const dependencies = fixture()
    const failure = new Error('command construction failed')
    mocks.createOwner.mockImplementationOnce(() => {
      throw failure
    })
    await expect(
      composeApplicationRuntime((modules) => registerReviewerComposition(modules, dependencies))
    ).rejects.toBe(failure)
    expect(mocks.shutdown).toHaveBeenCalledTimes(1)
    expect(dependencies.runtimeShutdownOwner.current).toBeUndefined()
    expect(dependencies.declareElectronAdapter).not.toHaveBeenCalled()
  })

  it.each([false, 'reject'] as const)(
    'reports shutdown failure (%s) and clears its runtime reference',
    async (outcome) => {
      const dependencies = fixture()
      const runtime = await composeApplicationRuntime((modules) =>
        registerReviewerComposition(modules, dependencies)
      )
      if (outcome === 'reject') mocks.shutdown.mockRejectedValueOnce(new Error('shutdown failed'))
      else mocks.shutdown.mockResolvedValueOnce({ reaped: false })
      await expect(runtime.dispose()).rejects.toThrow()
      expect(dependencies.runtimeShutdownOwner.current).toBeUndefined()
    }
  )
})

vi.mock('../desktop-surface-declarations', () => ({ registerReviewerIpcHandlers: mocks.register }))

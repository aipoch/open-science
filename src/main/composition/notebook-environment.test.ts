import { configureTestRuntimeMetadata } from '../../../test/runtime-metadata'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createProvisioner: vi.fn(),
  mirror: vi.fn(),
  register: vi.fn(),
  progress: vi.fn(),
  error: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', getPath: () => 'home', isPackaged: false }
}))
vi.mock('../logger', () => ({
  createLogger: () => ({ error: mocks.error, info: vi.fn(), warn: vi.fn() }),
  errorLogFields: (error: unknown) => ({ error })
}))
vi.mock('../notebook/runtime-service', () => ({ NotebookRuntimeService: class {} }))
vi.mock('../notebook/provisioner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notebook/provisioner')>()),
  createProductionProvisioner: mocks.createProvisioner
}))
vi.mock('../notebook/mirror-probe', () => ({ effectiveMirrorAsync: mocks.mirror }))
vi.mock('../desktop-surface-declarations', () => ({
  registerNotebookEnvIpcHandlers: mocks.register
}))
vi.mock('../notebook/env-ipc', () => ({
  registerNotebookEnvIpcHandlers: mocks.register,
  broadcastNotebookEnvProgress: mocks.progress
}))

import type { RuntimeProvisioner } from '../notebook/provisioner'
import { initializeDataRootWriteAvailability } from '../storage/migration-state'
import { registerNotebookEnvironmentComposition } from './notebook-environment'

type Dependencies = Parameters<typeof registerNotebookEnvironmentComposition>[0]
const fixture = (): Dependencies => ({
  settingsService: { getPackageMirror: vi.fn().mockResolvedValue({ caBundle: 'corp.pem' }) },
  provisioningRoot: join(tmpdir(), 'notebook-composition-runtime'),
  notebookNetworkSandbox: {
    revokeManagedRAccess: vi.fn()
  } as unknown as Dependencies['notebookNetworkSandbox'],
  micromambaRunner: undefined,
  notebookService: {
    isPrefixRecoveryBlocked: vi.fn().mockReturnValue(false),
    clearRecoveryBlock: vi.fn(),
    clearRuntimeRecoveryBlock: vi.fn(),
    clearCorruptRecoveryBlock: vi.fn(),
    blockPrefixRecovery: vi.fn(),
    isPrefixLiveUnconfirmed: vi.fn().mockReturnValue(false),
    withEnvLock: vi.fn(async (_name, run) => run()),
    recoverInterruptedOperations: vi.fn().mockResolvedValue(undefined),
    ensureRecovered: vi.fn().mockResolvedValue(undefined),
    isDefaultEnvRecoveryBlocked: vi.fn().mockReturnValue(false),
    recoveryStatus: vi.fn(),
    prepareRuntimeRepair: vi.fn(),
    completeRuntimeRepair: vi.fn(),
    setEnvironmentStartupBarrier: vi.fn(),
    setEnvironmentManager: vi.fn(),
    setDefaultEnvProvisioner: vi.fn()
  },
  notebookCommands: { state: vi.fn() },
  notebookRunResultDelivery: { recoverWaiting: vi.fn().mockResolvedValue(undefined) },
  markNotebookResultAuthorityReady: vi.fn(),
  declareElectronAdapter: vi.fn()
})
const provisioner = (): RuntimeProvisioner => ({
  status: () => ({ pythonReady: true, rReady: true, version: 0, provisioning: false }),
  provisionPython: vi.fn().mockResolvedValue(undefined),
  provisionR: vi.fn().mockResolvedValue(undefined),
  upgradeIfNeeded: vi.fn().mockResolvedValue(undefined),
  repair: vi.fn().mockResolvedValue(undefined),
  restoreRelocatedEnvs: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn()
})
const install = (deps: Dependencies): void => {
  const [name, register] = vi.mocked(deps.declareElectronAdapter).mock.calls[0]
  expect(name).toBe('notebook-environment')
  register()
}

beforeEach(() => {
  vi.resetAllMocks()
  initializeDataRootWriteAvailability(false)
  mocks.mirror.mockResolvedValue({ condaChannel: 'https://mirror.example/conda' })
  mocks.createProvisioner.mockReturnValue(provisioner())
})

describe('Notebook environment composition', () => {
  it('registers before maintenance, waits for recovery and keeps mirror probing off startup', async () => {
    const deps = fixture()
    const raw = provisioner()
    mocks.createProvisioner.mockReturnValue(raw)
    const recovery = Promise.withResolvers<void>()
    vi.mocked(deps.notebookService.recoverInterruptedOperations).mockReturnValue(recovery.promise)
    vi.mocked(deps.notebookService.ensureRecovered).mockReturnValue(recovery.promise)
    const mirror = Promise.withResolvers<{ condaChannel: string }>()
    mocks.mirror.mockReturnValue(mirror.promise)
    const lifecycle = await registerNotebookEnvironmentComposition(deps)
    expect(deps.notebookService.recoverInterruptedOperations).toHaveBeenCalledTimes(1)
    expect(mocks.register).not.toHaveBeenCalled()
    expect(raw.restoreRelocatedEnvs).not.toHaveBeenCalled()
    install(deps)
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(lifecycle)
    expect(raw.restoreRelocatedEnvs).not.toHaveBeenCalled()
    recovery.resolve()
    const startup = vi.mocked(deps.notebookService.setEnvironmentStartupBarrier).mock.calls[0][0]
    await startup
    expect(raw.restoreRelocatedEnvs).toHaveBeenCalledTimes(1)
    expect(deps.markNotebookResultAuthorityReady).toHaveBeenCalledTimes(1)
    expect(deps.notebookService.setEnvironmentManager).toHaveBeenCalledExactlyOnceWith(raw)
    const options = mocks.createProvisioner.mock.calls[0][0]
    expect(options.caBundle).toBe('corp.pem')
    mirror.resolve({ condaChannel: 'https://mirror.example/conda' })
    await expect(options.channel()).resolves.toBe('https://mirror.example/conda')
  })

  it('serializes UI and service provisioning through the same queue and retains recovery guards', async () => {
    const deps = fixture()
    const raw = provisioner()
    const pending = Promise.withResolvers<void>()
    vi.mocked(raw.provisionPython).mockReturnValue(pending.promise)
    mocks.createProvisioner.mockReturnValue(raw)
    const lifecycle = await registerNotebookEnvironmentComposition(deps)
    const [shared] = vi.mocked(deps.notebookService.setDefaultEnvProvisioner).mock.calls[0]
    const serviceProvision = shared.provisionPython(() => undefined)
    await vi.waitFor(() => expect(raw.provisionPython).toHaveBeenCalledTimes(1))
    const uiProvision = lifecycle.provision('r')
    await vi.waitFor(() =>
      expect(deps.notebookService.isDefaultEnvRecoveryBlocked).toHaveBeenCalledWith('r')
    )
    expect(raw.provisionR).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.all([serviceProvision, uiProvision])
    expect(raw.provisionR).toHaveBeenCalledTimes(1)
    vi.mocked(deps.notebookService.isDefaultEnvRecoveryBlocked).mockReturnValue(true)
    await expect(lifecycle.provision('python')).rejects.toThrow('RUNTIME_RECOVERY_BLOCKED')
    expect(raw.provisionPython).toHaveBeenCalledTimes(1)
  })

  it('keeps unavailable handlers and releases result authority when recovery fails', async () => {
    const deps = fixture()
    mocks.createProvisioner.mockImplementation(() => {
      throw new Error('missing micromamba')
    })
    vi.mocked(deps.notebookService.recoverInterruptedOperations).mockRejectedValue(
      new Error('recovery failed')
    )
    const lifecycle = await registerNotebookEnvironmentComposition(deps)
    install(deps)
    expect(mocks.register).toHaveBeenCalledExactlyOnceWith(lifecycle)
    expect(deps.notebookService.setEnvironmentManager).not.toHaveBeenCalled()
    expect(deps.notebookService.setDefaultEnvProvisioner).not.toHaveBeenCalled()
    await expect(lifecycle.status()).resolves.toMatchObject({ pythonReady: false, rReady: false })
    await expect(lifecycle.provision('python')).rejects.toThrow('micromamba was not found')
    expect(mocks.progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'error' }))
    expect(deps.markNotebookResultAuthorityReady).toHaveBeenCalledTimes(1)
    expect(deps.notebookRunResultDelivery.recoverWaiting).not.toHaveBeenCalled()
    expect(mocks.error).toHaveBeenCalledWith('operation recovery failed', expect.anything())
  })

  it('recovers waiting results in the original project/session and marks authority ready afterwards', async () => {
    const deps = fixture()
    const request = { projectId: 'project', sessionId: 'session', runId: 'run' }
    const run = { runId: 'run' }
    vi.mocked(deps.notebookCommands.state).mockResolvedValue({
      runs: [{ runId: 'other' }, run]
    } as never)
    vi.mocked(deps.notebookRunResultDelivery.recoverWaiting).mockImplementation(async (loadRun) => {
      expect(deps.markNotebookResultAuthorityReady).not.toHaveBeenCalled()
      expect(await loadRun(request)).toBe(run)
    })
    await registerNotebookEnvironmentComposition(deps)
    await vi.waitFor(() => expect(deps.markNotebookResultAuthorityReady).toHaveBeenCalledTimes(1))
    expect(deps.notebookCommands.state).toHaveBeenCalledExactlyOnceWith({
      projectId: request.projectId,
      sessionId: request.sessionId,
      workspaceCwd: '',
      runIds: ['run']
    })
  })
})

configureTestRuntimeMetadata()

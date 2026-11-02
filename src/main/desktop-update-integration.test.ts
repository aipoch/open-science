import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeStopError } from './runtime-stop-confirmation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import { UpdateLifecycleError, type UpdateStatus } from '../shared/update'
import type { InstallationUpdateRecord } from './update/installation-protection'
const state = vi.hoisted(() => ({
  record: undefined as InstallationUpdateRecord | undefined,
  begin: vi.fn(),
  reboot: vi.fn(),
  advance: vi.fn(),
  finish: vi.fn(),
  check: vi.fn(),
  availability: vi.fn(),
  rootForEntry: vi.fn(),
  control: 'granted' as 'granted' | 'held',
  exitOutcome: vi.fn(async () => 'clean'),
  alive: vi.fn(() => false)
}))
vi.mock('electron', () => ({}))
vi.mock('./update/installation-reboot-recovery', () => ({
  recoverInstallationAfterSystemRestart: state.reboot
}))
vi.mock('./update/installation-protection', () => ({
  inspectInstallationUpdate: () => state.record,
  inspectInstallationAvailability: state.availability,
  installationRootForEntry: () => state.rootForEntry(),
  installationRecoveryStatus: (record: InstallationUpdateRecord) => ({
    phase: record.phase,
    runtime: record.stoppedClean ? 'stopped-clean' : 'running',
    canCancel: record.phase !== 'handoff'
  }),
  beginInstallationUpdateAsync: state.begin,
  advanceInstallationUpdate: state.advance,
  advanceInstallationUpdateAsync: state.advance,
  finishInstallationRecoveryAsync: state.finish,
  completeInstallationStartupAsync: vi.fn(),
  checkInstallationResultAsync: state.check
}))
vi.mock('./runtime-stop-confirmation', async (original) => ({
  ...(await original<typeof import('./runtime-stop-confirmation')>()),
  isRuntimeProcessAlive: state.alive,
  readRuntimeExitOutcome: state.exitOutcome
}))
import { createDesktopUpdateIntegration } from './desktop-update-integration'
const config = {
  configRoot: join(tmpdir(), 'config'),
  dataRoot: join(tmpdir(), 'data'),
  profilePath: join(tmpdir(), 'profile'),
  host: '127.0.0.1' as const,
  port: 44100,
  credentialStore: 'os' as const
}
const base = {
  operationId: 'op',
  phase: 'preparing',
  startupOptions: config,
  runtime: { pid: 123, generation: 'gen', configRoot: config.configRoot }
} as InstallationUpdateRecord
function setup(
  launch: 'desktop' | 'cli' = 'desktop',
  verifyInstallerReady?: () => Promise<void>,
  legacyInstall?: (status: UpdateStatus) => boolean,
  preparation: Partial<
    Pick<
      Parameters<typeof createDesktopUpdateIntegration>[0],
      | 'flushRenderer'
      | 'allowedProcessIds'
      | 'closeOtherInstances'
      | 'forceStopRuntime'
      | 'installationOperation'
    >
  > = {}
): {
  setClosing: ReturnType<typeof vi.fn>
  verifyArtifact: ReturnType<typeof vi.fn>
  onHandoff: ReturnType<typeof vi.fn>
  hooks: ReturnType<typeof createDesktopUpdateIntegration>
  invoke: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
  retainLease: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  reconnect: ReturnType<typeof vi.fn>
  progress: ReturnType<typeof vi.fn>
} {
  const invoke = vi.fn().mockResolvedValue({ completed: true, reaped: true })
  const stop = vi.fn().mockResolvedValue({ release: vi.fn() })
  const refresh = vi.fn(async () => ({
    launch,
    control: state.control,
    generation: 'gen',
    entryPath: join(tmpdir(), 'entry'),
    startupOptions: config
  }))
  const reconnect = vi.fn().mockResolvedValue(undefined)
  const progress = vi.fn()
  const client = {
    refreshControl: refresh,
    runtimeInfo: () => ({
      launch,
      control: state.control,
      generation: 'gen',
      entryPath: join(tmpdir(), 'entry'),
      startupOptions: config
    }),
    processId: () => 123,
    invokeHost: invoke,
    waitForStopped: stop,
    stopRuntime: stop
  } as unknown as DesktopRuntimeClient
  const restart = vi.fn().mockResolvedValue(undefined)
  const retainLease = vi.fn()
  const setClosing = vi.fn()
  const verifyArtifact = vi.fn().mockResolvedValue({ version: '2', files: {} })
  const onHandoff = vi.fn()
  const hooks = createDesktopUpdateIntegration({
    location: { installationRoot: tmpdir() },
    client: () => client,
    currentVersion: '1',
    allowedProcessIds: () => [],
    ...preparation,
    verifyInstallerReady,
    verifyArtifact,
    ...(legacyInstall ? { legacyInstall } : {}),
    validateConfiguration: vi.fn(),
    setClosing,
    retainLease,
    restart,
    reconnectOriginal: reconnect,
    onProgress: progress,
    onHandoff,
    onStopped: vi.fn()
  })
  return {
    hooks,
    invoke,
    stop,
    restart,
    retainLease,
    refresh,
    reconnect,
    progress,
    setClosing,
    verifyArtifact,
    onHandoff
  }
}
const status = { state: 'ready' as const, current: '1', latest: '2' }
beforeEach(() => {
  vi.clearAllMocks()
  state.record = undefined
  state.rootForEntry.mockReturnValue(tmpdir())
  state.control = 'granted'
  state.reboot.mockResolvedValue(undefined)
  state.alive.mockReturnValue(false)
  state.availability.mockResolvedValue(undefined)
  state.begin.mockImplementation(async () => (state.record = { ...base }))
  state.advance.mockImplementation(
    (_location, _id, phase, stoppedClean, runtimeExited) =>
      (state.record = { ...state.record!, phase, stoppedClean, runtimeExited })
  )
  state.check.mockResolvedValue('unchanged')
  state.finish.mockReturnValue(config)
})
describe('Desktop installation orchestration', () => {
  it('restarts through the readiness path after reboot recovery without claiming clean shutdown', async () => {
    state.record = { ...base, phase: 'stopping', stoppedClean: false }
    state.reboot.mockResolvedValue({ intent: 'cancel', startupOptions: config })
    const { hooks, stop, restart } = setup()
    expect((await hooks.recoverInstall!()).outcome).toBe('recovered')
    expect(state.reboot).toHaveBeenCalledWith({ installationRoot: tmpdir() }, 'op', {
      version: '1',
      allowedProcessIds: expect.any(Function)
    })
    expect(stop).not.toHaveBeenCalled()
    expect(state.advance).not.toHaveBeenCalled()
    expect(restart).toHaveBeenCalledWith(config)
  })
  it('rejects a dead authorized package gate before asking the Runtime to stop', async () => {
    const check = vi.fn().mockRejectedValue(new Error('authorized gate died'))
    const { hooks, invoke, stop } = setup('desktop', check)
    await hooks.prepareInstall!(status, {})
    await expect(hooks.installGate!({})).rejects.toThrow('authorized gate died')
    expect(check).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('uses the existing update consent for a CLI Runtime from this installation', async () => {
    const { hooks, stop } = setup('cli')
    const offer = await hooks.prepareInstall!(status, {})
    expect(offer?.cliConfirmation).toBeUndefined()
    expect(state.begin).toHaveBeenCalledWith(
      expect.objectContaining({ startupOptions: config }),
      expect.any(AbortSignal)
    )
    await hooks.installGate!({})
    expect(stop).toHaveBeenCalledOnce()
  })
  it('never stops a connected Runtime belonging to another installation', async () => {
    const { hooks, stop } = setup('cli')
    state.rootForEntry.mockReturnValue(process.cwd())
    await expect(hooks.prepareInstall!(status, {})).rejects.toMatchObject({
      reason: 'runtime-configuration-unsupported'
    })
    expect(state.begin).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('retains the stop lease and retries stopped-clean installation without a dead task gate', async () => {
    const { hooks, invoke, stop, retainLease } = setup()
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({ force: true })
    expect(invoke).toHaveBeenCalledWith('desktop:update-gate', [
      { force: true, shutdownDeadlineAt: expect.any(Number) }
    ])
    expect(retainLease).toHaveBeenCalledOnce()
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    await hooks.beforeInstallHandoff!(status)
    expect(state.record?.phase).toBe('handoff')
  })
  it('cancel after clean stop verifies the old installation and restarts before reporting success', async () => {
    const { hooks, restart, invoke } = setup()
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    const result = await hooks.cancelInstall!()
    expect(state.finish).toHaveBeenCalledWith({ installationRoot: tmpdir() }, 'op', 'cancel')
    expect(restart).toHaveBeenCalledWith(config)
    expect(invoke).not.toHaveBeenCalledWith('desktop:update-abort')
    expect(result.outcome).toBe('cancelled')
  })
  it('refuses cancel or repeated installation after handoff and only checks result', async () => {
    state.record = { ...base, phase: 'handoff', stoppedClean: true }
    state.check.mockResolvedValue('incomplete')
    const { hooks, stop } = setup()
    expect((await hooks.prepareInstall!(status, {}))?.reason).toBe('install-failed')
    await hooks.cancelInstall!()
    await hooks.recheckInstall!()
    expect(state.finish).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('leaves protection in place if an exclusive installation operation refuses and cancels through the live abort', async () => {
    const { hooks, invoke, stop } = setup()
    invoke.mockResolvedValueOnce({ completed: false, reaped: false, reason: 'installation-busy' })
    await hooks.prepareInstall!(status, {})
    expect(await hooks.installGate!({})).toMatchObject({ reason: 'installation-busy' })
    expect(stop).not.toHaveBeenCalled()
    await hooks.cancelInstall!()
    expect(invoke).toHaveBeenLastCalledWith('desktop:update-abort')
  })
  it('serializes cancellation against pending preparation', async () => {
    const { hooks } = setup()
    let done!: () => void
    state.begin.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = () => resolve((state.record = { ...base }))
        })
    )
    const apply = hooks.prepareInstall!(status, {})
    await vi.waitFor(() => expect(done).toBeTypeOf('function'))
    const cancelled = hooks.cancelInstall!()
    done()
    await apply
    expect((await cancelled).outcome).toBe('cancelled')
    expect(state.finish).toHaveBeenCalled()
  })
  it('waits for an in-flight stop before cancellation restores the app', async () => {
    const { hooks, stop, restart } = setup()
    await hooks.prepareInstall!(status, {})
    let finishStop!: () => void
    stop.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishStop = () => resolve({ release: vi.fn() })
        })
    )
    const gate = hooks.installGate!({})
    await vi.waitFor(() => expect(finishStop).toBeTypeOf('function'))
    const cancelled = hooks.cancelInstall!()
    expect(restart).not.toHaveBeenCalled()
    finishStop()
    await gate
    await expect(hooks.beforeInstallHandoff!(status)).rejects.toThrow('cancelled')
    expect((await cancelled).outcome).toBe('cancelled')
    expect(restart).toHaveBeenCalledOnce()
  })
  it('reconfirms a stop that timed out instead of leaving recovery permanently blocked', async () => {
    state.record = { ...base, phase: 'stopping' }
    const { hooks, stop, restart } = setup()
    const result = await hooks.recoverInstall!()
    expect(stop).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
    expect(result.outcome).toBe('recovered')
  })
  it('retains confirmed configuration after a restart/readability failure for recovery retry', async () => {
    state.record = { ...base, phase: 'stopped', stoppedClean: true }
    const { hooks, restart } = setup()
    restart.mockRejectedValueOnce(new Error('data not readable'))
    await expect(hooks.cancelInstall!()).rejects.toThrow('original data is not ready')
    expect((await hooks.prepareInstall!(status, {}))?.recovery?.canRetryInstall).toBe(false)
    expect((await hooks.recoverInstall!()).outcome).toBe('cancelled')
    expect(restart).toHaveBeenNthCalledWith(2, config)
  })
  it('rechecks actual control, occupancy and live blockers without running the teardown gate', async () => {
    const { hooks, refresh, invoke } = setup()
    invoke.mockResolvedValueOnce({
      blockedBy: ['agent'],
      canForce: true,
      completed: false,
      reaped: false
    })
    expect(await hooks.recheckInstall!()).toMatchObject({ reason: 'active-work', canForce: true })
    expect(refresh).toHaveBeenCalledOnce()
    expect(state.availability).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('desktop:update-inspect')
    expect(invoke).not.toHaveBeenCalledWith('desktop:update-gate', expect.anything())
    invoke.mockResolvedValueOnce({ blockedBy: [], completed: true, reaped: false })
    expect(await hooks.recheckInstall!()).toMatchObject({
      reason: undefined,
      error: undefined,
      recovery: { canRetryInstall: true }
    })
  })
  it('does not let a late recheck overwrite a cancellation', async () => {
    const { hooks, refresh, invoke } = setup()
    let finish!: () => void
    refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ control: 'granted', startupOptions: config })
        })
    )
    const checked = hooks.recheckInstall!().catch((error) => error)
    const cancelled = hooks.cancelInstall!()
    finish()
    expect(await checked).toBeInstanceOf(Error)
    expect((await cancelled).outcome).toBe('cancelled')
    expect(invoke).not.toHaveBeenCalled()
  })
  it('cancels an unanswered readonly host check without waiting for its response', async () => {
    const { hooks, invoke } = setup()
    invoke.mockImplementationOnce(() => new Promise(() => {}))
    const checked = hooks.recheckInstall!().catch((error) => error)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('desktop:update-inspect'))
    expect((await hooks.cancelInstall!()).outcome).toBe('cancelled')
    expect(await checked).toBeInstanceOf(Error)
  })
  it('reconnects a live original identity and aborts its settled gate without launching another writer', async () => {
    state.record = { ...base, phase: 'stopping' }
    state.alive.mockReturnValue(true)
    const { hooks, reconnect, invoke, restart, stop } = setup()
    expect((await hooks.recoverInstall!()).outcome).toBe('recovered')
    expect(reconnect).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('desktop:update-abort')
    expect(restart).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })
  it('preserves failed-exit evidence and actionable external recovery guidance without guessing residual work is safe', async () => {
    state.record = { ...base, phase: 'stopping' }
    const { hooks, stop, restart, progress } = setup()
    const evidence = { processExited: true, lockHeld: false, exitRecord: 'failed' as const }
    stop.mockRejectedValueOnce(new RuntimeStopError('runtime-stop-unclean', evidence))
    await expect(hooks.recoverInstall!()).rejects.toThrow('directory ownership')
    expect(progress).toHaveBeenCalledWith({
      diagnostics: expect.stringContaining('"exitRecord": "failed"')
    })
    expect(restart).not.toHaveBeenCalled()
    expect(state.finish).not.toHaveBeenCalled()
  })
  it('can recheck a delayed clean exit into a retryable stopped state', async () => {
    state.record = { ...base, phase: 'stopping' }
    const { hooks, stop } = setup()
    expect(await hooks.recheckInstall!()).toMatchObject({
      reason: undefined,
      recovery: { phase: 'stopped' }
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(state.record?.stoppedClean).toBe(true)
  })
  it('accepts proven exit and directory release without inventing a clean receipt', async () => {
    state.record = { ...base, phase: 'stopping' }
    state.exitOutcome.mockResolvedValueOnce('failed')
    const { hooks, stop } = setup()
    expect(await hooks.recheckInstall!()).toMatchObject({
      reason: undefined,
      recovery: { phase: 'stopped' }
    })
    expect(stop).toHaveBeenCalledWith(undefined, false)
    expect(state.record?.stoppedClean).toBe(false)
    expect(state.record?.runtimeExited).toBe(true)
  })
  it('recovers a verified rollback through the core terminal-proof check', async () => {
    state.record = { ...base, phase: 'handoff', stoppedClean: true }
    const { hooks, restart } = setup()
    expect((await hooks.recoverInstall!()).outcome).toBe('recovered')
    expect(state.finish).toHaveBeenCalledWith(expect.anything(), 'op', 'cancel')
    expect(restart).toHaveBeenCalledWith(config)
  })
})

describe('supervised install admission release', () => {
  it('records a failed graceful close RPC and continues the verified runtime stop', async () => {
    const { hooks, invoke, stop, progress } = setup()
    invoke.mockRejectedValueOnce(
      Object.assign(new Error('Another Desktop controls this Runtime'), {
        code: 'command-unavailable'
      })
    )
    await hooks.prepareInstall!(status, {})
    await expect(hooks.installGate!({})).resolves.toMatchObject({ runtimeStopped: true })
    expect(stop).toHaveBeenCalledOnce()
    expect(progress).toHaveBeenCalledWith({ diagnostics: expect.stringContaining('failed') })
  })

  it('releases admission when the supervised stop is not confirmed', async () => {
    const { hooks, stop, setClosing } = setup()
    stop.mockRejectedValue(new RuntimeStopError('runtime-stop-timeout', {} as never))
    await hooks.prepareInstall!(status, {})
    await expect(hooks.installGate!({})).rejects.toMatchObject({ reason: 'runtime-stop-timeout' })
    expect(setClosing).toHaveBeenLastCalledWith(false)
  })

  it('releases admission when the supervised handoff release cannot abort the gate', async () => {
    const { hooks, invoke, setClosing, progress } = setup()
    invoke.mockResolvedValueOnce({ completed: false, reaped: false, reason: 'installation-busy' })
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    invoke.mockRejectedValue(new Error('abort unavailable'))
    setClosing.mockClear()
    hooks.releaseInstallHandoff!()
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    expect(setClosing).toHaveBeenLastCalledWith(false)
  })
})

describe('legacy install for uncertified channels', () => {
  const legacy = (): true => true
  it('stops and confirms the runtime without a supervised record or artifact verification', async () => {
    const { hooks, invoke, stop, retainLease, verifyArtifact, onHandoff } = setup(
      'desktop',
      undefined,
      legacy
    )
    expect(await hooks.prepareInstall!(status, {})).toBeUndefined()
    expect(state.availability).not.toHaveBeenCalled()
    expect(await hooks.installGate!({})).toMatchObject({ completed: true, reaped: true })
    await hooks.beforeInstallHandoff!(status)
    expect(invoke).toHaveBeenCalledWith('desktop:update-gate', [
      { shutdownDeadlineAt: expect.any(Number) }
    ])
    expect(stop).toHaveBeenCalledTimes(1)
    expect(retainLease).toHaveBeenCalledTimes(1)
    expect(onHandoff).toHaveBeenCalledTimes(1)
    expect(verifyArtifact).not.toHaveBeenCalled()
    expect(state.begin).not.toHaveBeenCalled()
  })

  it('aborts an unconfirmed stop and releases admission', async () => {
    const { hooks, invoke, stop, setClosing } = setup('desktop', undefined, legacy)
    stop.mockRejectedValue(new RuntimeStopError('runtime-stop-timeout', {} as never))
    await hooks.prepareInstall!(status, {})
    await expect(hooks.installGate!({})).rejects.toMatchObject({ reason: 'runtime-stop-timeout' })
    expect(invoke).toHaveBeenCalledWith('desktop:update-abort')
    expect(setClosing).toHaveBeenLastCalledWith(false)
  })

  it('releases admission when an exclusive installation operation refuses', async () => {
    const { hooks, invoke, setClosing, stop } = setup('desktop', undefined, legacy)
    invoke.mockResolvedValue({ completed: false, reaped: false, reason: 'installation-busy' })
    await hooks.prepareInstall!(status, {})
    expect(await hooks.installGate!({})).toMatchObject({
      completed: false,
      reason: 'installation-busy'
    })
    expect(setClosing).toHaveBeenLastCalledWith(false)
    expect(stop).not.toHaveBeenCalled()
  })

  it('lets the current owner release its workloads before checking installation occupancy', async () => {
    const { hooks, invoke, stop } = setup('desktop', undefined, legacy)
    state.availability.mockImplementation(async () => {
      if (!stop.mock.calls.length) throw new Error('other-runtime: current Notebook workload')
    })
    await hooks.prepareInstall!(status, {})
    expect(state.availability).not.toHaveBeenCalled()
    await hooks.installGate!({})
    await hooks.beforeInstallHandoff!(status)
    expect(invoke).toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
    expect(state.availability).toHaveBeenCalledOnce()
  })

  it.each(['other-runtime', 'occupancy-unknown'] as const)(
    'blocks %s after service exit and retries without contacting the stopped host',
    async (detail) => {
      const metrics = vi.fn(() => [process.pid, 789])
      const flushRenderer = vi.fn(async () => {})
      const { hooks, invoke, stop, refresh, onHandoff } = setup('desktop', undefined, legacy, {
        allowedProcessIds: metrics,
        flushRenderer
      })
      invoke.mockResolvedValue({ completed: false, reaped: false, stopAuthorized: true })
      await hooks.prepareInstall!(status, {})
      expect(await hooks.installGate!({})).toMatchObject({ runtimeStopped: true, reaped: false })
      const busy = new UpdateLifecycleError(
        'installation-busy',
        'Another process is using this installation.',
        {
          phase: 'preparing',
          runtime: 'running',
          installation: 'unchanged',
          canCancel: true,
          canRecover: false,
          canRetryInstall: false,
          detail
        }
      )
      state.availability.mockRejectedValue(busy)
      await expect(hooks.beforeInstallHandoff!(status)).rejects.toMatchObject({
        reason: 'installation-busy',
        recovery: { runtime: 'stopped-unclean', canRecover: true, canRetryInstall: false, detail }
      })
      expect(onHandoff).not.toHaveBeenCalled()
      expect(await hooks.recheckInstall!()).toMatchObject({
        reason: 'installation-busy',
        canForce: undefined,
        recovery: { runtime: 'stopped-unclean', canRecover: true, canRetryInstall: false, detail }
      })
      await expect(hooks.prepareInstall!(status, { force: true })).rejects.toMatchObject({
        reason: 'installation-busy'
      })
      expect(refresh).not.toHaveBeenCalled()
      expect(invoke).toHaveBeenCalledTimes(1)
      state.availability.mockImplementation(async (options) => {
        expect(options).not.toHaveProperty('runtime')
        expect(options.allowedProcessIds).toBe(metrics)
        expect(options.allowedProcessIds()).toEqual([process.pid, 789])
      })
      expect(await hooks.recheckInstall!()).toMatchObject({
        reason: undefined,
        recovery: { runtime: 'stopped-unclean', canRetryInstall: true }
      })
      await hooks.prepareInstall!(status, {})
      expect(await hooks.installGate!({})).toMatchObject({ runtimeStopped: true, reaped: false })
      await hooks.beforeInstallHandoff!(status)
      expect(onHandoff).toHaveBeenCalledOnce()
      expect(stop).toHaveBeenCalledOnce()
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(flushRenderer).toHaveBeenCalledTimes(2)
      expect(refresh).not.toHaveBeenCalled()
    }
  )

  it('restores the runtime through strategy handoff release and refuses retries while restoration is pending', async () => {
    const { hooks, invoke, stop, restart, onHandoff, setClosing } = setup(
      'desktop',
      undefined,
      legacy
    )
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    state.availability.mockRejectedValue(new UpdateLifecycleError('installation-busy', 'occupied'))
    await expect(hooks.beforeInstallHandoff!(status)).rejects.toMatchObject({
      reason: 'installation-busy'
    })
    let restored!: () => void
    restart.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          restored = resolve
        })
    )
    hooks.releaseInstallHandoff!()
    await vi.waitFor(() => expect(restart).toHaveBeenCalledWith(config))
    await expect(hooks.prepareInstall!(status, {})).rejects.toMatchObject({
      reason: 'installation-busy'
    })
    restored()
    await vi.waitFor(() => expect(setClosing).toHaveBeenLastCalledWith(false))
    state.availability.mockResolvedValue(undefined)
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    await hooks.beforeInstallHandoff!(status)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(onHandoff).toHaveBeenCalledOnce()
  })

  it.each(['cancelInstall', 'recoverInstall'] as const)(
    'keeps stopped configuration available for %s after a busy handoff',
    async (action) => {
      const { hooks, invoke, restart, onHandoff } = setup('desktop', undefined, legacy)
      await hooks.prepareInstall!(status, {})
      await hooks.installGate!({})
      state.availability.mockRejectedValue(
        new UpdateLifecycleError('installation-busy', 'occupied')
      )
      await expect(hooks.beforeInstallHandoff!(status)).rejects.toMatchObject({
        reason: 'installation-busy'
      })
      expect(await hooks[action]!()).toMatchObject({ outcome: 'cancelled' })
      expect(restart).toHaveBeenCalledWith(config)
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(onHandoff).not.toHaveBeenCalled()
    }
  )

  it('reports a failed runtime restoration after the strategy releases a blocked legacy handoff', async () => {
    const { hooks, restart, progress, onHandoff, setClosing } = setup('desktop', undefined, legacy)
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    state.availability.mockRejectedValue(new UpdateLifecycleError('installation-busy', 'occupied'))
    await expect(hooks.beforeInstallHandoff!(status)).rejects.toMatchObject({
      reason: 'installation-busy'
    })
    restart.mockRejectedValue(new Error('restore failed'))
    hooks.releaseInstallHandoff!()
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'runtime-not-controlled', error: 'restore failed' })
      )
    )
    expect(setClosing).toHaveBeenLastCalledWith(false)
    expect(onHandoff).not.toHaveBeenCalled()
  })

  it('restarts the runtime and releases admission when the installer cannot start', async () => {
    const { hooks, restart, setClosing } = setup('desktop', undefined, legacy)
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({})
    hooks.releaseInstallHandoff!()
    await vi.waitFor(() => expect(restart).toHaveBeenCalledWith(config))
    expect(setClosing).toHaveBeenLastCalledWith(false)
  })

  it('releases admission when the legacy handoff release cannot abort the gate', async () => {
    const { hooks, invoke, stop, setClosing, progress } = setup('desktop', undefined, legacy)
    await hooks.prepareInstall!(status, {})
    stop.mockRejectedValueOnce(new RuntimeStopError('runtime-stop-timeout', {} as never))
    await expect(hooks.installGate!({})).rejects.toThrow()
    invoke.mockRejectedValue(new Error('abort unavailable'))
    setClosing.mockClear()
    hooks.releaseInstallHandoff!()
    await vi.waitFor(() => expect(progress).toHaveBeenCalled())
    expect(setClosing).toHaveBeenLastCalledWith(false)
  })

  it('keeps the supervised path when the channel is certified', async () => {
    const { hooks, verifyArtifact } = setup('desktop', undefined, () => false)
    await hooks.prepareInstall!(status, {})
    expect(verifyArtifact).toHaveBeenCalled()
    expect(state.begin).toHaveBeenCalled()
  })
})

// Both native installers and the supervised executor must save before stopping Node.
it.each([true, false])('saves before stopping the runtime (legacy=%s)', async (legacy) => {
  const order: string[] = []
  const flushRenderer = vi.fn(async (phase: string) => {
    order.push(phase)
  })
  const h = setup('desktop', undefined, () => legacy, { flushRenderer })
  h.invoke.mockImplementation(async () => {
    order.push('drain')
    return { completed: true, reaped: true }
  })
  h.stop.mockImplementation(async () => {
    order.push('stop')
    return { release: vi.fn() }
  })
  await h.hooks.prepareInstall!(status, {})
  await h.hooks.installGate!({})
  expect(order).toEqual(['preflight', 'drain', 'final', 'stop'])
  await h.hooks.beforeInstallHandoff!(status)
  if (legacy)
    expect(h.progress).toHaveBeenLastCalledWith({
      recovery: expect.objectContaining({
        phase: 'handoff',
        runtime: 'stopped-unclean',
        canCancel: false
      })
    })
})

it.each([true, false])(
  'records renderer save failures but still stops the verified runtime (legacy=%s)',
  async (legacy) => {
    for (const failedPhase of ['preflight', 'final']) {
      state.record = undefined
      const h = setup('desktop', undefined, () => legacy, {
        flushRenderer: async (phase) => {
          if (phase === failedPhase) throw new Error('save failed')
        }
      })
      await h.hooks.prepareInstall!(status, {})
      await expect(h.hooks.installGate!({})).resolves.toMatchObject({ runtimeStopped: true })
      expect(h.stop).toHaveBeenCalledOnce()
      expect(h.progress).toHaveBeenCalledWith({
        diagnostics: expect.stringContaining(`"step": "renderer-${failedPhase}"`)
      })
      await h.hooks.beforeInstallHandoff!(status)
      expect(h.onHandoff).toHaveBeenCalledOnce()
    }
  }
)

it.each([true, false])(
  'bounds a hung renderer flush and shares one deadline with the backend and runtime stop (legacy=%s)',
  async (legacy) => {
    vi.useFakeTimers()
    try {
      const h = setup('desktop', undefined, () => legacy, {
        flushRenderer: async () => new Promise<void>(() => {})
      })
      await h.hooks.prepareInstall!(status, {})
      const started = Date.now()
      const installing = h.hooks.installGate!({})
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(installing).resolves.toMatchObject({ runtimeStopped: true })
      const gateOptions = h.invoke.mock.calls.find(
        ([name]) => name === 'desktop:update-gate'
      )![1][0]
      expect(gateOptions.shutdownDeadlineAt).toBe(started + 20_000)
      expect(h.stop).toHaveBeenCalledWith('update', {
        deadlineAt: started + 20_000,
        requireCleanExit: false
      })
      expect(h.progress).toHaveBeenCalledWith({ diagnostics: expect.stringContaining('timeout') })
    } finally {
      vi.useRealTimers()
    }
  }
)

it.each([true, false])(
  'settles an initiated stop before cancellation can restore admission (legacy=%s)',
  async (legacy) => {
    const h = setup('desktop', undefined, () => legacy)
    let finishGate!: () => void
    h.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishGate = () => resolve({ completed: false, reaped: false, stopAuthorized: true })
        })
    )
    await h.hooks.prepareInstall!(status, {})
    const installing = h.hooks.installGate!({})
    await vi.waitFor(() => expect(finishGate).toBeTypeOf('function'))
    const cancelling = h.hooks.cancelInstall!()
    expect(h.restart).not.toHaveBeenCalled()
    expect(h.setClosing).not.toHaveBeenCalledWith(false)
    finishGate()
    await installing
    await cancelling
    expect(h.stop).toHaveBeenCalledOnce()
    expect(h.restart).toHaveBeenCalledOnce()
  }
)

it.each([true, false])(
  'escalates a hung graceful-close RPC within the original deadline (legacy=%s)',
  async (legacy) => {
    vi.useFakeTimers()
    try {
      const h = setup('desktop', undefined, () => legacy)
      h.invoke.mockImplementationOnce(() => new Promise(() => {}))
      await h.hooks.prepareInstall!(status, {})
      const started = Date.now()
      const installing = h.hooks.installGate!({})
      await vi.advanceTimersByTimeAsync(16_500)
      await expect(installing).resolves.toMatchObject({ runtimeStopped: true })
      expect(h.stop).toHaveBeenCalledWith('update', {
        deadlineAt: started + 20_000,
        requireCleanExit: false
      })
      expect(h.progress).toHaveBeenCalledWith({
        diagnostics: expect.stringContaining('"outcome": "timeout"')
      })
    } finally {
      vi.useRealTimers()
    }
  }
)

it('awaits native instance closure before cancelling and reopening the original profile', async () => {
  let finishClosure!: () => void
  const closeOtherInstances = vi.fn<(deadlineAt: number) => Promise<void>>(
    () =>
      new Promise<void>((resolve) => {
        finishClosure = resolve
      })
  )
  const h = setup('desktop', undefined, () => true, { closeOtherInstances })
  await h.hooks.prepareInstall!(status, {})
  const applying = h.hooks.installGate!({})
  await vi.waitFor(() => expect(closeOtherInstances).toHaveBeenCalledOnce())
  const cancelling = h.hooks.cancelInstall!()
  expect(h.restart).not.toHaveBeenCalled()
  expect(h.stop).not.toHaveBeenCalled()
  finishClosure()
  await applying
  await cancelling
  expect(h.stop).toHaveBeenCalledWith('update', {
    deadlineAt: closeOtherInstances.mock.calls[0][0],
    requireCleanExit: false
  })
  expect(h.restart).toHaveBeenCalledWith(config)
})

it('never hands off when native instance closure cannot prove completion', async () => {
  const h = setup('desktop', undefined, () => true, {
    closeOtherInstances: async () => {
      throw new Error('object-bound stop failed')
    }
  })
  await h.hooks.prepareInstall!(status, {})
  await expect(h.hooks.installGate!({})).rejects.toThrow('object-bound stop failed')
  expect(h.onHandoff).not.toHaveBeenCalled()
  expect(h.setClosing).toHaveBeenLastCalledWith(false)
})

it.each(['runtime-stop-timeout', 'runtime-stop-unclean'] as const)(
  'uses the native object-bound fallback after %s and retains its confirmed lock',
  async (code) => {
    const lease = { directory: config.configRoot, release: vi.fn() }
    const forceStopRuntime = vi.fn(async () => lease)
    const h = setup('desktop', undefined, () => true, { forceStopRuntime })
    h.stop.mockRejectedValue(new RuntimeStopError(code, {} as never))
    await h.hooks.prepareInstall!(status, {})
    await expect(h.hooks.installGate!({})).resolves.toMatchObject({ runtimeStopped: true })
    expect(forceStopRuntime).toHaveBeenCalledOnce()
    expect(h.retainLease).toHaveBeenCalledWith(lease)
    await h.hooks.beforeInstallHandoff!(status)
    expect(h.onHandoff).toHaveBeenCalledOnce()
  }
)

it('reserves native force and verification time inside the original close deadline', async () => {
  vi.useFakeTimers()
  try {
    const lease = { directory: config.configRoot, release: vi.fn() }
    const forceStopRuntime = vi.fn<(deadlineAt: number) => Promise<typeof lease>>(async () => lease)
    const h = setup('desktop', undefined, () => true, { forceStopRuntime })
    h.stop.mockImplementation(async (_reason, { deadlineAt }) => {
      await new Promise((resolve) => setTimeout(resolve, deadlineAt - Date.now()))
      throw new RuntimeStopError('runtime-stop-timeout', {} as never)
    })
    await h.hooks.prepareInstall!(status, {})
    const started = Date.now()
    const installing = h.hooks.installGate!({})
    await vi.advanceTimersByTimeAsync(18_500)
    expect(forceStopRuntime).toHaveBeenCalledWith(started + 20_000)
    await expect(installing).resolves.toMatchObject({ runtimeStopped: true })
    expect(Date.now()).toBeLessThan(started + 20_000)
  } finally {
    vi.useRealTimers()
  }
})

it('does not start native force after an already initiated stop settles beyond the deadline', async () => {
  vi.useFakeTimers()
  try {
    const forceStopRuntime = vi.fn()
    const h = setup('desktop', undefined, () => true, { forceStopRuntime })
    h.stop.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 21_000))
      throw new RuntimeStopError('runtime-stop-timeout', {} as never)
    })
    await h.hooks.prepareInstall!(status, {})
    const installing = expect(h.hooks.installGate!({})).rejects.toMatchObject({
      reason: 'runtime-stop-timeout'
    })
    await vi.advanceTimersByTimeAsync(21_000)
    await installing
    expect(forceStopRuntime).not.toHaveBeenCalled()
    expect(h.onHandoff).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('awaits started native cleanup without granting new save or stop work after its deadline', async () => {
  vi.useFakeTimers()
  try {
    const flushRenderer = vi.fn(async () => {})
    const forceStopRuntime = vi.fn()
    const closeOtherInstances = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 21_000))
    })
    const h = setup('desktop', undefined, () => true, {
      flushRenderer,
      forceStopRuntime,
      closeOtherInstances
    })
    await h.hooks.prepareInstall!(status, {})
    const installing = expect(h.hooks.installGate!({})).rejects.toMatchObject({
      reason: 'runtime-stop-timeout'
    })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(h.setClosing).not.toHaveBeenCalledWith(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await installing
    expect(flushRenderer.mock.calls).toEqual([['preflight']])
    expect(h.stop).not.toHaveBeenCalled()
    expect(forceStopRuntime).not.toHaveBeenCalled()
    expect(h.onHandoff).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('does not escalate a runtime control failure using installation close authority', async () => {
  const forceStopRuntime = vi.fn()
  const h = setup('desktop', undefined, () => true, { forceStopRuntime })
  h.stop.mockRejectedValue(new UpdateLifecycleError('runtime-not-controlled', 'control changed'))
  await h.hooks.prepareInstall!(status, {})
  await expect(h.hooks.installGate!({})).rejects.toMatchObject({ reason: 'runtime-not-controlled' })
  expect(forceStopRuntime).not.toHaveBeenCalled()
  expect(h.onHandoff).not.toHaveBeenCalled()
})

it('releases native startup admission after stop settlement but before restarting on cancellation', async () => {
  const h = setup('desktop', undefined, () => true)
  let admissionReleased = false
  h.restart.mockImplementation(async () => {
    expect(admissionReleased).toBe(true)
  })
  await h.hooks.prepareInstall!(status, {})
  await h.hooks.installGate!({})
  await expect(
    h.hooks.cancelInstall!(() => {
      expect(h.stop).toHaveBeenCalledOnce()
      admissionReleased = true
    })
  ).resolves.toMatchObject({ outcome: 'cancelled' })
  expect(h.restart).toHaveBeenCalledOnce()
})

it('retains the stopped profile when native admission cannot be released', async () => {
  const h = setup('desktop', undefined, () => true)
  await h.hooks.prepareInstall!(status, {})
  await h.hooks.installGate!({})
  await expect(
    h.hooks.cancelInstall!(() => {
      throw new Error('native marker still owned')
    })
  ).rejects.toThrow('native marker still owned')
  expect(h.restart).not.toHaveBeenCalled()
  await h.hooks.cancelInstall!(() => {})
  expect(h.restart).toHaveBeenCalledWith(config)
})

it('uses only installation-scoped close commands when another Desktop holds Runtime control', async () => {
  const operationId = '11111111-1111-4111-8111-111111111111'
  state.control = 'held'
  const installationOperation = vi.fn(() => operationId)
  const h = setup('desktop', undefined, () => true, { installationOperation })
  await expect(h.hooks.prepareInstall!(status, {})).resolves.toBeUndefined()
  expect(await h.hooks.installGate!({})).toMatchObject({ runtimeStopped: true })
  expect(h.invoke).toHaveBeenCalledWith('desktop:update-installation-gate', [
    { operationId, shutdownDeadlineAt: expect.any(Number) }
  ])
  expect(h.invoke).toHaveBeenCalledWith('desktop:update-installation-stop', [
    { operationId, shutdownDeadlineAt: expect.any(Number) }
  ])
  expect(h.stop).toHaveBeenCalledWith(undefined, false, expect.any(Number))
  expect(h.stop).not.toHaveBeenCalledWith('update', expect.anything())
  expect(installationOperation).toHaveBeenCalledTimes(2)
  await h.hooks.beforeInstallHandoff!(status)
  expect(h.onHandoff).toHaveBeenCalledOnce()
})

it('does not offer controller-held closure without an installation operation capability', async () => {
  state.control = 'held'
  const h = setup('desktop', undefined, () => true)
  await expect(h.hooks.prepareInstall!(status, {})).rejects.toMatchObject({
    reason: 'runtime-not-controlled'
  })
  expect(h.invoke).not.toHaveBeenCalled()
  expect(h.stop).not.toHaveBeenCalled()
})

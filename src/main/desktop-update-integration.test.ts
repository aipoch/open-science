import { RuntimeStopError } from './runtime-stop-confirmation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopRuntimeClient } from './desktop-runtime-client'
import type { UpdateStatus } from '../shared/update'
import type { InstallationUpdateRecord } from './update/installation-protection'
const state = vi.hoisted(() => ({
  record: undefined as InstallationUpdateRecord | undefined,
  begin: vi.fn(),
  reboot: vi.fn(),
  advance: vi.fn(),
  finish: vi.fn(),
  check: vi.fn(),
  availability: vi.fn(),
  alive: vi.fn(() => false)
}))
vi.mock('./update/installation-reboot-recovery', () => ({
  recoverInstallationAfterSystemRestart: state.reboot
}))
vi.mock('./update/installation-protection', () => ({
  inspectInstallationUpdate: () => state.record,
  inspectInstallationAvailability: state.availability,
  installationRootForEntry: () => '/tmp',
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
  isRuntimeProcessAlive: state.alive
}))
import { createDesktopUpdateIntegration } from './desktop-update-integration'
const config = {
  configRoot: '/tmp/config',
  dataRoot: '/tmp/data',
  profilePath: '/tmp/profile',
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
    Pick<Parameters<typeof createDesktopUpdateIntegration>[0], 'flushRenderer'>
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
    control: 'granted',
    generation: 'gen',
    entryPath: '/tmp/entry',
    startupOptions: config
  }))
  const reconnect = vi.fn().mockResolvedValue(undefined)
  const progress = vi.fn()
  const client = {
    refreshControl: refresh,
    runtimeInfo: () => ({
      launch,
      control: 'granted',
      generation: 'gen',
      entryPath: '/tmp/entry',
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
    location: { installationRoot: '/tmp' },
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
  state.reboot.mockResolvedValue(undefined)
  state.alive.mockReturnValue(false)
  state.availability.mockResolvedValue(undefined)
  state.begin.mockImplementation(async () => (state.record = { ...base }))
  state.advance.mockImplementation(
    (_location, _id, phase, stoppedClean) =>
      (state.record = { ...state.record!, phase, stoppedClean })
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
    expect(state.reboot).toHaveBeenCalledWith({ installationRoot: '/tmp' }, 'op', {
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
  it('requires exact CLI consent before protection or stopping and preserves source/config', async () => {
    const { hooks, stop } = setup('cli')
    const offer = await hooks.prepareInstall!(status, {})
    expect(offer?.cliConfirmation).toMatchObject({
      source: 'this-installation',
      pid: 123,
      port: 44100
    })
    expect(state.begin).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    await hooks.prepareInstall!(status, { cliConsentToken: offer!.cliConfirmation!.token })
    expect(state.begin).toHaveBeenCalledWith(
      expect.objectContaining({ startupOptions: config }),
      expect.any(AbortSignal)
    )
  })
  it('retains the stop lease and retries stopped-clean installation without a dead task gate', async () => {
    const { hooks, invoke, stop, retainLease } = setup()
    await hooks.prepareInstall!(status, {})
    await hooks.installGate!({ force: true })
    expect(invoke).toHaveBeenCalledWith('desktop:update-gate', [{ force: true }])
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
    expect(state.finish).toHaveBeenCalledWith({ installationRoot: '/tmp' }, 'op', 'cancel')
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
  it('leaves protection in place if task gate refuses and cancels through the live abort', async () => {
    const { hooks, invoke, stop } = setup()
    invoke.mockResolvedValueOnce({ completed: false, reaped: false, blockedBy: ['agent'] })
    await hooks.prepareInstall!(status, {})
    expect(await hooks.installGate!({})).toMatchObject({ blockedBy: ['agent'] })
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
    await expect(hooks.recoverInstall!()).rejects.toThrow('remaining processes')
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
  it('recovers a verified rollback through the core terminal-proof check', async () => {
    state.record = { ...base, phase: 'handoff', stoppedClean: true }
    const { hooks, restart } = setup()
    expect((await hooks.recoverInstall!()).outcome).toBe('recovered')
    expect(state.finish).toHaveBeenCalledWith(expect.anything(), 'op', 'cancel')
    expect(restart).toHaveBeenCalledWith(config)
  })
})

const stopBeforeAbort = (invoke: ReturnType<typeof vi.fn>): void => {
  invoke.mockRejectedValueOnce(new Error('gate unavailable'))
}

describe('supervised install admission release', () => {
  it('releases admission when the update gate throws', async () => {
    const { hooks, invoke, setClosing } = setup()
    invoke.mockRejectedValueOnce(
      Object.assign(new Error('Another Desktop controls this Runtime'), {
        code: 'command-unavailable'
      })
    )
    await hooks.prepareInstall!(status, {})
    await expect(hooks.installGate!({})).rejects.toThrow('Another Desktop')
    expect(setClosing).toHaveBeenCalledWith(true)
    expect(setClosing).toHaveBeenLastCalledWith(false)
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
    invoke.mockResolvedValueOnce({ completed: false, reaped: false, blockedBy: ['agent'] })
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
    expect(state.availability).toHaveBeenCalled()
    expect(await hooks.installGate!({})).toMatchObject({ completed: true, reaped: true })
    await hooks.beforeInstallHandoff!(status)
    expect(invoke).toHaveBeenCalledWith('desktop:update-gate', [{}])
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

  it('releases admission when the task gate refuses', async () => {
    const { hooks, invoke, setClosing, stop } = setup('desktop', undefined, legacy)
    invoke.mockResolvedValue({ completed: false, reaped: false, blockedBy: ['agent'] })
    await hooks.prepareInstall!(status, {})
    expect(await hooks.installGate!({})).toMatchObject({ completed: false, blockedBy: ['agent'] })
    expect(setClosing).toHaveBeenLastCalledWith(false)
    expect(stop).not.toHaveBeenCalled()
  })

  it('refuses a live occupant before touching the runtime', async () => {
    const { hooks, invoke, setClosing } = setup('desktop', undefined, legacy)
    const busy = new Error('occupied')
    state.availability.mockRejectedValue(busy)
    await expect(hooks.prepareInstall!(status, {})).rejects.toBe(busy)
    expect(invoke).not.toHaveBeenCalled()
    expect(setClosing).not.toHaveBeenCalledWith(true)
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
    const { hooks, invoke, setClosing, progress } = setup('desktop', undefined, legacy)
    await hooks.prepareInstall!(status, {})
    stopBeforeAbort(invoke)
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
        runtime: 'stopped-clean',
        canCancel: false
      })
    })
})

it.each([true, false])(
  'never stops Node after a failed renderer save (legacy=%s)',
  async (legacy) => {
    for (const failedPhase of ['preflight', 'final']) {
      state.record = undefined
      const h = setup('desktop', undefined, () => legacy, {
        flushRenderer: async (phase) => {
          if (phase === failedPhase) throw new Error('save failed')
        }
      })
      await h.hooks.prepareInstall!(status, {})
      await expect(h.hooks.installGate!({})).rejects.toThrow('save failed')
      expect(h.stop).not.toHaveBeenCalled()
      expect(h.onHandoff).not.toHaveBeenCalled()
      expect(h.setClosing).toHaveBeenLastCalledWith(false)
      h.hooks.releaseInstallHandoff!()
      await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith('desktop:update-abort'))
      expect(h.restart).not.toHaveBeenCalled()
    }
  }
)

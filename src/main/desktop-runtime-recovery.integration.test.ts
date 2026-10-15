import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { ApplicationEventHub } from './application-events'
import { connectDesktopRuntime, type DesktopRuntimeClient } from './desktop-runtime-client'
import { createDesktopRuntimeLifecycle } from './desktop-runtime-lifecycle'
import { createDesktopRuntimeRecovery } from './desktop-runtime-recovery'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import {
  connectDesktopRuntimeForStartup,
  DesktopRuntimeStartupError
} from './desktop-startup-recovery'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Real lifecycle, socket protocol, client and recovery; only business work is controlled here.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture(timeoutMs?: number, candidateId?: string) {
  let finish!: () => void
  const migration = new Promise<void>((resolve) => {
    finish = resolve
  })
  const cancelMigration = vi.fn(() => migration)
  const releaseAdmission = vi.fn()
  const events = new ApplicationEventHub()
  const invoke = vi.fn(async () => 'accepted')
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    events,
    commands: { commandNames: () => ['acp:prompt'], invoke },
    createLifecycle: () =>
      createDesktopRuntimeLifecycle({
        detectActiveSessions: () => [],
        hasActiveReviewerWork: () => false,
        getActiveSettingsInstallId: () => undefined,
        isMigrationInProgress: () => false,
        hasActivePackageTransfer: () => false,
        holdSettingsInstallAdmission: () => releaseAdmission,
        cancelMigrationForQuit: cancelMigration,
        prepareForQuit: async () => 'completed',
        abortQuitPreparation: () => {}
      })
  })
  cleanups.push(host.close)
  const observed = vi.fn()
  const attach = async (id: string): Promise<DesktopRuntimeClient> => {
    const client = await connectDesktopRuntime({
      endpoint: host.endpoint,
      desktopInstanceId: id,
      onEvent: observed,
      onDisconnect: () => {},
      onNativeRequest: async () => true
    })
    cleanups.push(client.close)
    return client
  }
  const id = randomUUID()
  const first = await attach(id)
  await first.lifecycle({ operation: 'hold' })
  const pending = first.lifecycle({ operation: 'cancel-migration' }).catch(() => undefined)
  await vi.waitFor(() => expect(cancelMigration).toHaveBeenCalledOnce())
  cleanups.push(async () => {
    finish()
    await pending
  })
  first.close()
  await pending
  // Bootstrap a candidate while the real controller still owns unfinished work.
  const candidate = await attach(candidateId ?? id)
  expect(candidate.runtimeInfo()).toMatchObject({
    control: 'held',
    controlReason: 'operation-pending'
  })
  const activate = vi.fn(
    async (_client: DesktopRuntimeClient, _signal: AbortSignal, ready: () => void) => {
      ready()
    }
  )
  let attempts = 0
  const recovery = createDesktopRuntimeRecovery({
    client: first,
    connect: async () => (attempts++ === 0 ? candidate : attach(id)),
    activate,
    onState: () => {},
    timeoutMs
  })
  recovery.disconnect(first)
  return {
    first,
    candidate,
    recovery,
    activate,
    finish,
    releaseAdmission,
    attach,
    host,
    events,
    observed,
    invoke
  }
}

it('waits for retiring control before reconciling and restores commands, events and lifecycle authority', async () => {
  const value = await fixture()
  const attempt = value.recovery.reconnect()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(value.recovery.state().phase).toBe('reconnecting')
  expect(value.activate).not.toHaveBeenCalled()
  expect(value.releaseAdmission).not.toHaveBeenCalled()
  await expect(value.candidate.lifecycle({ operation: 'hold' })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  value.finish()
  await attempt
  expect(value.releaseAdmission).toHaveBeenCalledOnce()
  expect(value.recovery.state().phase).toBe('connected')
  expect(value.candidate.ownsRuntime()).toBe(true)
  await expect(value.candidate.invoke(randomUUID(), 'acp:prompt', [])).resolves.toBe('accepted')
  expect(value.invoke).toHaveBeenCalledOnce()
  value.events.publish('runtime:policy-changed', undefined)
  await vi.waitFor(() =>
    expect(value.observed).toHaveBeenCalledWith({
      channel: 'runtime:policy-changed',
      payload: null
    })
  )
  await expect(value.host.requestNative({ operation: 'runtime-relaunch' })).resolves.toBe(true)
  await expect(value.candidate.lifecycle({ operation: 'hold' })).resolves.toBeNull()
})

it('cancels waiting for control without exposing or later activating the candidate', async () => {
  const value = await fixture()
  const attempt = value.recovery.reconnect()
  await new Promise((resolve) => setTimeout(resolve, 30))
  value.recovery.setClosing(true)
  await attempt
  expect(value.recovery.state()).toMatchObject({ phase: 'disconnected', closing: true })
  expect(value.activate).not.toHaveBeenCalled()
  value.finish()
  await vi.waitFor(() => expect(value.releaseAdmission).toHaveBeenCalledOnce())
  expect(value.activate).not.toHaveBeenCalled()
})

it('preserves a spectator connection when another live Desktop holds control', async () => {
  const value = await fixture()
  value.finish()
  await vi.waitFor(() => expect(value.releaseAdmission).toHaveBeenCalledOnce())
  const other = await value.attach(randomUUID())
  expect(other.ownsRuntime()).toBe(true)
  await value.recovery.reconnect()
  expect(value.recovery.state().phase).toBe('connected')
  expect(value.candidate.runtimeInfo()).toMatchObject({
    control: 'held',
    controlReason: 'controller-held'
  })
  await expect(value.candidate.invoke(randomUUID(), 'acp:prompt', [])).resolves.toBe('accepted')
  await expect(value.candidate.lifecycle({ operation: 'hold' })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
})

it('keeps the cleanup fence on deadline and allows a fresh attempt after settlement', async () => {
  const value = await fixture(150)
  await value.recovery.reconnect()
  expect(value.recovery.state().phase).toBe('disconnected')
  expect(value.activate).not.toHaveBeenCalled()
  expect(value.releaseAdmission).not.toHaveBeenCalled()
  value.finish()
  await vi.waitFor(() => expect(value.releaseAdmission).toHaveBeenCalledOnce())
  await value.recovery.reconnect()
  expect(value.recovery.state().phase).toBe('connected')
  const recovered = value.activate.mock.calls[0][0] as DesktopRuntimeClient
  expect(recovered.ownsRuntime()).toBe(true)
  await expect(recovered.invoke(randomUUID(), 'acp:prompt', [])).resolves.toBe('accepted')
})

it('does not finish first startup while an earlier Desktop is still retiring', async () => {
  const value = await fixture(undefined, randomUUID())
  let ready = false
  const startup = connectDesktopRuntimeForStartup({
    connect: async () => value.candidate,
    version: 'test'
  }).then((client) => {
    ready = true
    return client
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(ready).toBe(false)
  expect(value.releaseAdmission).not.toHaveBeenCalled()
  value.finish()
  const client = await startup
  expect(client.ownsRuntime()).toBe(true)
  await expect(client.invoke(randomUUID(), 'acp:prompt', [])).resolves.toBe('accepted')
  await expect(value.host.requestNative({ operation: 'runtime-relaunch' })).resolves.toBe(true)
})

it('closes a timed-out startup attachment and can retry the same service after cleanup', async () => {
  const value = await fixture(undefined, randomUUID())
  const error = await connectDesktopRuntimeForStartup({
    connect: async () => value.candidate,
    version: 'test',
    timeoutMs: 150
  }).catch((error: unknown) => error)
  expect(error).toBeInstanceOf(DesktopRuntimeStartupError)
  expect((error as DesktopRuntimeStartupError).issue).toMatchObject({
    reason: 'startup-recovery-required',
    canRecover: true,
    canStop: false
  })
  await expect(value.candidate.invoke(randomUUID(), 'acp:prompt', [])).rejects.toThrow(
    'disconnected'
  )
  expect(value.releaseAdmission).not.toHaveBeenCalled()
  expect(value.invoke).not.toHaveBeenCalled()
  value.finish()
  await (error as DesktopRuntimeStartupError).recover()
  const client = await connectDesktopRuntimeForStartup({
    connect: () => value.attach(randomUUID()),
    version: 'test'
  })
  expect(client.processId()).toBe(value.first.processId())
  expect(client.runtimeInfo().generation).toBe(value.first.runtimeInfo().generation)
  expect(client.ownsRuntime()).toBe(true)
  await expect(client.invoke(randomUUID(), 'acp:prompt', [])).resolves.toBe('accepted')
})

it('allows first startup as a spectator without displacing another live controller', async () => {
  const value = await fixture(undefined, randomUUID())
  value.finish()
  await vi.waitFor(() => expect(value.releaseAdmission).toHaveBeenCalledOnce())
  const other = await value.attach(randomUUID())
  const client = await connectDesktopRuntimeForStartup({
    connect: async () => value.candidate,
    version: 'test'
  })
  expect(client.runtimeInfo()).toMatchObject({ control: 'held', controlReason: 'controller-held' })
  expect(other.ownsRuntime()).toBe(true)
  await expect(client.invoke(randomUUID(), 'acp:prompt', [])).resolves.toBe('accepted')
  await expect(client.lifecycle({ operation: 'hold' })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
})

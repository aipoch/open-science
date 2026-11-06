import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ApplicationEventHub } from './application-events'
import { connectDesktopRuntime, type DesktopRuntimeClient } from './desktop-runtime-client'
import { startDesktopRuntimeTransport } from './desktop-runtime-transport'
import { trackLifecycleSettlement } from './lifecycle-settlement'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireNativeInstallationUpdate,
  beginNativeInstallationShutdown,
  assertNativeInstallationUpdateAuthorized,
  claimNativeInstallationUpdateRecovery,
  installationStateDirectory,
  readNativeInstallationUpdate,
  releaseNativeInstallationUpdate
} from './update/installation-protection'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function fixture() {
  const lifecycle = { request: vi.fn(async () => null), disconnect: vi.fn(async () => undefined) }
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    createLifecycle: () => lifecycle,
    controllerRetireDeadlineMs: 400,
    hostCommands: {
      commandNames: () => ['desktop:update-gate', 'desktop:update-abort'],
      invoke: vi.fn(async () => null)
    }
  })
  cleanup.push(host.close)
  const attach = async (
    id: string,
    onNativeRequest = vi.fn(async () => true)
  ): Promise<DesktopRuntimeClient> => {
    const client = await connectDesktopRuntime({
      endpoint: host.endpoint,
      desktopInstanceId: id,
      onEvent: vi.fn(),
      onDisconnect: vi.fn(),
      onNativeRequest
    })
    cleanup.push(client.close)
    return client
  }
  return { host, lifecycle, attach }
}
it('shares controller across one instance, excludes competitors, and routes lifecycle native to controller', async () => {
  const { host, attach, lifecycle } = await fixture()
  const id = randomUUID()
  const native = vi.fn(async () => true)
  const first = await attach(id, native)
  const second = await attach(id)
  const heldNative = vi.fn(async () => true)
  const held = await attach(randomUUID(), heldNative)
  expect(first.ownsRuntime()).toBe(true)
  expect(second.runtimeInfo().control).toBe('granted')
  expect(held.runtimeInfo().control).toBe('held')
  await expect(held.lifecycle({ operation: 'hold' })).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  await expect(held.invokeHost('desktop:update-gate')).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  await held.lifecycle({ operation: 'inspect' })
  await expect(host.requestNative({ operation: 'runtime-relaunch' })).resolves.toBe(true)
  expect(native).toHaveBeenCalledOnce()
  expect(heldNative).not.toHaveBeenCalled()
  first.close()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(lifecycle.disconnect).not.toHaveBeenCalled()
  await second.lifecycle({ operation: 'hold' })
})

it('grants only operation-bound installation close to a spectator while preserving controller ownership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'installation-close-transport-'))
  const location = {
    installationRoot: join(directory, 'installation'),
    stateRoot: join(directory, 'state')
  }
  const otherLocation = { ...location, installationRoot: join(directory, 'other-installation') }
  mkdirSync(location.installationRoot)
  mkdirSync(otherLocation.installationRoot)
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const operation = acquireNativeInstallationUpdate(location, {
    operationId: randomUUID(),
    handoffDirectory: directory,
    targetVersion: '2',
    installerSha512: Buffer.alloc(64).toString('base64'),
    requestSha256: 'a'.repeat(64)
  })
  const shutdownDeadlineAt = Date.now() + 10_000
  const closingOperation = beginNativeInstallationShutdown(
    location,
    operation.operationId,
    shutdownDeadlineAt
  )
  cleanup.push(() => {
    if (readNativeInstallationUpdate(location))
      releaseNativeInstallationUpdate(location, operation.operationId, 'installed')
  })
  let serviceLocation = location
  const invoke = vi.fn(async () => ({ completed: true, reaped: true, stopAuthorized: true }))
  const requestShutdown = vi.fn(async () => {})
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    requestShutdown,
    authorizeInstallationUpdate: (operationId) =>
      assertNativeInstallationUpdateAuthorized(serviceLocation, operationId),
    hostCommands: { commandNames: () => ['desktop:update-installation-gate'], invoke }
  })
  cleanup.push(host.close)
  const attach = async (): Promise<Awaited<ReturnType<typeof connectDesktopRuntime>>> => {
    const client = await connectDesktopRuntime({
      endpoint: host.endpoint,
      desktopInstanceId: randomUUID(),
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
    cleanup.push(client.close)
    return client
  }
  const controller = await attach()
  const spectator = await attach()
  expect(spectator.runtimeInfo().control).toBe('held')
  const request = { operationId: operation.operationId, shutdownDeadlineAt }
  await expect(
    spectator.invokeHost('desktop:update-installation-gate', [request])
  ).resolves.toMatchObject({ stopAuthorized: true })
  expect(spectator.runtimeInfo().control).toBe('held')
  expect(controller.runtimeInfo().control).toBe('granted')
  await expect(spectator.invokeHost('desktop:update-gate', [{}])).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  await expect(
    spectator.invokeHost('desktop:update-installation-gate', [
      { ...request, operationId: randomUUID() }
    ])
  ).rejects.toMatchObject({ code: 'command-unavailable' })
  await expect(
    spectator.invokeHost('desktop:update-installation-gate', [{ ...request, force: true }])
  ).rejects.toMatchObject({ code: 'command-unavailable' })
  serviceLocation = otherLocation
  await expect(
    spectator.invokeHost('desktop:update-installation-stop', [request])
  ).rejects.toMatchObject({ code: 'command-unavailable' })
  serviceLocation = location
  releaseNativeInstallationUpdate(location, operation.operationId)
  writeFileSync(
    join(installationStateDirectory(location), 'windows-update-in-progress.json'),
    JSON.stringify(closingOperation)
  )
  await expect(
    spectator.invokeHost('desktop:update-installation-gate', [request])
  ).rejects.toMatchObject({ code: 'command-unavailable' })
  expect(requestShutdown).not.toHaveBeenCalled()
  const release = claimNativeInstallationUpdateRecovery(location, operation.operationId)
  cleanup.push(() => release?.())
  await expect(
    spectator.invokeHost('desktop:update-installation-stop', [
      { ...request, shutdownDeadlineAt: Date.now() + 30_000 }
    ])
  ).resolves.toBeNull()
  await vi.waitFor(() =>
    expect(requestShutdown).toHaveBeenCalledWith('update', request.shutdownDeadlineAt)
  )
})
it('retains controller until a timed-out underlying teardown really settles', async () => {
  const { attach, lifecycle } = await fixture()
  let finish!: () => void
  const actual = new Promise<void>((resolve) => {
    finish = resolve
  })
  cleanup.push(finish)
  lifecycle.request.mockImplementationOnce(async () => {
    trackLifecycleSettlement(actual)
    return null
  })
  const first = await attach(randomUUID())
  await first.lifecycle({ operation: 'prepare', fingerprint: 'a'.repeat(64) })
  await expect(first.lifecycle({ operation: 'abort' })).resolves.toBeNull()
  await expect(first.lifecycle({ operation: 'release' })).resolves.toBeNull()
  // Rolling back the current quit must not authorize new preparation or an update before the
  // underlying teardown settles, nor allow a competing Desktop to release the owner's holds.
  for (const operation of ['hold', 'prepare'] as const)
    await expect(
      first.lifecycle(
        operation === 'prepare' ? { operation, fingerprint: 'a'.repeat(64) } : { operation }
      )
    ).rejects.toMatchObject({ code: 'command-unavailable' })
  await expect(first.invokeHost('desktop:update-gate')).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  const competitor = await attach(randomUUID())
  for (const operation of ['abort', 'release'] as const)
    await expect(competitor.lifecycle({ operation })).rejects.toMatchObject({
      code: 'command-unavailable'
    })
  first.close()
  const held = await attach(randomUUID())
  expect(held.runtimeInfo().control).toBe('held')
  expect(lifecycle.disconnect).not.toHaveBeenCalled()
  finish()
  await vi.waitFor(() => expect(lifecycle.disconnect).toHaveBeenCalledOnce())
  const next = await attach(randomUUID())
  expect(next.runtimeInfo().control).toBe('granted')
  await next.lifecycle({ operation: 'hold' })
})

it('does not overlap rollback with an active lifecycle request, even on another owner socket', async () => {
  const { attach, lifecycle } = await fixture()
  const preparation = Promise.withResolvers<null>()
  lifecycle.request.mockImplementationOnce(() => preparation.promise)
  const id = randomUUID()
  const first = await attach(id)
  const second = await attach(id)
  const pending = first.lifecycle({ operation: 'prepare', fingerprint: 'a'.repeat(64) })
  try {
    await vi.waitFor(() => expect(lifecycle.request).toHaveBeenCalledOnce())
    for (const client of [first, second])
      for (const operation of ['abort', 'release'] as const)
        await expect(client.lifecycle({ operation })).rejects.toMatchObject({
          code: 'command-unavailable'
        })
    expect(lifecycle.request).toHaveBeenCalledOnce()
  } finally {
    preparation.resolve(null)
    await pending
  }
  await second.lifecycle({ operation: 'abort' })
  await first.lifecycle({ operation: 'release' })
})

it('delivers events to every attachment and retains controller documents after a spectator closes', async () => {
  const events = new ApplicationEventHub()
  const disconnected = vi.fn()
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    events,
    onDisconnect: disconnected,
    commands: { commandNames: () => ['projects:list'], invoke: vi.fn(async () => []) }
  })
  cleanup.push(host.close)
  const firstEvents = vi.fn(),
    heldEvents = vi.fn(),
    secondEvents = vi.fn()
  const firstDocs = vi.fn(),
    heldDocs = vi.fn()
  const id = randomUUID()
  const attach = async (
    desktopInstanceId: string,
    onEvent: typeof firstEvents,
    onDocumentEvent = vi.fn()
  ): Promise<DesktopRuntimeClient> => {
    const client = await connectDesktopRuntime({
      endpoint: host.endpoint,
      desktopInstanceId,
      onEvent,
      onDocumentEvent,
      onDisconnect: vi.fn()
    })
    cleanup.push(client.close)
    return client
  }
  const first = await attach(id, firstEvents, firstDocs)
  const second = await attach(id, secondEvents)
  const held = await attach(randomUUID(), heldEvents, heldDocs)
  const document = randomUUID()
  await first.invoke(document, 'projects:list', [])
  events.publish('connectors:approval-settled', 'first')
  await vi.waitFor(() => {
    expect(firstEvents).toHaveBeenCalledOnce()
    expect(secondEvents).toHaveBeenCalledOnce()
    expect(heldEvents).toHaveBeenCalledOnce()
  })
  host.reportMarketplaceProgress(document, {
    sourceId: 'source',
    specialistId: 'specialist',
    version: 'v1',
    transferred: 1,
    total: 2,
    percent: 50
  })
  await vi.waitFor(() => expect(firstDocs).toHaveBeenCalledOnce())
  held.close()
  second.close()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(host.isConnected()).toBe(true)
  expect(host.hasActiveDocuments()).toBe(true)
  expect(disconnected).not.toHaveBeenCalled()
  events.publish('connectors:approval-settled', 'second')
  await vi.waitFor(() => expect(firstEvents).toHaveBeenCalledTimes(2))
  expect(heldDocs).not.toHaveBeenCalled()
  first.close()
  await vi.waitFor(() => expect(disconnected).toHaveBeenCalledOnce())
})

it('borrowed Quit only detaches, leaving the Runtime usable by another Desktop', async () => {
  const shutdown = vi.fn()
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'cli',
    events: new ApplicationEventHub(),
    requestShutdown: shutdown,
    commands: { commandNames: () => ['projects:list'], invoke: vi.fn(async () => []) }
  })
  cleanup.push(host.close)
  const first = await connectDesktopRuntime({
    endpoint: host.endpoint,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  await first.quit()
  expect(shutdown).not.toHaveBeenCalled()
  const next = await connectDesktopRuntime({
    endpoint: host.endpoint,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  cleanup.push(next.close)
  await expect(next.invoke(randomUUID(), 'projects:list', [])).resolves.toEqual([])
})

it('rejects wrong shutdown identity and dispatches accepted shutdown only once', async () => {
  const { connectToDesktopEndpoint } = await import('./desktop-connection')
  const shutdown = vi.fn()
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    events: new ApplicationEventHub(),
    requestShutdown: shutdown,
    commands: { commandNames: () => [], invoke: vi.fn() }
  })
  cleanup.push(host.close)
  const socket = await connectToDesktopEndpoint(host.endpoint)
  cleanup.push(() => socket.terminate())
  let response = once(socket, 'message')
  socket.send(JSON.stringify({ kind: 'bootstrap', desktopInstanceId: randomUUID() }))
  await response
  let id = 0
  for (const identity of [
    { generation: randomUUID(), pid: process.pid },
    { generation: host.endpoint.generation, pid: process.pid + 1 },
    { generation: host.endpoint.generation, pid: process.pid },
    { generation: host.endpoint.generation, pid: process.pid }
  ]) {
    response = once(socket, 'message')
    socket.send(JSON.stringify({ kind: 'shutdown', id: ++id, ...identity }))
    const frame = JSON.parse(String((await response)[0]))
    expect(frame.ok).toBe(id > 2)
  }
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
})

it('rebootstraps held control on the same socket without losing events or documents', async () => {
  const events = new ApplicationEventHub()
  const lifecycle = { request: vi.fn(async () => null), disconnect: vi.fn(async () => undefined) }
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    events,
    createLifecycle: () => lifecycle,
    commands: { commandNames: () => ['projects:list'], invoke: vi.fn(async () => []) }
  })
  cleanup.push(host.close)
  const owner = await connectDesktopRuntime({
    endpoint: host.endpoint,
    desktopInstanceId: randomUUID(),
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  cleanup.push(owner.close)
  const received = vi.fn(),
    documents = vi.fn(),
    native = vi.fn(async () => true)
  const held = await connectDesktopRuntime({
    endpoint: host.endpoint,
    desktopInstanceId: randomUUID(),
    onEvent: received,
    onDocumentEvent: documents,
    onNativeRequest: native,
    onDisconnect: vi.fn()
  })
  cleanup.push(held.close)
  const document = randomUUID()
  await held.invoke(document, 'projects:list', [])
  expect((await held.refreshControl()).control).toBe('held')
  events.publish('connectors:approval-settled', 'before')
  owner.close()
  await vi.waitFor(() => expect(lifecycle.disconnect).toHaveBeenCalledOnce())
  const refreshed = held.refreshControl()
  events.publish('connectors:approval-settled', 'during')
  expect((await refreshed).control).toBe('granted')
  events.publish('connectors:approval-settled', 'after')
  await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(3))
  await held.lifecycle({ operation: 'hold' })
  host.reportMarketplaceProgress(document, {
    sourceId: 'source',
    specialistId: 'specialist',
    version: 'v1',
    transferred: 1,
    total: 2,
    percent: 50
  })
  await vi.waitFor(() => expect(documents).toHaveBeenCalledOnce())
  await expect(host.requestNative({ operation: 'runtime-relaunch' })).resolves.toBe(true)
  expect(native).toHaveBeenCalledOnce()
})

it('starts the stop deadline after the native response is sent even when the Runtime socket stays open', async () => {
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    events: new ApplicationEventHub(),
    commands: { commandNames: () => [], invoke: vi.fn() }
  })
  cleanup.push(host.close)
  let confirmation: Promise<unknown> | undefined
  let sentAt = 0
  const responseSent = Promise.withResolvers<void>()
  const sent = vi.fn(() => {
    sentAt = Date.now()
    confirmation = client.waitForStopped().catch((error) => error)
    responseSent.resolve()
  })
  const client = await connectDesktopRuntime({
    endpoint: host.endpoint,
    onEvent: vi.fn(),
    onDisconnect: vi.fn(),
    onNativeRequest: async () => true,
    onNativeResponseSent: sent
  })
  cleanup.push(client.close)
  await expect(host.requestNative({ operation: 'runtime-relaunch' })).resolves.toBe(true)
  // Windows may deliver the peer's response before the local socket write callback runs.
  // Observe that callback itself; receiving bytes is not proof its completion hook settled.
  await responseSent.promise
  expect(sent).toHaveBeenCalledOnce()
  expect(host.isConnected()).toBe(true)
  expect(await confirmation).toMatchObject({ code: 'runtime-stop-timeout' })
  expect(Date.now() - sentAt).toBeLessThan(16_000)
}, 20_000)

it('does not let a new socket abort a Runtime shutdown already accepted on another socket', async () => {
  const abort = vi.fn(async () => null)
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    events: new ApplicationEventHub(),
    commands: { commandNames: () => [], invoke: vi.fn() },
    hostCommands: { commandNames: () => ['desktop:update-abort'], invoke: abort },
    requestShutdown: vi.fn()
  })
  cleanup.push(host.close)
  const { connectToDesktopEndpoint } = await import('./desktop-connection')
  const socket = await connectToDesktopEndpoint(host.endpoint)
  cleanup.push(() => socket.terminate())
  const id = randomUUID()
  let response = once(socket, 'message')
  socket.send(JSON.stringify({ kind: 'bootstrap', desktopInstanceId: id }))
  await response
  response = once(socket, 'message')
  socket.send(
    JSON.stringify({
      kind: 'shutdown',
      id: 1,
      pid: process.pid,
      generation: host.endpoint.generation
    })
  )
  await response
  const next = await connectDesktopRuntime({
    endpoint: host.endpoint,
    desktopInstanceId: id,
    onEvent: vi.fn(),
    onDisconnect: vi.fn()
  })
  cleanup.push(next.close)
  await expect(next.invokeHost('desktop:update-abort')).rejects.toMatchObject({
    code: 'command-unavailable'
  })
  expect(abort).not.toHaveBeenCalled()
})

it('lets recovery commands through while a teardown is still settling', async () => {
  const { attach, lifecycle } = await fixture()
  let finish!: () => void
  const actual = new Promise<void>((resolve) => {
    finish = resolve
  })
  cleanup.push(finish)
  lifecycle.request.mockImplementationOnce(async () => {
    trackLifecycleSettlement(actual, { abandonAfterMs: 60_000 })
    return null
  })
  const first = await attach(randomUUID())
  await first.lifecycle({ operation: 'prepare', fingerprint: 'a'.repeat(64) })
  await expect(first.invokeHost('desktop:update-abort')).resolves.toBeNull()
  await expect(first.lifecycle({ operation: 'abort' })).resolves.toBeNull()
  await expect(first.lifecycle({ operation: 'release' })).resolves.toBeNull()
})

it('releases the controller fence when disconnect cleanup throws', async () => {
  const { attach, lifecycle } = await fixture()
  lifecycle.disconnect.mockRejectedValueOnce(new Error('abort failed'))
  const first = await attach(randomUUID())
  first.close()
  await vi.waitFor(() => expect(lifecycle.disconnect).toHaveBeenCalledOnce())
  await vi.waitFor(async () => {
    const next = await attach(randomUUID())
    expect(next.runtimeInfo().control).toBe('granted')
  })
})

it('releases the controller fence when a settlement never converges', async () => {
  const { attach, lifecycle } = await fixture()
  lifecycle.request.mockImplementationOnce(async () => {
    trackLifecycleSettlement(new Promise<void>(() => {}), { abandonAfterMs: 150 })
    return null
  })
  const first = await attach(randomUUID())
  await first.lifecycle({ operation: 'prepare', fingerprint: 'a'.repeat(64) })
  first.close()
  await sleep(50)
  const held = await attach(randomUUID())
  expect(held.runtimeInfo().control).toBe('held')
  await vi.waitFor(
    async () => {
      const next = await attach(randomUUID())
      expect(next.runtimeInfo().control).toBe('granted')
    },
    { timeout: 3000 }
  )
  expect(lifecycle.disconnect).toHaveBeenCalledOnce()
})

it('releases the controller fence when a controller operation never settles', async () => {
  const { attach, lifecycle } = await fixture()
  lifecycle.request.mockImplementationOnce(() => new Promise<null>(() => {}))
  const first = await attach(randomUUID())
  void first.lifecycle({ operation: 'prepare', fingerprint: 'a'.repeat(64) }).catch(() => undefined)
  await vi.waitFor(() => expect(lifecycle.request).toHaveBeenCalledOnce())
  first.close()
  await vi.waitFor(
    async () => {
      const next = await attach(randomUUID())
      expect(next.runtimeInfo().control).toBe('granted')
    },
    { timeout: 3000 }
  )
})

it('does not grant control of a runtime that is already stopping', async () => {
  let stopping = false
  const host = await startDesktopRuntimeTransport({
    version: 'test',
    launch: 'desktop',
    commands: { commandNames: () => [], invoke: vi.fn() },
    events: new ApplicationEventHub(),
    isStopping: () => stopping,
    createLifecycle: () => ({ request: vi.fn(async () => null), disconnect: vi.fn() })
  })
  cleanup.push(host.close)
  const connect = async (): Promise<DesktopRuntimeClient> => {
    const client = await connectDesktopRuntime({
      endpoint: host.endpoint,
      desktopInstanceId: randomUUID(),
      onEvent: vi.fn(),
      onDisconnect: vi.fn()
    })
    cleanup.push(client.close)
    return client
  }
  expect((await connect()).runtimeInfo().control).toBe('granted')
  stopping = true
  const late = await connect()
  expect(late.runtimeInfo()).toMatchObject({ control: 'held', controlReason: 'runtime-stopping' })
})

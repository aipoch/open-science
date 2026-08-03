import { EventEmitter } from 'node:events'

import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { isWebRpcChannel } from '../shared/web-rpc-contract'
import { callerContextForEvent, type CallerContext } from './caller-context'
import {
  ApplicationCallerLeaseRegistry,
  bindCallerLeaseToEvent,
  callerLeaseOwnershipKeyForContext,
  type OwnedApplicationCallerLease
} from './caller-lifecycle'
import {
  invokeWithIpcRejectionDiagnostics,
  type IpcRejectionLogger
} from './diagnostics/ipc-rejection'
import { createLogger } from './logger'

type IpcHandler = Parameters<IpcMain['handle']>[1]

type IpcHandlerInstallation = {
  uninstall(): void
}

type IpcHandlerInstallationScope = {
  complete(cleanup?: () => void): IpcHandlerInstallation
  rollback(): void
}

class WebIpcSender {
  readonly id: number
  readonly lifecycleClientId: string
  readonly callerContext: CallerContext

  constructor(
    id: number,
    callerContext: CallerContext,
    private readonly lifecycle: EventEmitter
  ) {
    this.id = id
    this.lifecycleClientId = callerContext.lifecycleClientId
    this.callerContext = callerContext
  }

  once(event: string, listener: (...args: unknown[]) => void): this {
    this.lifecycle.once(event, listener)
    return this
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    this.lifecycle.on(event, listener)
    return this
  }

  off(event: string, listener: (...args: unknown[]) => void): this {
    this.lifecycle.off(event, listener)
    return this
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.lifecycle.removeListener(event, listener)
    return this
  }
}

export type WebRpcRouter = {
  invoke: (channel: string, callerContext: CallerContext, args: unknown[]) => Promise<unknown>
  releaseClient: (clientId: string) => void
  dispose: () => void
  channels: () => string[]
}

type IpcHandlerRegistry = {
  ipcMainHandle: IpcMain['handle']
  webRpc: WebRpcRouter
  createInstallationScope(): IpcHandlerInstallationScope
}

type IpcHandlerRegistryDiagnostics = {
  log?: IpcRejectionLogger
  now?: () => number
}

type CallerLeaseEpoch = {
  registry: ApplicationCallerLeaseRegistry
  nativeCallers: WeakMap<object, OwnedApplicationCallerLease>
  disposed: boolean
}

const createCallerLeaseEpoch = (): CallerLeaseEpoch => ({
  registry: new ApplicationCallerLeaseRegistry(),
  nativeCallers: new WeakMap(),
  disposed: false
})

const diagnosticCallerContextForEvent = (
  event: IpcMainInvokeEvent
): Pick<CallerContext, 'surface' | 'location' | 'principalKind' | 'actionOrigin'> => {
  try {
    return callerContextForEvent(event)
  } catch {
    return {
      surface: 'electron',
      location: 'local',
      principalKind: 'human',
      actionOrigin: 'human'
    }
  }
}

const createIpcHandlerRegistry = (
  target: Pick<IpcMain, 'handle'> & Partial<Pick<IpcMain, 'removeHandler'>>,
  diagnostics: IpcHandlerRegistryDiagnostics = {}
): IpcHandlerRegistry => {
  const diagnosticLog =
    diagnostics.log ??
    ({
      warn: (message, data) => createLogger('ipc').warn(message, data)
    } satisfies IpcRejectionLogger)
  const webHandlers = new Map<string, IpcHandler>()
  const registeredChannels = new Set<string>()
  const clients = new Map<
    string,
    {
      id: number
      clientId: string
      surface: CallerContext['surface']
      lifecycle: EventEmitter
      callerLease: OwnedApplicationCallerLease
    }
  >()
  let activeCallerLeaseEpoch = createCallerLeaseEpoch()
  const destroyedNativeCallers = new WeakSet<object>()
  let nextSenderId = -1

  const callerLeaseEpochForRegistration = (): CallerLeaseEpoch => {
    if (activeCallerLeaseEpoch.disposed) activeCallerLeaseEpoch = createCallerLeaseEpoch()
    return activeCallerLeaseEpoch
  }

  const nativeCallerLease = (
    epoch: CallerLeaseEpoch,
    event: IpcMainInvokeEvent
  ): OwnedApplicationCallerLease => {
    const sender = event.sender as object
    if (destroyedNativeCallers.has(sender)) {
      throw new Error('Caller lease is no longer current.')
    }
    const existing = epoch.nativeCallers.get(sender)
    if (existing && !existing.lease.signal.aborted && existing.lease.isCurrent()) return existing

    const ownedLease = epoch.registry.acquire(callerContextForEvent(event))
    epoch.nativeCallers.set(sender, ownedLease)
    const lifecycleSender = event.sender as typeof event.sender & {
      once?: (name: string, listener: () => void) => unknown
    }
    lifecycleSender.once?.('destroyed', () => {
      destroyedNativeCallers.add(sender)
      ownedLease.release()
    })
    lifecycleSender.once?.('render-process-gone', ownedLease.release)
    return ownedLease
  }

  const assertCurrentLease = (lease: OwnedApplicationCallerLease['lease']): void => {
    if (lease.signal.aborted || !lease.isCurrent()) {
      throw new Error('Caller lease is no longer current.')
    }
  }

  const senderFor = (
    callerContext: CallerContext
  ): { sender: WebIpcSender; lease: OwnedApplicationCallerLease['lease'] } => {
    const ownershipKey = callerLeaseOwnershipKeyForContext(callerContext)
    let client = clients.get(ownershipKey)
    if (!client) {
      client = {
        id: nextSenderId--,
        clientId: callerContext.clientId,
        surface: callerContext.surface,
        lifecycle: new EventEmitter(),
        callerLease: activeCallerLeaseEpoch.registry.acquire(callerContext)
      }
      clients.set(ownershipKey, client)
    }
    return {
      sender: new WebIpcSender(client.id, callerContext, client.lifecycle),
      lease: client.callerLease.lease
    }
  }

  const destroyClient = (ownershipKey: string): void => {
    const client = clients.get(ownershipKey)
    if (!client) return
    clients.delete(ownershipKey)
    client.callerLease.release()
    client.lifecycle.emit('destroyed')
    client.lifecycle.removeAllListeners()
  }

  const releaseWebClient = (clientId: string): void => {
    for (const [ownershipKey, client] of clients) {
      if (client.surface === 'web' && client.clientId === clientId) destroyClient(ownershipKey)
    }
  }

  const ipcMainHandle: IpcMain['handle'] = (channel, listener) => {
    const callerLeaseEpoch = callerLeaseEpochForRegistration()
    target.handle(channel, (event, ...args) =>
      invokeWithIpcRejectionDiagnostics({
        channel,
        callerContext: diagnosticCallerContextForEvent(event),
        invoke: () => {
          // Electron always supplies an invoke event. Isolated handler registrars historically call
          // their injected target without Electron, so keep that pure test seam lease-neutral.
          const invokedEvent = event as IpcMainInvokeEvent | undefined
          if (!invokedEvent?.sender || typeof invokedEvent.sender !== 'object') {
            return listener(event, ...args)
          }
          const { lease } = nativeCallerLease(callerLeaseEpoch, invokedEvent)
          bindCallerLeaseToEvent(invokedEvent, lease)
          assertCurrentLease(lease)
          return listener(invokedEvent, ...args)
        },
        log: diagnosticLog,
        now: diagnostics.now
      })
    )
    registeredChannels.add(channel)
    if (isWebRpcChannel(channel)) webHandlers.set(channel, listener)
  }

  const removeChannels = (channels: Iterable<string>): void => {
    for (const channel of channels) {
      target.removeHandler?.(channel)
      registeredChannels.delete(channel)
      webHandlers.delete(channel)
    }
  }

  return {
    ipcMainHandle,
    createInstallationScope: () => {
      const before = new Set(registeredChannels)
      let settled = false
      const addedChannels = (): string[] =>
        [...registeredChannels].filter((channel) => !before.has(channel))
      return {
        complete: (cleanup) => {
          if (settled) throw new Error('IPC handler installation scope is already settled.')
          settled = true
          const channels = addedChannels()
          let uninstalled = false
          return {
            uninstall: () => {
              if (uninstalled) return
              uninstalled = true
              try {
                cleanup?.()
              } finally {
                removeChannels(channels)
              }
            }
          }
        },
        rollback: () => {
          if (settled) return
          settled = true
          removeChannels(addedChannels())
        }
      }
    },
    webRpc: {
      invoke: async (channel, callerContext, args) => {
        if (!isWebRpcChannel(channel)) throw new Error(`Unknown Web RPC channel: ${channel}`)
        const handler = webHandlers.get(channel)
        if (!handler) throw new Error(`Unregistered Web RPC channel: ${channel}`)
        if (!callerContext.isAuthorizationCurrent()) {
          throw new Error('Caller authorization is no longer current.')
        }
        const { sender, lease } = senderFor(callerContext)
        const event = { sender } as unknown as IpcMainInvokeEvent
        bindCallerLeaseToEvent(event, lease)
        assertCurrentLease(lease)
        return invokeWithIpcRejectionDiagnostics({
          channel,
          callerContext,
          invoke: () => handler(event, ...args),
          log: diagnosticLog,
          now: diagnostics.now
        })
      },
      releaseClient: releaseWebClient,
      dispose: () => {
        for (const ownershipKey of [...clients.keys()]) destroyClient(ownershipKey)
        activeCallerLeaseEpoch.registry.dispose()
        activeCallerLeaseEpoch.disposed = true
        webHandlers.clear()
      },
      channels: () => [...webHandlers.keys()].sort()
    }
  }
}

const defaultRegistry = createIpcHandlerRegistry(ipcMain)

const ipcMainHandle = defaultRegistry.ipcMainHandle
const webRpc = defaultRegistry.webRpc
const createIpcHandlerInstallationScope = (): IpcHandlerInstallationScope =>
  defaultRegistry.createInstallationScope()

export { createIpcHandlerInstallationScope, createIpcHandlerRegistry, ipcMainHandle, webRpc }
export type { IpcHandlerInstallation, IpcHandlerInstallationScope, IpcHandlerRegistryDiagnostics }

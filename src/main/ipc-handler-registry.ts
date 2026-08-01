import { EventEmitter } from 'node:events'

import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { isWebRpcChannel } from '../shared/web-rpc-contract'
import { callerContextForEvent, hasCallerAuthority, type CallerContext } from './caller-context'

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

const createIpcHandlerRegistry = (
  target: Pick<IpcMain, 'handle'> & Partial<Pick<IpcMain, 'removeHandler'>>
): IpcHandlerRegistry => {
  const webHandlers = new Map<string, IpcHandler>()
  const registeredChannels = new Set<string>()
  const clients = new Map<string, { id: number; lifecycle: EventEmitter }>()
  let nextSenderId = -1

  const senderFor = (callerContext: CallerContext): WebIpcSender => {
    let client = clients.get(callerContext.clientId)
    if (!client) {
      client = { id: nextSenderId--, lifecycle: new EventEmitter() }
      clients.set(callerContext.clientId, client)
    }
    return new WebIpcSender(client.id, callerContext, client.lifecycle)
  }

  const destroyClient = (clientId: string): void => {
    const client = clients.get(clientId)
    if (!client) return
    clients.delete(clientId)
    client.lifecycle.emit('destroyed')
    client.lifecycle.removeAllListeners()
  }

  const ipcMainHandle: IpcMain['handle'] = (channel, listener) => {
    target.handle(channel, listener)
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
        const sender = senderFor(callerContext)
        const event = { sender } as unknown as IpcMainInvokeEvent
        return handler(event, ...args)
      },
      releaseClient: destroyClient,
      dispose: () => {
        for (const clientId of [...clients.keys()]) destroyClient(clientId)
        webHandlers.clear()
      },
      channels: () => [...webHandlers.keys()].sort()
    }
  }
}

const isRemotePairingManagerSender = (event: IpcMainInvokeEvent): boolean =>
  hasCallerAuthority(callerContextForEvent(event), 'manage-remote-pairing')

const defaultRegistry = createIpcHandlerRegistry(ipcMain)

const ipcMainHandle = defaultRegistry.ipcMainHandle
const webRpc = defaultRegistry.webRpc
const createIpcHandlerInstallationScope = (): IpcHandlerInstallationScope =>
  defaultRegistry.createInstallationScope()

export {
  createIpcHandlerInstallationScope,
  createIpcHandlerRegistry,
  ipcMainHandle,
  isRemotePairingManagerSender,
  webRpc
}
export type { IpcHandlerInstallation, IpcHandlerInstallationScope }

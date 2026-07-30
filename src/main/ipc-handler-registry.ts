import { EventEmitter } from 'node:events'

import { ipcMain, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { isWebRpcChannel } from '../shared/web-rpc-contract'

type IpcHandler = Parameters<IpcMain['handle']>[1]

class WebIpcSender extends EventEmitter {
  readonly id: number
  readonly lifecycleClientId: string
  canManageRemotePairing = false

  constructor(id: number, clientId: string) {
    super()
    this.id = id
    this.lifecycleClientId = `web:${clientId}`
  }

  destroy(): void {
    this.emit('destroyed')
    this.removeAllListeners()
  }
}

export type WebRpcRouter = {
  invoke: (
    channel: string,
    clientId: string,
    args: unknown[],
    context?: { canManageRemotePairing?: boolean }
  ) => Promise<unknown>
  releaseClient: (clientId: string) => void
  dispose: () => void
  channels: () => string[]
}

type IpcHandlerRegistry = {
  ipcMainHandle: IpcMain['handle']
  webRpc: WebRpcRouter
}

const createIpcHandlerRegistry = (target: Pick<IpcMain, 'handle'>): IpcHandlerRegistry => {
  const webHandlers = new Map<string, IpcHandler>()
  const senders = new Map<string, WebIpcSender>()
  let nextSenderId = -1

  const senderFor = (clientId: string): WebIpcSender => {
    const existing = senders.get(clientId)
    if (existing) return existing
    const sender = new WebIpcSender(nextSenderId--, clientId)
    senders.set(clientId, sender)
    return sender
  }

  const ipcMainHandle: IpcMain['handle'] = (channel, listener) => {
    target.handle(channel, listener)
    if (isWebRpcChannel(channel)) webHandlers.set(channel, listener)
  }

  return {
    ipcMainHandle,
    webRpc: {
      invoke: async (channel, clientId, args, context = {}) => {
        if (!isWebRpcChannel(channel)) throw new Error(`Unknown Web RPC channel: ${channel}`)
        const handler = webHandlers.get(channel)
        if (!handler) throw new Error(`Unregistered Web RPC channel: ${channel}`)
        const sender = senderFor(clientId)
        sender.canManageRemotePairing = context.canManageRemotePairing === true
        const event = { sender } as unknown as IpcMainInvokeEvent
        return handler(event, ...args)
      },
      releaseClient: (clientId) => {
        senders.get(clientId)?.destroy()
        senders.delete(clientId)
      },
      dispose: () => {
        for (const sender of senders.values()) sender.destroy()
        senders.clear()
        webHandlers.clear()
      },
      channels: () => [...webHandlers.keys()].sort()
    }
  }
}

const isRemotePairingManagerSender = (event: IpcMainInvokeEvent): boolean =>
  event.sender.id < 0 &&
  (event.sender as unknown as { canManageRemotePairing?: boolean }).canManageRemotePairing === true

const defaultRegistry = createIpcHandlerRegistry(ipcMain)

const ipcMainHandle = defaultRegistry.ipcMainHandle
const webRpc = defaultRegistry.webRpc

export { createIpcHandlerRegistry, ipcMainHandle, isRemotePairingManagerSender, webRpc }

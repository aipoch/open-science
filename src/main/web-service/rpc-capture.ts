import { EventEmitter } from 'node:events'

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

class WebIpcSender extends EventEmitter {
  readonly id: number

  constructor(id: number) {
    super()
    this.id = id
  }

  destroy(): void {
    this.emit('destroyed')
    this.removeAllListeners()
  }
}

export type RpcCapture = {
  invoke: (channel: string, clientId: string, args: unknown[]) => Promise<unknown>
  releaseClient: (clientId: string) => void
  dispose: () => void
  channels: () => string[]
}

const installRpcCapture = (ipcMain: IpcMain): RpcCapture => {
  const handlers = new Map<string, IpcHandler>()
  const senders = new Map<string, WebIpcSender>()
  const originalHandle = ipcMain.handle.bind(ipcMain)
  let nextSenderId = -1

  ipcMain.handle = ((channel: string, listener: IpcHandler): void => {
    handlers.set(channel, listener)
    originalHandle(channel, listener)
  }) as IpcMain['handle']

  const senderFor = (clientId: string): WebIpcSender => {
    const existing = senders.get(clientId)
    if (existing) return existing
    const sender = new WebIpcSender(nextSenderId--)
    senders.set(clientId, sender)
    return sender
  }

  return {
    invoke: async (channel, clientId, args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`Unknown RPC channel: ${channel}`)
      const sender = senderFor(clientId)
      const event = { sender } as unknown as IpcMainInvokeEvent
      return handler(event, ...args)
    },
    releaseClient: (clientId) => {
      senders.get(clientId)?.destroy()
      senders.delete(clientId)
    },
    dispose: () => {
      ipcMain.handle = originalHandle as IpcMain['handle']
      for (const sender of senders.values()) sender.destroy()
      senders.clear()
      handlers.clear()
    },
    channels: () => [...handlers.keys()].sort()
  }
}

export { installRpcCapture }

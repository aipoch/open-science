import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const native = vi.hoisted(() => ({
  handlers: new Map<string, Parameters<IpcMain['handle']>[1]>(),
  failAt: undefined as string | undefined,
  windows: [
    { isDestroyed: () => false, webContents: { send: vi.fn() } },
    { isDestroyed: () => false, webContents: { send: vi.fn() } }
  ]
}))

// Exercise the real registrar, registry, event hub and Electron broadcast projection.
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<IpcMain['handle']>[1]) => {
      if (native.failAt === channel) throw new Error(`install failed: ${channel}`)
      if (native.handlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      native.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => native.handlers.delete(channel)
  },
  BrowserWindow: { getAllWindows: () => native.windows }
}))

import { ApplicationEventHub } from '../application-events'
import { disposeIpcHandlerRegistry, ipcMainHandle } from '../ipc-handler-registry'
import { installRendererBroadcastEventHub } from '../renderer-broadcast'
import type { UploadCommandOwner } from '../uploads/command-owner'
import type { UploadedAttachment } from '../../shared/uploads'
import { createUploadElectronSurface } from './uploads'

const caller = (): {
  sender: EventEmitter & { id: number; send: ReturnType<typeof vi.fn> }
  event: IpcMainInvokeEvent
} => {
  const sender = Object.assign(new EventEmitter(), { id: 42, send: vi.fn() })
  return { sender, event: { sender } as unknown as IpcMainInvokeEvent }
}
const attachment: UploadedAttachment = {
  id: 'file',
  sessionId: 'standalone-uploads',
  name: 'data.csv',
  originalName: 'data.csv',
  path: resolve('managed', 'data.csv'),
  size: 3
}
const fixture = (): {
  owner: UploadCommandOwner
  stageLocalPath: Mock<UploadCommandOwner['stageLocalPath']>
  beginTransfer: Mock<UploadCommandOwner['beginTransfer']>
  pending: ReturnType<typeof Promise.withResolvers<UploadedAttachment>>
} => {
  const pending = Promise.withResolvers<UploadedAttachment>()
  const stageLocalPath = vi.fn<UploadCommandOwner['stageLocalPath']>(() => pending.promise)
  const beginTransfer = vi.fn<UploadCommandOwner['beginTransfer']>()
  // Supply only exercised methods. Production must use this owner, not construct a fallback.
  const owner = { stageLocalPath, beginTransfer } as unknown as UploadCommandOwner
  return { owner, stageLocalPath, beginTransfer, pending }
}
let hub: ApplicationEventHub
let uninstallHub: () => void

beforeEach(() => {
  hub = new ApplicationEventHub()
  uninstallHub = installRendererBroadcastEventHub(hub)
  native.windows.forEach((window) => window.webContents.send.mockClear())
})
afterEach(() => {
  uninstallHub()
  hub.dispose()
  disposeIpcHandlerRegistry()
  native.failAt = undefined
  expect(native.handlers.size).toBe(0)
})

describe('upload Electron production surface', () => {
  it('lazily installs ten channels and idempotently removes only its own handlers', async () => {
    const surface = createUploadElectronSurface(fixture().owner)
    expect(surface.name).toBe('uploads')
    expect(native.handlers.size).toBe(0)
    ipcMainHandle('test:external', () => undefined)
    const installation = await surface.install()
    expect([...native.handlers.keys()].filter((channel) => channel.startsWith('uploads:'))).toEqual(
      [
        'uploads:stage-local-file',
        'uploads:claim-local-file',
        'uploads:stage-local-path',
        'uploads:begin-transfer',
        'uploads:append-transfer',
        'uploads:transfer-status',
        'uploads:finish-transfer',
        'uploads:abort-transfer',
        'uploads:delete',
        'uploads:read-preview'
      ]
    )
    await installation.uninstall()
    await installation.uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    await (await surface.install()).uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
  })

  it.each([undefined, 'project-1'])(
    'publishes a Files refresh only after saving for project %s',
    async (projectId) => {
      const { owner, stageLocalPath, pending } = fixture()
      await createUploadElectronSurface(owner).install()
      const { event, sender } = caller()
      const request = {
        transferId: 'transfer',
        name: 'data.csv',
        sourcePath: resolve('data.csv'),
        projectId
      }
      const received = vi.fn()
      hub.subscribe(received)
      const result = native.handlers.get('uploads:stage-local-path')!(event, request)
      const [invocation, progressTarget] = stageLocalPath.mock.calls[0]
      expect(invocation.args[0]).toBe(request)
      expect(invocation.callerContext.lifecycleClientId).toBe('electron:42')
      expect(invocation.callerLease.isCurrent()).toBe(true)
      const progress = { transferId: 'transfer', name: 'data.csv', receivedBytes: 1, totalBytes: 3 }
      progressTarget!.report(progress)
      expect(sender.send).toHaveBeenCalledExactlyOnceWith('uploads:transfer-progress', progress)
      expect(received).not.toHaveBeenCalled()
      native.windows.forEach((window) => expect(window.webContents.send).not.toHaveBeenCalled())

      pending.resolve(attachment)
      await expect(result).resolves.toBe(attachment)
      const payload = {
        projectId: projectId ?? 'default-project',
        sessionId: 'standalone-uploads',
        sources: ['upload'],
        kind: 'upsert'
      }
      expect(received).toHaveBeenCalledOnce()
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'project-files:changed', payload })
      )
      native.windows.forEach((window) =>
        expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith(
          'project-files:changed',
          payload
        )
      )
      expect(sender.send).toHaveBeenCalledOnce()
    }
  )

  it('propagates publication failures without sending a Files refresh', async () => {
    const { owner, pending } = fixture()
    await createUploadElectronSurface(owner).install()
    const received = vi.fn()
    hub.subscribe(received)
    const result = native.handlers.get('uploads:stage-local-path')!(caller().event, {})
    const failure = new Error('upload publication failed')
    const rejected = expect(result).rejects.toBe(failure)
    pending.reject(failure)
    await rejected
    expect(received).not.toHaveBeenCalled()
    native.windows.forEach((window) => expect(window.webContents.send).not.toHaveBeenCalled())
  })

  it('rolls back a partial upload installation without removing an earlier surface', async () => {
    ipcMainHandle('test:external', () => undefined)
    native.failAt = 'uploads:stage-local-path'
    const surface = createUploadElectronSurface(fixture().owner)
    expect(() => surface.install()).toThrow('install failed: uploads:stage-local-path')
    expect([...native.handlers.keys()]).toEqual(['test:external'])
    native.failAt = undefined
    await (await surface.install()).uninstall()
    expect([...native.handlers.keys()]).toEqual(['test:external'])
  })

  it('passes the registry lease to the owner and revokes it on navigation and registry disposal', async () => {
    const { owner, beginTransfer } = fixture()
    await createUploadElectronSurface(owner).install()
    const { sender, event } = caller()
    await native.handlers.get('uploads:begin-transfer')!(event, { transferId: 'first' })
    const first = beginTransfer.mock.calls[0][0].callerLease
    sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(first.signal.aborted).toBe(true)
    expect(first.isCurrent()).toBe(false)
    await native.handlers.get('uploads:begin-transfer')!(event, { transferId: 'second' })
    const second = beginTransfer.mock.calls[1][0].callerLease
    expect(second).not.toBe(first)
    expect(second.isCurrent()).toBe(true)
    disposeIpcHandlerRegistry()
    expect(second.signal.aborted).toBe(true)
    expect(second.isCurrent()).toBe(false)
  })
})

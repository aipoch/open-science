import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, request: unknown) => unknown>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, request: unknown) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  app: { getPath: (): string => '/unused', isPackaged: false }
}))

import { createIpcHandlerInstallationScope } from '../ipc-handler-registry'
import { waitForDataRootWriters } from '../storage/migration-state'
import { createUploadCommandOwner } from './command-owner'
import { registerUploadIpcHandlers } from './ipc'
import { UploadRepository } from './repository'

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}

describe('upload caller cancellation through native IPC', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])(
    'rejects both pending begins when the sender emits %s',
    async (eventName) => {
      const root = await mkdtemp(join(tmpdir(), 'upload-caller-cancel-'))
      cleanup.push(() => rm(root, { recursive: true, force: true }))
      const repository = new UploadRepository(root)
      const begin = repository.beginTransfer.bind(repository)
      const initialized = deferred()
      const resume = deferred()
      const calls = vi
        .spyOn(repository, 'beginTransfer')
        .mockImplementationOnce(async (request) => {
          const status = await begin(request)
          initialized.resolve()
          await resume.promise
          return status
        })
      const sender = Object.assign(new EventEmitter(), { id: 71, send: vi.fn() })
      const scope = createIpcHandlerInstallationScope()
      registerUploadIpcHandlers(createUploadCommandOwner(repository))
      const installed = scope.complete()
      cleanup.push(async () => {
        resume.resolve()
        sender.emit('destroyed')
        await waitForDataRootWriters()
        installed.uninstall()
      })
      const invoke = handlers.get('uploads:begin-transfer')!
      const request = { transferId: 'native-duplicate', name: 'data.csv', size: 10 }
      const first = Promise.resolve(invoke({ sender }, request))
      await initialized.promise
      const duplicate = Promise.resolve(invoke({ sender }, request))
      const results = Promise.allSettled([first, duplicate])
      sender.emit(eventName, { isMainFrame: true, isSameDocument: false })
      resume.resolve()
      const settled = await results
      await waitForDataRootWriters()

      expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
      for (const result of settled) {
        if (result.status === 'rejected')
          expect(result.reason.message).toContain('no longer available')
      }
      expect(calls).toHaveBeenCalledOnce()
    }
  )
})

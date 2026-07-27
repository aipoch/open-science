import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ homePath: '' }))
const ipcHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, request: unknown) => unknown>()
)

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.homePath,
    isPackaged: false
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, request: unknown) => unknown) =>
      ipcHandlers.set(channel, handler)
    )
  }
}))

import { dataFolderName } from '../storage-root'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'
import { createDefaultUploadRepository, registerUploadIpcHandlers } from './ipc'
import type { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'

const createIpcEvent = (
  id: number = 1
): {
  event: unknown
  emit: (channel: string, ...args: unknown[]) => void
} => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const on = (channel: string, listener: (...args: unknown[]) => void): void => {
    const channelListeners = listeners.get(channel) ?? new Set()
    channelListeners.add(listener)
    listeners.set(channel, channelListeners)
  }
  const removeListener = (channel: string, listener: (...args: unknown[]) => void): void => {
    listeners.get(channel)?.delete(listener)
  }
  const sender = {
    id,
    send: vi.fn(),
    on: vi.fn(on),
    once: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const onceListener = (...args: unknown[]): void => {
        removeListener(channel, onceListener)
        listener(...args)
      }
      on(channel, onceListener)
    }),
    removeListener: vi.fn(removeListener)
  }

  return {
    event: { sender },
    emit: (channel, ...args) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(...args)
    }
  }
}

describe('default upload repository', () => {
  let homeRoot: string | undefined

  afterEach(async () => {
    ipcHandlers.clear()
    clearMigrationPending()
    if (homeRoot) await rm(homeRoot, { recursive: true, force: true })
    homeRoot = undefined
  })

  it('stores and previews uploads under the default data root', async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-ipc-'))
    electronState.homePath = homeRoot
    const repository = createDefaultUploadRepository()
    const content = 'event,count\nheadache,4\n'

    const [attachment] = await stageUploadFixtures(repository, {
      files: [
        {
          name: 'adverse_events.csv',
          mimeType: 'text/csv',
          content: Buffer.from(content).toString('base64')
        }
      ]
    })

    // Uploads follow the configurable data root; a fresh dev install defaults to <home>/OpenScience-DEV.
    expect(attachment.path).toBe(
      join(
        homeRoot,
        dataFolderName(),
        'uploads',
        'default-project',
        '.pending',
        'adverse_events.csv'
      )
    )
    await expect(
      repository.readManagedUploadPreview({ path: attachment.path, encoding: 'utf8' })
    ).resolves.toMatchObject({ content })
  })

  it('holds one migration writer lease across the complete chunk transfer', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'transfer-1',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      appendTransfer: vi.fn(async () => ({
        transferId: 'transfer-1',
        name: 'data.csv',
        receivedBytes: 10,
        totalBytes: 10
      })),
      finishTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const append = ipcHandlers.get('uploads:append-transfer')!
    const finish = ipcHandlers.get('uploads:finish-transfer')!
    const { event } = createIpcEvent()

    await begin(event, { transferId: 'transfer-1', name: 'data.csv', size: 10 })
    beginMigration()
    await append(event, {
      transferId: 'transfer-1',
      offset: 0,
      chunk: new Uint8Array(10)
    })

    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await finish(event, { transferId: 'transfer-1' })
    await drainPromise
    expect(drained).toBe(true)
    expect(repository.appendTransfer).toHaveBeenCalledOnce()
    expect(repository.finishTransfer).toHaveBeenCalledOnce()
  })

  it('waits for begin before aborting and releases the transfer during migration', async () => {
    let finishBegin: (() => void) | undefined
    const repository = {
      beginTransfer: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishBegin = resolve
          })
      ),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const abort = ipcHandlers.get('uploads:abort-transfer')!
    const { event } = createIpcEvent()

    const beginPromise = Promise.resolve(
      begin(event, { transferId: 'transfer-2', name: 'data.csv', size: 10 })
    )
    beginMigration()
    const abortPromise = Promise.resolve(abort(event, { transferId: 'transfer-2' }))
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    finishBegin?.()
    await expect(beginPromise).rejects.toThrow(/renderer is no longer available/i)
    await abortPromise
    await drainPromise
    expect(drained).toBe(true)
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'transfer-2' })
  })

  it('aborts transfers and releases migration leases when their renderer is destroyed', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'transfer-3',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const sender = createIpcEvent()

    await begin(sender.event, { transferId: 'transfer-3', name: 'data.csv', size: 10 })
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    sender.emit('destroyed')
    await drainPromise
    expect(drained).toBe(true)
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'transfer-3' })
  })

  it('keeps the teardown lease until an in-flight append has settled', async () => {
    let finishAppend: ((status: unknown) => void) | undefined
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'transfer-in-flight',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      appendTransfer: vi.fn(
        () =>
          new Promise((resolve) => {
            finishAppend = resolve
          })
      ),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const append = ipcHandlers.get('uploads:append-transfer')!
    const sender = createIpcEvent()

    await begin(sender.event, {
      transferId: 'transfer-in-flight',
      name: 'data.csv',
      size: 10
    })
    const appendPromise = Promise.resolve(
      append(sender.event, {
        transferId: 'transfer-in-flight',
        offset: 0,
        chunk: new Uint8Array(10)
      })
    )
    await Promise.resolve()
    expect(repository.appendTransfer).toHaveBeenCalledOnce()
    beginMigration()
    sender.emit('destroyed')
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    finishAppend?.({
      transferId: 'transfer-in-flight',
      name: 'data.csv',
      receivedBytes: 10,
      totalBytes: 10
    })
    await appendPromise
    await drainPromise
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'transfer-in-flight' })
  })

  it('aborts transfers when their renderer starts a main-frame navigation', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'transfer-4',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const sender = createIpcEvent()

    await begin(sender.event, { transferId: 'transfer-4', name: 'data.csv', size: 10 })
    sender.emit('did-start-navigation', {}, 'http://localhost/', false, false)
    expect(repository.abortTransfer).not.toHaveBeenCalled()

    beginMigration()
    const drainPromise = waitForDataRootWriters()
    sender.emit('did-start-navigation', {}, 'http://localhost/', false, true)
    await drainPromise
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'transfer-4' })
  })

  it('does not expose the removed whole-file base64 staging channel', () => {
    registerUploadIpcHandlers({} as UploadRepository)

    expect(ipcHandlers.has('uploads:stage-files')).toBe(false)
  })
})

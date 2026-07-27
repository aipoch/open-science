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

    await begin(undefined, { transferId: 'transfer-1', name: 'data.csv', size: 10 })
    beginMigration()
    await append(undefined, {
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

    await finish(undefined, { transferId: 'transfer-1' })
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

    const beginPromise = Promise.resolve(
      begin(undefined, { transferId: 'transfer-2', name: 'data.csv', size: 10 })
    )
    beginMigration()
    const abortPromise = Promise.resolve(abort(undefined, { transferId: 'transfer-2' }))
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    finishBegin?.()
    await beginPromise
    await abortPromise
    await drainPromise
    expect(drained).toBe(true)
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'transfer-2' })
  })

  it('does not expose the removed whole-file base64 staging channel', () => {
    registerUploadIpcHandlers({} as UploadRepository)

    expect(ipcHandlers.has('uploads:stage-files')).toBe(false)
  })
})

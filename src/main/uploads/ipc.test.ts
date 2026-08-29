import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { createElectronCallerContext, type CallerContext } from '../caller-context'
import { createUploadCommandOwner } from './command-owner'
import {
  createDefaultUploadRepository,
  registerUploadIpcHandlers as registerUploadOwnerIpcHandlers
} from './ipc'
import type { UploadRepository } from './repository'
import { stageUploadFixtures } from './repository.test-utils'

const createIpcEvent = (
  id: number = 1,
  callerContext?: CallerContext
): {
  event: unknown
  emit: (channel: string, ...args: unknown[]) => void
  send: ReturnType<typeof vi.fn>
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
  const send = vi.fn()
  const sender = {
    id,
    callerContext,
    send,
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
    send,
    emit: (channel, ...args) => {
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(...args)
    }
  }
}

const registerUploadIpcHandlers = (
  repository: UploadRepository,
  options: {
    onStandaloneUploadSaved?: (projectId: string, sessionId: string) => void
  } = {}
): void => {
  const owner = createUploadCommandOwner(repository)
  registerUploadOwnerIpcHandlers(owner, {
    onStandaloneUploadSaved: options.onStandaloneUploadSaved
  })
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

  it('shares transfer ownership between legacy IPC and the injected command owner', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'shared-ipc-transfer',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      finishTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    registerUploadOwnerIpcHandlers(owner)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const finish = ipcHandlers.get('uploads:finish-transfer')!
    const caller = createIpcEvent(1)

    await begin(caller.event, {
      transferId: 'shared-ipc-transfer',
      name: 'data.csv',
      size: 10
    })

    const otherContext = createElectronCallerContext(2)
    const otherController = new AbortController()
    await expect(
      owner.finishTransfer({
        callerContext: otherContext,
        callerLease: {
          leaseId: otherContext.leaseId,
          generation: 1,
          signal: otherController.signal,
          isCurrent: () => true
        },
        args: [{ transferId: 'shared-ipc-transfer' }]
      })
    ).rejects.toThrow(/another renderer/i)
    expect(repository.finishTransfer).not.toHaveBeenCalled()

    await finish(caller.event, { transferId: 'shared-ipc-transfer' })
  })

  it('leaves finalize Session ownership to the runtime-validated command adapter', () => {
    registerUploadIpcHandlers({} as UploadRepository)

    expect(ipcHandlers.has('uploads:finalize-session')).toBe(false)
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

  it('isolates a same-ID replacement from the stale renderer lifecycle', async () => {
    const repository = {
      beginTransfer: vi.fn(async (request: { transferId: string; name: string; size: number }) => ({
        transferId: request.transferId,
        name: request.name,
        receivedBytes: 0,
        totalBytes: request.size
      })),
      finishTransfer: vi.fn(async () => undefined),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const finish = ipcHandlers.get('uploads:finish-transfer')!
    const staleRenderer = createIpcEvent(17)
    const replacement = createIpcEvent(17)

    await begin(staleRenderer.event, {
      transferId: 'stale-generation',
      name: 'old.csv',
      size: 5
    })
    await begin(replacement.event, {
      transferId: 'replacement-generation',
      name: 'new.csv',
      size: 7
    })
    await new Promise((resolve) => setImmediate(resolve))

    expect(repository.abortTransfer).toHaveBeenCalledTimes(1)
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'stale-generation' })

    staleRenderer.emit('destroyed')
    await new Promise((resolve) => setImmediate(resolve))
    expect(repository.abortTransfer).not.toHaveBeenCalledWith({
      transferId: 'replacement-generation'
    })

    await expect(
      finish(replacement.event, { transferId: 'replacement-generation' })
    ).resolves.toBeUndefined()
    expect(repository.finishTransfer).toHaveBeenCalledWith({
      transferId: 'replacement-generation'
    })
  })

  it('releases a crashed caller generation exactly once', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'crashed-transfer',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const begin = ipcHandlers.get('uploads:begin-transfer')!
    const caller = createIpcEvent(23)

    await begin(caller.event, {
      transferId: 'crashed-transfer',
      name: 'data.csv',
      size: 10
    })
    caller.emit('render-process-gone')
    caller.emit('destroyed')

    await vi.waitFor(() => {
      expect(repository.abortTransfer).toHaveBeenCalledTimes(1)
    })
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'crashed-transfer' })
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

  it('aborts a native-path upload and releases its migration lease when its renderer is destroyed', async () => {
    let rejectStage: ((error: Error) => void) | undefined
    const repository = {
      stageLocalFile: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectStage = reject
          })
      ),
      abortTransfer: vi.fn(async () => {
        rejectStage?.(new Error('Upload cancelled: data.csv'))
      })
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalFile = ipcHandlers.get('uploads:stage-local-file')!
    const sender = createIpcEvent()

    const stagePromise = Promise.resolve(
      stageLocalFile(sender.event, {
        transferId: 'local-transfer-1',
        sourcePath: '/fixtures/data.csv',
        name: 'data.csv',
        size: 10
      })
    )
    await Promise.resolve()
    beginMigration()
    sender.emit('destroyed')
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await expect(stagePromise).rejects.toThrow(/upload cancelled/i)
    await drainPromise
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'local-transfer-1' })
    expect(drained).toBe(true)
  })

  it('deletes a native-path upload that finishes after its renderer starts navigating', async () => {
    let finishStage: ((attachment: unknown) => void) | undefined
    const attachment = {
      id: 'attachment-1',
      sessionId: '.pending',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/managed/.pending/data.csv',
      size: 10
    }
    const repository = {
      stageLocalFile: vi.fn(
        () =>
          new Promise((resolve) => {
            finishStage = resolve
          })
      ),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalFile = ipcHandlers.get('uploads:stage-local-file')!
    const sender = createIpcEvent()

    const stagePromise = Promise.resolve(
      stageLocalFile(sender.event, {
        transferId: 'local-transfer-2',
        sourcePath: '/fixtures/data.csv',
        name: 'data.csv',
        size: 10
      })
    )
    await Promise.resolve()
    sender.emit('did-start-navigation', {}, 'http://localhost/', false, false)
    expect(repository.abortTransfer).not.toHaveBeenCalled()

    sender.emit('did-start-navigation', {}, 'http://localhost/', false, true)
    finishStage?.(attachment)

    await expect(stagePromise).rejects.toThrow(/renderer is no longer available/i)
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'local-transfer-2' })
    expect(repository.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
  })

  it('keeps a completed native-path upload owned until the renderer claims it', async () => {
    const attachment = {
      id: 'attachment-awaiting-claim',
      sessionId: '.pending',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/managed/.pending/data.csv',
      size: 10
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalFile = ipcHandlers.get('uploads:stage-local-file')!
    const sender = createIpcEvent()

    await expect(
      stageLocalFile(sender.event, {
        transferId: 'local-transfer-awaiting-claim',
        sourcePath: '/fixtures/data.csv',
        name: 'data.csv',
        size: 10
      })
    ).resolves.toEqual(attachment)

    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    sender.emit('destroyed')
    await drainPromise
    await vi.waitFor(() => {
      expect(repository.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
    })
    expect(drained).toBe(true)
  })

  it('releases a completed native-path upload after the owning renderer claims it', async () => {
    const attachment = {
      id: 'attachment-claimed',
      sessionId: '.pending',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/managed/.pending/data.csv',
      size: 10
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalFile = ipcHandlers.get('uploads:stage-local-file')!
    const claim = ipcHandlers.get('uploads:claim-local-file')!
    const sender = createIpcEvent()

    await stageLocalFile(sender.event, {
      transferId: 'local-transfer-claimed',
      sourcePath: '/fixtures/data.csv',
      name: 'data.csv',
      size: 10
    })
    await claim(sender.event, { transferId: 'local-transfer-claimed' })
    sender.emit('destroyed')

    expect(repository.deleteUpload).not.toHaveBeenCalled()
  })

  it('routes native-path progress through the owning caller sender', async () => {
    const progress = {
      transferId: 'local-transfer-progress',
      receivedBytes: 4,
      totalBytes: 10
    }
    const attachment = {
      id: 'attachment-progress',
      sessionId: '.pending',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/managed/.pending/data.csv',
      size: 10
    }
    const repository = {
      stageLocalFile: vi.fn(async (_request, onProgress: (value: typeof progress) => void) => {
        onProgress(progress)
        return attachment
      }),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalFile = ipcHandlers.get('uploads:stage-local-file')!
    const claim = ipcHandlers.get('uploads:claim-local-file')!
    const caller = createIpcEvent(29)

    await stageLocalFile(caller.event, {
      transferId: 'local-transfer-progress',
      sourcePath: '/fixtures/data.csv',
      name: 'data.csv',
      size: 10
    })

    expect(caller.send).toHaveBeenCalledWith('uploads:transfer-progress', progress)
    await claim(caller.event, { transferId: 'local-transfer-progress' })
  })

  it('routes standalone local-path progress only through the invoking caller sender', async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-ipc-'))
    const sourcePath = join(homeRoot, 'standalone-progress.csv')
    await writeFile(sourcePath, 'event,count\nheadache,4\n')
    const progress = {
      transferId: 'local-path-progress',
      receivedBytes: 8,
      totalBytes: 23
    }
    const attachment = {
      id: 'standalone-progress-attachment',
      sessionId: '.pending',
      name: 'standalone-progress.csv',
      originalName: 'standalone-progress.csv',
      path: '/managed/.pending/standalone-progress.csv',
      size: 23
    }
    const repository = {
      stageLocalFile: vi.fn(async (_request, report: (value: typeof progress) => void) => {
        report(progress)
        return attachment
      }),
      finalizePendingSessionUploads: vi.fn(async () => [attachment])
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalPath = ipcHandlers.get('uploads:stage-local-path')!
    const caller = createIpcEvent(31)
    const otherCaller = createIpcEvent(32)

    await stageLocalPath(caller.event, {
      transferId: 'local-path-progress',
      sourcePath,
      name: 'standalone-progress.csv'
    })

    expect(caller.send).toHaveBeenCalledWith('uploads:transfer-progress', progress)
    expect(otherCaller.send).not.toHaveBeenCalled()
  })

  it('does not let another renderer cancel an active native-path upload', async () => {
    let finishStage: ((attachment: unknown) => void) | undefined
    const attachment = {
      id: 'attachment-owned',
      sessionId: '.pending',
      name: 'data.csv',
      originalName: 'data.csv',
      path: '/managed/.pending/data.csv',
      size: 10
    }
    const repository = {
      stageLocalFile: vi.fn(
        () =>
          new Promise((resolve) => {
            finishStage = resolve
          })
      ),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalFile = ipcHandlers.get('uploads:stage-local-file')!
    const abort = ipcHandlers.get('uploads:abort-transfer')!
    const claim = ipcHandlers.get('uploads:claim-local-file')!
    const owner = createIpcEvent(1)
    const otherRenderer = createIpcEvent(2)

    const stagePromise = Promise.resolve(
      stageLocalFile(owner.event, {
        transferId: 'local-transfer-owned',
        sourcePath: '/fixtures/data.csv',
        name: 'data.csv',
        size: 10
      })
    )
    await Promise.resolve()

    await expect(
      abort(otherRenderer.event, { transferId: 'local-transfer-owned' })
    ).rejects.toThrow(/another renderer/i)
    expect(repository.abortTransfer).not.toHaveBeenCalled()

    finishStage?.(attachment)
    await expect(stagePromise).resolves.toEqual(attachment)
    await claim(owner.event, { transferId: 'local-transfer-owned' })
  })

  it('stages a local path upload with a main-side size and releases its lease immediately', async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-ipc-'))
    const sourcePath = join(homeRoot, 'proxy.log')
    await writeFile(sourcePath, 'local preview bytes')
    const attachment = {
      id: 'attachment-local-path',
      sessionId: '.pending',
      name: 'proxy.log',
      originalName: 'proxy.log',
      path: '/managed/.pending/proxy.log',
      size: 19
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      finalizePendingSessionUploads: vi.fn(async () => [attachment]),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalPath = ipcHandlers.get('uploads:stage-local-path')!
    const sender = createIpcEvent()

    await expect(
      stageLocalPath(sender.event, {
        transferId: 'local-path-transfer-1',
        sourcePath,
        name: 'proxy.log'
      })
    ).resolves.toEqual(attachment)

    expect(repository.stageLocalFile).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: 'local-path-transfer-1',
        sourcePath,
        name: 'proxy.log',
        size: 19
      }),
      expect.any(Function)
    )
    // Finalization publishes the upload to SQLite so it appears in "Your uploads".
    expect(repository.finalizePendingSessionUploads).toHaveBeenCalledWith(
      'standalone-uploads',
      [attachment],
      'default-project'
    )

    // No claim arrives for this transfer: the lease is already released, so migration is not
    // blocked and renderer teardown does not delete the staged upload.
    beginMigration()
    await waitForDataRootWriters()
    sender.emit('destroyed')
    await new Promise((resolve) => setImmediate(resolve))
    expect(repository.deleteUpload).not.toHaveBeenCalled()
  })

  it('calls onStandaloneUploadSaved after publishing a local path upload to SQLite', async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-ipc-'))
    const sourcePath = join(homeRoot, 'notes.txt')
    await writeFile(sourcePath, 'standalone upload content')
    const attachment = {
      id: 'attachment-standalone',
      sessionId: '.pending',
      name: 'notes.txt',
      originalName: 'notes.txt',
      path: '/managed/.pending/notes.txt',
      size: 24
    }
    const onStandaloneUploadSaved = vi.fn()
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      finalizePendingSessionUploads: vi.fn(async () => [attachment]),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository, { onStandaloneUploadSaved })
    const stageLocalPath = ipcHandlers.get('uploads:stage-local-path')!
    const sender = createIpcEvent()

    await stageLocalPath(sender.event, {
      transferId: 'local-path-standalone',
      sourcePath,
      name: 'notes.txt'
    })

    // finalizePendingSessionUploads writes uploadFile + uploadVersion + ManagedFile rows so
    // the file appears in "Your uploads" without an active conversation session.
    expect(repository.finalizePendingSessionUploads).toHaveBeenCalledWith(
      'standalone-uploads',
      [attachment],
      'default-project'
    )
    // The callback lets ipc.ts broadcast project-files:changed to the renderer.
    expect(onStandaloneUploadSaved).toHaveBeenCalledWith('default-project', 'standalone-uploads')
  })

  it('rejects a malformed local path upload request before staging', async () => {
    const repository = {
      stageLocalFile: vi.fn()
    } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalPath = ipcHandlers.get('uploads:stage-local-path')!

    await expect(
      stageLocalPath(createIpcEvent().event, {
        transferId: 'local-path-transfer-bad',
        name: 'proxy.log',
        sourcePath: '   '
      })
    ).rejects.toThrow('Invalid local path upload request.')
    expect(repository.stageLocalFile).not.toHaveBeenCalled()
  })

  it.each([
    ['relative', 'relative/notes.txt'],
    ['control characters', '/Users/example/notes .txt']
  ])('rejects a local path upload with %s before touching the filesystem', async (_label, path) => {
    const repository = { stageLocalFile: vi.fn() } as unknown as UploadRepository
    registerUploadIpcHandlers(repository)
    const stageLocalPath = ipcHandlers.get('uploads:stage-local-path')!

    await expect(
      stageLocalPath(createIpcEvent().event, {
        transferId: 'local-path-transfer-invalid',
        name: 'notes.txt',
        sourcePath: path
      })
    ).rejects.toThrow('Invalid local path upload request.')
    expect(repository.stageLocalFile).not.toHaveBeenCalled()
  })

  it('discards the staged copy when publishing a local path upload fails', async () => {
    homeRoot = await mkdtemp(join(tmpdir(), 'open-science-upload-ipc-'))
    const sourcePath = join(homeRoot, 'orphan.txt')
    await writeFile(sourcePath, 'orphan candidate')
    const attachment = {
      id: 'attachment-orphan',
      sessionId: '.pending',
      name: 'orphan.txt',
      originalName: 'orphan.txt',
      path: '/managed/.pending/orphan.txt',
      size: 16
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      // Staging committed its bytes, then the SQLite publish fails.
      finalizePendingSessionUploads: vi.fn(async () => {
        throw new Error('publish failed')
      }),
      abortTransfer: vi.fn(async () => undefined),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const onStandaloneUploadSaved = vi.fn()
    registerUploadIpcHandlers(repository, { onStandaloneUploadSaved })
    const stageLocalPath = ipcHandlers.get('uploads:stage-local-path')!

    await expect(
      stageLocalPath(createIpcEvent().event, {
        transferId: 'local-path-orphan',
        sourcePath,
        name: 'orphan.txt'
      })
    ).rejects.toThrow('publish failed')

    // Without this the .pending/ copy survives with no Version row and no sweep to reclaim it.
    expect(repository.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
    expect(onStandaloneUploadSaved).not.toHaveBeenCalled()
  })

  it('does not expose the removed whole-file base64 staging channel', () => {
    registerUploadIpcHandlers({} as UploadRepository)

    expect(ipcHandlers.has('uploads:stage-files')).toBe(false)
  })
})

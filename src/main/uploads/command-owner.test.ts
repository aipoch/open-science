import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApplicationInvocation } from '../application-command-router'
import { createElectronCallerContext } from '../caller-context'
import { ApplicationCallerLeaseRegistry } from '../caller-lifecycle'
import type { DataContentApplicationCommandDependencies } from '../data-content-application-commands'
import { createUploadVersionReference, DEFAULT_UPLOAD_PROJECT_ID } from '../../shared/uploads'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'
import { createUploadCommandOwner } from './command-owner'
import { UploadRepository } from './repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

type TestCaller = Readonly<{
  context: ReturnType<typeof createElectronCallerContext>
  ownedLease: ReturnType<ApplicationCallerLeaseRegistry['acquire']>
}>

const createCaller = (leases: ApplicationCallerLeaseRegistry, id: number): TestCaller => {
  const context = createElectronCallerContext(id)
  return { context, ownedLease: leases.acquire(context) }
}

const invocationFor = <Args extends readonly unknown[]>(
  caller: TestCaller,
  args: Args
): ApplicationInvocation<Args> => ({
  callerContext: caller.context,
  callerLease: caller.ownedLease.lease,
  args
})

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('upload command owner', () => {
  const temporaryRoots: string[] = []

  afterEach(async () => {
    clearMigrationPending()
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
  })

  it('keeps one transfer owner across application command calls', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'shared-transfer',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      finishTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const firstCaller = createCaller(leases, 1)
    const secondCaller = createCaller(leases, 2)

    await owner.beginTransfer(
      invocationFor(firstCaller, [
        { transferId: 'shared-transfer', name: 'data.csv', size: 10 }
      ] as const)
    )

    await expect(
      owner.finishTransfer(
        invocationFor(secondCaller, [{ transferId: 'shared-transfer' }] as const)
      )
    ).rejects.toThrow(/another renderer/i)
    await expect(
      owner.finishTransfer(invocationFor(firstCaller, [{ transferId: 'shared-transfer' }] as const))
    ).resolves.toBeUndefined()
    expect(repository.finishTransfer).toHaveBeenCalledOnce()
  })

  it('reports native staging progress only through the invoking adapter', async () => {
    const progress = {
      transferId: 'native-transfer',
      name: 'data.csv',
      receivedBytes: 4,
      totalBytes: 10
    }
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
        async (_request: unknown, onProgress: (value: typeof progress) => void) => {
          onProgress(progress)
          return attachment
        }
      )
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 7)
    const report = vi.fn()

    await expect(
      owner.stageLocalFile(
        invocationFor(caller, [
          {
            transferId: 'native-transfer',
            sourcePath: '/fixtures/data.csv',
            name: 'data.csv',
            size: 10
          }
        ] as const),
        { report }
      )
    ).resolves.toEqual(attachment)
    expect(report).toHaveBeenCalledWith(progress)

    owner.claimLocalFile(invocationFor(caller, [{ transferId: 'native-transfer' }] as const))
  })

  it('rejects an invalid standalone native path before staging', async () => {
    const repository = { stageLocalFile: vi.fn() } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 8)

    await expect(
      owner.stageLocalPath(
        invocationFor(caller, [
          { transferId: 'invalid-path', sourcePath: 'relative/data.csv', name: 'data.csv' }
        ] as const)
      )
    ).rejects.toThrow('Invalid local path upload request.')
    expect(repository.stageLocalFile).not.toHaveBeenCalled()
  })

  it('releases every transfer owned by a caller on adapter navigation cleanup', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'navigating-transfer',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 9)

    await owner.beginTransfer(
      invocationFor(caller, [
        { transferId: 'navigating-transfer', name: 'data.csv', size: 10 }
      ] as const)
    )
    owner.releaseCaller(caller.ownedLease.lease)

    await vi.waitFor(() => {
      expect(repository.abortTransfer).toHaveBeenCalledWith({
        transferId: 'navigating-transfer'
      })
    })
  })

  it('isolates a replacement caller generation from stale lease cleanup', async () => {
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
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const staleCaller = createCaller(leases, 16)

    await owner.beginTransfer(
      invocationFor(staleCaller, [
        { transferId: 'stale-generation', name: 'old.csv', size: 5 }
      ] as const)
    )

    const replacement = createCaller(leases, 16)
    expect(staleCaller.ownedLease.lease.signal.aborted).toBe(true)
    await vi.waitFor(() => {
      expect(repository.abortTransfer).toHaveBeenCalledTimes(1)
    })
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'stale-generation' })

    await owner.beginTransfer(
      invocationFor(replacement, [
        { transferId: 'replacement-generation', name: 'new.csv', size: 7 }
      ] as const)
    )
    staleCaller.ownedLease.release()
    owner.releaseCaller(staleCaller.ownedLease.lease)
    await new Promise((resolve) => setImmediate(resolve))

    expect(repository.abortTransfer).not.toHaveBeenCalledWith({
      transferId: 'replacement-generation'
    })
    await expect(
      owner.finishTransfer(
        invocationFor(replacement, [{ transferId: 'replacement-generation' }] as const)
      )
    ).resolves.toBeUndefined()
  })

  it('holds the data-root writer across a complete chunk transfer', async () => {
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'leased-transfer',
        name: 'data.csv',
        receivedBytes: 0,
        totalBytes: 10
      })),
      finishTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 10)

    await owner.beginTransfer(
      invocationFor(caller, [
        { transferId: 'leased-transfer', name: 'data.csv', size: 10 }
      ] as const)
    )
    beginMigration()
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    await owner.finishTransfer(invocationFor(caller, [{ transferId: 'leased-transfer' }] as const))
    await drain
    expect(drained).toBe(true)
  })

  it('waits for an in-flight append before caller cleanup aborts the transfer', async () => {
    let finishAppend: ((status: unknown) => void) | undefined
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'in-flight-transfer',
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
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 11)

    await owner.beginTransfer(
      invocationFor(caller, [
        { transferId: 'in-flight-transfer', name: 'data.csv', size: 10 }
      ] as const)
    )
    const append = owner.appendTransfer(
      invocationFor(caller, [
        {
          transferId: 'in-flight-transfer',
          offset: 0,
          chunk: new Uint8Array(10)
        }
      ] as const)
    )
    await Promise.resolve()
    beginMigration()
    owner.releaseCaller(caller.ownedLease.lease)
    let drained = false
    const drain = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(repository.abortTransfer).not.toHaveBeenCalled()

    finishAppend?.({
      transferId: 'in-flight-transfer',
      name: 'data.csv',
      receivedBytes: 10,
      totalBytes: 10
    })
    await append
    await drain
    expect(repository.abortTransfer).toHaveBeenCalledWith({ transferId: 'in-flight-transfer' })
  })

  it('rejects abort after finish wins terminal settlement', async () => {
    const finishing = deferred<undefined>()
    const repository = {
      beginTransfer: vi.fn(async () => ({
        transferId: 'settling-transfer',
        name: 'data.csv',
        receivedBytes: 10,
        totalBytes: 10
      })),
      finishTransfer: vi.fn(() => finishing.promise),
      abortTransfer: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 17)

    await owner.beginTransfer(
      invocationFor(caller, [
        { transferId: 'settling-transfer', name: 'data.csv', size: 10 }
      ] as const)
    )
    const finish = owner.finishTransfer(
      invocationFor(caller, [{ transferId: 'settling-transfer' }] as const)
    )
    await vi.waitFor(() => expect(repository.finishTransfer).toHaveBeenCalledOnce())

    try {
      await expect(
        owner.abortTransfer(invocationFor(caller, [{ transferId: 'settling-transfer' }] as const))
      ).rejects.toThrow('Upload transfer is already finishing')
      expect(repository.abortTransfer).not.toHaveBeenCalled()
    } finally {
      finishing.resolve(undefined)
      await finish
    }
  })

  it('deletes a staged native upload when its caller releases before claim', async () => {
    const attachment = {
      id: 'unclaimed-attachment',
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
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 12)

    await owner.stageLocalFile(
      invocationFor(caller, [
        {
          transferId: 'unclaimed-transfer',
          sourcePath: '/fixtures/data.csv',
          name: 'data.csv',
          size: 10
        }
      ] as const),
      { report: () => undefined }
    )
    owner.releaseCaller(caller.ownedLease.lease)

    await vi.waitFor(() => {
      expect(repository.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
    })
  })

  it('uses the native file size and releases standalone staging before publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upload-owner-'))
    temporaryRoots.push(root)
    const sourcePath = join(root, 'notes.txt')
    await writeFile(sourcePath, 'standalone upload')
    const attachment = {
      id: 'standalone-attachment',
      sessionId: '.pending',
      name: 'notes.txt',
      originalName: 'notes.txt',
      path: '/managed/.pending/notes.txt',
      size: 17
    }
    const published = {
      ...attachment,
      sessionId: 'standalone-uploads',
      path: join(root, 'versions', 'version-1', 'content'),
      versionId: 'version-1',
      versionNumber: 1,
      checksum: 'published-checksum',
      createdAt: '2026-09-05T00:00:00.000Z'
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      finalizePendingSessionUploads: vi.fn(async () => [published])
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 13)

    await expect(
      owner.stageLocalPath(
        invocationFor(caller, [
          {
            transferId: 'standalone-transfer',
            sourcePath,
            name: 'notes.txt',
            projectId: 'project-1'
          }
        ] as const)
      )
    ).resolves.toEqual(published)
    expect(repository.stageLocalFile).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath, size: 17 }),
      expect.any(Function)
    )
    expect(repository.finalizePendingSessionUploads).toHaveBeenCalledWith(
      'standalone-uploads',
      [attachment],
      'project-1'
    )

    beginMigration()
    await waitForDataRootWriters()
  })

  it('returns readable durable content and version identity after standalone publication', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upload-owner-'))
    temporaryRoots.push(root)
    const sourcePath = join(root, 'notes.txt')
    await writeFile(sourcePath, 'standalone upload')
    const client = createProjectDbClient(root)
    try {
      await migrateApplicationDatabase(client)
      const repository = new UploadRepository(root, { getClient: async () => client })
      const owner = createUploadCommandOwner(repository)
      const caller = createCaller(new ApplicationCallerLeaseRegistry(), 16)
      const attachment = await owner.stageLocalPath(
        invocationFor(caller, [
          { transferId: 'durable-transfer', sourcePath, name: 'notes.txt', projectId: 'project-1' }
        ] as const)
      )
      const file = await client.uploadFile.findUniqueOrThrow({
        where: { id: attachment.id },
        include: { currentVersion: true }
      })
      const version = file.currentVersion!
      const durablePath = join(root, ...version.contentStorageKey.split('/'))
      expect(file.sessionId).toBe('standalone-uploads')
      expect(version.state).toBe('ready')
      await expect(readFile(durablePath, 'utf8')).resolves.toBe('standalone upload')
      expect.soft(attachment).toMatchObject({
        sessionId: file.sessionId,
        path: durablePath,
        versionId: version.id,
        versionNumber: version.versionNumber,
        checksum: version.checksum,
        createdAt: version.createdAt?.toISOString()
      })
      await expect(stat(attachment.path)).resolves.toMatchObject({ size: 17 })
    } finally {
      await client.$disconnect()
    }
  })

  it.each([0, 2])('rejects standalone publication returning %i attachments', async (count) => {
    const root = await mkdtemp(join(tmpdir(), 'upload-owner-'))
    temporaryRoots.push(root)
    const sourcePath = join(root, 'notes.txt')
    await writeFile(sourcePath, 'standalone upload')
    const attachment = {
      id: 'standalone-attachment',
      sessionId: '.pending',
      name: 'notes.txt',
      originalName: 'notes.txt',
      path: join(root, '.pending', 'notes.txt'),
      size: 17
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      finalizePendingSessionUploads: vi.fn(async () =>
        Array.from({ length: count }, () => attachment)
      ),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const caller = createCaller(new ApplicationCallerLeaseRegistry(), 17)

    await expect(
      owner.stageLocalPath(
        invocationFor(caller, [
          { transferId: 'invalid-count-transfer', sourcePath, name: 'notes.txt' }
        ] as const)
      )
    ).rejects.toThrow(`Expected exactly one published standalone upload, received ${count}.`)
  })

  it('deletes the standalone copy when its durable publication fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'upload-owner-'))
    temporaryRoots.push(root)
    const sourcePath = join(root, 'orphan.txt')
    await writeFile(sourcePath, 'orphan')
    const attachment = {
      id: 'orphan-attachment',
      sessionId: '.pending',
      name: 'orphan.txt',
      originalName: 'orphan.txt',
      path: '/managed/.pending/orphan.txt',
      size: 6
    }
    const repository = {
      stageLocalFile: vi.fn(async () => attachment),
      finalizePendingSessionUploads: vi.fn(async () => {
        throw new Error('publish failed')
      }),
      deleteUpload: vi.fn(async () => undefined)
    } as unknown as UploadRepository
    const owner = createUploadCommandOwner(repository)
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 14)

    await expect(
      owner.stageLocalPath(
        invocationFor(caller, [
          { transferId: 'orphan-transfer', sourcePath, name: 'orphan.txt' }
        ] as const)
      )
    ).rejects.toThrow('publish failed')
    expect(repository.deleteUpload).toHaveBeenCalledWith({ path: attachment.path })
  })

  it('finalizes session uploads inside the injected session mutation', async () => {
    const repository = {
      finalizePendingSessionUploads: vi.fn(async () => [])
    } as unknown as UploadRepository
    const order: string[] = []
    const mutationScopes: Array<{ projectId: string; sessionId: string }> = []
    const withSessionMutation = async <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ): Promise<Result> => {
      mutationScopes.push({ projectId, sessionId })
      order.push('lock')
      const result = await mutation()
      order.push('unlock')
      return result
    }
    const owner = createUploadCommandOwner(repository, { withSessionMutation })
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 15)

    await owner.finalizeSession(
      invocationFor(caller, [
        { projectId: 'project-1', sessionId: 'session-1', attachments: [] }
      ] as const)
    )

    expect(mutationScopes).toEqual([{ projectId: 'project-1', sessionId: 'session-1' }])
    expect(order).toEqual(['lock', 'unlock'])
  })

  it('uses the default Project session mutation when finalization omits projectId', async () => {
    const repository = {
      finalizePendingSessionUploads: vi.fn(async () => [])
    } as unknown as UploadRepository
    const mutationScopes: Array<{ projectId: string; sessionId: string }> = []
    const withSessionMutation = async <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ): Promise<Result> => {
      mutationScopes.push({ projectId, sessionId })
      return mutation()
    }
    const owner = createUploadCommandOwner(repository, { withSessionMutation })
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 16)

    await owner.finalizeSession(
      invocationFor(caller, [{ sessionId: 'session-1', attachments: [] }] as const)
    )

    expect(mutationScopes).toEqual([
      { projectId: DEFAULT_UPLOAD_PROJECT_ID, sessionId: 'session-1' }
    ])
    expect(repository.finalizePendingSessionUploads).toHaveBeenCalledWith(
      'session-1',
      [],
      DEFAULT_UPLOAD_PROJECT_ID
    )
  })

  it('exposes the exact staged data-command owner interface', () => {
    const owner = createUploadCommandOwner({} as UploadRepository)
    const stagedOwner: DataContentApplicationCommandDependencies['uploads'] = owner

    expect(stagedOwner).toBe(owner)
  })

  it('rejects a path-only Upload preview instead of reopening repository bytes', async () => {
    const resolveManagedFilePath = vi.fn()
    const readManagedUploadPreview = vi.fn()
    const owner = createUploadCommandOwner(
      { readManagedUploadPreview } as unknown as UploadRepository,
      {}
    )
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 16)
    const request = {
      path: '/stale/upload.txt',
      maxBytes: 1024
    }

    await expect(owner.readPreview(invocationFor(caller, [request] as const))).rejects.toThrow(
      /logical identity/i
    )
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(readManagedUploadPreview).not.toHaveBeenCalled()
  })

  it('reads a logical Upload preview through the verified lease and always closes it', async () => {
    const bytes = Buffer.from('verified upload bytes')
    const close = vi.fn().mockResolvedValue(undefined)
    const verifyUnchanged = vi.fn().mockResolvedValue(undefined)
    const openManagedFileVersion = vi.fn().mockResolvedValue({
      size: bytes.byteLength,
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const chunk = bytes.subarray(position, position + length)
        buffer.set(chunk, offset)
        return { bytesRead: chunk.byteLength }
      }),
      verifyUnchanged,
      close
    })
    const resolveManagedFilePath = vi.fn().mockRejectedValue(new Error('must not resolve a path'))
    const readManagedUploadPreview = vi.fn()
    const owner = createUploadCommandOwner(
      { readManagedUploadPreview } as unknown as UploadRepository,
      { openManagedFileVersion }
    )
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 17)
    const request = {
      path: '/replaceable/upload.txt',
      projectId: 'project-1',
      fileId: 'upload-1',
      versionId: 'upload-v1',
      maxBytes: 1024
    }

    await expect(
      owner.readPreview(invocationFor(caller, [request] as const))
    ).resolves.toMatchObject({ content: 'verified upload bytes' })
    expect(openManagedFileVersion).toHaveBeenCalledWith(request)
    expect(resolveManagedFilePath).not.toHaveBeenCalled()
    expect(readManagedUploadPreview).not.toHaveBeenCalled()
    expect(verifyUnchanged).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('derives the logical Upload identity from a managed Version locator', async () => {
    const bytes = Buffer.from('managed upload bytes')
    const close = vi.fn().mockResolvedValue(undefined)
    const openManagedFileVersion = vi.fn().mockResolvedValue({
      size: bytes.byteLength,
      read: vi.fn(async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const chunk = bytes.subarray(position, position + length)
        buffer.set(chunk, offset)
        return { bytesRead: chunk.byteLength }
      }),
      verifyUnchanged: vi.fn().mockResolvedValue(undefined),
      close
    })
    const owner = createUploadCommandOwner({} as UploadRepository, { openManagedFileVersion })
    const leases = new ApplicationCallerLeaseRegistry()
    const caller = createCaller(leases, 18)
    const path = createUploadVersionReference('upload-v1', {
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'upload-1'
    })

    await expect(
      owner.readPreview(invocationFor(caller, [{ path, maxBytes: 1024 }] as const))
    ).resolves.toMatchObject({ content: 'managed upload bytes' })
    expect(openManagedFileVersion).toHaveBeenCalledWith({
      path,
      projectId: 'project-1',
      sessionId: 'session-1',
      fileId: 'upload-1',
      versionId: 'upload-v1',
      maxBytes: 1024
    })
    expect(close).toHaveBeenCalledOnce()
  })
})

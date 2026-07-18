import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ArtifactFile, ArtifactWriteSource } from '../../shared/artifacts'
import { ArtifactRepository } from './repository'
import { createArtifactHandlers } from './ipc'
import { ArtifactRunRegistry } from './run-registry'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'

let storageRoot: string | undefined

const createStorageRoot = async (): Promise<string> => {
  storageRoot = await mkdtemp(join(tmpdir(), 'open-science-artifact-ipc-'))
  return storageRoot
}

const createInlineSource = (
  content: string,
  encoding: 'utf8' | 'base64' = 'utf8'
): ArtifactWriteSource => ({
  kind: 'inline' as const,
  content,
  encoding
})

afterEach(async () => {
  clearMigrationPending()
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true })
    storageRoot = undefined
  }
})

describe('artifact IPC handlers', () => {
  const createFinalizedArtifact = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
    id: 'session-1:message-1:result.txt',
    projectName: 'default-project',
    sessionId: 'session-1',
    messageId: 'message-1',
    name: 'result.txt',
    path: '/tmp/result.txt',
    fileUrl: 'file:///tmp/result.txt',
    size: 2,
    mtimeMs: 1710000000000,
    ...overrides
  })

  it('finalizes pending files and lists message files through the repository', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    const finalized = await handlers.finalizeRunArtifacts({
      claimId,
      messageId: 'message-1'
    })
    const listed = await repository.listMessageFiles({
      projectName: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1'
    })

    expect(finalized.map((file) => file.name)).toEqual(['result.txt'])
    expect(listed).toEqual(finalized)
  })

  it('serializes concurrent finalize requests for the same claim', async () => {
    const finalizedArtifact = createFinalizedArtifact()
    let releaseFinalize: (() => void) | undefined
    const repository = {
      finalizeRunArtifacts: vi.fn(
        () =>
          new Promise<ArtifactFile[]>((resolve) => {
            releaseFinalize = () => resolve([finalizedArtifact])
          })
      ),
      listMessageFiles: vi.fn().mockResolvedValue([finalizedArtifact])
    } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry)
    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    const firstFinalize = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    const secondFinalize = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })

    await Promise.resolve()

    expect(repository.finalizeRunArtifacts).toHaveBeenCalledTimes(1)

    releaseFinalize?.()

    await expect(Promise.all([firstFinalize, secondFinalize])).resolves.toEqual([
      [finalizedArtifact],
      [finalizedArtifact]
    ])
    expect(repository.listMessageFiles).toHaveBeenCalledTimes(1)
  })

  it('keeps migration drain pending until an artifact finalization already in progress finishes', async () => {
    let releaseFinalize: (() => void) | undefined
    const repository = {
      finalizeRunArtifacts: vi.fn(
        () =>
          new Promise<ArtifactFile[]>((resolve) => {
            releaseFinalize = () => resolve([createFinalizedArtifact()])
          })
      )
    } as unknown as ArtifactRepository
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })
    const handlers = createArtifactHandlers(repository, registry)

    const finalizePromise = handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    releaseFinalize?.()
    await finalizePromise
    await drainPromise
    expect(drained).toBe(true)
  })

  it('opens only files inside the managed artifact root', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const openPath = vi.fn().mockResolvedValue('')
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry(), { openPath })
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    await handlers.openFile({ path: artifact.path })

    expect(openPath).toHaveBeenCalledWith(await realpath(artifact.path))
    await expect(handlers.openFile({ path: join(tmpdir(), 'outside.txt') })).rejects.toThrow(
      /outside artifact storage/
    )
  })

  it('reads only bounded preview text from managed artifact files', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('alpha\nbeta\ngamma')
    })

    await expect(handlers.readPreview({ path: artifact.path, maxBytes: 10 })).resolves.toEqual({
      content: 'alpha\nbeta',
      encoding: 'utf8',
      size: 16,
      truncated: true
    })
  })

  it('reads bounded base64 previews for small managed image artifacts', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'pixel.png',
      source: createInlineSource(Buffer.from('png-bytes').toString('base64'), 'base64'),
      mimeType: 'image/png'
    })

    await expect(
      handlers.readPreview({ path: artifact.path, maxBytes: 1024, encoding: 'base64' })
    ).resolves.toEqual({
      content: Buffer.from('png-bytes').toString('base64'),
      encoding: 'base64',
      size: 9,
      truncated: false
    })
  })

  it('rejects invalid preview encodings from renderer IPC input', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('alpha')
    })

    await expect(
      handlers.readPreview({ path: artifact.path, encoding: 'hex' as 'utf8' })
    ).rejects.toThrow(/Invalid artifact preview encoding/)
  })

  it('rejects preview reads outside the managed artifact root', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    await expect(handlers.readPreview({ path: join(tmpdir(), 'outside.txt') })).rejects.toThrow(
      /outside artifact storage/
    )
  })

  it('rejects unknown artifact finalize claims', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    await expect(
      handlers.finalizeRunArtifacts({
        claimId: 'missing-claim',
        messageId: 'message-1'
      })
    ).rejects.toThrow(/Artifact run claim not found/)
  })

  it('allows finalize replay only for the original message owner', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry)

    await repository.writePendingFile({
      projectName: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })
    const claimId = runRegistry.register({
      projectName: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    await handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-2' })
    ).rejects.toThrow(/already finalized/)
    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).resolves.toEqual([
      expect.objectContaining({
        name: 'result.txt',
        messageId: 'message-1'
      })
    ])
  })

  it('does not expose message file listing as a renderer IPC handler', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    expect('listMessageFiles' in handlers).toBe(false)
  })
})

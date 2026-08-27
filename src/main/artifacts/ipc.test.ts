import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createArtifactVersionLocator } from '../../shared/artifact-provenance'
import {
  ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
  type ArtifactFile,
  type ArtifactWriteSource
} from '../../shared/artifacts'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createPngBytes, createPngInlineSource } from './artifact-test-fixtures'
import {
  ArtifactFinalizationProofError,
  ArtifactOwnershipPersistenceRaceError,
  ArtifactProvenanceRepository
} from './provenance-repository'
import { ArtifactRepository } from './repository'
import {
  createArtifactHandlers,
  createDefaultArtifactRepository,
  registerArtifactIpcHandlers,
  type ArtifactHandlers
} from './ipc'
import { ArtifactRunRegistry } from './run-registry'
import {
  beginMigration,
  clearMigrationPending,
  waitForDataRootWriters
} from '../storage/migration-state'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

// Capture every ipcMain.handle registration so registerArtifactIpcHandlers can be verified directly.
// The mock is set up here (before importing the IPC module) so registering handlers in tests is
// observable without depending on a real Electron process.
const { ipcHandlers, registrationFailure } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  registrationFailure: {
    channel: undefined as string | undefined,
    error: undefined as Error | undefined
  }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      if (registrationFailure.channel === channel) throw registrationFailure.error
      ipcHandlers.set(channel, handler)
    }
  },
  shell: { openPath: vi.fn().mockResolvedValue('') },
  dialog: { showMessageBoxSync: vi.fn() }
}))

// Lock the data root to a known path so createDefaultArtifactRepository is testable in isolation.
// Existing tests don't touch the data-root resolver — they construct ArtifactRepository directly
// with a tempdir — so this stub doesn't affect their setup.
const ARTIFACT_DATA_ROOT = '/tmp/open-science-artifact-data-root'
vi.mock('../storage-root', () => ({
  resolveDataRoot: () => ARTIFACT_DATA_ROOT,
  resolveStorageRoot: () => '/tmp/open-science-artifact-config-root'
}))

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

// Reset the captured-IPC map between tests so registerArtifactIpcHandlers does not see
// registrations from a prior test case. Individual tests re-register as needed.
beforeEach(() => {
  ipcHandlers.clear()
  registrationFailure.channel = undefined
  registrationFailure.error = undefined
})

describe('artifact IPC handlers', () => {
  const createFinalizedArtifact = (overrides: Partial<ArtifactFile> = {}): ArtifactFile => ({
    id: 'session-1:message-1:result.txt',
    projectId: 'default-project',
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
      projectId: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    const claimId = runRegistry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })

    const finalized = await handlers.finalizeRunArtifacts({
      claimId,
      messageId: 'message-1'
    })
    const listed = await repository.listMessageFiles({
      projectId: 'default-project',
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
      projectId: 'default-project',
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

  it('finalizes compatibility files and provenance inside the shared Session mutation', async () => {
    const finalizedArtifact = createFinalizedArtifact()
    const callOrder: string[] = []
    const repository = {
      finalizeRunArtifacts: vi.fn(async () => {
        callOrder.push('compatibility')
        return [finalizedArtifact]
      })
    } as unknown as ArtifactRepository
    const provenance = {
      finalizeRun: vi.fn(async () => {
        callOrder.push('sqlite')
        return [finalizedArtifact]
      })
    }
    const mutationScopes: Array<{ projectId: string; sessionId: string }> = []
    const withSessionMutation = async <Result>(
      projectId: string,
      sessionId: string,
      mutation: () => Promise<Result>
    ): Promise<Result> => {
      mutationScopes.push({ projectId, sessionId })
      return mutation()
    }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      messageBranchAncestry: ['branch-parent', 'branch-1'],
      messageAncestry: ['prompt-1', 'message-1'],
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      artifactVersionIds: ['version-1']
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never,
      withSessionMutation
    })

    await handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })

    expect(mutationScopes).toEqual([{ projectId: 'default-project', sessionId: 'session-1' }])
    expect(callOrder).toEqual(['sqlite', 'compatibility'])
    expect(provenance.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-1',
        promptMessageId: 'prompt-1',
        artifactVersionIds: ['version-1']
      })
    )
    expect(provenance.finalizeRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageAncestry: expect.anything() })
    )
  })

  it('does not move compatibility files when the complete provenance proof is rejected', async () => {
    const repository = {
      finalizeRunArtifacts: vi.fn()
    } as unknown as ArtifactRepository
    const diagnosticLogger = { error: vi.fn() }
    const provenance = {
      finalizeRun: vi
        .fn()
        .mockRejectedValue(
          new ArtifactFinalizationProofError(
            'execution-snapshot-corrupt',
            'corrupt Artifact Version proof for /Users/private/result.txt: secret artifact contents'
          )
        )
    }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      artifactVersionIds: ['version-1']
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never,
      logger: diagnosticLogger
    })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-forged' })
    ).rejects.toThrow(/corrupt Artifact Version proof/i)
    expect(repository.finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(provenance.finalizeRun).toHaveBeenCalledOnce()
    expect(registry.resolve(claimId).finalizedMessageId).toBeUndefined()
    expect(diagnosticLogger.error).toHaveBeenCalledOnce()
    expect(diagnosticLogger.error).toHaveBeenCalledWith(
      'artifact finalization attempt failed',
      expect.objectContaining({
        stage: 'durable-finalization',
        failureKind: 'invalid-proof',
        proofFailureReason: 'execution-snapshot-corrupt',
        durableFinalizationCompleted: false,
        compatibilityPublicationCompleted: false,
        claimId,
        artifactRunId: 'run-1',
        artifactVersionIds: ['version-1'],
        artifactVersionCount: 1,
        messageId: 'message-forged',
        messageBranchId: 'branch-1'
      })
    )
    const diagnostic = JSON.stringify(diagnosticLogger.error.mock.calls[0])
    expect(diagnostic).not.toContain('secret artifact contents')
    expect(diagnostic).not.toContain('/Users/private')
  })

  it('does not bypass provenance when a claim is missing part of its durable context', async () => {
    const repository = {
      finalizeRunArtifacts: vi.fn()
    } as unknown as ArtifactRepository
    const diagnosticLogger = { error: vi.fn() }
    const provenance = { finalizeRun: vi.fn() }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      artifactVersionIds: ['version-1'],
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1'
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never,
      logger: diagnosticLogger
    })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).rejects.toThrow(/complete provenance context/i)
    expect(provenance.finalizeRun).not.toHaveBeenCalled()
    expect(repository.finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(diagnosticLogger.error).toHaveBeenCalledWith(
      'artifact finalization attempt failed',
      expect.objectContaining({
        failureKind: 'invalid-proof',
        proofFailureReason: 'claim-context-missing',
        artifactVersionCount: 1
      })
    )
  })

  it('reports an empty claimed Version set without invoking provenance', async () => {
    const repository = {
      finalizeRunArtifacts: vi.fn()
    } as unknown as ArtifactRepository
    const diagnosticLogger = { error: vi.fn() }
    const provenance = { finalizeRun: vi.fn() }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1'
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never,
      logger: diagnosticLogger
    })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).rejects.toMatchObject({ reasonCode: 'claim-version-ids-missing' })
    expect(provenance.finalizeRun).not.toHaveBeenCalled()
    expect(repository.finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(diagnosticLogger.error).toHaveBeenCalledWith(
      'artifact finalization attempt failed',
      expect.objectContaining({
        failureKind: 'invalid-proof',
        proofFailureReason: 'claim-version-ids-missing',
        artifactVersionCount: 0
      })
    )
  })

  it('keeps pending bytes in place when normal IPC encounters a corrupt provenance proof', async () => {
    const root = await createStorageRoot()
    const client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    try {
      const prompt = {
        id: 'prompt-1',
        role: 'user' as const,
        content: 'draw',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
      const message = {
        id: 'message-1',
        role: 'agent' as const,
        content: 'done',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
      const conversationGraph = createLinearConversationGraph({
        sessionId: 'session-1',
        messages: [prompt, message],
        frameworkId: 'codex',
        createdAt: 1,
        updatedAt: 2
      })
      const session: PersistedChatSession = {
        id: 'session-1',
        projectId: 'project-1',
        title: 'IPC proof',
        cwd: '/workspace',
        status: 'idle',
        messages: [prompt, message],
        conversationGraph,
        createdAt: 1,
        updatedAt: 2
      }
      const context = {
        rootFrameId: conversationGraph.rootFrameId,
        agentFrameId: conversationGraph.activeFrameId,
        messageBranchId: conversationGraph.branches[0].id,
        runtimeSegmentId: conversationGraph.runtimeSegments[0].id,
        promptMessageId: prompt.id
      }
      const compatibility = new ArtifactRepository(root)
      const provenance = new ArtifactProvenanceRepository({
        storageRoot: root,
        getClient: () => Promise.resolve(client),
        compatibilityRepository: compatibility,
        loadSession: async () => session
      })
      await compatibility.writePendingFile({
        projectId: 'project-1',
        sessionId: 'artifact-session-1',
        runId: 'run-1',
        filename: 'result.png',
        source: createPngInlineSource('result bytes')
      })
      const version = await provenance.createVersion({
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactStorageSessionId: 'artifact-session-1',
        artifactRunId: 'run-1',
        writeOperationId: 'write-1',
        writeRequestChecksum: 'a'.repeat(64),
        ...context,
        filename: 'result.png'
      })
      await client.artifactVersion.update({
        where: { id: version.versionId },
        data: {
          executionSnapshotJson: '{"schemaVersion":2}',
          executionSnapshotChecksum: '0'.repeat(64),
          executionSnapshotStorageKey: 'corrupt-execution.json',
          executionSnapshotSchemaVersion: 2
        }
      })
      await compatibility.prepareRunFinalization({
        projectId: 'project-1',
        sourceSessionId: 'artifact-session-1',
        sessionId: 'session-1',
        runId: 'run-1',
        artifactVersionIds: [version.versionId],
        provenanceContext: context
      })
      const registry = new ArtifactRunRegistry()
      const claimId = registry.register({
        projectId: 'project-1',
        artifactSessionId: 'artifact-session-1',
        sessionId: 'session-1',
        runId: 'run-1',
        artifactVersionIds: [version.versionId],
        ...context
      })
      const handlers = createArtifactHandlers(compatibility, registry, { provenance })

      await expect(
        handlers.finalizeRunArtifacts({ claimId, messageId: message.id })
      ).rejects.toMatchObject({
        name: 'ArtifactFinalizationProofError',
        reasonCode: 'execution-snapshot-corrupt',
        message: expect.stringMatching(/execution snapshot is corrupt/i)
      })
      await expect(
        compatibility.listPendingRunFiles({
          projectId: 'project-1',
          sessionId: 'artifact-session-1',
          runId: 'run-1'
        })
      ).resolves.toEqual([expect.objectContaining({ name: 'result.png' })])
      await expect(
        compatibility.listMessageFiles({
          projectId: 'project-1',
          sessionId: 'session-1',
          messageId: message.id
        })
      ).resolves.toEqual([])
      await expect(
        client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
      ).resolves.toMatchObject({ state: 'pending', messageId: null })
    } finally {
      await client.$disconnect()
    }
  })

  it('retries compatibility publication after provenance finalized but the first move failed', async () => {
    const finalizedArtifact = createFinalizedArtifact()
    const diagnosticLogger = { error: vi.fn() }
    const repository = {
      finalizeRunArtifacts: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'compatibility storage unavailable at /Users/private/result.txt: secret artifact contents'
          )
        )
        .mockResolvedValue([finalizedArtifact])
    } as unknown as ArtifactRepository
    const provenance = {
      finalizeRun: vi.fn().mockResolvedValue([finalizedArtifact])
    }
    const registry = new ArtifactRunRegistry()
    const claimId = registry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      artifactVersionIds: ['version-1']
    })
    const handlers = createArtifactHandlers(repository, registry, {
      provenance: provenance as never,
      logger: diagnosticLogger
    })

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).rejects.toThrow(/compatibility storage unavailable/)
    expect(repository.finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(provenance.finalizeRun).toHaveBeenCalledOnce()
    expect(registry.resolve(claimId).finalizedMessageId).toBeUndefined()
    expect(diagnosticLogger.error).toHaveBeenCalledWith(
      'artifact finalization attempt failed',
      expect.objectContaining({
        stage: 'compatibility-publication',
        failureKind: 'operational-failure',
        durableFinalizationCompleted: true,
        compatibilityPublicationCompleted: false,
        claimId,
        artifactRunId: 'run-1',
        artifactVersionIds: ['version-1'],
        artifactVersionCount: 1,
        messageId: 'message-1',
        messageBranchId: 'branch-1'
      })
    )
    expect(diagnosticLogger.error.mock.calls[0]?.[1]).not.toHaveProperty('proofFailureReason')
    const diagnostic = JSON.stringify(diagnosticLogger.error.mock.calls[0])
    expect(diagnostic).not.toContain('secret artifact contents')
    expect(diagnostic).not.toContain('/Users/private')

    await expect(
      handlers.finalizeRunArtifacts({ claimId, messageId: 'message-1' })
    ).resolves.toEqual([finalizedArtifact])
    expect(repository.finalizeRunArtifacts).toHaveBeenCalledTimes(2)
    expect(provenance.finalizeRun).toHaveBeenCalledTimes(2)
    expect(registry.resolve(claimId).finalizedMessageId).toBe('message-1')
    expect(diagnosticLogger.error).toHaveBeenCalledOnce()
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
      projectId: 'default-project',
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

  it('keeps migration drain pending until code reconstruction generation finishes', async () => {
    let releaseGeneration: (() => void) | undefined
    const codeReconstruction = {
      get: vi.fn(),
      generate: vi.fn(
        () =>
          new Promise<{
            state: 'ready'
            origin: 'llm'
            language: 'python'
            sourceTruncated: false
          }>((resolve) => {
            releaseGeneration = () =>
              resolve({ state: 'ready', origin: 'llm', language: 'python', sourceTruncated: false })
          })
      )
    }
    const handlers = createArtifactHandlers({} as ArtifactRepository, new ArtifactRunRegistry(), {
      codeReconstruction
    })
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }

    const generationPromise = handlers.generateCodeReconstruction(request)
    beginMigration()
    let drained = false
    const drainPromise = waitForDataRootWriters().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    releaseGeneration?.()
    await expect(generationPromise).resolves.toEqual({
      state: 'ready',
      origin: 'llm',
      language: 'python',
      sourceTruncated: false
    })
    await drainPromise
    expect(drained).toBe(true)
    expect(codeReconstruction.generate).toHaveBeenCalledWith(request)
  })

  it('opens only files inside the managed artifact root', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const openPath = vi.fn().mockResolvedValue('')
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry(), { openPath })
    const artifact = await repository.writePendingFile({
      projectId: 'default-project',
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
      projectId: 'default-project',
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
      projectId: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'pixel.png',
      source: createPngInlineSource('png-bytes'),
      mimeType: 'image/png'
    })

    await expect(
      handlers.readPreview({ path: artifact.path, maxBytes: 1024, encoding: 'base64' })
    ).resolves.toEqual({
      content: createPngBytes('png-bytes').toString('base64'),
      encoding: 'base64',
      size: createPngBytes('png-bytes').length,
      truncated: false
    })
  })

  it('rejects invalid preview encodings from renderer IPC input', async () => {
    const repository = new ArtifactRepository(await createStorageRoot())
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())
    const artifact = await repository.writePendingFile({
      projectId: 'default-project',
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
      projectId: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })
    const claimId = runRegistry.register({
      projectId: 'default-project',
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

  it('resolves copied-message Version descriptors through Provenance only', async () => {
    const descriptors = [
      {
        id: 'version-1',
        artifactId: 'artifact-1',
        versionId: 'version-1',
        versionNumber: 1,
        checksum: 'a'.repeat(64),
        createdAt: '2026-08-04T00:00:00.000Z',
        projectId: 'project-1',
        sessionId: 'source-session-1',
        runId: 'run-1',
        name: 'sin.png',
        mimeType: 'image/png',
        size: 12,
        mtimeMs: 1,
        state: 'finalized' as const
      }
    ]
    const resolveVersionDescriptors = vi.fn().mockResolvedValue(descriptors)
    const handlers = createArtifactHandlers({} as ArtifactRepository, new ArtifactRunRegistry(), {
      provenance: { resolveVersionDescriptors }
    } as never)

    await expect(
      handlers.resolveVersionDescriptors({
        projectId: 'project-1',
        appSessionId: 'branched-session',
        versionIds: ['version-1', 'version-1']
      })
    ).resolves.toEqual(descriptors)
    expect(resolveVersionDescriptors).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'branched-session',
      versionIds: ['version-1', 'version-1']
    })
  })

  it('excludes both prompt-active runs and unfinalized claims from the orphan scan', async () => {
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const repository = { listProjectArtifacts } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()

    // A run whose files were emitted and are awaiting the renderer's finalize call — it has left the
    // runtime's prompt-active set but must still be treated as in-flight, not orphaned.
    runRegistry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-awaiting-finalize'
    })

    const handlers = createArtifactHandlers(repository, runRegistry, {
      getActiveArtifactRunIds: () => ['run-in-prompt']
    })

    await handlers.listProjectFiles({ projectId: 'default-project' })

    const passedSet = listProjectArtifacts.mock.calls[0][1] as Set<string>
    expect([...passedSet].sort()).toEqual(['run-awaiting-finalize', 'run-in-prompt'])
  })

  it('drops a run from the exclusion set once its claim is finalized', async () => {
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const repository = { listProjectArtifacts } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const claimId = runRegistry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-done'
    })
    runRegistry.markFinalized(claimId, 'message-1')

    const handlers = createArtifactHandlers(repository, runRegistry)
    await handlers.listProjectFiles({ projectId: 'default-project' })

    const passedSet = listProjectArtifacts.mock.calls[0][1] as Set<string>
    expect(passedSet.has('run-done')).toBe(false)
  })
})

describe('artifact IPC handler registration', () => {
  it('creates the default repository rooted at the data root', () => {
    // Line 139: createDefaultArtifactRepository must use resolveDataRoot (artifacts follow the
    // relocatable data root), not the config root. Smoke-check the constructor wiring by reading the
    // private `storageRoot` field the constructor assigns. Do NOT default to ARTIFACT_DATA_ROOT when
    // the field is missing — that would hide a regression where someone passes the config root or
    // stops forwarding resolveDataRoot() entirely.
    const repository = createDefaultArtifactRepository()

    expect(repository).toBeInstanceOf(ArtifactRepository)
    const storedRoot = (repository as unknown as { storageRoot: string }).storageRoot
    expect(storedRoot).toBe(ARTIFACT_DATA_ROOT)
  })

  it('registers every renderer-visible artifact channel exactly once', () => {
    registerArtifactIpcHandlers()

    // Every command and Provenance query must be registered. Anything missing here is invisible to
    // the renderer — a regression we want to catch.
    expect([...ipcHandlers.keys()].sort()).toEqual([
      'artifacts:finalize-run',
      'artifacts:generate-code-reconstruction',
      'artifacts:get-code-reconstruction',
      'artifacts:get-lineage',
      'artifacts:get-version-execution',
      'artifacts:get-version-messages',
      'artifacts:get-version-provenance',
      'artifacts:get-version-review',
      'artifacts:list-project-files',
      'artifacts:open-file',
      'artifacts:read-preview',
      'artifacts:reconcile-pending',
      'artifacts:resolve-version-descriptors'
    ])
  })

  it('shares the injected artifact finalization lock with application commands', async () => {
    let releaseFinalize!: () => void
    const finalizePending = new Promise<ArtifactFile[]>((resolve) => {
      releaseFinalize = () => resolve([])
    })
    const repository = {
      finalizeRunArtifacts: vi.fn().mockReturnValue(finalizePending),
      listMessageFiles: vi.fn().mockResolvedValue([])
    } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const claimId = runRegistry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })
    const injected = createArtifactHandlers(repository, runRegistry)
    registerArtifactIpcHandlers(repository, runRegistry, undefined, undefined, undefined, injected)
    const request = { claimId, messageId: 'message-1' }

    const applicationFinalize = injected.finalizeRunArtifacts(request)
    await vi.waitFor(() => expect(repository.finalizeRunArtifacts).toHaveBeenCalledOnce())
    const electronFinalize = ipcHandlers.get('artifacts:finalize-run')?.({}, request)
    await Promise.resolve()

    expect(repository.finalizeRunArtifacts).toHaveBeenCalledOnce()
    releaseFinalize()
    await expect(applicationFinalize).resolves.toEqual([])
    await expect(electronFinalize).resolves.toEqual({ ok: true, artifacts: [] })
    expect(repository.finalizeRunArtifacts).toHaveBeenCalledOnce()
    expect(repository.listMessageFiles).toHaveBeenCalledOnce()
  })

  it('preserves an injected handler identity when registration fails', async () => {
    const failure = new Error('registration failed')
    const injected: ArtifactHandlers = {
      finalizeRunArtifacts: vi.fn(),
      listProjectFiles: vi.fn().mockResolvedValue([]),
      reconcilePendingArtifacts: vi.fn(),
      openFile: vi.fn(),
      readPreview: vi.fn(),
      getLineage: vi.fn(),
      getVersionProvenance: vi.fn(),
      getVersionExecution: vi.fn(),
      getVersionMessages: vi.fn(),
      getVersionReview: vi.fn(),
      getCodeReconstruction: vi.fn(),
      generateCodeReconstruction: vi.fn(),
      resolveVersionDescriptors: vi.fn()
    }
    registrationFailure.channel = 'artifacts:finalize-run'
    registrationFailure.error = failure

    expect(() =>
      registerArtifactIpcHandlers(undefined, undefined, undefined, undefined, undefined, injected)
    ).toThrow(failure)

    registrationFailure.channel = undefined
    registrationFailure.error = undefined
    registerArtifactIpcHandlers(undefined, undefined, undefined, undefined, undefined, injected)
    await ipcHandlers.get('artifacts:list-project-files')?.({}, { projectId: 'default-project' })
    expect(injected.listProjectFiles).toHaveBeenCalledOnce()
  })

  it('delegates each registered channel to the matching handler implementation', async () => {
    // Register with lightweight repositories whose methods are spies — this exercises the entire
    // ipcMain.handle -> createArtifactHandlers -> method chain for every channel.
    const finalizeRunArtifacts = vi.fn().mockResolvedValue([])
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const reconcilePendingArtifactPaths = vi.fn().mockResolvedValue([])
    const resolveManagedFilePath = vi.fn().mockResolvedValue('/managed/inside.txt')
    const readManagedFilePreview = vi.fn().mockResolvedValue({
      content: 'preview',
      encoding: 'utf8',
      size: 7,
      truncated: false
    })
    const repository = {
      finalizeRunArtifacts,
      listProjectArtifacts,
      reconcilePendingArtifactPaths,
      resolveManagedFilePath,
      readManagedFilePreview
    } as unknown as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const claimId = runRegistry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1'
    })
    registerArtifactIpcHandlers(repository, runRegistry)

    const finalizeResult = await ipcHandlers.get('artifacts:finalize-run')?.(
      {},
      {
        claimId,
        messageId: 'message-1'
      }
    )
    expect(finalizeResult).toEqual({ ok: true, artifacts: [] })
    expect(finalizeRunArtifacts).toHaveBeenCalledWith({
      projectId: 'default-project',
      sourceSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      messageId: 'message-1'
    })

    await ipcHandlers.get('artifacts:list-project-files')?.(
      {},
      {
        projectId: 'default-project'
      }
    )
    expect(listProjectArtifacts).toHaveBeenCalledWith('default-project', expect.any(Set))

    await ipcHandlers.get('artifacts:reconcile-pending')?.(
      {},
      {
        projectId: 'default-project',
        sessionId: 'session-1',
        messageId: 'message-1',
        pendingPaths: ['/p/.pending/run-1/a.txt']
      }
    )
    expect(reconcilePendingArtifactPaths).toHaveBeenCalledWith({
      projectId: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1',
      pendingPaths: ['/p/.pending/run-1/a.txt']
    })

    await ipcHandlers.get('artifacts:open-file')?.({}, { path: '/managed/inside.txt' })
    expect(resolveManagedFilePath).toHaveBeenCalledWith({ path: '/managed/inside.txt' })

    await ipcHandlers.get('artifacts:read-preview')?.(
      {},
      {
        path: '/managed/inside.txt',
        maxBytes: 16
      }
    )
    expect(readManagedFilePreview).toHaveBeenCalledWith({
      path: '/managed/inside.txt',
      maxBytes: 16
    })
  })

  it('delegates code reconstruction cache and generation through separate channels', async () => {
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    }
    const get = vi.fn().mockResolvedValue({
      state: 'ready',
      origin: 'llm',
      language: 'python',
      sourceTruncated: false
    })
    const generate = vi.fn().mockResolvedValue({
      state: 'cached',
      value: {
        origin: 'llm',
        code: 'print(1)',
        language: 'python',
        generatedAt: '2026-08-06T00:00:00.000Z',
        frameworkId: 'codex',
        model: 'model-a',
        sourceTruncated: false
      }
    })
    const repository = {} as ArtifactRepository
    const runRegistry = new ArtifactRunRegistry()
    const handlers = createArtifactHandlers(repository, runRegistry, {
      codeReconstruction: { get, generate }
    })
    registerArtifactIpcHandlers(repository, runRegistry, undefined, undefined, undefined, handlers)

    await expect(
      ipcHandlers.get('artifacts:get-code-reconstruction')?.({}, request)
    ).resolves.toMatchObject({ state: 'ready' })
    await expect(
      ipcHandlers.get('artifacts:generate-code-reconstruction')?.({}, request)
    ).resolves.toMatchObject({ state: 'cached' })
    expect(get).toHaveBeenCalledWith(request)
    expect(generate).toHaveBeenCalledWith(request)
  })

  it('returns only the ownership persistence race as a stable IPC failure result', async () => {
    const repository = { finalizeRunArtifacts: vi.fn() } as unknown as ArtifactRepository
    const diagnosticLogger = { error: vi.fn() }
    const provenance = {
      finalizeRun: vi
        .fn()
        .mockRejectedValue(
          new ArtifactOwnershipPersistenceRaceError(
            'The durable graph projection has not caught up with the selected owner.'
          )
        )
    }
    const runRegistry = new ArtifactRunRegistry()
    const claimId = runRegistry.register({
      projectId: 'default-project',
      artifactSessionId: 'artifact-session-1',
      sessionId: 'session-1',
      runId: 'run-1',
      rootFrameId: 'root-frame-1',
      agentFrameId: 'agent-frame-1',
      messageBranchId: 'branch-1',
      runtimeSegmentId: 'runtime-1',
      promptMessageId: 'prompt-1',
      artifactVersionIds: ['version-1']
    })
    const handlers = createArtifactHandlers(repository, runRegistry, {
      provenance: provenance as never,
      logger: diagnosticLogger
    })
    registerArtifactIpcHandlers(
      repository,
      runRegistry,
      undefined,
      provenance as never,
      undefined,
      handlers
    )

    await expect(
      ipcHandlers.get('artifacts:finalize-run')?.({}, { claimId, messageId: 'message-1' })
    ).resolves.toEqual({
      ok: false,
      code: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
      message: 'The durable graph projection has not caught up with the selected owner.'
    })
    expect(repository.finalizeRunArtifacts).not.toHaveBeenCalled()
    expect(runRegistry.resolve(claimId).finalizedMessageId).toBeUndefined()
    expect(diagnosticLogger.error).toHaveBeenCalledWith(
      'artifact finalization attempt failed',
      expect.objectContaining({
        failureKind: ARTIFACT_OWNERSHIP_PERSISTENCE_RACE,
        proofFailureReason: 'message-not-durable',
        artifactVersionCount: 1
      })
    )
  })

  it('resolves native Version preview locators through Provenance instead of filesystem paths', async () => {
    const root = await createStorageRoot()
    const contentPath = join(root, 'immutable-content')
    await writeFile(contentPath, 'version bytes')
    const readManagedFilePreview = vi.fn()
    const resolveVersionContent = vi.fn().mockResolvedValue({
      path: contentPath,
      filename: 'result.txt',
      contentType: 'text/plain'
    })
    const handlers = createArtifactHandlers(
      { readManagedFilePreview } as unknown as ArtifactRepository,
      new ArtifactRunRegistry(),
      { provenance: { resolveVersionContent } } as never
    )
    const identity = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-2'
    }

    await expect(
      handlers.readPreview({
        path: createArtifactVersionLocator(identity),
        maxBytes: 64
      })
    ).resolves.toMatchObject({ content: 'version bytes', size: 13, truncated: false })
    expect(resolveVersionContent).toHaveBeenCalledWith(identity)
    expect(readManagedFilePreview).not.toHaveBeenCalled()
  })

  it('threads a live getActiveArtifactRunIds closure into list-project-files', async () => {
    // Without getActiveArtifactRunIds the in-flight set defaults to empty. The registry-based
    // unfinalized-claim exclusion is exercised in the main suite; here we pin the runtime-side
    // thread (default vs. supplied) so a regression that loses the dependency is caught.
    const listProjectArtifacts = vi.fn().mockResolvedValue([])
    const repository = { listProjectArtifacts } as unknown as ArtifactRepository
    const activeIds = vi.fn().mockReturnValue(['run-active'])

    registerArtifactIpcHandlers(repository, new ArtifactRunRegistry(), activeIds)
    await ipcHandlers.get('artifacts:list-project-files')?.(
      {},
      {
        projectId: 'default-project'
      }
    )

    expect(activeIds).toHaveBeenCalled()
    const passedSet = listProjectArtifacts.mock.calls[0][1] as Set<string>
    expect([...passedSet]).toEqual(['run-active'])
  })
})

describe('artifact handler edge cases', () => {
  it('throws when the injected openPath returns a non-empty error string', async () => {
    // Lines 88-95: openFile shells out via the (dependency-injected) openPath; a non-empty return
    // value is an OS error message that must be propagated as a thrown Error so the renderer sees it.
    const repository = new ArtifactRepository(await createStorageRoot())
    const openPath = vi.fn().mockResolvedValue('no application is registered for this file type')
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry(), { openPath })
    const artifact = await repository.writePendingFile({
      projectId: 'default-project',
      sessionId: 'artifact-session-1',
      runId: 'run-1',
      filename: 'result.txt',
      source: createInlineSource('ok')
    })

    await expect(handlers.openFile({ path: artifact.path })).rejects.toThrow(
      /no application is registered for this file type/
    )
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it('delegates reconcilePendingArtifacts through withDataRootWrite and the repository', async () => {
    // Lines 86-87: reconcilePendingArtifacts wraps the repository call in withDataRootWrite so a
    // pending migration can block it. With no migration pending the gate is transparent and the
    // request reaches the repository verbatim.
    const reconcilePendingArtifactPaths = vi.fn().mockResolvedValue([])
    const repository = { reconcilePendingArtifactPaths } as unknown as ArtifactRepository
    const handlers = createArtifactHandlers(repository, new ArtifactRunRegistry())

    const request = {
      projectId: 'default-project',
      sessionId: 'session-1',
      messageId: 'message-1',
      pendingPaths: ['/p/.pending/run-1/a.txt', '/p/.pending/run-1/b.txt']
    }
    await handlers.reconcilePendingArtifacts(request)

    expect(reconcilePendingArtifactPaths).toHaveBeenCalledWith(request)
  })
})

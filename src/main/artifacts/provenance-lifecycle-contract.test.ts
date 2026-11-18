import { createPngBytes } from './artifact-test-fixtures'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import sharp from 'sharp'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureProvenanceRead } from '../../shared/provenance-read-result'

import type {
  ArtifactVersionEvidence,
  CreateArtifactVersionRequest,
  FinalizeArtifactVersionsRequest
} from '../../shared/artifact-provenance'
import {
  createLinearConversationGraph,
  projectConversationMessage
} from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  ArtifactOwnershipPersistenceRaceError,
  ArtifactProvenanceRepository
} from './provenance-repository'
import { canonicalJson, sha256, type CanonicalJson } from './provenance-canonical'
import { ProvenanceMessageSnapshotRepository } from './provenance-message-snapshot'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from './provenance-test-fixtures'
import { createRootNotebookLane } from '../notebook/lane-identity'
import { migrateApplicationDatabase } from '../projects/prisma-client'
import { ImmutableInputAuthority } from '../immutable-input-authority'
import { ManagedFileVersionService } from '../managed-file-versions/service'
import { NotebookInputRegistry } from '../notebook/input-registry'
import { ManagedFileIndexRepository } from '../project-files/repository'
import { stageUploadFixtures } from '../uploads/repository.test-utils'
import { UploadRepository } from '../uploads/repository'

type Fixture = Awaited<ReturnType<typeof createProvenanceTestFixture>>

const fixtures: Fixture[] = []
const fixture = async (): Promise<Fixture> => {
  const value = await createProvenanceTestFixture()
  fixtures.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((value) => value.dispose()))
})

const durableSession = (storageRoot: string): PersistedChatSession => {
  const conversationGraph = createLinearConversationGraph({
    sessionId: 'session-1',
    messages: [
      {
        id: 'prompt-1',
        role: 'user',
        content: 'draw a plot',
        status: 'complete',
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'message-1',
        role: 'agent',
        content: 'saved plot.png',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ],
    frameworkId: 'codex',
    model: 'gpt-5',
    createdAt: 1,
    updatedAt: 2
  })
  return {
    id: 'session-1',
    projectId: 'project-1',
    title: 'Provenance contract',
    cwd: join(storageRoot, 'workspace'),
    status: 'idle',
    messages: conversationGraph.messages.map(projectConversationMessage),
    conversationGraph,
    createdAt: 1,
    updatedAt: 2
  }
}

const finalizationRequest = (
  versionId: string,
  session: PersistedChatSession
): FinalizeArtifactVersionsRequest => ({
  projectId: 'project-1',
  appSessionId: 'session-1',
  artifactRunId: 'artifact-run-1',
  artifactVersionIds: [versionId],
  rootFrameId: session.conversationGraph!.rootFrameId,
  agentFrameId: session.conversationGraph!.activeFrameId,
  messageBranchId: session.conversationGraph!.branches[0].id,
  runtimeSegmentId: session.conversationGraph!.runtimeSegments[0].id,
  promptMessageId: 'prompt-1',
  messageId: 'message-1'
})

const versionRequest = (session: PersistedChatSession): CreateArtifactVersionRequest => {
  const finalization = finalizationRequest('unused-version', session)
  return createArtifactVersionRequest({
    rootFrameId: finalization.rootFrameId,
    agentFrameId: finalization.agentFrameId,
    messageBranchId: finalization.messageBranchId,
    runtimeSegmentId: finalization.runtimeSegmentId,
    promptMessageId: finalization.promptMessageId
  })
}

const withoutTerminalMessage = (input: PersistedChatSession): PersistedChatSession => {
  const session = structuredClone(input)
  session.messages = session.messages.filter((message) => message.id !== 'message-1')
  session.conversationGraph!.messages = session.conversationGraph!.messages.filter(
    (message) => message.id !== 'message-1'
  )
  session.conversationGraph!.branches[0].headMessageId = 'prompt-1'
  return session
}

describe('artifact provenance durable lifecycle contract', () => {
  it('admits the same published Version before and after its producing turn finalizes', async () => {
    const value = await fixture()
    await value.client.project.create({ data: { id: 'project-1', name: 'Replay admission' } })
    const session = durableSession(value.storageRoot)
    let authority = withoutTerminalMessage(session)
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => authority
    })
    const managedFileVersions = new ManagedFileVersionService({
      storageRoot: value.storageRoot,
      getClient: () => Promise.resolve(value.client)
    })
    const catalog = new ManagedFileIndexRepository(
      () => Promise.resolve(value.client),
      value.storageRoot,
      managedFileVersions,
      new UploadRepository(value.storageRoot, { getClient: () => Promise.resolve(value.client) })
    )
    const registry = new NotebookInputRegistry({
      storageRoot: value.storageRoot,
      inputAuthority: new ImmutableInputAuthority({
        storageRoot: value.storageRoot,
        managedFileVersions
      }),
      // Match the application composition: real catalog and content authority, no fake resolver.
      resolveArtifactVersionIdentity: async (projectId, versionId) => {
        const [artifact] = await catalog.readHostArtifactCatalog({
          projectId,
          versionId,
          finalizedArtifactsOnly: true
        })
        return artifact?.source === 'artifact' ? { sourceFileId: artifact.sourceFileId } : undefined
      }
    })
    await value.stagePng('immutable producer bytes')
    const version = await repository.createVersion(versionRequest(session))
    let active = true
    const request = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      promptMessageId: 'prompt-1',
      artifactVersionInputs: [version.versionId],
      producerScope: {
        appSessionId: 'session-1',
        artifactRunId: 'artifact-run-1',
        rootFrameId: session.conversationGraph!.rootFrameId,
        agentFrameId: session.conversationGraph!.activeFrameId,
        messageBranchId: session.conversationGraph!.branches[0].id,
        runtimeSegmentId: session.conversationGraph!.runtimeSegments[0].id,
        promptMessageId: 'prompt-1',
        assertActive: () => {
          if (!active) throw new Error('producer turn ended')
        }
      }
    }
    // Soft assertion lets the after-finalization control run even on the unfixed baseline.
    const sameTurn = await registry.openRun(request).then(
      async (lease) => ({ inputs: await lease.close() }),
      (error: Error) => ({ error: error.message })
    )
    expect.soft(sameTurn, JSON.stringify(sameTurn)).toEqual({
      inputs: [expect.objectContaining({ inputFileVersionId: version.versionId })]
    })
    // A bare ID or another owner never acquires producer authority.
    await expect(registry.openRun({ ...request, producerScope: undefined })).rejects.toThrow(
      'unavailable'
    )
    await expect(registry.openRun({ ...request, projectId: 'another-project' })).rejects.toThrow(
      'unavailable'
    )
    for (const key of [
      'appSessionId',
      'artifactRunId',
      'rootFrameId',
      'agentFrameId',
      'messageBranchId',
      'runtimeSegmentId',
      'promptMessageId'
    ] as const) {
      await expect(
        registry.openRun({
          ...request,
          producerScope: { ...request.producerScope, [key]: 'another-owner' }
        })
      ).rejects.toThrow('unavailable')
    }
    const lease = await registry.openRun(request)
    const path = await lease.resolve({
      sourceKind: 'artifact-version',
      inputFileVersionId: version.versionId
    })
    expect(sha256(await readFile(path))).toBe(lease.getRunInputFiles()[0].checksum)
    active = false
    await expect(
      lease.resolve({ sourceKind: 'artifact-version', inputFileVersionId: version.versionId })
    ).rejects.toThrow('producer turn ended')
    active = true
    await lease.close()
    await expect(
      lease.resolve({ sourceKind: 'artifact-version', inputFileVersionId: version.versionId })
    ).rejects.toThrow('closed')
    authority = session
    await repository.finalizeRun(finalizationRequest(version.versionId, session))
    await repository.activateFinalizedRun(finalizationRequest(version.versionId, session))
    await expect(registry.openRun(request).then((lease) => lease.close())).resolves.toEqual([
      expect.objectContaining({ inputFileVersionId: version.versionId })
    ])
  })

  it('reopens the database after finalizing both same-turn artifact revisions (issue 2544)', async () => {
    const value = await fixture()
    const session = durableSession(value.storageRoot)
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => session
    })
    await value.stagePng('first revision')
    const first = await repository.createVersion(versionRequest(session))
    await value.stagePng('second revision')
    const second = await repository.createVersion({
      ...versionRequest(session),
      writeOperationId: 'write-2',
      writeRequestChecksum: 'b'.repeat(64)
    })
    await repository.finalizeRun({
      ...finalizationRequest(first.versionId, session),
      artifactVersionIds: [first.versionId, second.versionId]
    })
    await value.client.$disconnect()
    await expect(migrateApplicationDatabase(value.client)).resolves.toMatchObject({ applied: [] })
  })

  it('distinguishes a persistence race, then finalizes and replays one exact Message owner', async () => {
    const value = await fixture()
    const session = durableSession(value.storageRoot)
    let authority = withoutTerminalMessage(session)
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => authority
    })
    await value.stagePng('finalized bytes')
    const version = await repository.createVersion(versionRequest(session))
    const request = finalizationRequest(version.versionId, session)

    await expect(repository.finalizeRun(request)).rejects.toBeInstanceOf(
      ArtifactOwnershipPersistenceRaceError
    )
    await expect(
      value.client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'pending', messageId: null })

    authority = session
    const finalized = await repository.finalizeRun(request)
    const replayed = await repository.finalizeRun(request)
    expect(finalized).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ versionId: finalized[0].versionId })
    await expect(
      repository.finalizeRun({ ...request, messageId: 'prompt-1' })
    ).rejects.toMatchObject({ name: 'ArtifactFinalizationProofError' })
  })

  it('retries finalization when Prisma reports an expired interactive transaction', async () => {
    const value = await fixture()
    const session = durableSession(value.storageRoot)
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => session
    })
    await value.stagePng('expired transaction bytes')
    const version = await repository.createVersion(versionRequest(session))
    const request = finalizationRequest(version.versionId, session)
    const transaction = vi.spyOn(value.client, '$transaction')
    transaction.mockImplementationOnce(async () => {
      throw { code: 'P2028' }
    })

    await expect(repository.finalizeRun(request)).resolves.toHaveLength(1)
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 30_000 })
    )
  })

  it('reads finalized Versions only after the ownership transaction commits', async () => {
    const value = await fixture()
    const session = durableSession(value.storageRoot)
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => session
    })
    await value.stagePng('post-commit read bytes')
    const version = await repository.createVersion(versionRequest(session))
    const transaction = value.client.$transaction.bind(value.client)
    let committed = false
    vi.spyOn(value.client, '$transaction').mockImplementation(async (...args) => {
      const result = await Reflect.apply(transaction, value.client, args)
      committed = true
      return result
    })
    const findMany = value.client.artifactVersion.findMany.bind(value.client.artifactVersion)
    const read = vi
      .spyOn(value.client.artifactVersion, 'findMany')
      .mockImplementation((...args) => {
        expect(committed).toBe(true)
        return Reflect.apply(findMany, value.client.artifactVersion, args)
      })

    await expect(
      repository.finalizeRun(finalizationRequest(version.versionId, session))
    ).resolves.toHaveLength(1)
    expect(read).toHaveBeenCalledOnce()
    await expect(
      value.client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
    ).resolves.toMatchObject({ state: 'finalized', messageId: 'message-1' })
  })

  it('rejects non-string artifact scope identities before querying', async () => {
    const value = await fixture()
    const repository = new ArtifactProvenanceRepository(value.repositoryOptions)

    await expect(
      repository.getLineage({
        projectId: undefined as unknown as string,
        appSessionId: 'session-1',
        artifactId: 'artifact-1'
      })
    ).rejects.toThrow('Invalid project id')
    await expect(
      repository.deleteProjectProvenance(undefined as unknown as string)
    ).rejects.toThrow('Invalid project id')
  })

  it.each([
    ['staging-files', false],
    ['renamed-files', false],
    ['staging-files', true],
    ['renamed-files', true]
  ] as const)(
    'recovers the %s crash window after startup (pending parent: %s)',
    async (crashWindow, pendingParent) => {
      const value = await fixture()
      if (pendingParent) {
        await value.stagePng('first revision')
        await value.repository.createVersion(createArtifactVersionRequest())
      }
      let failedFinalDirectoryBarrier = false
      const crashingRepository = new ArtifactProvenanceRepository({
        ...value.repositoryOptions,
        durability: {
          syncFile: async (path) => {
            if (crashWindow === 'staging-files' && basename(path) === 'evidence.json') {
              throw new Error('simulated staging file crash')
            }
          },
          syncDirectory: async (path) => {
            if (
              crashWindow === 'renamed-files' &&
              !path.includes(`${sep}.staging${sep}`) &&
              !failedFinalDirectoryBarrier
            ) {
              failedFinalDirectoryBarrier = true
              throw new Error('simulated renamed file crash')
            }
          }
        }
      })
      const request = createArtifactVersionRequest({
        writeOperationId: `write-${crashWindow}`,
        writeRequestChecksum: crashWindow === 'staging-files' ? 'b'.repeat(64) : 'c'.repeat(64)
      })
      await value.stagePng(`${crashWindow} bytes`)

      await expect(crashingRepository.createVersion(request)).rejects.toThrow('simulated')
      const staging = await value.client.artifactVersion.findUniqueOrThrow({
        where: { writeOperationId: request.writeOperationId }
      })
      expect(staging.state).toBe('staging')

      await value.client.$disconnect()
      await expect(migrateApplicationDatabase(value.client)).resolves.toMatchObject({ applied: [] })

      const recovered = await value.repository.replayVersion({
        projectId: request.projectId,
        appSessionId: request.appSessionId,
        artifactStorageSessionId: request.artifactStorageSessionId,
        artifactRunId: request.artifactRunId,
        writeOperationId: request.writeOperationId,
        filename: request.filename,
        contentType: request.contentType
      })
      expect(recovered).toMatchObject({ versionId: staging.id })
      await expect(
        value.client.artifactVersion.findUniqueOrThrow({ where: { id: staging.id } })
      ).resolves.toMatchObject({ state: 'pending' })
      await expect(readFile(recovered!.path)).resolves.toBeTruthy()
      await expect(migrateApplicationDatabase(value.client)).resolves.toMatchObject({ applied: [] })
    }
  )

  it.each(['database', 'backfill-race', 'checksum', 'missing'] as const)(
    'preserves the actionable message snapshot failure for %s',
    async (failure) => {
      const value = await fixture()
      const session = durableSession(value.storageRoot)
      const repository = new ArtifactProvenanceRepository({
        ...value.repositoryOptions,
        loadSession: async () => session
      })
      await value.stagePng('first bytes')
      const version = await repository.createVersion(versionRequest(session))
      await repository.finalizeRun(finalizationRequest(version.versionId, session))
      const snapshots = new ProvenanceMessageSnapshotRepository({
        storageRoot: value.storageRoot,
        getClient: async () => value.client
      })
      await snapshots.captureFinalizedMessages(session)
      const row = await value.client.artifactVersion.findUniqueOrThrow({
        where: { id: version.versionId },
        include: { messageSnapshot: true }
      })
      const snapshot = row.messageSnapshot!
      const path = join(value.storageRoot, ...snapshot.storageKey.split('/'))
      if (failure === 'checksum') await writeFile(path, '{"corrupt":true}')
      else if (failure === 'missing') await unlink(path)
      else {
        await value.client.artifactMessageSnapshot.update({
          where: { id: snapshot.id },
          data: { checksum: '' }
        })
        const update = vi.spyOn(value.client.artifactMessageSnapshot, 'updateMany')
        if (failure === 'database')
          update.mockRejectedValueOnce(new Error('database temporarily unavailable'))
        else update.mockResolvedValueOnce({ count: 0 })
      }
      const request = {
        projectId: 'project-1',
        appSessionId: 'session-1',
        artifactId: version.artifactId,
        versionId: version.versionId
      }
      expect(
        await captureProvenanceRead(() => repository.getVersionMessages(request))
      ).toMatchObject({
        failure: {
          kind: failure === 'checksum' || failure === 'missing' ? 'integrity-failed' : 'load-failed'
        }
      })
      if (failure === 'database' || failure === 'backfill-race') {
        await expect(repository.getVersionMessages(request)).resolves.toMatchObject({
          messages: { state: 'available' }
        })
      }
    }
  )

  it('segments exact-Version projections and isolates reconstruction cache entries', async () => {
    const value = await fixture()
    const session = durableSession(value.storageRoot)
    const repository = new ArtifactProvenanceRepository({
      ...value.repositoryOptions,
      loadSession: async () => session
    })
    await value.stagePng('first bytes')
    const first = await repository.createVersion(versionRequest(session))
    await repository.finalizeRun(finalizationRequest(first.versionId, session))
    const snapshots = new ProvenanceMessageSnapshotRepository({
      storageRoot: value.storageRoot,
      getClient: () => Promise.resolve(value.client)
    })
    await snapshots.captureFinalizedMessages(session)

    await value.stagePng('second bytes')
    const second = await repository.createVersion(
      createArtifactVersionRequest({
        writeOperationId: 'write-2',
        writeRequestChecksum: 'd'.repeat(64)
      })
    )
    const firstIdentity = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: first.artifactId,
      versionId: first.versionId
    }
    const secondIdentity = { ...firstIdentity, versionId: second.versionId }

    await expect(repository.getLineage(firstIdentity)).resolves.toMatchObject({
      versions: [{ versionId: first.versionId }, { versionId: second.versionId }]
    })
    await expect(repository.getVersionCore(firstIdentity)).resolves.toMatchObject({
      descriptor: { versionId: first.versionId },
      messages: { state: 'unavailable', reason: 'not-loaded' },
      review: { state: 'unavailable', reason: 'not-loaded' }
    })
    await expect(repository.getVersionExecution(firstIdentity)).resolves.toEqual({
      execution: undefined
    })
    await expect(repository.getVersionMessages(firstIdentity)).resolves.toMatchObject({
      messages: {
        state: 'available',
        items: [{ id: 'prompt-1' }, { id: 'message-1', content: 'saved plot.png' }]
      }
    })
    await expect(repository.getVersionReview(firstIdentity)).resolves.toEqual({
      review: { state: 'unavailable', reason: 'not-triggered' }
    })

    await expect(repository.readCodeReconstructionCache(firstIdentity)).resolves.toBeUndefined()
    await repository.writeCodeReconstructionCache(firstIdentity, '{"schemaVersion":1}\n')
    await expect(repository.readCodeReconstructionCache(firstIdentity)).resolves.toBe(
      '{"schemaVersion":1}\n'
    )
    await expect(repository.readCodeReconstructionCache(secondIdentity)).resolves.toBeUndefined()
    await expect(
      repository.getVersionCore({ ...firstIdentity, versionId: 'missing-version' })
    ).rejects.toThrow('Artifact Version not found')

    const snapshotRow = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: first.versionId },
      include: { messageSnapshot: true }
    })
    const snapshotPath = join(
      value.storageRoot,
      ...snapshotRow.messageSnapshot!.storageKey.split('/')
    )
    const currentSnapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<
      string,
      unknown
    >
    const futureSnapshot = JSON.stringify({ ...currentSnapshot, schemaVersion: 4 })
    await writeFile(snapshotPath, futureSnapshot, 'utf8')
    await value.client.artifactMessageSnapshot.update({
      where: { id: snapshotRow.messageSnapshot!.id },
      data: { checksum: sha256(futureSnapshot) }
    })
    await expect(repository.getVersionMessages(firstIdentity)).resolves.toEqual({
      messages: { state: 'unavailable', reason: 'message-snapshot-unsupported' }
    })

    await writeFile(snapshotPath, '{"corrupt":true}\n', 'utf8')
    await expect(repository.getVersionMessages(firstIdentity)).rejects.toThrow(
      'Message snapshot checksum mismatch.'
    )

    const coreRow = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: first.versionId }
    })
    if (!coreRow.evidenceJson || !coreRow.evidenceStorageKey) {
      throw new Error('Expected the agent-generated lifecycle fixture to retain evidence.')
    }
    const coreEvidenceStorageKey = coreRow.evidenceStorageKey
    const corruptEvidence = JSON.parse(coreRow.evidenceJson) as ArtifactVersionEvidence
    const persistCorruptEvidence = async (): Promise<void> => {
      const corruptEvidenceJson = canonicalJson(corruptEvidence as unknown as CanonicalJson)
      await value.client.artifactVersion.update({
        where: { id: first.versionId },
        data: {
          evidenceJson: corruptEvidenceJson,
          evidenceChecksum: sha256(corruptEvidenceJson)
        }
      })
      await writeFile(
        join(value.storageRoot, ...coreEvidenceStorageKey.split('/')),
        corruptEvidenceJson,
        'utf8'
      )
    }

    if (corruptEvidence.producer.state !== 'unavailable') {
      throw new Error('Expected the lifecycle fixture producer to be unavailable.')
    }
    corruptEvidence.environment_status = {
      state: 'unavailable',
      reason: 'environment-capture-failed'
    }
    await persistCorruptEvidence()
    await expect(repository.getVersionCore(firstIdentity)).rejects.toThrow(
      'Artifact Version core evidence metadata mismatch'
    )

    corruptEvidence.environment_status = {
      state: 'unavailable',
      reason: corruptEvidence.producer.reason
    }
    corruptEvidence.conversation.message_branch_id = 'self-consistent-but-wrong-branch'
    await persistCorruptEvidence()
    await expect(repository.getVersionCore(firstIdentity)).rejects.toThrow(
      'Artifact Version core evidence metadata mismatch'
    )
  })

  it('rejects a self-consistent checksum when an available producer uses a producer-only environment reason', async () => {
    const value = await fixture()
    const session = durableSession(value.storageRoot)
    const request = versionRequest(session)
    const lane = createRootNotebookLane('project-1', 'session-1', request.rootFrameId)
    await value.notebookRepository.loadOrCreate({
      projectId: 'project-1',
      sessionId: 'session-1',
      workspaceCwd: join(value.storageRoot, 'workspace'),
      lane
    })
    await value.notebookRepository.appendRun({
      projectId: 'project-1',
      sessionId: 'session-1',
      lane,
      run: {
        runId: 'producer-run-1',
        cellId: 'cell-1',
        source: 'agent',
        kernelKind: 'python',
        status: 'completed',
        startedAt: 1,
        endedAt: 2,
        script: 'save_plot()',
        text: { stdout: '', stderr: '', traceback: '', plain: [] },
        outputs: [],
        artifacts: [],
        workingFiles: [],
        inputFiles: [],
        environmentCapture: {
          state: 'unavailable',
          reason: 'environment-capture-failed'
        },
        rootFrameId: request.rootFrameId,
        agentFrameId: request.agentFrameId,
        messageBranchId: request.messageBranchId,
        runtimeSegmentId: request.runtimeSegmentId!,
        promptMessageId: request.promptMessageId!
      }
    })
    await value.stagePng('producer bytes')
    const version = await value.repository.createVersion({
      ...request,
      notebookSessionId: 'session-1',
      producerRunId: 'producer-run-1',
      sourceKind: 'inline'
    })
    const identity = {
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: version.artifactId,
      versionId: version.versionId
    }
    const row = await value.client.artifactVersion.findUniqueOrThrow({
      where: { id: version.versionId }
    })
    if (!row.evidenceJson || !row.evidenceStorageKey) {
      throw new Error('Expected the agent-generated lifecycle fixture to retain evidence.')
    }
    const corruptEvidence = JSON.parse(row.evidenceJson) as ArtifactVersionEvidence
    expect(corruptEvidence).toMatchObject({
      producer: { state: 'available' },
      environment_status: { state: 'unavailable', reason: 'environment-capture-failed' }
    })
    corruptEvidence.environment_status = {
      state: 'unavailable',
      reason: 'producer-not-supplied'
    }
    const corruptEvidenceJson = canonicalJson(corruptEvidence as unknown as CanonicalJson)
    await value.client.artifactVersion.update({
      where: { id: version.versionId },
      data: {
        evidenceJson: corruptEvidenceJson,
        evidenceChecksum: sha256(corruptEvidenceJson)
      }
    })
    await writeFile(
      join(value.storageRoot, ...row.evidenceStorageKey.split('/')),
      corruptEvidenceJson,
      'utf8'
    )

    await expect(value.repository.getVersionCore(identity)).rejects.toThrow(
      'Artifact Version core evidence metadata mismatch'
    )
  })
})

it('publishes a validated Host image above the tool inline byte limit', async () => {
  const value = await fixture()
  const bytes = await sharp({
    create: { width: 3500, height: 3400, channels: 3, background: '#f1f5f0' }
  })
    .png({ compressionLevel: 0 })
    .toBuffer()
  expect(bytes.byteLength).toBeGreaterThan(32 * 1024 * 1024)
  await value.client.project.create({ data: { id: 'project-1', name: 'Image owner' } })
  const request = {
    ...versionRequest(durableSession(value.storageRoot)),
    filename: 'large.png',
    contentType: 'image/png',
    writeOperationId: 'large-host-generated-image'
  }
  const content = bytes.toString('base64')
  await expect(
    value.repository.saveVersion(
      {
        ...request,
        source: { kind: 'inline', content, encoding: 'base64' }
      },
      { allowedImportRoots: [] }
    )
  ).rejects.toThrow(/budget exceeded/i)
  const result = await value.repository.writeAppGeneratedVersion({
    ...request,
    content: bytes,
    producer: {
      kind: 'connector',
      connectorId: 'image-model',
      toolId: 'generate_image',
      invocationId: 'large-host-generated-image',
      implementationVersion: '1',
      normalizedArguments: {}
    }
  })
  expect(result.checksum).toBe(sha256(bytes))
  expect(result.size).toBe(bytes.byteLength)
  expect(sha256(await readFile(result.path))).toBe(result.checksum)
})

it('publishes an image task without a prompt and recovers its result without advancing a newer head', async () => {
  const value = await fixture()
  await value.client.project.create({ data: { id: 'project-1', name: 'Image task owner' } })
  const authority = new ImmutableInputAuthority({
    storageRoot: value.storageRoot,
    managedFileVersions: new ManagedFileVersionService({
      storageRoot: value.storageRoot,
      getClient: async () => value.client
    })
  })
  const uploads = new UploadRepository(value.storageRoot, { getClient: async () => value.client })
  const staged = await stageUploadFixtures(uploads, {
    files: [
      {
        name: 'source.png',
        mimeType: 'image/png',
        content: createPngBytes('source').toString('base64')
      }
    ]
  })
  const [upload] = await uploads.finalizePendingSessionUploads('session-1', staged, 'project-1')
  const sourceVersionId = upload.versionId!
  const source = await authority.resolveVersion({
    projectId: 'project-1',
    sourceKind: 'upload-version',
    expectedSourceFileId: upload.id,
    inputFileVersionId: sourceVersionId
  })
  const taskId = crypto.randomUUID()
  const request = {
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactStorageSessionId: 'session-1',
    artifactRunId: taskId,
    imageTaskId: taskId,
    rootFrameId: 'root-frame-1',
    agentFrameId: 'root-frame-1',
    messageBranchId: 'branch-1',
    runtimeSegmentId: null,
    promptMessageId: null,
    filename: 'image.png',
    content: createPngBytes('generated bytes').toString('base64'),
    encoding: 'base64' as const,
    contentType: 'image/png',
    producer: {
      kind: 'connector' as const,
      connectorId: 'image-model',
      toolId: 'edit_image',
      invocationId: taskId,
      implementationVersion: '1',
      normalizedArguments: { imageTaskId: taskId, sourceVersionId },
      inputFiles: [source!]
    }
  }
  const interrupted = new ArtifactProvenanceRepository({
    ...value.repositoryOptions,
    durability: {
      syncFile: async (path) => {
        if (basename(path) === 'evidence.json') throw new Error('simulated staging write failure')
      },
      syncDirectory: async () => {}
    }
  })
  await expect(interrupted.writeAppGeneratedVersion(request)).rejects.toThrow('simulated staging')
  const output = await value.client.artifactVersion
    .findUniqueOrThrow({
      where: { writeOperationId: `artifact-app-write-${taskId}` },
      select: { id: true, artifactId: true, state: true }
    })
    .then(({ id, ...row }) => ({ ...row, versionId: id }))
  expect(output.state).toBe('staging')
  const pending = { projectId: 'project-1', sessionId: 'session-1', runId: taskId }
  expect(await value.compatibilityRepository.listPendingRunFiles(pending)).toHaveLength(1)
  const recovery = {
    projectId: 'project-1',
    appSessionId: 'session-1',
    taskId,
    sourceVersionId
  }
  const stagedPath = join(
    value.storageRoot,
    'artifacts',
    recovery.projectId,
    recovery.appSessionId,
    '.provenance',
    '.staging',
    'versions',
    output.versionId,
    'content'
  )
  const stagedBytes = await readFile(stagedPath)
  await writeFile(stagedPath, Buffer.alloc(stagedBytes.length))
  await expect(value.repository.recoverImageTaskVersion(recovery)).rejects.toThrow(
    'staging content is corrupt'
  )
  await writeFile(stagedPath, stagedBytes)
  await expect(
    value.repository.recoverImageTaskVersion({ ...recovery, sourceVersionId: 'other-version' })
  ).rejects.toMatchObject({ name: 'ImageTaskIntegrityError', taskIds: [taskId] })
  expect(
    await value.client.artifactLineage.findUniqueOrThrow({ where: { id: output.artifactId } })
  ).toMatchObject({ currentVersionId: null })
  const published = (await value.repository.recoverImageTaskVersion(recovery))!
  expect(published.versionId).toBe(output.versionId)
  expect(published.isPublished).toBe(true)
  expect(await value.compatibilityRepository.listPendingRunFiles(pending)).toEqual([])
  expect(sha256(await readFile(published.path))).toBe(published.checksum)
  const task = {
    id: taskId,
    projectId: 'project-1',
    sessionId: 'session-1',
    frameId: 'root-frame-1',
    branchId: 'branch-1',
    state: 'succeeded' as const,
    result: published,
    edit: { source: { sourceVersionId } }
  }
  const query = vi.spyOn(value.client.artifactVersion, 'findMany')
  await value.repository.verifyImageTaskResults([task, task])
  expect(query).toHaveBeenCalledTimes(1)
  for (const invalid of [
    { ...task, id: 'another-task' },
    { ...task, edit: { source: { sourceVersionId: 'other-version' } } },
    { ...task, projectId: 'another-project' },
    { ...task, sessionId: 'another-session' },
    { ...task, branchId: 'another-branch' },
    { ...task, result: { ...published, checksum: '0'.repeat(64) } },
    { ...task, result: { ...published, artifactId: 'another-artifact' } }
  ])
    await expect(value.repository.verifyImageTaskResults([invalid])).rejects.toThrow('integrity')
  query.mockRestore()

  const core = await value.repository.getVersionCore({
    projectId: 'project-1',
    appSessionId: 'session-1',
    artifactId: output.artifactId,
    versionId: output.versionId
  })
  expect(core.evidence.image_task_id).toBe(taskId)
  expect(core.evidence.conversation.prompt_message_id).toBeUndefined()
  expect(core.evidence.conversation.runtime_segment_id).toBeUndefined()
  expect(
    await value.repository.recoverImageTaskVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      taskId,
      sourceVersionId
    })
  ).toMatchObject({ versionId: output.versionId, isPublished: true })
  const input = await authority.resolveVersion({
    projectId: 'project-1',
    sourceKind: 'artifact-version',
    inputFileVersionId: published.versionId,
    expectedSourceFileId: published.artifactId
  })
  expect(input).toBeDefined()
  const laterId = crypto.randomUUID()
  const later = await value.repository.writeAppGeneratedVersion({
    ...request,
    artifactRunId: laterId,
    imageTaskId: laterId,
    content: createPngBytes('distinct later result').toString('base64'),
    producer: {
      ...request.producer,
      invocationId: laterId,
      normalizedArguments: { imageTaskId: laterId, sourceVersionId: output.versionId },
      inputFiles: [input!]
    }
  })
  await value.repository.publishImageTaskVersion({
    projectId: 'project-1',
    appSessionId: 'session-1',
    taskId: laterId,
    versionId: later.versionId,
    sourceVersionId: output.versionId
  })
  await value.repository.recoverImageTaskVersion({
    projectId: 'project-1',
    appSessionId: 'session-1',
    taskId,
    sourceVersionId
  })
  expect(
    (await value.client.artifactLineage.findUniqueOrThrow({ where: { id: output.artifactId } }))
      .currentVersionId
  ).toBe(later.versionId)
  expect(await value.client.artifactVersion.count()).toBe(2)

  for (const filename of ['image.png', 'different-image.png']) {
    const conversationRequest = {
      ...request,
      ...versionRequest(durableSession(value.storageRoot)),
      filename,
      writeOperationId: `conversation-edit-${filename}`,
      imageTaskId: undefined,
      producer: { ...request.producer, normalizedArguments: {}, inputFiles: [input!] }
    }
    if (filename === 'different-image.png') {
      await expect(interrupted.writeAppGeneratedVersion(conversationRequest)).rejects.toThrow(
        'simulated staging'
      )
    } else {
      await value.repository.writeAppGeneratedVersion(conversationRequest)
    }
    const row = await value.client.artifactVersion.findUniqueOrThrow({
      where: { writeOperationId: conversationRequest.writeOperationId },
      include: { inputs: true }
    })
    expect(row.basedOnVersionId).toBe(filename === 'image.png' ? published.versionId : null)
    expect(row.state).toBe(filename === 'image.png' ? 'pending' : 'staging')
    const recheck = {
      ...conversationRequest,
      invocationId: request.producer.invocationId,
      promptMessageId: 'prompt-1'
    }
    await expect(
      value.repository.readImageInvocationVersion({ ...recheck, messageBranchId: 'other-branch' })
    ).resolves.toBeUndefined()
    await expect(value.repository.readImageInvocationVersion(recheck)).resolves.toMatchObject({
      descriptor: { versionId: row.id }
    })
    expect(row.inputs).toEqual([
      expect.objectContaining({ inputFileVersionId: published.versionId })
    ])
  }

  const crossFileTaskId = crypto.randomUUID()
  const crossFile = await value.repository.writeAppGeneratedVersion({
    ...request,
    filename: 'cross-file.png',
    artifactRunId: crossFileTaskId,
    imageTaskId: crossFileTaskId,
    producer: {
      ...request.producer,
      invocationId: crossFileTaskId,
      normalizedArguments: { sourceVersionId: published.versionId, imageTaskId: crossFileTaskId },
      inputFiles: [input!]
    }
  })
  await value.repository.publishImageTaskVersion({
    projectId: request.projectId,
    appSessionId: request.appSessionId,
    taskId: crossFileTaskId,
    versionId: crossFile.versionId,
    sourceVersionId: published.versionId
  })
  for (const anchor of [published, crossFile]) {
    const lineage = await value.repository.getLineage({
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      artifactId: anchor.artifactId,
      versionId: anchor.versionId,
      imageSourceKind: 'artifact-version'
    })
    const edges = lineage!.imageDependencies!.map(({ input, output }) => [
      input.sourceVersionId,
      output.versionId
    ])
    const expected = [[published.versionId, crossFile.versionId]]
    if (anchor === published)
      expected.push([sourceVersionId, published.versionId], [published.versionId, later.versionId])
    expect(edges.sort()).toEqual(expected.sort())
  }

  const historyRequest = {
    projectId: request.projectId,
    appSessionId: request.appSessionId,
    artifactId: published.artifactId,
    versionId: published.versionId,
    imageSourceKind: 'artifact-version' as const
  }
  const outputs = new Set([published.versionId, later.versionId, crossFile.versionId])
  for (let i = 0; i < 32; i++) {
    const id = crypto.randomUUID()
    const result = await value.repository.writeAppGeneratedVersion({
      ...request,
      filename: 'cross-file.png',
      artifactRunId: id,
      imageTaskId: id,
      producer: {
        ...request.producer,
        invocationId: id,
        normalizedArguments: { sourceVersionId: published.versionId, imageTaskId: id },
        inputFiles: [input!]
      }
    })
    await value.repository.publishImageTaskVersion({
      projectId: request.projectId,
      appSessionId: request.appSessionId,
      taskId: id,
      versionId: result.versionId,
      sourceVersionId: published.versionId
    })
    outputs.add(result.versionId)
  }
  const first = (await value.repository.getLineage(historyRequest))!
  expect(first.nextImageCursor).toBeDefined()
  expect(first.imageDependencies).toHaveLength(32)
  const second = (await value.repository.getLineage({
    ...historyRequest,
    imageCursor: first.nextImageCursor
  }))!
  expect(second.nextImageCursor).toBeUndefined()
  expect(second.imageDependencies).toHaveLength(3)
  expect(
    new Set(
      [...first.imageDependencies!, ...second.imageDependencies!].map(
        ({ output }) => output.versionId
      )
    )
  ).toEqual(outputs)
  await expect(
    value.repository.getLineage({ ...historyRequest, cursor: '1' })
  ).resolves.toMatchObject({ versions: [], imageDependencies: [] })
  const comparison = {
    ...historyRequest,
    versionId: crossFile.versionId,
    imageInputOnly: true
  }
  await expect(value.repository.getLineage(comparison)).resolves.toMatchObject({
    versions: [],
    imageDependencies: []
  })
  await expect(
    value.repository.getLineage({ ...comparison, artifactId: crossFile.artifactId })
  ).resolves.toMatchObject({
    versions: [],
    imageDependencies: [
      {
        output: { versionId: crossFile.versionId },
        input: { sourceVersionId: published.versionId }
      }
    ]
  })

  // Editing v1 after v2 exists must publish a new current version, without flattening lineage.
  const branches = []
  for (const label of ['older branch', 'newest branch']) {
    const id = crypto.randomUUID()
    const result = await value.repository.writeAppGeneratedVersion({
      ...request,
      artifactRunId: id,
      imageTaskId: id,
      content: createPngBytes(label).toString('base64'),
      producer: {
        ...request.producer,
        invocationId: id,
        normalizedArguments: { imageTaskId: id, sourceVersionId: published.versionId },
        inputFiles: [input!]
      }
    })
    branches.push({ id, result })
  }
  const newest = branches[1]!.result
  // A late completion/retry of the older branch must not roll Files back.
  for (const branch of [...branches].reverse()) {
    await value.repository.publishImageTaskVersion({
      ...recovery,
      taskId: branch.id,
      versionId: branch.result.versionId,
      sourceVersionId: published.versionId
    })
  }
  await expect(
    value.client.artifactLineage.findUniqueOrThrow({ where: { id: published.artifactId } })
  ).resolves.toMatchObject({ currentVersionId: newest.versionId })
  await expect(
    value.client.artifactVersion.findUniqueOrThrow({ where: { id: newest.versionId } })
  ).resolves.toMatchObject({ basedOnVersionId: published.versionId })
  const catalog = new ManagedFileIndexRepository(
    async () => value.client,
    value.storageRoot,
    new ManagedFileVersionService({
      storageRoot: value.storageRoot,
      getClient: async () => value.client
    }),
    new UploadRepository(value.storageRoot, { getClient: async () => value.client })
  )
  await catalog.syncSession(durableSession(value.storageRoot))
  await expect(
    value.client.managedFile.findFirstOrThrow({
      where: { source: 'artifact', sourceFileId: newest.artifactId }
    })
  ).resolves.toMatchObject({
    sourceVersionId: newest.versionId,
    checksum: newest.checksum,
    sizeBytes: BigInt(newest.size)
  })

  const snapshots = new ProvenanceMessageSnapshotRepository(value.repositoryOptions)
  const deletion = await snapshots.prepareSessionDeletion(durableSession(value.storageRoot))
  expect(deletion.kind).toBe('retained')
  await snapshots.completeSessionDeletion(deletion)
  expect(await value.client.artifactVersion.count()).toBe(39)
  expect(sha256(await readFile(published.path))).toBe(published.checksum)
  await unlink(later.path)
  await expect(
    value.repository.recoverImageTaskVersion({
      projectId: 'project-1',
      appSessionId: 'session-1',
      taskId: laterId,
      sourceVersionId: output.versionId
    })
  ).rejects.toMatchObject({ name: 'ImageTaskIntegrityError', taskIds: [laterId] })
})

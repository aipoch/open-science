import { readFile, writeFile, unlink } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'

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

  it.each(['staging-files', 'renamed-files'] as const)(
    'recovers the %s crash window through exact operation replay',
    async (crashWindow) => {
      const value = await fixture()
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
        runtimeSegmentId: request.runtimeSegmentId,
        promptMessageId: request.promptMessageId
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

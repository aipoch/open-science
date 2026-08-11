import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
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
import { ProvenanceMessageSnapshotRepository } from './provenance-message-snapshot'
import {
  createArtifactVersionRequest,
  createProvenanceTestFixture
} from './provenance-test-fixtures'

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
    await writeFile(snapshotPath, '{"corrupt":true}\n', 'utf8')
    await expect(repository.getVersionMessages(firstIdentity)).resolves.toEqual({
      messages: { state: 'unavailable', reason: 'message-snapshot-corrupt' }
    })
  })
})

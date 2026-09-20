import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrismaClient } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import { createLinearConversationGraph } from '../../shared/conversation-graph'
import { applySessionConversationCommands } from '../../shared/session-conversation-command'
import type { PersistedChatSession } from '../../shared/session-persistence'
import { createPngBytes, createPngInlineSource } from '../artifacts/artifact-test-fixtures'
import { ArtifactProvenanceRepository } from '../artifacts/provenance-repository'
import { ArtifactRepository } from '../artifacts/repository'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import { initDataRoot } from '../storage-root'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import { RuntimeSessionOwner } from './runtime-session-owner'

const projectId = 'project-resume'
const sessionId = 'session-resume'
const artifactStorageSessionId = 'artifact-session-resume'
const artifactRunId = 'artifact-run-resume'

describe('resumed runtime Artifact publication through durable repositories', () => {
  let storageRoot: string
  let client: PrismaClient
  let sessions: SessionRepository

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'open-science-resumed-publication-'))
    initDataRoot(storageRoot)
    client = createProjectDbClient(storageRoot)
    await migrateApplicationDatabase(client)
    sessions = new SessionRepository(storageRoot)
  })

  afterEach(async () => {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it.each(['normal', 'before-provenance-commit', 'after-provenance-commit'] as const)(
    'finalizes unchanged PNG bytes across Resume; restart=%s',
    async (restart) => {
      const prompt = {
        id: 'prompt-original',
        role: 'user' as const,
        content: 'Make a figure',
        status: 'complete' as const,
        eventIds: [],
        createdAt: 1,
        updatedAt: 1
      }
      const graph = createLinearConversationGraph({
        sessionId,
        messages: [prompt],
        frameworkId: 'codex',
        createdAt: 1,
        updatedAt: 1
      })
      await sessions.saveSession({
        id: sessionId,
        projectId,
        title: 'Resume',
        cwd: '/workspace',
        status: 'running',
        activeRun: { promptMessageId: prompt.id, startedAt: 1 },
        messages: [prompt],
        conversationGraph: graph,
        createdAt: 1,
        updatedAt: 1
      })
      const load = async (): Promise<PersistedChatSession> => {
        const result = await loadSessionMutationAuthority(sessions, projectId, sessionId)
        if (result.status !== 'found') throw new Error('Missing durable fixture')
        return result.session
      }
      const compatibility = new ArtifactRepository(storageRoot)
      const createProvenance = (): ArtifactProvenanceRepository =>
        new ArtifactProvenanceRepository({
          storageRoot,
          getClient: () => Promise.resolve(client),
          compatibilityRepository: compatibility,
          loadSession: () => load()
        })
      let provenance = createProvenance()
      const originalScope = {
        projectId,
        sessionId,
        executionId: 'execution-original',
        promptMessageId: prompt.id,
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.branches[0].id,
        runtimeSegmentId: graph.runtimeSegments[0].id
      }
      const resumedScope = {
        ...originalScope,
        executionId: 'execution-resumed',
        runtimeSegmentId: 'segment-resumed'
      }
      const context = {
        rootFrameId: graph.rootFrameId,
        agentFrameId: resumedScope.agentFrameId,
        messageBranchId: resumedScope.messageBranchId,
        runtimeSegmentId: resumedScope.runtimeSegmentId,
        promptMessageId: prompt.id
      }
      let artifactVersionIds: string[] = []
      let committedMessageId: string | undefined
      const owner = new RuntimeSessionOwner({
        loadSession: () => load(),
        mutateSession: async (_scope, mutate) =>
          sessions.saveSession({
            ...mutate(await load()),
            runtimeTranscriptOwner: 'main'
          }),
        scheduleFlush: () => () => undefined,
        now: () => 20,
        finalizeArtifacts: async ({ messageId }) => {
          const request = {
            projectId,
            appSessionId: sessionId,
            artifactRunId,
            artifactVersionIds,
            ...context,
            messageId
          }
          committedMessageId = messageId
          // Both crash boundaries follow the owner's real durable attachment transaction.
          if (restart === 'before-provenance-commit')
            throw new Error('Process exited before provenance commit')
          await provenance.finalizeRun(request)
          if (restart === 'after-provenance-commit')
            throw new Error('Process exited after provenance commit')
          await compatibility.finalizeRunArtifacts({
            projectId,
            sourceSessionId: artifactStorageSessionId,
            sessionId,
            runId: artifactRunId,
            artifactVersionIds,
            provenanceContext: context,
            messageId
          })
          return provenance.activateFinalizedRun(request)
        }
      })
      await owner.begin(originalScope)
      owner.accept({
        id: 'connection-failed',
        timestamp: 5,
        kind: 'error',
        level: 'error',
        sessionId,
        promptMessageId: prompt.id,
        title: 'Prompt failed',
        providerError: true,
        text: 'API Error: Connection closed mid-response'
      })
      await owner.flush(sessionId, prompt.id)
      const interrupted = await load()
      expect(interrupted.resumeRecovery?.promptMessageId).toBe(prompt.id)
      await sessions.saveSession(
        applySessionConversationCommands(interrupted, [
          {
            id: 'open-replacement',
            kind: 'open-segment',
            timestamp: 9,
            segment: { id: resumedScope.runtimeSegmentId, frameworkId: 'codex', startedAt: 9 }
          },
          {
            id: 'resume-run',
            kind: 'resume-run',
            timestamp: 10,
            run: { promptMessageId: prompt.id, startedAt: 10 }
          }
        ])
      )
      await owner.begin(resumedScope)
      const admitted = await load()
      expect(admitted.resumeRecovery).toBeUndefined()
      expect(admitted.runtimeSessionAdmissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executionId: resumedScope.executionId,
            promptRuntimeSegmentId: originalScope.runtimeSegmentId,
            ...context
          })
        ])
      )
      owner.accept({
        id: 'resumed-response',
        timestamp: 21,
        kind: 'message',
        level: 'info',
        sessionId,
        promptMessageId: prompt.id,
        messageId: 'resumed-stream',
        role: 'assistant',
        text: 'Here is the figure.'
      })
      await owner.flush(sessionId, prompt.id)
      const bytes = createPngBytes('resume figure bytes')
      await compatibility.writePendingFile({
        projectId,
        sessionId: artifactStorageSessionId,
        runId: artifactRunId,
        filename: 'figure.png',
        source: createPngInlineSource('resume figure bytes')
      })
      const version = await provenance.createVersion({
        projectId,
        appSessionId: sessionId,
        artifactStorageSessionId,
        artifactRunId,
        writeOperationId: 'write-resumed',
        writeRequestChecksum: 'a'.repeat(64),
        ...context,
        filename: 'figure.png'
      })
      artifactVersionIds = [version.versionId]
      await compatibility.prepareRunFinalization({
        projectId,
        sourceSessionId: artifactStorageSessionId,
        sessionId,
        runId: artifactRunId,
        artifactVersionIds,
        provenanceContext: context
      })
      const publication = {
        appSessionId: sessionId,
        promptMessageId: prompt.id,
        artifactClaimId: 'claim-resumed',
        runId: artifactRunId,
        executionId: resumedScope.executionId,
        artifacts: [version]
      }
      if (restart !== 'normal') {
        await expect(owner.publish(publication)).rejects.toThrow(
          restart === 'before-provenance-commit'
            ? 'Process exited before provenance commit'
            : 'Process exited after provenance commit'
        )
        expect(
          await client.artifactVersion.findUniqueOrThrow({ where: { id: version.versionId } })
        ).toMatchObject({
          state: restart === 'before-provenance-commit' ? 'pending' : 'finalized',
          managedVisibleAt: null
        })
        sessions = new SessionRepository(storageRoot)
        provenance = createProvenance()
        const restored = await load()
        const recovery = await provenance.reconcileSession(projectId, sessionId, restored)
        expect(recovery.unresolvedNativeFinalizationRunIds).toEqual([])
        await provenance.reconcileSession(projectId, sessionId, await load())
      } else {
        const receipt = await owner.publish(publication)
        expect(await owner.publish(publication)).toEqual(receipt)
      }
      expect(committedMessageId).toBeDefined()
      const durable = await load()
      expect(
        durable.conversationGraph!.messages.find(({ id }) => id === prompt.id)?.runtimeSegmentId
      ).toBe(originalScope.runtimeSegmentId)
      expect(
        durable.conversationGraph!.messages.find(({ id }) => id === committedMessageId)
          ?.runtimeSegmentId
      ).toBe(resumedScope.runtimeSegmentId)
      const record = await client.artifactVersion.findUniqueOrThrow({
        where: { id: version.versionId }
      })
      expect(record).toMatchObject({
        state: 'finalized',
        messageId: committedMessageId,
        checksum: createHash('sha256').update(bytes).digest('hex'),
        managedVisibleAt: expect.any(Date)
      })
      expect(await readFile(join(storageRoot, record.contentStorageKey))).toEqual(bytes)
      expect(await client.artifactVersion.count()).toBe(1)
      expect(
        await compatibility.listPendingRunFiles({
          projectId,
          sessionId: artifactStorageSessionId,
          runId: artifactRunId
        })
      ).toEqual([])
      await expect(
        provenance.finalizeRun({
          projectId,
          appSessionId: sessionId,
          artifactRunId,
          artifactVersionIds,
          ...context,
          messageId: committedMessageId!,
          runtimeSegmentId: originalScope.runtimeSegmentId
        })
      ).rejects.toThrow()
    }
  )
})

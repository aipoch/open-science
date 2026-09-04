import { ProjectFilesReconciliationError } from '../project-files/repository'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import type { ArtifactVersionFile } from '../../shared/artifact-provenance'
import { hasAnswerableDelegatedQuestion } from '../../shared/delegated-work-projection'
import {
  createLinearConversationGraph,
  forkEditedConversationMessage,
  synchronizeActiveConversationMessages
} from '../../shared/conversation-graph'
import {
  materializeSessionConversationGraph,
  SessionRevisionConflictError,
  type PersistedArtifact,
  type PersistedChatMessage,
  type PersistedChatSession,
  type PersistedSideChat,
  type SessionPermissionRuntimeContext,
  type SessionPlanRuntimeContext
} from '../../shared/session-persistence'
import type { ArtifactProjectReconciliationSnapshot } from '../artifacts/provenance-repository'
import { FinalizedArtifactBindingConflictError } from '../artifacts/provenance-message-snapshot'
import type { Logger } from '../logger'
import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'
import {
  OrphanLegacyUploadAuthorityMissingError,
  UnsafeLegacyUploadResidualError,
  UploadRepository
} from '../uploads/repository'
import {
  SessionRuntimeContextRevisionConflictError,
  SessionPersistenceCoordinator,
  type SessionDeletionHandlers,
  type SessionFileIndex,
  type SessionMutationRepository,
  type SessionProvenancePersistence
} from './coordinator'
import { SessionRepository } from './repository'

const createSession = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2,
  ...overrides
})

const createUserMessage = (id: string, createdAt: number): PersistedChatMessage => ({
  id,
  role: 'user',
  content: id,
  status: 'complete',
  eventIds: [],
  createdAt,
  updatedAt: createdAt
})

const createIdleSessionWithRunningChild = (originMessageId = 'root-prompt'): PersistedChatSession =>
  createSession({
    conversationGraph: {
      schemaVersion: 1,
      rootFrameId: 'root',
      activeFrameId: 'root',
      frames: [
        {
          id: 'root',
          originBindingState: 'root',
          kind: 'root',
          status: 'completed',
          activeBranchId: 'root-branch',
          createdAt: 1
        },
        {
          id: 'child',
          parentFrameId: 'root',
          originMessageId,
          originBindingState: 'validated',
          kind: 'delegate',
          status: 'running',
          activeBranchId: 'child-branch',
          createdAt: 2
        }
      ],
      branches: [
        {
          id: 'root-branch',
          agentFrameId: 'root',
          headMessageId: 'root-prompt',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'child-branch',
          agentFrameId: 'child',
          createdAt: 2,
          updatedAt: 2
        },
        {
          id: 'inactive-root-branch',
          agentFrameId: 'root',
          headMessageId: 'inactive-root-prompt',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      messages: [
        {
          id: 'root-prompt',
          role: 'user',
          content: 'Delegate this task',
          status: 'complete',
          eventIds: [],
          agentFrameId: 'root',
          introducedOnBranchId: 'root-branch',
          createdAt: 1,
          updatedAt: 1
        },
        {
          id: 'inactive-root-prompt',
          role: 'user',
          content: 'Delegate from an alternate branch',
          status: 'complete',
          eventIds: [],
          agentFrameId: 'root',
          introducedOnBranchId: 'inactive-root-branch',
          createdAt: 2,
          updatedAt: 2
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    },
    runtimeContext: {
      version: 1,
      revision: 1,
      delegatedWork: {
        records: [
          {
            agentFrameId: 'child',
            attempts: [
              {
                id: 'child-attempt',
                status: 'running',
                resolvedAgent: { kind: 'main' },
                runtimeSegmentIds: [],
                startedAt: 2
              }
            ]
          }
        ]
      }
    }
  })

const createIdleSessionWithPendingDelegatedQuestion = (): PersistedChatSession => {
  const session = createIdleSessionWithRunningChild()
  const delegatedWork = session.runtimeContext?.delegatedWork
  const attempt = delegatedWork?.records[0]?.attempts[0]
  const child = session.conversationGraph?.frames.find((frame) => frame.id === 'child')
  if (!delegatedWork || !attempt || !child) throw new Error('Invalid delegated Session fixture')

  Object.assign(attempt, {
    status: 'completed',
    runtimeSegmentIds: ['runtime-1'],
    endedAt: 3,
    terminalMessageId: 'child-terminal'
  })
  Object.assign(child, { status: 'completed', delegateName: 'Researcher' })
  const childBranch = session.conversationGraph?.branches.find(
    (branch) => branch.id === 'child-branch'
  )
  if (!childBranch) throw new Error('Invalid delegated Session fixture')
  childBranch.headMessageId = 'child-terminal'
  session.conversationGraph?.messages.push({
    id: 'child-terminal',
    role: 'agent',
    content: 'Waiting for an answer',
    status: 'complete',
    eventIds: [],
    agentFrameId: child.id,
    introducedOnBranchId: childBranch.id,
    runtimeSegmentId: 'runtime-1',
    createdAt: 3,
    updatedAt: 3
  })
  session.conversationGraph?.runtimeSegments.push({
    id: 'runtime-1',
    agentFrameId: child.id,
    frameworkId: 'codex',
    startedAt: 2,
    endedAt: 3
  })
  Object.assign(delegatedWork, {
    questionRequests: [
      {
        requestId: 'question-1',
        canonicalDigest: 'a'.repeat(64),
        sourceFrameId: child.id,
        sourceAttemptId: attempt.id,
        sourceRuntimeSegmentId: 'runtime-1',
        sourceName: 'Researcher',
        rootBranchId: 'root-branch',
        rootOriginMessageId: 'root-prompt',
        sourceMessageBranchId: 'child-branch',
        questions: [
          {
            question: 'Choose a source',
            options: [{ label: 'Primary' }, { label: 'Secondary' }]
          }
        ],
        sequence: 1,
        askedAt: 3,
        status: 'pending',
        draftAnswers: [],
        draftQuestionIndex: 0
      }
    ]
  })
  return session
}

const createRuntimePlan = (
  overrides: Partial<SessionPlanRuntimeContext> = {}
): SessionPlanRuntimeContext => ({
  artifactId: 'plan-1',
  artifactVersionId: 'plan-version-1',
  artifactChecksum: 'a'.repeat(64),
  approval: 'pending',
  stepStatuses: {},
  ...overrides
})

const createRuntimePermission = (): SessionPermissionRuntimeContext => ({
  state: 'pending',
  request: {
    requestId: 'permission-1',
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    title: 'Run npm test',
    options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }]
  },
  originatingPromptMessageId: 'prompt-1',
  fingerprint: 'a'.repeat(64),
  createdAt: 1
})

const createSideChatProjection = (
  overrides: Partial<PersistedSideChat> = {}
): PersistedSideChat => ({
  version: 1,
  id: 'side-chat-1',
  lifecycle: 'open',
  frameworkId: 'codex',
  backendId: 'codex-responses',
  providerSessionId: 'provider-side-chat-1',
  providerContinuityToken: 'continuity-1',
  model: 'gpt-5.6-sol',
  historyPreamble: 'Main context',
  entries: [],
  createdAt: 10,
  updatedAt: 10,
  ...overrides
})

const createLegacyUploadSession = (sessionId: string): PersistedChatSession =>
  createSession({
    id: sessionId,
    messages: [
      {
        id: `${sessionId}-message`,
        role: 'user',
        content: 'legacy upload',
        status: 'complete',
        eventIds: [],
        uploads: [
          {
            id: `${sessionId}-upload`,
            sessionId,
            name: 'legacy.csv',
            originalName: 'legacy.csv',
            path: `/legacy/${sessionId}/legacy.csv`,
            size: 11
          }
        ],
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })

const toVersionedUploadSession = (session: PersistedChatSession): PersistedChatSession => {
  const upgraded = structuredClone(session)
  upgraded.messages[0].uploads = [
    {
      id: `${session.id}-upload`,
      versionId: `${session.id}-upload-version`,
      versionNumber: 1,
      sessionId: session.id,
      name: 'legacy.csv',
      originalName: 'legacy.csv',
      size: 11,
      sha256: 'a'.repeat(64)
    }
  ]
  return upgraded
}

const createRecoveredArtifact = (
  overrides: Partial<ArtifactVersionFile> = {}
): ArtifactVersionFile => ({
  id: 'artifact-version-1',
  artifactId: 'artifact-lineage-1',
  versionId: 'artifact-version-1',
  versionNumber: 1,
  checksum: 'a'.repeat(64),
  createdAt: '2026-07-29T00:00:00.000Z',
  projectId: 'project-1',
  sessionId: 'session-1',
  runId: 'artifact-run-1',
  name: 'result.csv',
  path: '/managed/.provenance/artifact-lineage-1/versions/artifact-version-1/content',
  fileUrl: 'file:///managed/result.csv',
  mimeType: 'text/csv',
  size: 12,
  mtimeMs: 3,
  ...overrides
})

const createPersistedRecoveredArtifact = (
  overrides: Partial<ArtifactVersionFile> = {}
): PersistedArtifact => {
  const artifact = createRecoveredArtifact(overrides)
  return {
    id: artifact.id,
    artifactId: artifact.artifactId,
    versionId: artifact.versionId,
    versionNumber: artifact.versionNumber,
    kind: 'managed-file',
    path: artifact.path,
    fileUrl: artifact.fileUrl,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    mtimeMs: artifact.mtimeMs,
    sha256: artifact.checksum
  }
}

const createLegacyArtifactAlias = (): PersistedArtifact => ({
  id: 'session-1:message-1:result.csv',
  artifactId: 'artifact-lineage-1',
  versionId: 'artifact-version-1',
  versionNumber: 1,
  kind: 'managed-file',
  path: '/managed/message-1/result.csv',
  fileUrl: 'file:///managed/message-1/result.csv',
  name: 'result.csv',
  mimeType: 'text/csv',
  size: 12,
  mtimeMs: 2
})

const createProjectReconciliationSnapshot = (): ArtifactProjectReconciliationSnapshot =>
  ({}) as ArtifactProjectReconciliationSnapshot

describe('SessionPersistenceCoordinator', () => {
  it('rejects a retry when any requested native Artifact run remains unresolved', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session })
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
        ],
        nativeFinalizationRunIds: ['run-1', 'run-2'],
        unresolvedNativeFinalizationRunIds: ['run-2']
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await expect(
      coordinator.retryArtifactFinalization({
        projectId: session.projectId,
        sessionId: session.id,
        messageId: 'message-1',
        pendingPaths: [
          '/artifacts/storage-session/.pending/run-1/a.txt',
          '/artifacts/storage-session/.pending/run-2/b.txt'
        ]
      })
    ).rejects.toThrow(/remains unresolved/u)
  })

  it('scopes an explicit Artifact retry so an unrelated native run cannot block it', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session })
    })
    const reconcileSession = vi.fn(
      async (
        _projectId: string,
        _sessionId: string,
        _session: PersistedChatSession,
        options?: { artifactRunIds?: string[] }
      ) => {
        if (!options?.artifactRunIds?.includes('run-legacy')) {
          throw new Error('unrelated native recovery failed')
        }
        return {
          recoveredMessageArtifacts: [],
          nativeFinalizationRunIds: [],
          unresolvedNativeFinalizationRunIds: []
        }
      }
    )
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )
    const request = {
      projectId: session.projectId,
      sessionId: session.id,
      messageId: 'message-1',
      pendingPaths: ['/artifacts/storage-session/.pending/run-legacy/result.txt']
    }

    await expect(coordinator.retryArtifactFinalization(request)).resolves.toBeUndefined()
    expect(reconcileSession).toHaveBeenCalledWith(session.projectId, session.id, session, {
      removeOrphanStaging: false,
      artifactRunIds: ['run-legacy']
    })
    expect(artifactStorage.prepareProjectReconciliation).not.toHaveBeenCalled()
  })

  it('stages and settles Task completion from current authority without replacing concurrent state', async () => {
    const prompt: PersistedChatMessage = {
      id: 'task-prompt',
      role: 'user',
      content: 'Run the task',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const concurrentMessage: PersistedChatMessage = {
      id: 'concurrent-message',
      role: 'agent',
      content: 'Concurrent state',
      status: 'complete',
      responseToMessageId: prompt.id,
      eventIds: ['concurrent-event'],
      createdAt: 2,
      updatedAt: 2
    }
    let durable = materializeSessionConversationGraph(
      createSession({
        revision: 3,
        status: 'running',
        errorReportable: false,
        agentFrameworkId: 'codex',
        activeRun: { promptMessageId: prompt.id, startedAt: 1 },
        runtimeContext: { version: 1, revision: 2 },
        messages: [prompt, concurrentMessage],
        activities: [
          {
            id: 'concurrent-activity',
            kind: 'tool',
            title: 'Concurrent tool',
            promptMessageId: prompt.id,
            status: 'completed',
            sortIndex: 2,
            eventIds: ['concurrent-tool-event'],
            createdAt: 2,
            updatedAt: 2
          }
        ],
        artifacts: [{ id: 'concurrent-artifact', kind: 'workspace-file', path: '/concurrent.txt' }]
      })
    )
    const expectedRevisions: number[] = []
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: structuredClone(durable)
      })),
      saveSession: vi.fn(async (candidate, expectedRevision) => {
        const expected = expectedRevision ?? candidate.revision ?? 0
        expect(expected).toBe(durable.revision)
        expectedRevisions.push(expected)
        durable = structuredClone({ ...candidate, revision: expected + 1 })
        return structuredClone(durable)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) })
    )
    const taskMessage: PersistedChatMessage = {
      id: 'task-answer',
      role: 'agent',
      content: 'Finished',
      status: 'complete',
      responseToMessageId: prompt.id,
      eventIds: ['task-event'],
      createdAt: 4,
      updatedAt: 4
    }

    await coordinator.stageTaskCompletion({
      projectId: durable.projectId,
      sessionId: durable.id,
      promptMessageId: prompt.id,
      message: taskMessage,
      activities: [
        {
          id: 'task-activity',
          kind: 'tool',
          title: 'Task tool',
          promptMessageId: prompt.id,
          status: 'completed',
          sortIndex: 4,
          eventIds: ['task-tool-event'],
          createdAt: 4,
          updatedAt: 4
        }
      ],
      updatedAt: 4
    })
    await coordinator.settleTaskCompletion({
      projectId: durable.projectId,
      sessionId: durable.id,
      promptMessageId: prompt.id,
      taskRunCommitId: 'task-run',
      messageId: taskMessage.id,
      artifacts: [{ id: 'task-artifact', kind: 'workspace-file', path: '/task.txt' }],
      updatedAt: 4
    })

    expect(expectedRevisions).toEqual([3, 4])
    expect(durable).toMatchObject({
      revision: 5,
      status: 'idle',
      activeRun: undefined,
      taskRunCommitId: 'task-run'
    })
    expect(durable.errorReportable).toBeUndefined()
    expect(durable.runtimeContext).toEqual({ version: 1, revision: 2 })
    expect(durable.messages.map(({ id }) => id)).toEqual([
      prompt.id,
      concurrentMessage.id,
      taskMessage.id
    ])
    expect(durable.messages.at(-1)?.artifactIds).toEqual(['task-artifact'])
    expect(
      durable.conversationGraph?.messages.find(({ id }) => id === taskMessage.id)?.artifactIds
    ).toEqual(['task-artifact'])
    expect(durable.activities?.map(({ id }) => id)).toEqual([
      'concurrent-activity',
      'task-activity'
    ])
    expect(durable.artifacts?.map(({ id }) => id)).toEqual(['concurrent-artifact', 'task-artifact'])
  })

  it('persists Task failure as a delta against current authority', async () => {
    const taskMessage: PersistedChatMessage = {
      id: 'task-answer',
      role: 'agent',
      content: 'Partial answer',
      status: 'complete',
      responseToMessageId: 'task-prompt',
      eventIds: [],
      createdAt: 2,
      updatedAt: 2
    }
    let durable = createSession({
      revision: 8,
      status: 'running',
      activeRun: { promptMessageId: 'task-prompt', startedAt: 1 },
      runtimeContext: { version: 1, revision: 4 },
      messages: [
        {
          id: 'task-prompt',
          role: 'user',
          content: 'Run the task',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        taskMessage
      ],
      artifacts: [{ id: 'concurrent-artifact', kind: 'workspace-file', path: '/concurrent.txt' }]
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (candidate) => {
        durable = structuredClone({ ...candidate, revision: (candidate.revision ?? 0) + 1 })
        return durable
      })
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) })
    )

    await coordinator.failTaskRun({
      projectId: durable.projectId,
      sessionId: durable.id,
      promptMessageId: 'task-prompt',
      taskRunCommitId: 'task-run',
      messageId: taskMessage.id,
      artifacts: [{ id: 'partial-artifact', kind: 'workspace-file', path: '/partial.txt' }],
      error: 'Provider failed',
      errorReportable: false,
      updatedAt: 9
    })

    expect(durable).toMatchObject({
      revision: 9,
      status: 'error',
      activeRun: undefined,
      error: 'Provider failed',
      errorReportable: false,
      taskRunCommitId: 'task-run',
      runtimeContext: { version: 1, revision: 4 }
    })
    expect(durable.messages.at(-1)?.artifactIds).toEqual(['partial-artifact'])
    expect(durable.artifacts?.map(({ id }) => id)).toEqual([
      'concurrent-artifact',
      'partial-artifact'
    ])
  })

  it('resolves Message membership from the durable active Branch', async () => {
    const prompt = (id: string, createdAt: number): PersistedChatMessage => ({
      id,
      role: 'user',
      content: id,
      status: 'complete',
      eventIds: [],
      createdAt,
      updatedAt: createdAt
    })
    const promptA = prompt('prompt-a', 1)
    const promptB = prompt('prompt-b', 2)
    const original = createLinearConversationGraph({
      sessionId: 'session-1',
      messages: [promptA],
      createdAt: 1,
      updatedAt: 1
    })
    const branchB = synchronizeActiveConversationMessages(
      forkEditedConversationMessage(original, promptA.id, 'branch-b', 2),
      [promptB],
      2
    )
    const durable = createSession({ messages: [promptB], conversationGraph: branchB })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      }))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.containsMessageOnActiveBranch('project-1', 'session-1', promptB.id)
    ).resolves.toBe(true)
    await expect(
      coordinator.containsMessageOnActiveBranch('project-1', 'session-1', promptA.id)
    ).resolves.toBe(false)
  })

  it('materializes a legacy linear Session before checking its active Branch', async () => {
    const durable = createSession({
      messages: [
        {
          id: 'legacy-prompt',
          role: 'user',
          content: 'Legacy prompt',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      }))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.containsMessageOnActiveBranch('project-1', 'session-1', 'legacy-prompt')
    ).resolves.toBe(true)
  })

  it.each(['missing', 'unreadable'] as const)(
    'fails closed when the durable Session is %s',
    async (status) => {
      const repository = createSessionRepository({
        loadSessionWithDiagnostics: vi.fn(async () => ({ status }))
      })
      const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

      await expect(
        coordinator.containsMessageOnActiveBranch('project-1', 'session-1', 'prompt-a')
      ).rejects.toThrow(`Cannot read active Message Branch for a ${status} Session.`)
    }
  )

  it('loads an isolated durable Session snapshot for a continuation', async () => {
    const durable = createSession({
      messages: [
        {
          id: 'prompt-1',
          role: 'user',
          content: 'Run the command',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      }))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const loaded = await coordinator.loadSessionForContinuation('project-1', 'session-1')
    loaded.messages[0].content = 'mutated snapshot'

    expect(durable.messages[0].content).toBe('Run the command')
  })

  it.each(['missing', 'unreadable'] as const)(
    'refuses a durable continuation when the Session is %s',
    async (status) => {
      const repository = createSessionRepository({
        loadSessionWithDiagnostics: vi.fn(async () => ({ status }))
      })
      const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

      await expect(
        coordinator.loadSessionForContinuation('project-1', 'session-1')
      ).rejects.toThrow(`Cannot prepare a durable continuation for a ${status} Session.`)
    }
  )

  it('persists blocked Plan feedback as a standard user Message without changing Plan authority', async () => {
    let durable = createSession({
      status: 'waiting-plan-approval',
      messages: [createUserMessage('interaction-1', 1)],
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const beforePersist = vi.fn()

    await coordinator.appendUserMessageToInteraction({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content: 'Split the analysis by cohort.',
      beforePersist
    })

    expect(beforePersist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        messages: [expect.objectContaining({ id: 'interaction-1' })]
      })
    )
    expect(durable.messages).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: 'Split the analysis by cohort.',
        responseToMessageId: 'interaction-1',
        status: 'complete'
      })
    )
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 2,
      plan: createRuntimePlan()
    })
    expect(durable.status).toBe('waiting-plan-approval')
  })

  it('atomically persists Plan feedback and its neutral review marker in one Session save', async () => {
    let durable = createSession({
      status: 'waiting-plan-approval',
      messages: [createUserMessage('interaction-1', 1)],
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const publishRuntimeContextSession = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publishRuntimeContextSession
    )

    const message = await coordinator.appendUserMessageToInteraction({
      projectId: 'project-1',
      sessionId: 'session-1',
      interactionId: 'interaction-1',
      content: 'Split the analysis by cohort.',
      runtimeContextPatch: {
        expectedRevision: 2,
        patch: (persistedMessage) => ({
          plan: {
            ...createRuntimePlan(),
            reviewFeedbackMessageId: persistedMessage.id
          }
        })
      }
    })

    expect(repository.saveSession).toHaveBeenCalledTimes(1)
    expect(durable.messages).toContainEqual(message)
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 3,
      plan: {
        ...createRuntimePlan(),
        reviewFeedbackMessageId: message.id
      }
    })
    expect(durable.status).toBe('waiting-plan-approval')
    expect(publishRuntimeContextSession).toHaveBeenCalledOnce()
    expect(publishRuntimeContextSession).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ content: 'Split the analysis by cohort.' })
        ]),
        runtimeContext: expect.objectContaining({ revision: 3 })
      }),
      'runtime-context'
    )
  })

  it('persists Side chat projection and relays without overwriting concurrent authority', async () => {
    let durable = createSession({
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveSideChatProjection({
      projectId: 'project-1',
      sessionId: 'session-1',
      sideChat: createSideChatProjection()
    })
    await coordinator.appendSideChatRelay({
      projectId: 'project-1',
      sessionId: 'session-1',
      sideChatId: 'side-chat-1',
      relay: { id: 'relay-1', text: 'Use a black line.', createdAt: 11 }
    })
    await coordinator.saveSideChatProjection({
      projectId: 'project-1',
      sessionId: 'session-1',
      sideChat: createSideChatProjection({
        entries: [{ id: 'user-1', kind: 'message', role: 'user', text: 'Follow up' }],
        updatedAt: 12
      })
    })

    expect(durable.runtimeContext).toMatchObject({
      revision: 5,
      plan: createRuntimePlan(),
      sideChat: {
        id: 'side-chat-1',
        entries: [{ id: 'user-1', kind: 'message', role: 'user', text: 'Follow up' }]
      },
      sideChatRelays: [
        {
          id: 'relay-1',
          sideChatId: 'side-chat-1',
          text: 'Use a black line.',
          createdAt: 11
        }
      ]
    })
  })

  it('publishes the parent Session after every Side chat mutation', async () => {
    let durable = createSession({ messages: [createUserMessage('main-prompt-1', 1)] })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const publishSession = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publishSession
    )

    await coordinator.saveSideChatProjection({
      projectId: 'project-1',
      sessionId: 'session-1',
      sideChat: createSideChatProjection()
    })
    await coordinator.appendSideChatRelay({
      projectId: 'project-1',
      sessionId: 'session-1',
      sideChatId: 'side-chat-1',
      relay: { id: 'relay-1', text: 'Use a black line.', createdAt: 11 }
    })
    await coordinator.commitSideChatRelays({
      projectId: 'project-1',
      sessionId: 'session-1',
      relayIds: ['relay-1'],
      promptMessageId: 'main-prompt-1'
    })
    await coordinator.clearSideChat({
      projectId: 'project-1',
      sessionId: 'session-1',
      sideChatId: 'side-chat-1'
    })

    expect(publishSession.mock.calls).toEqual(
      [1, 2, 3, 4].map((revision) => [
        expect.objectContaining({
          id: 'session-1',
          runtimeContext: expect.objectContaining({ revision })
        }),
        'runtime-context'
      ])
    )
  })

  it('keeps durable relays deliverable after clearing their producer Side chat', async () => {
    let durable = createSession({
      messages: [createUserMessage('main-prompt-1', 1), createUserMessage('main-prompt-2', 2)],
      runtimeContext: {
        version: 1,
        revision: 5,
        plan: createRuntimePlan(),
        sideChat: createSideChatProjection({ updatedAt: 12 }),
        sideChatRelays: [
          {
            id: 'relay-1',
            sideChatId: 'side-chat-1',
            text: 'Use a black line.',
            createdAt: 11
          },
          {
            id: 'relay-2',
            sideChatId: 'side-chat-1',
            text: 'Keep this queued.',
            createdAt: 12
          }
        ]
      }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const delivered = await coordinator.commitSideChatRelays({
      projectId: 'project-1',
      sessionId: 'session-1',
      relayIds: ['relay-1'],
      promptMessageId: 'main-prompt-1'
    })

    expect(delivered).toEqual([
      expect.objectContaining({
        content: 'Use a black line.',
        responseToMessageId: 'main-prompt-1',
        relayedFrom: { kind: 'side-chat', direction: 'to-main' }
      })
    ])
    expect(durable.runtimeContext).toMatchObject({
      sideChatRelays: [
        {
          id: 'relay-2',
          sideChatId: 'side-chat-1',
          text: 'Keep this queued.',
          createdAt: 12
        }
      ]
    })
    expect(durable.messages).toContainEqual(delivered[0])

    await expect(
      coordinator.clearSideChat({
        projectId: 'project-1',
        sessionId: 'session-1',
        sideChatId: 'side-chat-1'
      })
    ).resolves.toBe(true)
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 7,
      plan: createRuntimePlan(),
      sideChatRelays: [
        {
          id: 'relay-2',
          sideChatId: 'side-chat-1',
          text: 'Keep this queued.',
          createdAt: 12
        }
      ]
    })

    await expect(
      coordinator.commitSideChatRelays({
        projectId: 'project-1',
        sessionId: 'session-1',
        relayIds: ['relay-2'],
        promptMessageId: 'main-prompt-2'
      })
    ).resolves.toEqual([
      expect.objectContaining({
        content: 'Keep this queued.',
        responseToMessageId: 'main-prompt-2'
      })
    ])
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 8,
      plan: createRuntimePlan()
    })
  })

  it('loads a read-only durable Side chat catalog without starting recovery work', async () => {
    const session = createSession({
      runtimeContext: {
        version: 1,
        revision: 1,
        sideChat: createSideChatProjection(),
        sideChatRelays: [
          {
            id: 'relay-open',
            sideChatId: 'side-chat-1',
            text: 'From open chat',
            createdAt: 12
          }
        ]
      }
    })
    const closedSession = createSession({
      id: 'session-closed-side-chat',
      runtimeContext: {
        version: 1,
        revision: 2,
        sideChatRelays: [
          {
            id: 'relay-closed',
            sideChatId: 'side-chat-closed',
            text: 'From closed chat',
            createdAt: 13
          }
        ]
      }
    })
    const loadAllWithDiagnostics = vi.fn().mockResolvedValue({
      result: { sessions: [session, closedSession], manifest: { version: 1 } },
      isComplete: true
    })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({ loadAllWithDiagnostics }),
      createFileIndex()
    )

    await expect(coordinator.loadPersistedSideChats()).resolves.toEqual({
      sideChats: [
        {
          projectId: 'project-1',
          parentSessionId: 'session-1',
          sideChat: createSideChatProjection()
        }
      ],
      relays: [
        {
          projectId: 'project-1',
          parentSessionId: 'session-1',
          relays: [
            {
              id: 'relay-open',
              sideChatId: 'side-chat-1',
              text: 'From open chat',
              createdAt: 12
            }
          ]
        },
        {
          projectId: 'project-1',
          parentSessionId: 'session-closed-side-chat',
          relays: [
            {
              id: 'relay-closed',
              sideChatId: 'side-chat-closed',
              text: 'From closed chat',
              createdAt: 13
            }
          ]
        }
      ],
      isComplete: true
    })
    expect(loadAllWithDiagnostics).toHaveBeenCalledWith({ mode: 'read-only' })
  })

  it('does not persist Plan feedback when its interaction commit precondition fails', async () => {
    const durable = createSession({
      status: 'waiting-plan-approval',
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn()
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.appendUserMessageToInteraction({
        projectId: 'project-1',
        sessionId: 'session-1',
        interactionId: 'interaction-1',
        content: 'Stale feedback.',
        beforePersist: () => {
          throw new Error('interaction superseded')
        }
      })
    ).rejects.toThrow('interaction superseded')

    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(durable.messages).toEqual([])
  })

  it('atomically reads and patches main-owned runtime context with a new revision', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({ updatedAt: previousUpdatedAt })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = {
          ...structuredClone(session),
          revision: (session.revision ?? 0) + 1
        }
        return structuredClone(durable)
      })
    })
    const publishRuntimeContextSession = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      publishRuntimeContextSession
    )

    await expect(coordinator.readSessionRuntimeContext('project-1', 'session-1')).resolves.toEqual({
      version: 1,
      revision: 0
    })
    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 0,
        patch: { plan: createRuntimePlan() }
      })
    ).resolves.toEqual({
      version: 1,
      revision: 1,
      plan: createRuntimePlan()
    })
    await expect(coordinator.readSessionRuntimeContext('project-1', 'session-1')).resolves.toEqual({
      version: 1,
      revision: 1,
      plan: createRuntimePlan()
    })
    expect(durable.updatedAt).toBeGreaterThan(previousUpdatedAt)
    expect(publishRuntimeContextSession).toHaveBeenCalledOnce()
    expect(publishRuntimeContextSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        revision: 1,
        runtimeContext: expect.objectContaining({ revision: 1 })
      }),
      'runtime-context'
    )
  })

  it('does not persist a runtime context patch when its commit precondition fails', async () => {
    const durable = createSession({
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn()
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 2,
        patch: { plan: createRuntimePlan({ approval: 'approved' }) },
        beforePersist: () => {
          throw new Error('interaction superseded')
        }
      })
    ).rejects.toThrow('interaction superseded')

    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 2,
      plan: createRuntimePlan()
    })
  })

  it('rejects stale and duplicate runtime context patches without overwriting durable authority', async () => {
    let durable = createSession({
      runtimeContext: { version: 1, revision: 4, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const command = {
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 4,
      patch: { plan: createRuntimePlan({ approval: 'approved' }) }
    } as const

    await expect(coordinator.patchSessionRuntimeContext(command)).resolves.toMatchObject({
      revision: 5,
      plan: createRuntimePlan({ approval: 'approved' })
    })
    await expect(coordinator.patchSessionRuntimeContext(command)).rejects.toMatchObject({
      code: 'revision-conflict',
      expectedRevision: 4,
      actualRevision: 5
    })
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(durable.runtimeContext).toMatchObject({
      revision: 5,
      plan: createRuntimePlan({ approval: 'approved' })
    })
    expect(SessionRuntimeContextRevisionConflictError).toBeTypeOf('function')
  })

  it('preserves authoritative runtime context and approval waiting status on a stale renderer save', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({
      title: 'Before rename',
      status: 'waiting-plan-approval',
      updatedAt: previousUpdatedAt,
      specialistId: 'specialist-new',
      specialistBindingPending: true,
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const staleRendererSnapshot = createSession({
      title: 'Renamed by renderer',
      status: 'idle',
      specialistId: 'specialist-old',
      runtimeContext: {
        version: 1,
        revision: 0,
        plan: createRuntimePlan({ approval: 'approved' })
      }
    })

    await expect(coordinator.saveSession(staleRendererSnapshot)).resolves.toMatchObject({
      title: 'Renamed by renderer',
      status: 'waiting-plan-approval',
      specialistId: 'specialist-new',
      specialistBindingPending: true,
      runtimeContext: { version: 1, revision: 2, plan: createRuntimePlan() }
    })
    expect(durable.runtimeContext).toEqual({
      version: 1,
      revision: 2,
      plan: createRuntimePlan()
    })
    expect(durable.updatedAt).toBe(previousUpdatedAt)
  })

  it('preserves Main-owned Session details and usage across a stale renderer save', async () => {
    let durable = createSession({
      title: 'Generated title',
      description: 'Generated description',
      sessionDetailsSource: 'generated',
      sessionDetailsGeneration: {
        status: 'succeeded',
        sourceMessageId: 'message-1',
        requestId: 'details-1',
        queuedAt: 10,
        startedAt: 11,
        frameworkId: 'opencode',
        providerId: 'provider-1',
        model: 'model-1',
        reasoningEffort: 'low',
        completedAt: 12,
        usage: { inputTokens: 20, cacheTokens: 3, outputTokens: 8 }
      }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const saved = await coordinator.saveSession(
      createSession({
        title: 'Stale fallback',
        description: 'Stale fallback description',
        sessionDetailsSource: 'fallback',
        sessionDetailsGeneration: {
          status: 'queued',
          sourceMessageId: 'message-1',
          requestId: 'details-1',
          queuedAt: 10
        }
      })
    )

    expect(saved).toMatchObject({
      title: 'Generated title',
      description: 'Generated description',
      sessionDetailsSource: 'generated',
      sessionDetailsGeneration: {
        status: 'succeeded',
        usage: { inputTokens: 20, cacheTokens: 3, outputTokens: 8 }
      }
    })
  })

  it('commits a dedicated Session-details mutation against current durable revision', async () => {
    const durable = createSession({ revision: 5, title: 'Fallback' })
    const saveSession = vi.fn(async (session: PersistedChatSession, expectedRevision?: number) => ({
      ...session,
      revision: (expectedRevision ?? 0) + 1
    }))
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.mutateSessionDetailsAuthority('project-1', 'session-1', (session) => ({
        ...session,
        title: 'Manual',
        description: 'Edited',
        sessionDetailsSource: 'manual'
      }))
    ).resolves.toMatchObject({ revision: 6, title: 'Manual', description: 'Edited' })
    expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ title: 'Manual' }), 5)
  })

  it('preserves a running Session while committing Session-details authority before prompt admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-live-session-details-'))
    const repository = new SessionRepository(root, { hasActiveRuntimePrompt: () => false })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const prompt: PersistedChatMessage = {
      id: 'prompt-1',
      role: 'user',
      content: 'Investigate the interrupted banner',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }

    try {
      const running = await repository.saveSession(
        createSession({
          status: 'running',
          activeRun: { promptMessageId: prompt.id, startedAt: 3 },
          messages: [prompt],
          sessionDetailsGenerationEligible: true
        })
      )

      const mutated = await coordinator.mutateSessionDetailsAuthority(
        running.projectId,
        running.id,
        (current) => ({
          ...current,
          title: 'Interrupted banner investigation',
          description: 'Investigate why an active Session shows an interrupted banner.',
          sessionDetailsSource: 'fallback'
        })
      )

      expect(mutated).toMatchObject({
        status: 'running',
        activeRun: { promptMessageId: prompt.id, startedAt: 3 }
      })
      expect(mutated?.error).toBeUndefined()
      expect(mutated?.resumeRecovery).toBeUndefined()
      expect(mutated?.messages).toEqual([prompt])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves a running Session across an unrelated Main-owned policy mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-live-policy-mutation-'))
    const repository = new SessionRepository(root, { hasActiveRuntimePrompt: () => false })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const prompt: PersistedChatMessage = {
      id: 'prompt-1',
      role: 'user',
      content: 'Complete the task',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }

    try {
      await repository.saveSession(
        createSession({
          status: 'running',
          activeRun: { promptMessageId: prompt.id, startedAt: 3 },
          sessionDetailsGenerationEligible: true,
          messages: [prompt]
        })
      )

      const mutated = await coordinator.setSessionDelegationPolicy('project-1', 'session-1', 'deny')

      expect(mutated).toMatchObject({
        status: 'running',
        activeRun: { promptMessageId: prompt.id, startedAt: 3 },
        sessionDetailsGenerationEligible: true,
        delegationPolicy: 'deny'
      })
      expect(mutated.error).toBeUndefined()
      expect(mutated.resumeRecovery).toBeUndefined()
      expect(mutated.messages).toEqual([prompt])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not turn an unchanged runtime-context merge into Session activity', async () => {
    const activityAt = Date.now() - 24 * 60 * 60 * 1_000
    let durable = createSession({
      updatedAt: activityAt,
      runtimeContext: { version: 1, revision: 4 }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveSession(structuredClone(durable))

    expect(durable.updatedAt).toBe(activityAt)
  })

  it('rejects a stale whole-session snapshot before it replaces newer renderer-owned fields', async () => {
    const olderMessage: PersistedChatMessage = {
      id: 'older-message',
      role: 'user',
      content: 'Older prompt',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    const newerMessage: PersistedChatMessage = {
      id: 'newer-message',
      role: 'agent',
      content: 'Newer response',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    let durable = materializeSessionConversationGraph(
      createSession({
        revision: 1,
        title: 'Newer title',
        messages: [olderMessage, newerMessage],
        updatedAt: 4
      })
    )
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const staleSnapshot = materializeSessionConversationGraph(
      createSession({ revision: 0, title: 'Older title', messages: [olderMessage], updatedAt: 2 })
    )

    await expect(coordinator.saveSession(staleSnapshot)).rejects.toMatchObject({
      code: 'session-revision-conflict',
      expectedRevision: 0,
      actualRevision: 1
    })

    expect.soft(durable.title).toBe('Newer title')
    expect
      .soft(durable.messages.map((message) => message.id))
      .toEqual([olderMessage.id, newerMessage.id])
    expect
      .soft(durable.conversationGraph?.messages.map((message) => message.id))
      .toEqual([olderMessage.id, newerMessage.id])
  })

  it('rebases explicit renderer fields when a stale save carries the unchanged durable graph', async () => {
    const message: PersistedChatMessage = {
      id: 'message-1',
      role: 'user',
      content: 'Keep this graph',
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
    let durable = materializeSessionConversationGraph(
      createSession({
        revision: 2,
        title: 'Remote title',
        pinned: true,
        messages: [message],
        updatedAt: 3
      })
    )
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session, expectedRevision) => {
        durable = structuredClone({
          ...session,
          revision: (expectedRevision ?? session.revision ?? 0) + 1
        })
        return durable
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const staleTitleEdit = materializeSessionConversationGraph(
      createSession({
        revision: 1,
        title: 'Local title',
        messages: [message],
        updatedAt: 3
      })
    )

    await expect(
      coordinator.saveSession(staleTitleEdit, { conflictRebaseFields: ['title'] })
    ).resolves.toMatchObject({ revision: 3, title: 'Local title', pinned: true })
    expect(durable.conversationGraph?.messages.map(({ id }) => id)).toEqual([message.id])
    expect(durable.conversationGraph?.branches.map(({ id }) => id)).toEqual(
      staleTitleEdit.conversationGraph?.branches.map(({ id }) => id)
    )
  })

  it('rejects saving a globally identified Session under another Project', async () => {
    const existing = createSession({ id: 'session-1', projectId: 'project-a' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [existing], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    await coordinator.loadAll()
    vi.mocked(repository.saveSession).mockClear()

    await expect(
      coordinator.saveSession(createSession({ id: existing.id, projectId: 'project-b' }))
    ).rejects.toThrow(/Session id.*another Project/)
    expect(repository.loadSessionWithDiagnostics).not.toHaveBeenCalled()
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('delegates durable ownership verification when an incomplete catalog omitted a Session', async () => {
    const assertSessionIdentityOwnership = vi
      .fn()
      .mockRejectedValue(
        new Error('Cannot save a Session id that is already owned by another Project.')
      )
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [], manifest: { version: 1 } },
        isComplete: false,
        warnings: []
      }),
      assertSessionIdentityOwnership
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    await coordinator.loadAll()

    await expect(
      coordinator.saveSession(createSession({ id: 'session-1', projectId: 'project-c' }))
    ).rejects.toThrow(/Session id.*another Project/)
    expect(assertSessionIdentityOwnership).toHaveBeenCalledWith('session-1', 'project-c')
    expect(repository.loadSessionWithDiagnostics).not.toHaveBeenCalled()
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('keeps branch source immutable and does not backfill historical Sessions', async () => {
    const originalBranchSource = {
      sessionId: 'source-session',
      agentFrameId: 'source-frame',
      messageBranchId: 'source-branch',
      headMessageId: 'source-head'
    }
    let durable = createSession({ branchSource: originalBranchSource })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.saveSession(
        createSession({
          branchSource: { sessionId: 'replacement-source' }
        })
      )
    ).resolves.toMatchObject({ branchSource: originalBranchSource })

    durable = createSession()
    const historical = await coordinator.saveSession(
      createSession({ branchSource: { sessionId: 'retroactive-source' } })
    )
    expect(historical.branchSource).toBeUndefined()
    expect(durable.branchSource).toBeUndefined()
  })

  it('preserves authoritative permission context and waiting status on a stale renderer save', async () => {
    let durable = createSession({
      status: 'waiting-permission',
      runtimeContext: { version: 1, revision: 3, permission: createRuntimePermission() }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.saveSession(createSession({ status: 'idle', runtimeContext: undefined }))
    ).resolves.toMatchObject({
      status: 'waiting-permission',
      runtimeContext: {
        version: 1,
        revision: 3,
        permission: { request: { requestId: 'permission-1' } }
      }
    })
    expect(durable.status).toBe('waiting-permission')
    expect(durable.runtimeContext?.permission).toEqual(createRuntimePermission())
  })

  it('does not let a stale renderer save revive a permission wait after main clears it', async () => {
    let durable = createSession({
      status: 'running',
      runtimeContext: { version: 1, revision: 4 }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.saveSession(
        createSession({
          status: 'waiting-permission',
          runtimeContext: { version: 1, revision: 3, permission: createRuntimePermission() }
        })
      )
    ).resolves.toMatchObject({
      status: 'running',
      runtimeContext: { version: 1, revision: 4 }
    })
    expect(durable.runtimeContext?.permission).toBeUndefined()
  })

  it('does not let a stale renderer save revive a consumed permission continuation', async () => {
    const continuingPermission = { ...createRuntimePermission(), state: 'continuing' as const }
    let durable = createSession({
      status: 'running',
      runtimeContext: { version: 1, revision: 4, permission: continuingPermission }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.saveSession(
        createSession({
          status: 'waiting-permission',
          runtimeContext: { version: 1, revision: 3, permission: createRuntimePermission() }
        })
      )
    ).resolves.toMatchObject({
      status: 'running',
      runtimeContext: { version: 1, revision: 4, permission: continuingPermission }
    })
    expect(durable.status).toBe('running')
    expect(durable.runtimeContext?.permission).toEqual(continuingPermission)
  })

  it('preserves committed Side chat relays on a stale renderer save', async () => {
    const prompt: PersistedChatMessage = {
      id: 'main-prompt-1',
      role: 'user',
      content: 'Draw a cosine curve.',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    const relay: PersistedChatMessage = {
      id: 'side-chat-relay-1',
      role: 'user',
      content: 'Use a black line.',
      status: 'complete',
      eventIds: [],
      responseToMessageId: prompt.id,
      relayedFrom: { kind: 'side-chat', direction: 'to-main' },
      createdAt: 4,
      updatedAt: 4
    }
    let durable = materializeSessionConversationGraph(
      createSession({ messages: [prompt, relay], updatedAt: 4 })
    )
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveSession(
      materializeSessionConversationGraph(
        createSession({ title: 'Renamed by renderer', messages: [prompt], updatedAt: 3 })
      )
    )

    expect(durable.title).toBe('Renamed by renderer')
    expect(durable.messages).toEqual([prompt, relay])
    expect(durable.conversationGraph?.messages.map((message) => message.id)).toContain(relay.id)
  })

  it('preserves Renderer delivery evidence on a Main-owned Side chat relay', async () => {
    const prompt: PersistedChatMessage = {
      id: 'main-prompt-1',
      role: 'user',
      content: 'Draw a cosine curve.',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    const relay: PersistedChatMessage = {
      id: 'side-chat-relay-1',
      role: 'user',
      content: 'Use a black line.',
      status: 'complete',
      eventIds: [],
      responseToMessageId: prompt.id,
      relayedFrom: { kind: 'side-chat', direction: 'to-main' },
      createdAt: 4,
      updatedAt: 4
    }
    let durable = materializeSessionConversationGraph(
      createSession({ messages: [prompt, relay], updatedAt: 4 })
    )
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const deliveredEventId = `side-chat-delivered:${relay.id}`
    const deliveredRelay = { ...relay, eventIds: [deliveredEventId] }

    await coordinator.saveSession(
      materializeSessionConversationGraph(
        createSession({ messages: [prompt, deliveredRelay], updatedAt: 5 })
      )
    )

    expect(durable.messages).toContainEqual(deliveredRelay)
    expect(
      durable.conversationGraph?.messages.find((message) => message.id === relay.id)?.eventIds
    ).toEqual([deliveredEventId])
  })

  it('keeps a concurrent Side chat relay on its inactive Branch after a message edit', async () => {
    const prompt: PersistedChatMessage = {
      id: 'main-prompt-1',
      role: 'user',
      content: 'Draw a cosine curve.',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    const relay: PersistedChatMessage = {
      id: 'side-chat-relay-1',
      role: 'user',
      content: 'Use a black line.',
      status: 'complete',
      eventIds: [],
      responseToMessageId: prompt.id,
      relayedFrom: { kind: 'side-chat', direction: 'to-main' },
      createdAt: 4,
      updatedAt: 4
    }
    let durable = materializeSessionConversationGraph(
      createSession({ messages: [prompt, relay], updatedAt: 4 })
    )
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const editedGraph = forkEditedConversationMessage(
      durable.conversationGraph!,
      prompt.id,
      'edited-branch',
      5
    )

    await coordinator.saveSession({
      ...durable,
      messages: [],
      conversationGraph: editedGraph,
      updatedAt: 5
    })

    expect(durable.messages).toEqual([])
    expect(durable.conversationGraph?.messages.map((message) => message.id)).toEqual([
      prompt.id,
      relay.id
    ])
  })

  it('preserves main-owned archive state on a stale whole-session save', async () => {
    let durable = createSession({ archivedAt: 10 })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveSession(createSession({ title: 'Renderer rename' }))

    expect(durable).toMatchObject({ title: 'Renderer rename', archivedAt: 10 })
  })

  it('lets only Task-owned saves advance the Task Run commit witness', async () => {
    let durable = createSession({ taskRunCommitId: 'committed-run' })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveSession(
      createSession({ title: 'Renderer rename', taskRunCommitId: 'forged-run' })
    )
    expect(durable).toMatchObject({ title: 'Renderer rename', taskRunCommitId: 'committed-run' })

    await coordinator.saveSession(
      { ...durable, taskRunCommitId: 'next-run' },
      {},
      { taskRunCommit: true }
    )
    expect(durable.taskRunCommitId).toBe('next-run')
  })

  it('updates delegation policy through its dedicated durable Session owner', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({ delegationPolicy: 'allow', updatedAt: previousUpdatedAt })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const onDelegationPolicyUpdated = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onDelegationPolicyUpdated
    )

    await expect(
      coordinator.setSessionDelegationPolicy('project-1', 'session-1', 'deny')
    ).resolves.toMatchObject({ delegationPolicy: 'deny' })

    expect(durable.delegationPolicy).toBe('deny')
    expect(durable.updatedAt).toBeGreaterThan(previousUpdatedAt)
    expect(onDelegationPolicyUpdated).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'session-1', delegationPolicy: 'deny' })
    )
  })

  it('updates Main-owned Session configuration in one revision-checked commit', async () => {
    let durable = createSession({
      revision: 4,
      title: 'Authoritative title',
      memoryEnabled: true,
      delegationPolicy: 'allow',
      enabledComputeHosts: ['ssh:old'],
      selectedComputeHosts: ['ssh:old']
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session, expectedRevision) => {
        const revision = expectedRevision ?? session.revision ?? 0
        if (revision !== durable.revision) {
          throw new SessionRevisionConflictError(revision, durable.revision ?? 0)
        }
        durable = structuredClone({ ...session, revision: revision + 1 })
        return durable
      })
    })
    const onDelegationPolicyUpdated = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      onDelegationPolicyUpdated
    )
    const candidate = createSession({
      ...durable,
      title: 'Untrusted replacement title',
      permissionProfile: 'full',
      memoryEnabled: false,
      delegationPolicy: 'deny',
      enabledComputeHosts: ['ssh:new'],
      selectedComputeHosts: ['ssh:new']
    })

    await expect(coordinator.updateSessionConfiguration(candidate, 4)).resolves.toMatchObject({
      revision: 5,
      title: 'Authoritative title',
      permissionProfile: 'full',
      memoryEnabled: false,
      delegationPolicy: 'deny',
      enabledComputeHosts: ['ssh:new'],
      selectedComputeHosts: ['ssh:new']
    })
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(onDelegationPolicyUpdated).toHaveBeenCalledOnce()

    await expect(coordinator.updateSessionConfiguration(candidate, 4)).rejects.toMatchObject({
      code: 'session-revision-conflict',
      expectedRevision: 4,
      actualRevision: 5
    })
  })

  it('rejects a configuration update after a Run wins the Session lane', async () => {
    const durable = createSession({
      revision: 5,
      status: 'running',
      activeRun: { promptMessageId: 'prompt-1', startedAt: 3 }
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      }))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.updateSessionConfiguration(
        { ...durable, memoryEnabled: false, status: 'idle', activeRun: undefined },
        5
      )
    ).rejects.toMatchObject({
      code: 'session-configuration-busy',
      sessionId: durable.id
    })
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('preserves main-owned delegation policy on an ordinary existing-Session save', async () => {
    let durable = createSession({ delegationPolicy: 'deny' })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.saveSession(
        createSession({ title: 'Renderer rename', delegationPolicy: 'allow' })
      )
    ).resolves.toMatchObject({ title: 'Renderer rename', delegationPolicy: 'deny' })
    expect(durable.delegationPolicy).toBe('deny')
  })

  it('persists Compute concurrency through its dedicated Session owner', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({ updatedAt: previousUpdatedAt })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session, expectedRevision) => {
        durable = structuredClone({
          ...session,
          revision: (expectedRevision ?? session.revision ?? 0) + 1
        })
        return durable
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.setSessionComputeConcurrencyLimit('project-1', 'session-1', 2)
    ).resolves.toMatchObject({ computeConcurrencyLimit: 2 })

    expect(durable.computeConcurrencyLimit).toBe(2)
    expect(durable.updatedAt).toBeGreaterThan(previousUpdatedAt)
  })

  it('preserves Main-owned Compute concurrency on an ordinary existing-Session save', async () => {
    let durable = createSession({ computeConcurrencyLimit: 2 })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveSession(
      createSession({ title: 'Renderer rename', computeConcurrencyLimit: 9 })
    )

    expect(durable).toMatchObject({ title: 'Renderer rename', computeConcurrencyLimit: 2 })
  })

  it('updates enabled Compute Hosts through the durable Session owner', async () => {
    const previousUpdatedAt = Date.now() + 10_000
    let durable = createSession({
      title: 'Authoritative session',
      enabledComputeHosts: ['ssh:old'],
      updatedAt: previousUpdatedAt
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session, expectedRevision) => {
        durable = structuredClone({
          ...session,
          revision: (expectedRevision ?? session.revision ?? 0) + 1
        })
        return durable
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const result = await coordinator.setSessionEnabledComputeHosts('project-1', 'session-1', [
      'ssh:new'
    ])

    expect(result).toEqual(durable)
    expect(durable).toMatchObject({
      id: 'session-1',
      projectId: 'project-1',
      title: 'Authoritative session',
      enabledComputeHosts: ['ssh:new']
    })
    expect(durable.updatedAt).toBeGreaterThan(previousUpdatedAt)
  })

  it('applies Session Compute Host access intents atomically', async () => {
    let durable = createSession({
      enabledComputeHosts: ['ssh:available', 'ssh:selected'],
      selectedComputeHosts: ['ssh:selected']
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session, expectedRevision) => {
        durable = structuredClone({
          ...session,
          revision: (expectedRevision ?? session.revision ?? 0) + 1
        })
        return durable
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.mutateSessionComputeHostAccess('project-1', 'session-1', {
      kind: 'set-host-enabled',
      providerId: 'ssh:selected',
      enabled: false
    })
    await coordinator.mutateSessionComputeHostAccess('project-1', 'session-1', {
      kind: 'set-host-enabled',
      providerId: 'ssh:selected',
      enabled: true
    })

    expect(durable.enabledComputeHosts).toEqual(['ssh:available', 'ssh:selected'])
    expect(durable.selectedComputeHosts).toEqual([])
  })

  it('preserves enabled Compute Host authority on an ordinary existing-Session save', async () => {
    const authorityUpdatedAt = Date.now() + 10_000
    let durable = createSession({
      title: 'Before rename',
      enabledComputeHosts: ['ssh:authoritative'],
      selectedComputeHosts: [],
      updatedAt: authorityUpdatedAt
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const result = await coordinator.saveSession(
      createSession({
        title: 'Renamed',
        enabledComputeHosts: ['ssh:stale'],
        selectedComputeHosts: ['ssh:stale'],
        updatedAt: authorityUpdatedAt - 1_000
      })
    )

    expect(result).toMatchObject({
      title: 'Renamed',
      enabledComputeHosts: ['ssh:authoritative'],
      selectedComputeHosts: []
    })
    expect(durable.enabledComputeHosts).toEqual(['ssh:authoritative'])
    expect(durable.selectedComputeHosts).toEqual([])
    expect(durable.updatedAt).toBe(authorityUpdatedAt)
  })

  it('prunes missing Compute Hosts across a complete durable Session catalog', async () => {
    let sessions = [
      createSession({
        enabledComputeHosts: ['ssh:kept', 'ssh:deleted'],
        selectedComputeHosts: ['ssh:deleted']
      }),
      createSession({
        id: 'session-2',
        enabledComputeHosts: ['ssh:kept'],
        selectedComputeHosts: [],
        updatedAt: 5
      })
    ]
    const saveSession = vi.fn(async (session: PersistedChatSession) => {
      sessions = sessions.map((candidate) =>
        candidate.id === session.id ? structuredClone(session) : candidate
      )
    })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions, manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const result = await coordinator.pruneSessionEnabledComputeHosts(['ssh:kept'])

    expect(result.sessions.map((session) => session.enabledComputeHosts)).toEqual([
      ['ssh:kept'],
      ['ssh:kept']
    ])
    expect(result.sessions.map((session) => session.selectedComputeHosts)).toEqual([[], []])
    expect(result.previousSelections).toEqual([
      {
        projectId: 'project-1',
        sessionId: 'session-1',
        providerIds: ['ssh:kept', 'ssh:deleted'],
        selectedProviderIds: ['ssh:deleted']
      }
    ])
    expect(saveSession).toHaveBeenCalledTimes(1)
    expect(saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'session-1',
        enabledComputeHosts: ['ssh:kept'],
        selectedComputeHosts: []
      })
    )
  })

  it('preserves startup interruption recovery while pruning missing Compute Hosts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-startup-compute-prune-'))
    const repository = new SessionRepository(root)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const prompt: PersistedChatMessage = {
      id: 'prompt-1',
      role: 'user',
      content: 'Complete the task',
      status: 'complete',
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    try {
      await repository.saveSession(
        createSession({
          status: 'running',
          activeRun: { promptMessageId: prompt.id, startedAt: 3 },
          enabledComputeHosts: ['ssh:missing'],
          selectedComputeHosts: ['ssh:missing'],
          messages: [prompt]
        })
      )

      const result = await coordinator.pruneSessionEnabledComputeHosts([])

      expect(result.sessions[0]).toMatchObject({
        status: 'error',
        error: 'Session was interrupted before the app closed.',
        resumeRecovery: {
          kind: 'resume-required',
          cause: 'app-restart',
          promptMessageId: prompt.id
        },
        enabledComputeHosts: [],
        selectedComputeHosts: []
      })
      expect(result.sessions[0].activeRun).toBeUndefined()
      expect(result.sessions[0].messages[0]).toMatchObject({ interrupted: true })
      await expect(repository.loadSession('project-1', 'session-1')).resolves.toMatchObject({
        status: 'error',
        error: 'Session was interrupted before the app closed.'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('restores every attempted Session when durable Compute Host pruning fails partway', async () => {
    const originalSessions = [
      createSession({ enabledComputeHosts: ['ssh:kept', 'ssh:deleted'] }),
      createSession({
        id: 'session-2',
        enabledComputeHosts: ['ssh:deleted'],
        updatedAt: 5
      })
    ]
    let sessions = structuredClone(originalSessions)
    let saveAttempts = 0
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions, manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        saveAttempts += 1
        sessions = sessions.map((candidate) =>
          candidate.id === session.id ? structuredClone(session) : candidate
        )
        if (saveAttempts === 2) throw new Error('Session write failed')
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(coordinator.pruneSessionEnabledComputeHosts(['ssh:kept'])).rejects.toThrow(
      'Session write failed'
    )

    expect(sessions.map((session) => session.enabledComputeHosts)).toEqual(
      originalSessions.map((session) => session.enabledComputeHosts)
    )
  })

  it('refuses Compute Host pruning from an incomplete Session catalog', async () => {
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [createSession()], manifest: { version: 1 as const } },
        isComplete: false
      }))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(coordinator.pruneSessionEnabledComputeHosts([])).rejects.toThrow(
      'complete Session catalog'
    )
  })

  it('rejects Session archive while the Session is running', async () => {
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: createSession({ status: 'running' })
      }))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.updateArchive({
        projectId: 'project-1',
        sessionId: 'session-1',
        archived: true,
        expectedArchivedAt: null
      })
    ).rejects.toThrow('Finish or stop this session before archiving.')
  })

  it('rejects Project archive while an idle Session has a current child Attempt on any branch', async () => {
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createIdleSessionWithRunningChild()],
        isComplete: true
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(coordinator.assertProjectArchivable('project-1')).rejects.toThrow(
      'Finish or stop active sessions before archiving this project.'
    )

    const inactiveRoute = createIdleSessionWithRunningChild('inactive-root-prompt')
    vi.mocked(repository.loadProjectWithDiagnostics).mockResolvedValue({
      sessions: [inactiveRoute],
      isComplete: true
    })
    await expect(coordinator.assertProjectArchivable('project-1')).rejects.toThrow(
      'Finish or stop active sessions before archiving this project.'
    )
  })

  it('rejects Session archive while its current child Attempt is still running', async () => {
    const delegated = createIdleSessionWithRunningChild()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({
        status: 'found',
        session: delegated
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(
      coordinator.updateArchive({
        projectId: delegated.projectId,
        sessionId: delegated.id,
        archived: true,
        expectedArchivedAt: null
      })
    ).rejects.toThrow('Finish or stop this session before archiving.')

    expect(repository.saveSession).not.toHaveBeenCalled()

    const inactiveRoute = createIdleSessionWithRunningChild('inactive-root-prompt')
    vi.mocked(repository.loadSessionWithDiagnostics).mockResolvedValue({
      status: 'found',
      session: inactiveRoute
    })
    await expect(
      coordinator.updateArchive({
        projectId: inactiveRoute.projectId,
        sessionId: inactiveRoute.id,
        archived: true,
        expectedArchivedAt: null
      })
    ).rejects.toThrow('Finish or stop this session before archiving.')

    const terminal = structuredClone(inactiveRoute)
    const latest = terminal.runtimeContext?.delegatedWork?.records[0]?.attempts[0]
    if (latest) Object.assign(latest, { status: 'completed', endedAt: 3 })
    vi.mocked(repository.loadSessionWithDiagnostics).mockResolvedValue({
      status: 'found',
      session: terminal
    })
    await expect(
      coordinator.updateArchive({
        projectId: terminal.projectId,
        sessionId: terminal.id,
        archived: true,
        expectedArchivedAt: null
      })
    ).resolves.toMatchObject({ archivedAt: expect.any(Number) })
  })

  it('rejects archive while an idle Session has an answerable delegated question', async () => {
    const delegated = createIdleSessionWithPendingDelegatedQuestion()
    const root = await mkdtemp(join(tmpdir(), 'open-science-pending-question-archive-'))
    const repository = new SessionRepository(root)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    try {
      await repository.saveSession(delegated)
      const persisted = await repository.loadSession(delegated.projectId, delegated.id)
      expect(hasAnswerableDelegatedQuestion(persisted)).toBe(true)

      const [projectArchive] = await Promise.allSettled([
        coordinator.assertProjectArchivable(delegated.projectId)
      ])
      const [sessionArchive] = await Promise.allSettled([
        coordinator.updateArchive({
          projectId: delegated.projectId,
          sessionId: delegated.id,
          archived: true,
          expectedArchivedAt: null
        })
      ])

      expect([projectArchive.status, sessionArchive.status]).toEqual(['rejected', 'rejected'])
      expect(projectArchive).toMatchObject({
        status: 'rejected',
        reason: { message: 'Finish or stop active sessions before archiving this project.' }
      })
      expect(sessionArchive).toMatchObject({
        status: 'rejected',
        reason: { message: 'Finish or stop this session before archiving.' }
      })
      await expect(
        repository.loadSession(delegated.projectId, delegated.id)
      ).resolves.not.toHaveProperty('archivedAt')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let a renderer whole-session save create runtime authority', async () => {
    let durable: PersistedChatSession | undefined
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'missing' as const })),
      saveSession: vi.fn(async (session) => {
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const result = await coordinator.saveSession(
      createSession({
        status: 'waiting-plan-approval',
        runtimeContext: {
          version: 1,
          revision: 9,
          plan: createRuntimePlan({ approval: 'approved' })
        }
      })
    )

    expect(result.runtimeContext).toBeUndefined()
    expect(result.status).toBe('idle')
    expect(durable?.runtimeContext).toBeUndefined()
  })

  it('commits approval waiting state with context only after the atomic write succeeds', async () => {
    let durable = createSession()
    let failNextSave = true
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () => ({
        status: 'found' as const,
        session: durable
      })),
      saveSession: vi.fn(async (session) => {
        if (failNextSave) {
          failNextSave = false
          throw new Error('partial write rejected')
        }
        durable = structuredClone(session)
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const command = {
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      patch: { plan: createRuntimePlan() },
      sessionStatus: 'waiting-plan-approval'
    } as const

    await expect(coordinator.patchSessionRuntimeContext(command)).rejects.toThrow(
      'partial write rejected'
    )
    expect(durable).toMatchObject({ status: 'idle' })
    expect(durable.runtimeContext).toBeUndefined()

    await expect(coordinator.patchSessionRuntimeContext(command)).resolves.toMatchObject({
      revision: 1,
      plan: createRuntimePlan()
    })
    expect(durable).toMatchObject({
      status: 'waiting-plan-approval',
      runtimeContext: { revision: 1, plan: createRuntimePlan() }
    })
  })

  it('serializes a runtime patch before concurrent Session deletion and never revives it', async () => {
    let durable: PersistedChatSession | undefined = createSession()
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn(async () =>
        durable ? { status: 'found' as const, session: durable } : { status: 'missing' as const }
      ),
      saveSession: vi.fn(async (session) => {
        await saveGate.promise
        durable = structuredClone(session)
      }),
      deleteSession: vi.fn(async () => {
        durable = undefined
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const patch = coordinator.patchSessionRuntimeContext({
      projectId: 'project-1',
      sessionId: 'session-1',
      expectedRevision: 0,
      patch: { plan: createRuntimePlan() }
    })
    const deletion = coordinator.deleteSession('project-1', 'session-1')
    await vi.waitFor(() => expect(repository.saveSession).toHaveBeenCalledOnce())
    saveGate.resolve()

    await expect(patch).resolves.toMatchObject({ revision: 1 })
    await expect(deletion).resolves.toBeUndefined()
    expect(durable).toBeUndefined()
    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 1,
        patch: { plan: undefined }
      })
    ).rejects.toThrow(/deleted/)
  })

  it('removes embedded runtime context with Project Session authority', async () => {
    let durable: PersistedChatSession | undefined = createSession({
      runtimeContext: {
        version: 1,
        revision: 7,
        plan: createRuntimePlan({ approval: 'approved' })
      }
    })
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn(async () => ({
        sessions: durable ? [durable] : [],
        isComplete: true
      })),
      loadSessionWithDiagnostics: vi.fn(async () =>
        durable ? { status: 'found' as const, session: durable } : { status: 'missing' as const }
      ),
      deleteProjectSessions: vi.fn(async () => {
        durable = undefined
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(durable).toBeUndefined()
    await expect(
      coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 7,
        patch: { plan: undefined }
      })
    ).rejects.toThrow(/project.*deleted/i)
  })

  it('exposes Session metadata from the latest complete load without reading storage again', async () => {
    const session = createSession({ title: 'Cached session' })
    const loadAllWithDiagnostics = vi.fn().mockResolvedValue({
      result: { sessions: [session], manifest: { version: 1 as const } },
      isComplete: true
    })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({ loadAllWithDiagnostics }),
      createFileIndex()
    )

    await coordinator.loadAll()

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Cached session' }],
      isComplete: true
    })
    expect(loadAllWithDiagnostics).toHaveBeenCalledOnce()
  })

  it('hydrates complete Session metadata from the SQLite projection', async () => {
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex()
    )

    await coordinator.replaceSessionMetadata(
      [{ id: 'session-1', projectId: 'project-1', title: 'Projected session' }],
      true
    )

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Projected session' }],
      isComplete: true
    })
  })

  it('updates cached Session metadata after a durable save', async () => {
    const session = createSession({ title: 'Original title' })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics: vi.fn().mockResolvedValue({
          result: { sessions: [session], manifest: { version: 1 as const } },
          isComplete: true
        })
      }),
      createFileIndex()
    )

    await coordinator.loadAll()
    await coordinator.saveSession(createSession({ title: 'Renamed session' }))

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Renamed session' }],
      isComplete: true
    })
  })

  it('waits for an in-flight save before returning Session metadata', async () => {
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      saveSession: vi.fn(() => saveGate.promise)
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const save = coordinator.saveSession(createSession({ title: 'Renamed session' }))
    await vi.waitFor(() => expect(repository.saveSession).toHaveBeenCalledOnce())
    const snapshot = Promise.resolve(coordinator.sessionMetadataSnapshot())

    saveGate.resolve()
    await save

    await expect(snapshot).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Renamed session' }],
      isComplete: false
    })
  })

  it('marks saved Session metadata incomplete when the derived file index update fails', async () => {
    const session = createSession({ title: 'Original title' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const syncSession = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('index unavailable'))
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession })
    )

    await coordinator.loadAll()
    await expect(
      coordinator.saveSession(createSession({ title: 'Durable renamed session' }))
    ).rejects.toThrow('index unavailable')

    expect(repository.saveSession).toHaveBeenCalled()
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Durable renamed session' }],
      isComplete: false
    })
  })

  it('removes cached Session metadata after durable deletion', async () => {
    const session = createSession()
    const loadAllWithDiagnostics = vi
      .fn()
      .mockResolvedValueOnce({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
      .mockResolvedValueOnce({
        result: { sessions: [], manifest: { version: 1 as const } },
        isComplete: true
      })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics,
        loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session })
      }),
      createFileIndex()
    )

    await coordinator.loadAll()
    await coordinator.deleteSession('project-1', 'session-1')

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [],
      isComplete: true
    })
  })

  it('removes only the deleted Project from cached Session metadata', async () => {
    const deletedSession = createSession()
    const survivingSession = createSession({ id: 'session-2', projectId: 'project-2' })
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics: vi.fn().mockResolvedValue({
          result: {
            sessions: [deletedSession, survivingSession],
            manifest: { version: 1 as const }
          },
          isComplete: true
        }),
        loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
          sessions: [deletedSession],
          isComplete: true
        })
      }),
      createFileIndex()
    )

    await coordinator.loadAll()
    await coordinator.deleteProjectSessions('project-1')

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-2', projectId: 'project-2', title: 'Session' }],
      isComplete: true
    })
  })

  it('marks cached Session metadata incomplete until a complete authority scan succeeds', async () => {
    const session = createSession()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadAllWithDiagnostics: vi.fn().mockResolvedValue({
          result: { sessions: [session], manifest: { version: 1 as const } },
          isComplete: false
        })
      }),
      createFileIndex()
    )

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [],
      isComplete: false
    })

    await coordinator.loadAll()

    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Session' }],
      isComplete: false
    })
  })

  it('serializes a pending save before deletion and rejects saves after the tombstone', async () => {
    const order: string[] = []
    const saveGate = createDeferred<void>()
    const repository = createSessionRepository({
      saveSession: vi.fn(async () => {
        order.push('json-save:start')
        await saveGate.promise
        order.push('json-save:end')
      }),
      deleteSession: vi.fn(async () => {
        order.push('json-delete')
      })
    })
    const fileIndex = createFileIndex({
      syncSession: vi.fn(async () => {
        order.push('index-sync')
        return ['artifact' as const]
      }),
      softDeleteSession: vi.fn(async () => {
        order.push('index-soft-delete')
        return 'delete-session-operation'
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    const save = coordinator.saveSession(createSession())
    const deletion = coordinator.deleteSession('project-1', 'session-1')
    await vi.waitFor(() => expect(order).toEqual(['json-save:start']))

    saveGate.resolve()
    await Promise.all([save, deletion])
    expect(order).toEqual([
      'json-save:start',
      'json-save:end',
      'index-sync',
      'index-soft-delete',
      'json-delete'
    ])

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/deleted/)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('does not block an unrelated Project save while reconciling a deleted Session', async () => {
    const deletedSession = createSession()
    const unrelatedSession = createSession({ id: 'session-2', projectId: 'project-2' })
    const reconciliationStarted = createDeferred<void>()
    const releaseReconciliation = createDeferred<void>()
    const holdReconciliation = async (): Promise<void> => {
      reconciliationStarted.resolve()
      await releaseReconciliation.promise
    }
    const loadAllWithDiagnostics = vi
      .fn()
      .mockResolvedValueOnce({
        result: { sessions: [deletedSession], manifest: { version: 1 as const } },
        isComplete: true
      })
      .mockImplementationOnce(async () => {
        await holdReconciliation()
        return {
          result: { sessions: [], manifest: { version: 1 as const } },
          isComplete: true
        }
      })
    const repository = createSessionRepository({
      loadAllWithDiagnostics,
      loadProjectWithDiagnostics: vi.fn(async () => {
        await holdReconciliation()
        return { sessions: [], isComplete: true }
      }),
      loadSessionWithDiagnostics: vi.fn(async (projectId, sessionId) =>
        projectId === deletedSession.projectId && sessionId === deletedSession.id
          ? { status: 'found' as const, session: deletedSession }
          : { status: 'missing' as const }
      )
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.loadAll()
    const deletion = coordinator.deleteSession(deletedSession.projectId, deletedSession.id)
    await reconciliationStarted.promise

    const unrelatedSave = coordinator.saveSession(unrelatedSession)
    for (let index = 0; index < 20; index += 1) await Promise.resolve()
    const unrelatedSaveStartedBeforeReconciliationFinished = vi
      .mocked(repository.saveSession)
      .mock.calls.some(([session]) => session.id === unrelatedSession.id)

    releaseReconciliation.resolve()
    await Promise.all([deletion, unrelatedSave])

    expect(unrelatedSaveStartedBeforeReconciliationFinished).toBe(true)
    expect(loadAllWithDiagnostics).toHaveBeenCalledOnce()
  })

  it('falls back to global deletion reconciliation when cached metadata is incomplete', async () => {
    const loadAllWithDiagnostics = vi.fn().mockResolvedValue({
      result: { sessions: [], manifest: { version: 1 as const } },
      isComplete: true
    })
    const loadProjectWithDiagnostics = vi.fn().mockResolvedValue({ sessions: [], isComplete: true })
    const repository = createSessionRepository({
      loadAllWithDiagnostics,
      loadProjectWithDiagnostics
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteSession('project-1', 'session-1')

    expect(loadProjectWithDiagnostics).not.toHaveBeenCalled()
    expect(loadAllWithDiagnostics).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileProjectSessions).not.toHaveBeenCalled()
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([])
  })

  it('returns the exact durable Session after publishing legacy Uploads in live-safe mode', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const durableSession = toVersionedUploadSession(legacySession)
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(durableSession)
    }
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.saveSession(legacySession)).resolves.toEqual({
      ...durableSession,
      revision: 1
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      { mode: 'live-save' }
    )
    expect(repository.saveSession).toHaveBeenCalledWith(expect.objectContaining(durableSession), 0)
  })

  it('does not overwrite Session JSON when finalized Artifact bindings reject the snapshot', async () => {
    let durableSession = createSession({ title: 'Durable latest' })
    const repository = createSessionRepository({
      saveSession: vi.fn(async (session) => {
        durableSession = session
      })
    })
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi
        .fn()
        .mockRejectedValue(
          new FinalizedArtifactBindingConflictError(
            'Artifact-owning Message is outside its bound Branch.'
          )
        )
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance
    )

    await expect(coordinator.saveSession(createSession({ title: 'Queued stale' }))).rejects.toThrow(
      'Artifact-owning Message is outside its bound Branch.'
    )

    expect(durableSession.title).toBe('Durable latest')
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(provenance.captureFinalizedMessages).not.toHaveBeenCalled()
  })

  it('keeps JSON-first durability when pre-save provenance lookup is unavailable', async () => {
    const validationError = new Error('artifact database unavailable at /private/session.json')
    const repository = createSessionRepository()
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi.fn().mockRejectedValue(validationError)
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(
      coordinator.saveSession(createSession({ title: 'Private research' }))
    ).resolves.toMatchObject({
      id: 'session-1'
    })
    await expect(
      coordinator.saveSession(createSession({ title: 'Retry validation' }))
    ).resolves.toMatchObject({ id: 'session-1' })

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(2)
    expect(repository.saveSession).toHaveBeenCalledTimes(2)
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenCalledWith('pre-save provenance validation unavailable', {
      operation: 'session-save',
      phase: 'validate-provenance',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('artifact database unavailable')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Private research')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('/private/session.json')
  })

  it('keeps JSON-first durability when degraded diagnostics cannot be emitted', async () => {
    const repository = createSessionRepository()
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi.fn().mockRejectedValue(new Error('lookup unavailable'))
    })
    const log = createTestLogger()
    log.warn.mockImplementation(() => {
      throw new Error('diagnostic sink unavailable')
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })

    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledOnce()
  })

  it('revalidates finalized bindings only when topology or artifact bindings change', async () => {
    const provenance = createProvenancePersistence()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex(),
      undefined,
      provenance
    )
    const firstMessage = {
      id: 'message-1',
      role: 'agent' as const,
      content: 'streaming',
      status: 'streaming' as const,
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }

    await coordinator.saveSession(createSession({ messages: [firstMessage] }))
    await coordinator.saveSession(
      createSession({
        title: 'Renamed while streaming',
        messages: [{ ...firstMessage, content: 'more text', updatedAt: 2 }]
      })
    )

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledOnce()

    const secondMessage = {
      id: 'message-2',
      role: 'user' as const,
      content: 'continue',
      status: 'complete' as const,
      eventIds: [],
      createdAt: 3,
      updatedAt: 3
    }
    await coordinator.saveSession(
      createSession({
        messages: [
          { ...firstMessage, content: 'complete', status: 'complete', updatedAt: 2 },
          secondMessage
        ]
      })
    )

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(2)

    await coordinator.runSessionMutation('project-1', 'session-1', async () => undefined)
    await coordinator.saveSession(
      createSession({
        messages: [
          { ...firstMessage, content: 'complete', status: 'complete', updatedAt: 2 },
          { ...secondMessage, content: 'continue after artifact finalization', updatedAt: 4 }
        ]
      })
    )

    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(3)
  })

  it('rebases explicitly changed safe fields onto the latest durable graph after a conflict', async () => {
    const authoritativeSession = createSession({
      title: 'Durable latest',
      pinned: false,
      messages: [
        {
          id: 'durable-message',
          role: 'agent',
          content: 'Artifact finalized',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      updatedAt: 3
    })
    const submittedSession = createSession({
      title: 'Local rename',
      pinned: true,
      messages: [
        {
          id: 'stale-message',
          role: 'user',
          content: 'Stale graph',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      updatedAt: 4
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: authoritativeSession })
    })
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi
        .fn()
        .mockRejectedValueOnce(
          new FinalizedArtifactBindingConflictError(
            'Artifact-owning Message is outside its bound Branch.'
          )
        )
        .mockResolvedValue(undefined)
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance
    )

    const result = await coordinator.saveSession(submittedSession, {
      conflictRebaseFields: ['title', 'pinned']
    })

    expect(result).toMatchObject({ title: 'Local rename', pinned: true, updatedAt: 5 })
    expect(result.updatedAt).toBeGreaterThan(authoritativeSession.updatedAt)
    expect(result.updatedAt).toBeGreaterThan(submittedSession.updatedAt)
    expect(result.messages).toEqual(authoritativeSession.messages)
    expect(repository.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        title: result.title,
        pinned: result.pinned,
        messages: result.messages
      }),
      0
    )
    expect(provenance.validateFinalizedMessageBindings).toHaveBeenCalledTimes(2)
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledWith(result)
  })

  it('preserves Main-owned specialist binding fields when renderer save options are forged', async () => {
    const authoritativeSession = createSession({
      specialistId: 'specialist-old',
      updatedAt: 7
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: authoritativeSession })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    const forgedRendererOptions = {
      conflictRebaseFields: ['specialistId', 'specialistBindingPending']
    } as unknown as Parameters<SessionPersistenceCoordinator['saveSession']>[1]

    const result = await coordinator.saveSession(
      {
        ...authoritativeSession,
        specialistId: 'specialist-forged',
        specialistBindingPending: true
      },
      forgedRendererOptions
    )

    expect(result.specialistId).toBe('specialist-old')
    expect(result.specialistBindingPending).toBeUndefined()
    expect(repository.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistId: 'specialist-old',
        specialistBindingPending: undefined
      }),
      0
    )
  })

  it('advances the session revision when a specialist binding first becomes pending', async () => {
    const authoritativeSession = createSession({
      specialistId: 'specialist-old',
      updatedAt: 7
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: authoritativeSession })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    const result = await coordinator.saveSessionSpecialistBinding(
      authoritativeSession,
      'specialist-new',
      true
    )

    expect(result).toMatchObject({
      specialistId: 'specialist-new',
      specialistBindingPending: true
    })
    expect(result.updatedAt).toBeGreaterThan(authoritativeSession.updatedAt)
    expect(repository.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistId: result.specialistId,
        specialistBindingPending: result.specialistBindingPending
      }),
      0
    )
  })

  it('rebases a specialist binding onto the latest durable graph after a conflict', async () => {
    const authoritativeSession = createSession({
      specialistId: 'specialist-old',
      messages: [
        {
          id: 'durable-message',
          role: 'agent',
          content: 'Artifact finalized',
          status: 'complete',
          eventIds: [],
          createdAt: 3,
          updatedAt: 3
        }
      ],
      updatedAt: 3
    })
    const submittedSession = createSession({
      messages: [
        {
          id: 'stale-message',
          role: 'user',
          content: 'Stale graph',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      updatedAt: 4
    })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: authoritativeSession })
    })
    const provenance = createProvenancePersistence({
      validateFinalizedMessageBindings: vi
        .fn()
        .mockRejectedValueOnce(new FinalizedArtifactBindingConflictError('stale graph'))
        .mockResolvedValue(undefined)
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance
    )

    const result = await coordinator.saveSessionSpecialistBinding(
      submittedSession,
      'specialist-new',
      true
    )

    expect(result.specialistId).toBe('specialist-new')
    expect(result.specialistBindingPending).toBe(true)
    expect(result.messages).toEqual(authoritativeSession.messages)
    expect(repository.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        specialistId: result.specialistId,
        specialistBindingPending: result.specialistBindingPending,
        messages: result.messages
      }),
      0
    )
  })

  it('restores DB visibility and clears the tombstone when JSON deletion fails', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session }),
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')
    expect(fileIndex.softDeleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(fileIndex.restoreSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'delete-session-operation'
    )

    await expect(coordinator.saveSession(session)).resolves.toMatchObject({
      id: 'session-1'
    })
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('retains native Project files and completes the origin tombstone after JSON deletion', async () => {
    const session = createSession({ title: 'Retained analysis' })
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session })
    })
    const fileIndex = createFileIndex()
    const onFilesChanged = vi.fn()
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn().mockResolvedValue({
        kind: 'retained' as const,
        projectId: 'project-1',
        sessionId: 'session-1',
        operationId: 'origin-delete-1'
      }),
      completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
      abortSessionDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      onFilesChanged,
      provenance
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(provenance.prepareSessionDeletion).toHaveBeenCalledWith(session)
    expect(fileIndex.softDeleteSession).not.toHaveBeenCalled()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    expect(provenance.completeSessionDeletion).toHaveBeenCalledWith({
      kind: 'retained',
      projectId: 'project-1',
      sessionId: 'session-1',
      operationId: 'origin-delete-1'
    })
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['artifact', 'upload'],
      kind: 'upsert'
    })
  })

  it('upgrades and persists a legacy upload before deleting its Session', async () => {
    const order: string[] = []
    const legacySession = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'legacy upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'data.csv',
              originalName: 'data.csv',
              path: '/legacy/data.csv',
              size: 4
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const upgradedSession = structuredClone(legacySession)
    upgradedSession.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'data.csv',
        originalName: 'data.csv',
        size: 4,
        sha256: 'a'.repeat(64)
      }
    ]
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: legacySession }),
      saveSession: vi.fn(async () => {
        order.push('save-upgraded')
      }),
      deleteSession: vi.fn(async () => {
        order.push('delete-json')
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session, options) => {
        if (options?.mode === 'live-save') {
          order.push('upgrade-live')
          return upgradedSession
        }
        order.push('cleanup-terminal')
        expect(session).toBe(upgradedSession)
        return session
      })
    }
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn(async () => {
        order.push('prepare-delete')
        return {
          kind: 'ordinary' as const,
          projectId: 'project-1',
          sessionId: 'session-1'
        }
      }),
      completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
      abortSessionDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      provenance,
      uploads
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(order).toEqual([
      'upgrade-live',
      'save-upgraded',
      'cleanup-terminal',
      'prepare-delete',
      'delete-json'
    ])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(1, legacySession, {
      mode: 'live-save'
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(2, upgradedSession, {
      mode: 'terminal-delete'
    })
    expect(provenance.prepareSessionDeletion).toHaveBeenCalledWith(upgradedSession)
  })

  it('retains a legacy Session source when its path-free projection cannot be saved before deletion', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    let legacySourceRemoved = false
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValue({ status: 'found', session: legacySession }),
      saveSession: vi.fn().mockRejectedValue(new Error('session file unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (_session, options) => {
        if (options?.mode === 'terminal-delete') legacySourceRemoved = true
        return upgradedSession
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'session file unavailable'
    )

    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(legacySession, {
      mode: 'live-save'
    })
    expect(legacySourceRemoved).toBe(false)
    expect(fileIndex.softDeleteSession).not.toHaveBeenCalled()
    expect(repository.deleteSession).not.toHaveBeenCalled()
  })

  it('aborts a retained origin tombstone when JSON deletion fails', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session }),
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const fileIndex = createFileIndex()
    const receipt = {
      kind: 'retained' as const,
      projectId: 'project-1',
      sessionId: 'session-1',
      operationId: 'origin-delete-1'
    }
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn().mockResolvedValue(receipt),
      completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
      abortSessionDeletion: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')

    expect(provenance.abortSessionDeletion).toHaveBeenCalledWith(receipt)
    expect(fileIndex.restoreSession).not.toHaveBeenCalled()
  })

  it('marks the index incomplete when deletion compensation cannot restore DB visibility', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session }),
      deleteSession: vi.fn().mockRejectedValueOnce(new Error('disk locked'))
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      restoreSession: vi.fn().mockRejectedValueOnce(new Error('database unavailable')),
      markReconciliationIncomplete
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'database unavailable'
    )
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    await expect(coordinator.saveSession(session)).resolves.toMatchObject({
      id: 'session-1'
    })
  })

  it('preserves the deletion failure and every failed compensation', async () => {
    const session = createSession()
    const deletionError = new Error('disk locked')
    const indexRollbackError = new Error('database unavailable')
    const computeRollbackError = new Error('compute cleanup unavailable')
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'found', session }),
      deleteSession: vi.fn().mockRejectedValue(deletionError)
    })
    const fileIndex = createFileIndex({
      restoreSession: vi.fn().mockRejectedValue(indexRollbackError)
    })
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(async () => undefined),
      commitSessionJobDeletion: vi.fn(async () => undefined),
      prepareProjectJobDeletion: vi.fn(async () => undefined),
      commitProjectJobDeletion: vi.fn(async () => undefined),
      abortSessionJobDeletion: vi.fn().mockRejectedValue(computeRollbackError)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    const failure = await coordinator
      .deleteSession('project-1', 'session-1')
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([
      deletionError,
      indexRollbackError,
      computeRollbackError
    ])
    expect(fileIndex.restoreSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      'delete-session-operation'
    )
    expect(computeJobs.abortSessionJobDeletion).toHaveBeenCalledWith('project-1', 'session-1')
    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledWith('project-1')
  })

  it('does not widen an already scoped file reconciliation failure during hydration', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex({
      reconcileActiveSessions: vi
        .fn()
        .mockRejectedValue(new ProjectFilesReconciliationError([new Error('busy')], ['project-1']))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    await coordinator.loadAll()
    expect(fileIndex.markReconciliationIncomplete).not.toHaveBeenCalled()
  })

  it('hydrates sessions after indexing and reconciles only a complete scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex()
    const projectReconciliation = createProjectReconciliationSnapshot()
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockResolvedValue(projectReconciliation),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )
    const reconcile = vi.fn(async () => undefined)
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ reconcile }))

    const loaded = await coordinator.loadAll()

    expect(loaded).toBe(result)
    expect(reconcile).toHaveBeenCalledWith(['session-1'], [])
    expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      session,
      {
        removeOrphanStaging: true,
        projectReconciliation
      }
    )
    expect(fileIndex.syncSession).toHaveBeenCalledWith(session)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
  })

  it('reconciles provisional managed workspaces during the first authoritative hydration', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const reconcileProvisional = vi.fn().mockResolvedValue(undefined)
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        markProjectRetained: vi.fn().mockResolvedValue([]),
        markRetained: vi.fn().mockResolvedValue(false),
        restoreProjectActive: vi.fn().mockResolvedValue(undefined),
        restoreActive: vi.fn().mockResolvedValue(undefined),
        reconcileProvisional
      }
    )

    await coordinator.loadAll()
    await coordinator.loadAll()

    expect(reconcileProvisional).toHaveBeenCalledOnce()
    expect(reconcileProvisional).toHaveBeenCalledWith([session])
  })

  it('keeps cleanup closed across scans after quarantining corrupt Session authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-corrupt-session-reconciliation-'))
    const projectDir = join(root, 'sessions', 'project-1')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'corrupt-session.json'), '{broken json', 'utf8')
    const repository = new SessionRepository(root)
    const fileIndex = createFileIndex()
    const provenance = createProvenancePersistence()
    const permissionGrants = { reconcileSessions: vi.fn().mockResolvedValue(undefined) }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      undefined,
      undefined,
      permissionGrants
    )
    const deletionHandlers = createSessionDeletionHandlers()
    coordinator.setSessionDeletionHandlers(deletionHandlers)

    try {
      const loaded = await coordinator.loadAll()
      const replayed = await coordinator.loadAll()

      expect(loaded.sessions).toEqual([])
      expect(loaded.diagnostics).toMatchObject({
        isComplete: true,
        warnings: [
          {
            kind: 'corrupt',
            projectId: 'project-1',
            fileName: 'corrupt-session.json',
            recovered: true
          }
        ]
      })
      expect(replayed.diagnostics).toEqual(loaded.diagnostics)
      expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledTimes(2)
      await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
        sessions: [],
        isComplete: false
      })
      expect(deletionHandlers.reconcile).not.toHaveBeenCalled()
      expect(permissionGrants.reconcileSessions).not.toHaveBeenCalled()
      expect(provenance.reconcileSessionDeletions).not.toHaveBeenCalled()
      expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves a main-owned permission wait when another client hydrates in the same process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-live-permission-hydration-'))
    const repository = new SessionRepository(root, { hasActiveRuntimePrompt: () => true })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    try {
      await repository.saveSession(createSession())
      const initialHydration = await coordinator.loadAll()

      await coordinator.saveSession(
        createSession({
          revision: initialHydration.sessions[0].revision,
          status: 'running',
          activeRun: { promptMessageId: 'prompt-1', startedAt: 3 },
          messages: [
            {
              id: 'prompt-1',
              role: 'user',
              content: 'Run the notebook cell',
              status: 'complete',
              eventIds: [],
              createdAt: 3,
              updatedAt: 3
            }
          ],
          activities: [
            {
              id: 'notebook-call-1',
              kind: 'tool',
              title: 'Notebook cell',
              status: 'in_progress',
              sortIndex: 1,
              eventIds: [],
              createdAt: 3,
              updatedAt: 3
            }
          ]
        })
      )
      await coordinator.patchSessionRuntimeContext({
        projectId: 'project-1',
        sessionId: 'session-1',
        expectedRevision: 0,
        patch: { permission: createRuntimePermission() },
        sessionStatus: 'waiting-permission'
      })

      const rehydrated = await coordinator.loadAll()

      expect(rehydrated.sessions[0]).toMatchObject({
        status: 'waiting-permission',
        activeRun: { promptMessageId: 'prompt-1', startedAt: 3 }
      })
      expect(rehydrated.sessions[0].resumeRecovery).toBeUndefined()
      expect(rehydrated.sessions[0].error).toBeUndefined()
      expect(rehydrated.sessions[0].messages[0].interrupted).toBeUndefined()
      expect(rehydrated.sessions[0].activities?.[0].status).toBe('in_progress')
      expect(rehydrated.sessions[0].conversationGraph?.activities[0]?.status).toBe('in_progress')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records a phased terminal aggregate for complete Session hydration', async () => {
    const session = createSession({ title: 'Private analysis', cwd: '/private/workspace' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result,
        isComplete: true,
        scanMetrics: {
          projectDirectoryCount: 1,
          sessionFileCount: 1,
          sessionBytes: 4096
        }
      })
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(log.info.mock.calls.map(([message]) => message)).toEqual([
      'operation started',
      'operation phase',
      'operation phase',
      'operation phase',
      'operation phase',
      'operation phase',
      'operation completed'
    ])
    expect(
      log.info.mock.calls
        .map(([, fields]) => (fields as { phase?: string } | undefined)?.phase)
        .filter(Boolean)
    ).toEqual([
      'load-authority',
      'authority-loaded',
      'recover-delegation',
      'reconcile-unread-sessions',
      'reconcile-derived-state',
      'reconcile-derived-state'
    ])
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'session-hydration',
        operationId: expect.any(String),
        mode: 'reconcile',
        startupCleanupEligible: true,
        phase: 'reconcile-derived-state',
        outcome: 'completed',
        status: 'ready',
        sessionCount: 1,
        warningCount: 0,
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.info.mock.calls)
    expect(log.info).toHaveBeenCalledWith(
      'operation phase',
      expect.objectContaining({
        phase: 'authority-loaded',
        projectDirectoryCount: 1,
        sessionFileCount: 1,
        sessionBytes: 4096
      })
    )
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('/private/workspace')
  })

  it('records a terminal failure when the Session authority scan rejects', async () => {
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockRejectedValue(new Error('Session authority unavailable at /private/sessions'))
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.loadAll()).rejects.toThrow('Session authority unavailable')

    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'session-hydration',
        phase: 'load-authority',
        outcome: 'failed',
        status: 'failed',
        hydrationAvailable: false,
        errorCategory: 'error'
      })
    )
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Session authority unavailable')
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('/private/sessions')
  })

  it('keeps healthy Sessions readable when one delegated recovery is structurally invalid', async () => {
    const damaged = materializeSessionConversationGraph(
      createSession({
        id: 'damaged-session',
        runtimeContext: {
          version: 1,
          revision: 1,
          delegatedWork: {
            records: [
              {
                agentFrameId: 'missing-child-frame',
                attempts: [
                  {
                    id: 'attempt-1',
                    status: 'running',
                    resolvedAgent: { kind: 'main' },
                    runtimeSegmentIds: [],
                    startedAt: 1
                  }
                ]
              }
            ]
          }
        }
      })
    )
    const healthy = createSession({ id: 'healthy-session', title: 'Healthy Session' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [damaged, healthy], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions.map(({ id }) => id)).toEqual(['damaged-session', 'healthy-session'])
    expect(loaded.diagnostics).toMatchObject({
      isComplete: false,
      failure: 'startup-reconciliation-failed'
    })
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'delegation-recovery',
        phase: 'recover-session',
        status: 'degraded',
        retryable: true
      })
    )
  })

  it('keeps hydration available and records unread Session reconciliation degradation', async () => {
    const session = createSession({ title: 'Private analysis' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        reconcile: vi
          .fn()
          .mockRejectedValue(new Error('unread database unavailable at /private/unread.sqlite'))
      })
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(log.warn).toHaveBeenCalledWith('unread Session reconciliation failed', {
      operation: 'session-hydration',
      phase: 'reconcile-unread-sessions',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Private analysis')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('unread database unavailable')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('/private/unread.sqlite')
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({ status: 'degraded', degradedReconciliationCount: 1 })
    )
  })

  it('hydrates a read-only snapshot without running startup reconciliation', async () => {
    const session = createSession({ title: 'Private analysis', cwd: '/private/workspace' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result,
        isComplete: true,
        warnings: []
      })
    })
    const fileIndex = createFileIndex()
    const provenance = {
      validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
      captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
      reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
      prepareSessionDeletion: vi.fn(),
      completeSessionDeletion: vi.fn(),
      abortSessionDeletion: vi.fn()
    }
    const uploads = { upgradeLegacySessionUploads: vi.fn() }
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn(),
      reconcileSession: vi.fn()
    }
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      uploads,
      artifactStorage,
      undefined,
      log
    )

    await expect(coordinator.loadAllReadOnly()).resolves.toEqual({
      ...result,
      diagnostics: {
        isComplete: false,
        warnings: [],
        failure: 'startup-reconciliation-failed'
      }
    })

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(repository.loadAllWithDiagnostics).toHaveBeenCalledWith({ mode: 'read-only' })
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(provenance.reconcileSessionDeletions).not.toHaveBeenCalled()
    expect(uploads.upgradeLegacySessionUploads).not.toHaveBeenCalled()
    expect(artifactStorage.prepareProjectReconciliation).not.toHaveBeenCalled()
    expect(artifactStorage.reconcileSession).not.toHaveBeenCalled()
    expect(log.info.mock.calls.map(([message]) => message)).toEqual([
      'operation started',
      'operation phase',
      'operation phase',
      'operation completed'
    ])
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'session-hydration',
        operationId: expect.any(String),
        mode: 'read-only',
        phase: 'authority-loaded',
        outcome: 'completed',
        status: 'degraded',
        sessionCount: 1,
        warningCount: 0,
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.info.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('/private/workspace')
  })

  it('reconciles durable Session grants only on the first complete startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const reconcileSessions = vi.fn().mockResolvedValue(undefined)
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      { reconcileSessions }
    )

    await coordinator.loadAll()
    await coordinator.loadAll()

    expect(reconcileSessions).toHaveBeenCalledOnce()
    expect(reconcileSessions).toHaveBeenCalledWith([
      { projectId: 'project-1', sessionId: 'session-1' }
    ])
  })

  it('keeps hydration available and records permission grant reconciliation degradation', async () => {
    const session = createSession({ title: 'Private analysis' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      {
        reconcileSessions: vi
          .fn()
          .mockRejectedValue(new Error('permission registry unavailable for Private analysis'))
      },
      log
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(log.warn).toHaveBeenCalledWith('permission grant reconciliation failed', {
      operation: 'session-hydration',
      phase: 'reconcile-permission-grants',
      outcome: 'degraded',
      errorCategory: 'error'
    })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('Private analysis')
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('permission registry unavailable')
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({ status: 'degraded', degradedReconciliationCount: 1 })
    )
  })

  it('does not prune durable Session grants from a partial startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce({ result, isComplete: false })
        .mockResolvedValueOnce({ result, isComplete: true })
    })
    const reconcileSessions = vi.fn().mockResolvedValue(undefined)
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      { reconcileSessions }
    )

    await coordinator.loadAll()
    await coordinator.loadAll()

    expect(reconcileSessions).not.toHaveBeenCalled()
  })

  it('reconciles path-free Upload copies only on the first complete load from multiple clients', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-upload-startup-reconcile-'))
    const client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const content = Buffer.from('sample,value\na,1\n')
    const checksum = '5fe3f7b7e3492c63599954312dcb1e1d78488782753b6d3068c8d03292c7c1f6'
    const contentStorageKey =
      'uploads/project-1/session-1/upload-1/versions/upload-version-1/content'
    const finalPath = join(root, ...contentStorageKey.split('/'))
    const legacyPath = join(root, 'uploads', 'default-project', 'session-1', 'legacy.csv')
    await mkdir(dirname(finalPath), { recursive: true })
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(finalPath, content)
    await writeFile(legacyPath, content)
    await client.fileOriginSession.create({
      data: { projectId: 'project-1', sessionId: 'session-1' }
    })
    await client.uploadFile.create({
      data: {
        id: 'upload-1',
        projectId: 'project-1',
        sessionId: 'session-1',
        filename: 'legacy.csv',
        originalFilename: 'legacy.csv',
        versions: {
          create: {
            id: 'upload-version-1',
            versionNumber: 1,
            state: 'ready',
            contentStorageKey,
            filename: 'legacy.csv',
            originalFilename: 'legacy.csv',
            contentType: 'text/csv',
            sizeBytes: BigInt(content.byteLength),
            checksum
          }
        }
      }
    })
    const session = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'path-free upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              versionId: 'upload-version-1',
              versionNumber: 1,
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              size: content.byteLength,
              sha256: checksum
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    try {
      // No one-time normalizer participates here, representing pathsNormalizedAt already being set.
      await expect(coordinator.loadAll()).resolves.toBe(result)

      await expect(readFile(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(finalPath)).resolves.toEqual(content)
      expect(repository.saveSession).not.toHaveBeenCalled()
      expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
      expect(fileIndex.syncSession).toHaveBeenCalledWith(session)

      // A later renderer/task load is live-safe. Even if a historical path reappears, that call must
      // not remove bytes that another already-hydrated client could still be rendering.
      await writeFile(legacyPath, content)
      await expect(coordinator.loadAll()).resolves.toBe(result)
      await expect(readFile(legacyPath)).resolves.toEqual(content)
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists path-only Upload upgrades before startup indexing', async () => {
    const legacySession = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'legacy upload',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-1',
              sessionId: 'session-1',
              name: 'legacy.csv',
              originalName: 'legacy.csv',
              path: '/legacy/legacy.csv',
              size: 11
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const upgradedSession = structuredClone(legacySession)
    upgradedSession.messages[0].uploads = [
      {
        id: 'upload-1',
        versionId: 'upload-version-1',
        versionNumber: 1,
        sessionId: 'session-1',
        name: 'legacy.csv',
        originalName: 'legacy.csv',
        size: 11,
        sha256: 'a'.repeat(64)
      }
    ]
    const result = { sessions: [legacySession], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedSession])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(1, legacySession, {
      mode: 'live-save'
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(2, upgradedSession, {
      mode: 'reconcile'
    })
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedSession)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([upgradedSession])
    expect(fileIndex.syncSession).toHaveBeenCalledWith(upgradedSession)
  })

  it('retains every legacy source when one Upload prevents a complete startup projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'open-science-upload-startup-partial-'))
    const client = createProjectDbClient(root)
    await migrateApplicationDatabase(client)
    const content = Buffer.from('sample,value\na,1\n')
    const retainedPath = join(root, 'uploads', 'default-project', 'session-1', 'retained.csv')
    const missingPath = join(root, 'uploads', 'default-project', 'session-1', 'missing.csv')
    await mkdir(dirname(retainedPath), { recursive: true })
    await writeFile(retainedPath, content)
    const legacySession = createSession({
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'partially recoverable uploads',
          status: 'complete',
          eventIds: [],
          uploads: [
            {
              id: 'upload-retained',
              sessionId: 'session-1',
              name: 'retained.csv',
              originalName: 'retained.csv',
              path: retainedPath,
              size: content.byteLength
            },
            {
              id: 'upload-missing',
              sessionId: 'session-1',
              name: 'missing.csv',
              originalName: 'missing.csv',
              path: missingPath,
              size: content.byteLength
            }
          ],
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })
    const result = { sessions: [legacySession], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = new UploadRepository(root, { getClient: () => Promise.resolve(client) })
    const upgradeSpy = vi.spyOn(uploads, 'upgradeLegacySessionUploads')
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    try {
      await expect(coordinator.loadAll()).resolves.toBe(result)

      await vi.waitFor(async () => {
        await expect(
          client.uploadVersion.findFirst({
            where: { uploadFileId: 'upload-retained', state: 'ready' }
          })
        ).resolves.toBeTruthy()
      })
      await expect(readFile(retainedPath)).resolves.toEqual(content)
      expect(upgradeSpy).toHaveBeenCalledWith(legacySession, { mode: 'live-save' })
      expect(repository.saveSession).not.toHaveBeenCalled()
      expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
      expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    } finally {
      await client.$disconnect()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes destructive startup cleanup after an incomplete first load', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    const incomplete = {
      result: { sessions: [], manifest: { version: 1 as const } },
      isComplete: false
    }
    const complete = {
      result: { sessions: [legacySession], manifest: { version: 1 as const } },
      isComplete: true
    }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce(incomplete)
        .mockResolvedValueOnce(complete)
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const projectReconciliation = createProjectReconciliationSnapshot()
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockResolvedValue(projectReconciliation),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads,
      artifactStorage
    )

    await expect(coordinator.loadAll()).resolves.toBe(incomplete.result)
    await expect(coordinator.loadAll()).resolves.toEqual({
      sessions: [upgradedSession],
      manifest: complete.result.manifest,
      diagnostics: { isComplete: true, warnings: [] }
    })

    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(legacySession, {
      mode: 'live-save'
    })
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedSession)
    expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
      'project-1',
      'session-1',
      upgradedSession,
      { removeOrphanStaging: false, projectReconciliation }
    )
  })

  it('marks startup reconciliation incomplete when one Session Upload reconciliation fails', async () => {
    const first = createLegacyUploadSession('session-1')
    const upgradedFirst = toVersionedUploadSession(first)
    const second = createLegacyUploadSession('session-2')
    const result = { sessions: [first, second], manifest: { version: 1 as const } }
    let persistedFirst: PersistedChatSession | undefined
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true }),
      saveSession: vi.fn(async (session) => {
        persistedFirst = structuredClone(session)
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockResolvedValueOnce(upgradedFirst)
        .mockRejectedValueOnce(new Error('upload reconciliation failed'))
    }
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedFirst, second])
    expect(persistedFirst).toEqual(upgradedFirst)
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(1, first, {
      mode: 'live-save'
    })
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenNthCalledWith(2, upgradedFirst, {
      mode: 'reconcile'
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
  })

  it('hydrates an upgraded Session when its authoritative startup save fails', async () => {
    const session = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(session)
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true }),
      saveSession: vi.fn().mockRejectedValue(new Error('session file unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedSession])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(session, {
      mode: 'live-save'
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('does not roll back upgraded hydration when downstream startup reconciliation fails', async () => {
    const session = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(session)
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(upgradedSession)
    }
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      markReconciliationIncomplete,
      reconcileActiveSessions: vi.fn().mockRejectedValue(new Error('index unavailable'))
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions).toEqual([upgradedSession])
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedSession)
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
  })

  it('prepares one Artifact reconciliation snapshot for sessions in the same Project', async () => {
    const sessions = [createSession(), createSession({ id: 'session-2' })]
    const result = { sessions, manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const projectSnapshot = createProjectReconciliationSnapshot()
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockResolvedValue(projectSnapshot),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await coordinator.loadAll()

    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledOnce()
    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledWith('project-1')
    expect(artifactStorage.reconcileSession).toHaveBeenCalledTimes(2)
    for (const session of sessions) {
      expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
        'project-1',
        session.id,
        session,
        {
          removeOrphanStaging: true,
          projectReconciliation: projectSnapshot
        }
      )
    }
  })

  it('prepares separate Artifact reconciliation snapshots for different Projects', async () => {
    const sessions = [
      createSession(),
      createSession({ id: 'session-2' }),
      createSession({ id: 'session-3', projectId: 'project-2' })
    ]
    const result = { sessions, manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const snapshots = new Map<string, ArtifactProjectReconciliationSnapshot>([
      ['project-1', createProjectReconciliationSnapshot()],
      ['project-2', createProjectReconciliationSnapshot()]
    ])
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn(async (projectId: string) => snapshots.get(projectId)!),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await coordinator.loadAll()

    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledTimes(2)
    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledWith('project-1')
    expect(artifactStorage.prepareProjectReconciliation).toHaveBeenCalledWith('project-2')
    for (const session of sessions) {
      expect(artifactStorage.reconcileSession).toHaveBeenCalledWith(
        session.projectId,
        session.id,
        session,
        {
          removeOrphanStaging: true,
          projectReconciliation: snapshots.get(session.projectId)
        }
      )
    }
  })

  it('marks Files incomplete when Project reconciliation preparation fails', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const artifactStorage = {
      prepareProjectReconciliation: vi.fn().mockRejectedValue(new Error('scan failed')),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)

    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(artifactStorage.reconcileSession).not.toHaveBeenCalled()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('persists recovered Artifact Versions on their owning message without replay churn', async () => {
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 4,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'streaming',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    let durableSession = originalSession
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [durableSession], manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        durableSession = structuredClone(session)
      })
    })
    const recoveredArtifact = createRecoveredArtifact()
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [recoveredArtifact, recoveredArtifact] }
        ]
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const first = await coordinator.loadAll()
    const recoveredSession = first.sessions[0]

    // Message associations use ArtifactFile.id (the Artifact Version id), not lineage artifactId.
    expect(recoveredSession.messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(recoveredSession.conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(recoveredSession.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-version-1',
        artifactId: 'artifact-lineage-1',
        versionId: 'artifact-version-1',
        versionNumber: 1,
        sha256: 'a'.repeat(64)
      })
    ])
    expect(recoveredSession.filesRevision).toBe(5)
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([recoveredSession])
    expect(fileIndex.syncSession).toHaveBeenCalledWith(recoveredSession)

    const replayed = await coordinator.loadAll()
    expect(replayed.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(replayed.sessions[0].artifacts).toHaveLength(1)
    expect(replayed.sessions[0].filesRevision).toBe(5)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('replaces a recovered Artifact Version legacy alias instead of preserving two projections', async () => {
    const legacyAlias = createLegacyArtifactAlias()
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 4,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'complete',
            eventIds: [],
            artifactIds: [legacyAlias.id],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [legacyAlias]
      })
    )
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [originalSession], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
        ]
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()
    const recoveredSession = loaded.sessions[0]

    expect(recoveredSession.messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(recoveredSession.conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(recoveredSession.artifacts).toEqual([
      expect.objectContaining({
        id: 'artifact-version-1',
        versionId: 'artifact-version-1',
        sha256: 'a'.repeat(64)
      })
    ])
    expect(recoveredSession.filesRevision).toBe(5)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('normalizes an already duplicated historical Artifact Version without recovery input', async () => {
    const legacyAlias = createLegacyArtifactAlias()
    const nativeVersion = createPersistedRecoveredArtifact()
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 7,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'complete',
            eventIds: [],
            artifactIds: [legacyAlias.id, nativeVersion.id],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [legacyAlias, nativeVersion]
      })
    )
    let durableSession = originalSession
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [durableSession], manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        durableSession = structuredClone(session)
      })
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()
    const normalizedSession = loaded.sessions[0]

    expect(normalizedSession.messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(normalizedSession.conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(normalizedSession.artifacts).toEqual([nativeVersion])
    expect(normalizedSession.filesRevision).toBe(8)
    expect(repository.saveSession).toHaveBeenCalledOnce()

    const replayed = await coordinator.loadAll()
    expect(replayed.sessions[0]).toEqual(normalizedSession)
    expect(repository.saveSession).toHaveBeenCalledOnce()
  })

  it('retries a failed historical Artifact alias write-back without replay churn', async () => {
    const legacyAlias = createLegacyArtifactAlias()
    const nativeVersion = createPersistedRecoveredArtifact()
    const originalSession = materializeSessionConversationGraph(
      createSession({
        filesRevision: 7,
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'historical result',
            status: 'complete',
            eventIds: ['event-1'],
            artifactIds: [legacyAlias.id, nativeVersion.id],
            createdAt: 1,
            updatedAt: 2
          }
        ],
        artifacts: [legacyAlias, nativeVersion]
      })
    )
    let durableSession = originalSession
    let writeAttempt = 0
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn(async () => ({
        result: { sessions: [durableSession], manifest: { version: 1 as const } },
        isComplete: true
      })),
      saveSession: vi.fn(async (session) => {
        writeAttempt += 1
        if (writeAttempt === 1) throw new Error('session json is read-only')
        durableSession = structuredClone(session)
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue(undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ markReconciliationIncomplete }),
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const failedWriteView = await coordinator.loadAll()
    expect(failedWriteView.sessions[0].messages[0]).toMatchObject({
      content: 'historical result',
      eventIds: ['event-1'],
      artifactIds: ['artifact-version-1'],
      createdAt: 1,
      updatedAt: 2
    })
    expect(failedWriteView.sessions[0].artifacts).toEqual([nativeVersion])
    expect(failedWriteView.diagnostics?.failure).toBe('startup-reconciliation-failed')
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()

    const retried = await coordinator.loadAll()
    expect(retried.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(repository.saveSession).toHaveBeenCalledTimes(2)

    const replayed = await coordinator.loadAll()
    expect(replayed.sessions[0]).toEqual(retried.sessions[0])
    expect(repository.saveSession).toHaveBeenCalledTimes(2)
  })

  it('returns the recovered Session view and retries when its JSON save fails', async () => {
    const session = materializeSessionConversationGraph(
      createSession({
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'streaming',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true }),
      saveSession: vi
        .fn()
        .mockRejectedValueOnce(new Error('session json is read-only'))
        .mockResolvedValueOnce(undefined)
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const provenance = createProvenancePersistence()
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          {
            messageId: 'message-1',
            artifacts: [
              createRecoveredArtifact({
                checksum: 'b'.repeat(64),
                name: 'result.txt',
                path: '/managed/result.txt',
                fileUrl: 'file:///managed/result.txt',
                size: 6
              })
            ]
          }
        ]
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(loaded.sessions[0].conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(loaded.sessions[0].artifacts?.[0]).toMatchObject({ id: 'artifact-version-1' })
    expect(loaded.sessions[0].filesRevision).toBe(2)
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()

    const retried = await coordinator.loadAll()
    expect(retried.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledTimes(2)
    expect(repository.saveSession).toHaveBeenCalledTimes(2)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledOnce()
    expect(fileIndex.syncSession).toHaveBeenCalledOnce()
  })

  it('retries the attachment without saving JSON when Message snapshot capture fails', async () => {
    const session = materializeSessionConversationGraph(
      createSession({
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'result',
            status: 'streaming',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const provenance = createProvenancePersistence({
      captureFinalizedMessages: vi
        .fn()
        .mockRejectedValueOnce(new Error('snapshot storage is read-only'))
        .mockResolvedValueOnce(undefined)
    })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi.fn().mockResolvedValue({
        recoveredMessageArtifacts: [
          { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
        ]
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance,
      undefined,
      artifactStorage
    )

    const first = await coordinator.loadAll()
    expect(first.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()

    const retried = await coordinator.loadAll()
    expect(retried.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(provenance.captureFinalizedMessages).toHaveBeenCalledTimes(2)
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledOnce()
    expect(fileIndex.syncSession).toHaveBeenCalledOnce()
  })

  it('keeps earlier recovered Sessions when a later reconciliation fails', async () => {
    const firstSession = materializeSessionConversationGraph(
      createSession({
        messages: [
          {
            id: 'message-1',
            role: 'agent',
            content: 'first result',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 2
          }
        ]
      })
    )
    const secondSession = createSession({ id: 'session-2', title: 'Second Session' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [firstSession, secondSession], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const artifactStorage = {
      prepareProjectReconciliation: vi
        .fn()
        .mockResolvedValue(createProjectReconciliationSnapshot()),
      reconcileSession: vi
        .fn()
        .mockResolvedValueOnce({
          recoveredMessageArtifacts: [
            { messageId: 'message-1', artifacts: [createRecoveredArtifact()] }
          ]
        })
        .mockRejectedValueOnce(new Error('artifact database unavailable'))
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      artifactStorage
    )

    const loaded = await coordinator.loadAll()

    expect(loaded.sessions[0].messages[0].artifactIds).toEqual(['artifact-version-1'])
    expect(loaded.sessions[0].conversationGraph?.messages[0].artifactIds).toEqual([
      'artifact-version-1'
    ])
    expect(loaded.sessions[1]).toBe(secondSession)
    expect(repository.saveSession).toHaveBeenCalledWith(loaded.sessions[0])
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(fileIndex.syncSession).not.toHaveBeenCalled()
  })

  it('reconciles active owners before syncing sessions from a complete startup scan', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    let isReconciled = false
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const syncSession = vi.fn().mockResolvedValue([])
    const fileIndex = createFileIndex({
      syncSession,
      reconcileActiveSessions: vi.fn(async () => {
        isReconciled = true
      })
    })
    syncSession.mockImplementation(async () => {
      expect(isReconciled).toBe(true)
      return []
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.loadAll()

    expect(syncSession).toHaveBeenCalledOnce()
  })

  it('marks startup reconciliation incomplete when a Session file-index sync fails', async () => {
    const session = createSession({ title: 'Private analysis', cwd: '/private/workspace' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({
      markReconciliationIncomplete,
      syncSession: vi
        .fn()
        .mockRejectedValue(new Error('file index database is locked at /private/files.sqlite'))
    })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )

    await expect(coordinator.loadAll()).resolves.toMatchObject({
      diagnostics: {
        isComplete: false,
        failure: 'startup-reconciliation-failed'
      }
    })
    await expect(coordinator.sessionMetadataSnapshot()).resolves.toEqual({
      sessions: [{ id: 'session-1', projectId: 'project-1', title: 'Private analysis' }],
      isComplete: false
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'session-hydration',
        operationId: expect.any(String),
        mode: 'reconcile',
        startupCleanupEligible: true,
        phase: 'reconcile-derived-state',
        outcome: 'failed',
        status: 'degraded',
        hydrationAvailable: true,
        sessionCount: 1,
        warningCount: 0,
        errorCategory: 'error',
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.error.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('file index database is locked')
    expect(diagnosticPayload).not.toContain('/private/files.sqlite')
  })

  it('retries surviving project sessions after deleting a collision owner', async () => {
    const owner = createSession()
    const survivor = createSession({ id: 'session-2' })
    const result = { sessions: [owner, survivor], manifest: { version: 1 as const } }
    const loadAllWithDiagnostics = vi.fn().mockResolvedValue({ result, isComplete: true })
    const repository = createSessionRepository({
      loadAllWithDiagnostics,
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [survivor],
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)
    await coordinator.loadAll()
    vi.mocked(fileIndex.syncSession).mockClear()
    vi.mocked(fileIndex.syncSession).mockResolvedValueOnce(['artifact'])

    await coordinator.deleteSession('project-1', 'session-1')

    expect(fileIndex.syncSession).toHaveBeenCalledTimes(1)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(survivor)
    expect(fileIndex.reconcileProjectSessions).toHaveBeenCalledWith('project-1', [survivor])
    expect(loadAllWithDiagnostics).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledTimes(2)
    expect(onFilesChanged).toHaveBeenNthCalledWith(1, {
      projectId: 'project-1',
      sessionId: 'session-2',
      sources: ['artifact'],
      kind: 'upsert'
    })
    expect(onFilesChanged).toHaveBeenNthCalledWith(2, {
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['artifact', 'upload'],
      kind: 'delete'
    })
  })

  it('marks the index incomplete when the sessions scan is partial', async () => {
    const session = createSession({ title: 'Private analysis' })
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const warnings = [
      {
        kind: 'unreadable' as const,
        projectId: 'project-1',
        fileName: 'private-session-2.json',
        recovered: false
      }
    ]
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: false, warnings })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const log = createTestLogger()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      log
    )
    const reconcile = vi.fn(async () => undefined)
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ reconcile }))

    const loaded = await coordinator.loadAll()

    expect(loaded).toBe(result)
    expect(result).toMatchObject({ diagnostics: { isComplete: false, warnings } })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenLastCalledWith(
      'operation completed',
      expect.objectContaining({
        operation: 'session-hydration',
        phase: 'authority-loaded',
        outcome: 'completed',
        status: 'partial',
        sessionCount: 1,
        warningCount: 1
      })
    )
    const diagnosticPayload = JSON.stringify(log.info.mock.calls)
    expect(diagnosticPayload).not.toContain('Private analysis')
    expect(diagnosticPayload).not.toContain('private-session-2.json')
  })

  it('marks reconciliation incomplete when startup Provenance recovery fails', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const provenance = {
      validateFinalizedMessageBindings: vi.fn(),
      captureFinalizedMessages: vi.fn(),
      reconcileSessionDeletions: vi.fn().mockRejectedValue(new Error('recovery failed')),
      prepareSessionDeletion: vi.fn(),
      completeSessionDeletion: vi.fn(),
      abortSessionDeletion: vi.fn()
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      provenance
    )

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(result).toMatchObject({
      diagnostics: {
        isComplete: false,
        failure: 'startup-reconciliation-failed'
      }
    })
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.reconcileActiveSessions).not.toHaveBeenCalled()
  })

  it('keeps chat hydration available when one session cannot be indexed', async () => {
    const session = createSession()
    const result = { sessions: [session], manifest: { version: 1 as const } }
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({ result, isComplete: true })
    })
    const fileIndex = createFileIndex({
      syncSession: vi.fn().mockRejectedValue(new Error('missing managed file'))
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.loadAll()).resolves.toBe(result)
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([session])
  })

  it('leaves the project index untouched when authoritative Session rename fails', async () => {
    const repository = createSessionRepository({
      deleteProjectSessions: vi.fn().mockRejectedValueOnce(new Error('directory busy'))
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow('directory busy')
    expect(fileIndex.softDeleteProject).not.toHaveBeenCalled()
    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })
  })

  it('retains the Project tombstone and retries a derived index failure after Session commit', async () => {
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared')
    })
    const fileIndex = createFileIndex({
      softDeleteProject: vi
        .fn()
        .mockRejectedValueOnce(new Error('index unavailable'))
        .mockResolvedValue('delete-project-operation')
    })
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'index unavailable'
    )
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
    expect(repository.deleteProjectSessions).toHaveBeenCalledOnce()

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(repository.deleteProjectSessions).toHaveBeenCalledTimes(2)
    expect(fileIndex.softDeleteProject).toHaveBeenCalledTimes(2)
  })

  it('retries committed tombstone cleanup after persisting its path-free Session projection', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    let durableSession = legacySession
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
        sessions: [durableSession],
        isComplete: true
      })),
      saveCommittedProjectSession: vi.fn(async (session) => {
        durableSession = session
      })
    })
    let terminalAttempts = 0
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session, options) => {
        if (options?.mode === 'live-save') return upgradedSession
        terminalAttempts += 1
        if (terminalAttempts === 1) throw new Error('terminal cleanup interrupted')
        return session
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'terminal cleanup interrupted'
    )
    expect(repository.saveCommittedProjectSession).toHaveBeenCalledWith(upgradedSession)
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(repository.saveCommittedProjectSession).toHaveBeenCalledOnce()
    expect(repository.markCommittedProjectSessionsPrepared).toHaveBeenCalledOnce()
    expect(repository.deleteProjectSessions).toHaveBeenCalledOnce()
  })

  it('reconciles retained Upload copies before project Session and index authority are removed', async () => {
    const order: string[] = []
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      }),
      deleteProjectSessions: vi.fn(async () => {
        order.push('delete-json')
      })
    })
    const fileIndex = createFileIndex({
      softDeleteProject: vi.fn(async () => {
        order.push('soft-delete-index')
        return 'delete-project-operation'
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async () => {
        order.push('reconcile-upload-copy')
        return session
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await coordinator.deleteProjectSessions('project-1')

    expect(order).toEqual(['reconcile-upload-copy', 'delete-json', 'soft-delete-index'])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(session, {
      mode: 'terminal-delete'
    })
  })

  it('terminal-cleans readable Sessions before deleting incomplete Project authority', async () => {
    const order: string[] = []
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: false
      }),
      deleteProjectSessions: vi.fn(async () => {
        order.push('delete-project-sessions')
      })
    })
    const fileIndex = createFileIndex({
      markReconciliationIncomplete: vi.fn(() => {
        order.push('mark-incomplete')
      }),
      softDeleteProject: vi.fn(async () => {
        order.push('soft-delete-index')
        return 'delete-project-operation'
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async () => {
        order.push('terminal-cleanup')
        return session
      })
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })

    expect(order).toEqual([
      'mark-incomplete',
      'terminal-cleanup',
      'delete-project-sessions',
      'soft-delete-index'
    ])
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(session, {
      mode: 'terminal-delete'
    })
  })

  it('preserves incomplete orphaned tombstone authority instead of adopting its readable subset', async () => {
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: false
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn().mockResolvedValue(session)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      uploads
    )

    await expect(
      coordinator.deleteProjectSessions('project-1', {
        requireExistingUploadAuthority: true
      })
    ).rejects.toThrow(/incomplete Session authority/i)

    expect(uploads.upgradeLegacySessionUploads).not.toHaveBeenCalled()
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('returns orphan-retained only for positively missing Upload authority', async () => {
    const session = createLegacyUploadSession('session-1')
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockRejectedValue(new OrphanLegacyUploadAuthorityMissingError('missing Upload authority'))
    }
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(async () => undefined),
      commitProjectJobDeletion: vi.fn(async () => undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await expect(
      coordinator.deleteProjectSessions('project-1', {
        requireExistingUploadAuthority: true
      })
    ).resolves.toEqual({
      status: 'orphan-retained',
      reason: 'missing-upload-authority'
    })

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(computeJobs.prepareProjectJobDeletion).toHaveBeenCalledWith('project-1')
    expect(computeJobs.commitProjectJobDeletion).toHaveBeenCalledWith('project-1')
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('rejects orphan retention when the Project index cannot be soft-deleted', async () => {
    const session = createLegacyUploadSession('session-1')
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('legacy-committed'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      })
    })
    const fileIndex = createFileIndex({
      softDeleteProject: vi.fn().mockRejectedValue(new Error('index temporarily unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockRejectedValue(new OrphanLegacyUploadAuthorityMissingError('missing Upload authority'))
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(
      coordinator.deleteProjectSessions('project-1', {
        requireExistingUploadAuthority: true
      })
    ).rejects.toThrow('index temporarily unavailable')

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(repository.markCommittedProjectSessionsPrepared).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('aborts Project deletion on transient Upload cleanup failure and retries from intact authority', async () => {
    const first = createLegacyUploadSession('session-1')
    const upgradedFirst = toVersionedUploadSession(first)
    const second = createLegacyUploadSession('session-2')
    const order: string[] = []
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [first, second],
        isComplete: true
      }),
      saveSession: vi.fn(async (session) => {
        order.push(`save:${session.id}`)
      })
    })
    let secondUpgradeAttempts = 0
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (session, options) => {
        order.push(`${session.id}:${options?.mode}`)
        if (session.id === 'session-1') return upgradedFirst
        secondUpgradeAttempts += 1
        if (secondUpgradeAttempts === 1) throw new Error('second upload upgrade failed')
        return toVersionedUploadSession(second)
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'second upload upgrade failed'
    )

    expect(order).toEqual([
      'session-1:live-save',
      'save:session-1',
      'session-1:terminal-delete',
      'session-2:live-save'
    ])
    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(repository.saveSession).toHaveBeenCalledWith(upgradedFirst)
    expect(fileIndex.softDeleteProject).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
  })

  it('retains a legacy source and aborts Project deletion when path-free projection save fails', async () => {
    const legacySession = createLegacyUploadSession('session-1')
    const upgradedSession = toVersionedUploadSession(legacySession)
    let legacySourceRemoved = false
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [legacySession],
        isComplete: true
      }),
      saveSession: vi.fn().mockRejectedValue(new Error('session file unavailable'))
    })
    const uploads = {
      upgradeLegacySessionUploads: vi.fn(async (_session, options) => {
        if (options?.mode === 'terminal-delete') legacySourceRemoved = true
        return upgradedSession
      })
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'session file unavailable'
    )

    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledOnce()
    expect(uploads.upgradeLegacySessionUploads).toHaveBeenCalledWith(legacySession, {
      mode: 'live-save'
    })
    expect(legacySourceRemoved).toBe(false)
    expect(fileIndex.markReconciliationIncomplete).not.toHaveBeenCalled()
    expect(fileIndex.softDeleteProject).not.toHaveBeenCalled()
    expect(repository.deleteProjectSessions).not.toHaveBeenCalled()
  })

  it('retains a proven unsafe Upload replacement while committing Project deletion', async () => {
    const session = toVersionedUploadSession(createLegacyUploadSession('session-1'))
    const repository = createSessionRepository({
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [session],
        isComplete: true
      })
    })
    const uploads = {
      upgradeLegacySessionUploads: vi
        .fn()
        .mockRejectedValue(
          new UnsafeLegacyUploadResidualError('legacy path contains unrelated bytes')
        )
    }
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      fileIndex,
      undefined,
      undefined,
      uploads
    )

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })

    expect(fileIndex.markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(fileIndex.softDeleteProject).toHaveBeenCalledWith('project-1')
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
  })

  it('rejects late session saves after a project session directory was deleted', async () => {
    const repository = createSessionRepository()
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteProjectSessions('project-1')

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
  })

  it('does not turn a committed project-session deletion into a failure when notification throws', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex(), () => {
      throw new Error('renderer unavailable')
    })

    await expect(coordinator.deleteProjectSessions('project-1')).resolves.toEqual({
      status: 'completed'
    })
    expect(repository.deleteProjectSessions).toHaveBeenCalledWith('project-1')
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/project.*deleted/i)
  })

  it('does not turn a committed session deletion into a failure when notification throws', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex(), () => {
      throw new Error('renderer unavailable')
    })

    await expect(coordinator.deleteSession('project-1', 'session-1')).resolves.toBeUndefined()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
    await expect(coordinator.saveSession(createSession())).rejects.toThrow(/deleted/)
  })

  it('cleans unread state only after removing one authoritative session', async () => {
    const order: string[] = []
    const repository = createSessionRepository({
      deleteSession: vi.fn(async () => {
        order.push('delete-json')
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        commit: vi.fn(async (sessionIds) => {
          order.push(`commit:${sessionIds.join(',')}`)
        })
      })
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(order).toEqual(['delete-json', 'commit:session-1'])
  })

  it('does not clean unread state when the authoritative session delete fails', async () => {
    const repository = createSessionRepository({
      deleteSession: vi.fn().mockRejectedValue(new Error('disk locked'))
    })
    const commit = vi.fn(async () => undefined)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ commit }))

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')

    expect(commit).not.toHaveBeenCalled()
  })

  it('cleans every project session after removing project authority', async () => {
    const order: string[] = []
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('live'),
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createSession(), createSession({ id: 'session-2' })],
        isComplete: true
      }),
      deleteProjectSessions: vi.fn(async () => {
        order.push('delete-project-json')
      })
    })
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        commit: vi.fn(async (sessionIds) => {
          order.push(`commit:${sessionIds.join(',')}`)
        })
      })
    )

    await coordinator.deleteProjectSessions('project-1')

    expect(order).toEqual(['delete-project-json', 'commit:session-1,session-2'])
  })

  it('does not clean unread state when live project authority remains after failure', async () => {
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('live'),
      loadProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createSession()],
        isComplete: true
      }),
      deleteProjectSessions: vi.fn().mockRejectedValue(new Error('directory busy'))
    })
    const commit = vi.fn(async () => undefined)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ commit }))

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow('directory busy')

    expect(commit).not.toHaveBeenCalled()
    await expect(coordinator.saveSession(createSession())).resolves.toMatchObject({
      id: 'session-1'
    })
  })

  it('cleans unread state when replaying a project tombstone', async () => {
    const repository = createSessionRepository({
      getProjectSessionDeletionState: vi.fn().mockResolvedValue('prepared'),
      loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
        sessions: [createSession()],
        isComplete: true
      })
    })
    const commit = vi.fn(async () => undefined)
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(createSessionDeletionHandlers({ commit }))

    await coordinator.deleteProjectSessions('project-1')

    expect(commit).toHaveBeenCalledWith(['session-1'])
  })

  it('keeps committed session deletion successful when unread cleanup rejects', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
    coordinator.setSessionDeletionHandlers(
      createSessionDeletionHandlers({
        commit: vi.fn().mockRejectedValue(new Error('badge database locked'))
      })
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).resolves.toBeUndefined()
    expect(repository.deleteSession).toHaveBeenCalledWith('project-1', 'session-1')
  })

  it('reconciles surviving sessions after a successful session deletion', async () => {
    const survivor = createSession({ id: 'session-2' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [survivor], manifest: { version: 1 as const } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)

    await coordinator.deleteSession('project-1', 'session-1')

    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([survivor])
  })

  it('routes manifest writes through the same mutation queue', async () => {
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())

    await coordinator.saveManifest({ lastSessionId: 'session-1' })

    expect(repository.saveManifest).toHaveBeenCalledWith({ lastSessionId: 'session-1' })
  })

  it('does not broadcast a files change when the files revision is already indexed', async () => {
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) }),
      onFilesChanged
    )

    await coordinator.saveSession(createSession())

    expect(onFilesChanged).not.toHaveBeenCalled()
  })

  it('broadcasts only the file sources changed by the index transaction', async () => {
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository(),
      createFileIndex({ syncSession: vi.fn().mockResolvedValue(['upload']) }),
      onFilesChanged
    )

    await coordinator.saveSession(createSession())

    expect(onFilesChanged).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sessionId: 'session-1',
      sources: ['upload'],
      kind: 'upsert'
    })
  })

  it('broadcasts a reset when a saved session cannot be indexed', async () => {
    const onFilesChanged = vi.fn()
    const repository = createSessionRepository()
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({
        syncSession: vi.fn().mockRejectedValue(new Error('managed file is unreadable'))
      }),
      onFilesChanged
    )

    await expect(coordinator.saveSession(createSession())).rejects.toThrow(
      'managed file is unreadable'
    )

    expect(repository.saveSession).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('force-syncs the complete scan before repair clears the global reconciliation marker', async () => {
    const targetSession = createSession()
    const otherSession = createSession({ id: 'session-2', projectId: 'project-2' })
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [targetSession, otherSession], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const fileIndex = createFileIndex({ syncSession: vi.fn().mockResolvedValue([]) })
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)
    const repairProjectFiles = (
      coordinator as unknown as { repairProjectFiles(projectId: string): Promise<void> }
    ).repairProjectFiles

    await repairProjectFiles.call(coordinator, 'project-1')

    expect(fileIndex.syncSession).toHaveBeenCalledTimes(4)
    expect(fileIndex.syncSession).toHaveBeenCalledWith(targetSession, { force: true })
    expect(fileIndex.syncSession).toHaveBeenCalledWith(otherSession, { force: true })
    expect(fileIndex.reconcileActiveSessions).toHaveBeenCalledWith([targetSession, otherSession])
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('resolves repair when a transient first-pass sync succeeds after reconciliation', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [session], manifest: { version: 1 } },
        isComplete: true
      })
    })
    const syncSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('database busy'))
      .mockResolvedValueOnce([])
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ syncSession })
    )

    await expect(coordinator.repairProjectFiles('project-1')).resolves.toBeUndefined()
    expect(syncSession).toHaveBeenCalledTimes(2)
  })

  it('marks the index incomplete and broadcasts reset when repair sees a partial scan', async () => {
    const repository = createSessionRepository({
      loadAllWithDiagnostics: vi.fn().mockResolvedValue({
        result: { sessions: [], manifest: { version: 1 } },
        isComplete: false
      })
    })
    const markReconciliationIncomplete = vi.fn()
    const fileIndex = createFileIndex({ markReconciliationIncomplete })
    const onFilesChanged = vi.fn()
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex, onFilesChanged)

    await expect(coordinator.repairProjectFiles('project-1')).rejects.toThrow(/sessions directory/i)

    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    expect(onFilesChanged).toHaveBeenCalledWith({
      projectId: 'project-1',
      sources: ['artifact', 'upload'],
      kind: 'reset'
    })
  })

  it('keeps Compute Job rows until Session authority commits', async () => {
    const resources = new Set(['job-row', 'remote-workdir', 'pending-notification'])
    let sessionAuthorityDeleted = false
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(async (projectId: string, sessionId: string) => {
        expect({ projectId, sessionId }).toEqual({
          projectId: 'project-1',
          sessionId: 'session-1'
        })
      }),
      commitSessionJobDeletion: vi.fn(async () => {
        expect(sessionAuthorityDeleted).toBe(true)
        resources.delete('remote-workdir')
        resources.delete('job-row')
        resources.delete('pending-notification')
      }),
      prepareProjectJobDeletion: vi.fn(),
      commitProjectJobDeletion: vi.fn()
    }
    const repository = createSessionRepository({
      deleteSession: vi.fn(async () => {
        expect(resources).toEqual(new Set(['job-row', 'remote-workdir', 'pending-notification']))
        sessionAuthorityDeleted = true
      })
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(computeJobs.prepareSessionJobDeletion).toHaveBeenCalledOnce()
    expect(computeJobs.commitSessionJobDeletion).toHaveBeenCalledOnce()
    expect(resources).toEqual(new Set())
  })

  it('keeps Compute Job rows until Project Session authority commits', async () => {
    const resources = new Set(['job-row', 'remote-workdir', 'pending-notification'])
    let projectAuthorityDeleted = false
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(async (projectId: string) => {
        expect(projectId).toBe('project-1')
      }),
      commitProjectJobDeletion: vi.fn(async () => {
        expect(projectAuthorityDeleted).toBe(true)
        resources.delete('remote-workdir')
        resources.delete('job-row')
        resources.delete('pending-notification')
      })
    }
    const repository = createSessionRepository({
      deleteProjectSessions: vi.fn(async () => {
        expect(resources).toEqual(new Set(['job-row', 'remote-workdir', 'pending-notification']))
        projectAuthorityDeleted = true
      })
    })
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await coordinator.deleteProjectSessions('project-1')

    expect(computeJobs.prepareProjectJobDeletion).toHaveBeenCalledOnce()
    expect(computeJobs.commitProjectJobDeletion).toHaveBeenCalledOnce()
    expect(resources).toEqual(new Set())
  })

  it('arms Compute Job deletion before Session deletion preparation', async () => {
    const steps: string[] = []
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(async () => {
        steps.push('job-barrier')
      }),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(),
      commitProjectJobDeletion: vi.fn()
    }
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        loadSessionWithDiagnostics: vi.fn(async () => {
          steps.push('session-preparation')
          return { status: 'missing' as const }
        })
      }),
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await coordinator.deleteSession('project-1', 'session-1')

    expect(steps).toEqual(['job-barrier', 'session-preparation'])
  })

  it('arms Compute Job deletion before Project deletion preparation', async () => {
    const steps: string[] = []
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(async () => {
        steps.push('job-barrier')
      }),
      commitProjectJobDeletion: vi.fn()
    }
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        getProjectSessionDeletionState: vi.fn(async () => {
          steps.push('project-preparation')
          return 'absent' as const
        })
      }),
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await coordinator.deleteProjectSessions('project-1')

    expect(steps.slice(0, 2)).toEqual(['job-barrier', 'project-preparation'])
  })

  it('restores Compute Job admission when Session authority deletion fails', async () => {
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(async () => undefined),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(),
      commitProjectJobDeletion: vi.fn(),
      abortSessionJobDeletion: vi.fn(async () => undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        deleteSession: vi.fn().mockRejectedValue(new Error('disk locked'))
      }),
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow('disk locked')
    expect(computeJobs.abortSessionJobDeletion).toHaveBeenCalledWith('project-1', 'session-1')
  })

  it('logs the privacy-safe phase when Session authority deletion fails', async () => {
    const log = createTestLogger()
    const coordinator = createDeletionDiagnosticCoordinator(log, {
      repository: {
        deleteSession: vi
          .fn()
          .mockRejectedValue(
            new Error('database locked at C:\\Users\\example\\private-study\\open-science.db')
          )
      }
    })

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'database locked'
    )
    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'session-persistence-deletion',
        operationId: expect.any(String),
        phase: 'delete-authority',
        failurePhase: 'delete-authority',
        outcome: 'failed',
        errorCategory: 'error',
        durationMs: expect.any(Number)
      })
    )
    const diagnosticPayload = JSON.stringify(log.error.mock.calls)
    expect(diagnosticPayload).not.toContain('database locked')
    expect(diagnosticPayload).not.toContain('private-study')
    expect(diagnosticPayload).not.toContain('open-science.db')
  })

  it('distinguishes Session deletion participant failure phases', async () => {
    const failure = (): Promise<never> => Promise.reject(new Error('participant unavailable'))
    const session = createSession()
    const computeJobs = (overrides: {
      prepareSessionJobDeletion?: () => Promise<void>
      commitSessionJobDeletion?: () => Promise<void>
    }): NonNullable<ConstructorParameters<typeof SessionPersistenceCoordinator>[8]> => ({
      prepareSessionJobDeletion: vi.fn(
        overrides.prepareSessionJobDeletion ?? (async () => undefined)
      ),
      commitSessionJobDeletion: vi.fn(
        overrides.commitSessionJobDeletion ?? (async () => undefined)
      ),
      prepareProjectJobDeletion: vi.fn(async () => undefined),
      commitProjectJobDeletion: vi.fn(async () => undefined)
    })
    const cases: Array<{ phase: string; overrides: DeletionDiagnosticOverrides }> = [
      {
        phase: 'prepare-compute-cleanup',
        overrides: { computeJobs: computeJobs({ prepareSessionJobDeletion: failure }) }
      },
      {
        phase: 'load-authority',
        overrides: { repository: { loadSessionWithDiagnostics: vi.fn(failure) } }
      },
      {
        phase: 'prepare-upload-cleanup',
        overrides: {
          repository: {
            loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'found' as const, session }))
          },
          uploads: { upgradeLegacySessionUploads: vi.fn(failure) }
        }
      },
      {
        phase: 'prepare-provenance',
        overrides: {
          repository: {
            loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'found' as const, session }))
          },
          provenance: { prepareSessionDeletion: vi.fn(failure) }
        }
      },
      {
        phase: 'soft-delete-file-index',
        overrides: {
          repository: {
            loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'found' as const, session }))
          },
          fileIndex: { softDeleteSession: vi.fn(failure) }
        }
      },
      {
        phase: 'commit-compute-cleanup',
        overrides: { computeJobs: computeJobs({ commitSessionJobDeletion: failure }) }
      },
      {
        phase: 'complete-provenance',
        overrides: {
          repository: {
            loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'found' as const, session }))
          },
          provenance: { completeSessionDeletion: vi.fn(failure) }
        }
      }
    ]

    for (const testCase of cases) {
      const log = createTestLogger()
      await expect(
        createDeletionDiagnosticCoordinator(log, testCase.overrides).deleteSession(
          'project-1',
          'session-1'
        )
      ).rejects.toThrow('participant unavailable')
      expect(log.error).toHaveBeenCalledWith(
        'operation failed',
        expect.objectContaining({
          operation: 'session-persistence-deletion',
          failurePhase: testCase.phase,
          outcome: 'failed'
        })
      )
    }
  })

  it('logs the failed recovery phase without losing the original deletion phase', async () => {
    const session = createSession()
    const log = createTestLogger()
    const coordinator = createDeletionDiagnosticCoordinator(log, {
      repository: {
        loadSessionWithDiagnostics: vi.fn(async () => ({ status: 'found' as const, session })),
        deleteSession: vi.fn().mockRejectedValue(new Error('authority unavailable'))
      },
      fileIndex: {
        restoreSession: vi.fn().mockRejectedValue(new Error('file index unavailable'))
      },
      computeJobs: {
        prepareSessionJobDeletion: vi.fn(async () => undefined),
        commitSessionJobDeletion: vi.fn(async () => undefined),
        prepareProjectJobDeletion: vi.fn(async () => undefined),
        commitProjectJobDeletion: vi.fn(async () => undefined),
        abortSessionJobDeletion: vi.fn(async () => undefined)
      }
    })

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'file index unavailable'
    )
    expect(log.error).toHaveBeenCalledWith(
      'operation failed',
      expect.objectContaining({
        operation: 'session-persistence-deletion',
        phase: 'delete-authority',
        failurePhase: 'delete-authority',
        recoveryPhase: 'restore-file-index',
        outcome: 'failed'
      })
    )
  })

  it('keeps Session authority deleted when post-authority Compute cleanup fails', async () => {
    const session = createSession()
    const repository = createSessionRepository({
      loadSessionWithDiagnostics: vi
        .fn()
        .mockResolvedValueOnce({ status: 'found', session })
        .mockResolvedValue({ status: 'missing' })
    })
    const markReconciliationIncomplete = vi.fn()
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(async () => undefined),
      commitSessionJobDeletion: vi.fn().mockRejectedValue(new Error('remote cleanup failed')),
      prepareProjectJobDeletion: vi.fn(),
      commitProjectJobDeletion: vi.fn(),
      abortSessionJobDeletion: vi.fn(async () => undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ markReconciliationIncomplete }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'remote cleanup failed'
    )
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(computeJobs.abortSessionJobDeletion).not.toHaveBeenCalled()
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
    await expect(coordinator.saveSession(session)).rejects.toThrow(/session.*deleted/i)
    expect(repository.saveSession).not.toHaveBeenCalled()
  })

  it('retains missing Session deletion and the Compute barrier when cleanup fails', async () => {
    const repository = createSessionRepository()
    const restoreSession = vi.fn().mockResolvedValue(undefined)
    const markReconciliationIncomplete = vi.fn()
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(async () => undefined),
      commitSessionJobDeletion: vi.fn().mockRejectedValue(new Error('remote cleanup failed')),
      prepareProjectJobDeletion: vi.fn(),
      commitProjectJobDeletion: vi.fn(),
      abortSessionJobDeletion: vi.fn(async () => undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      repository,
      createFileIndex({ restoreSession, markReconciliationIncomplete }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await expect(coordinator.deleteSession('project-1', 'session-1')).rejects.toThrow(
      'remote cleanup failed'
    )
    expect(repository.saveSession).not.toHaveBeenCalled()
    expect(restoreSession).not.toHaveBeenCalled()
    expect(computeJobs.abortSessionJobDeletion).not.toHaveBeenCalled()
    expect(markReconciliationIncomplete).toHaveBeenCalledOnce()
  })

  it('restores Compute Job admission when Project authority deletion stays live', async () => {
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(async () => undefined),
      commitProjectJobDeletion: vi.fn(),
      abortProjectJobDeletion: vi.fn(async () => undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        deleteProjectSessions: vi.fn().mockRejectedValue(new Error('directory busy')),
        getProjectSessionDeletionState: vi.fn().mockResolvedValue('live')
      }),
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow('directory busy')
    expect(computeJobs.abortProjectJobDeletion).toHaveBeenCalledWith('project-1')
  })

  it('retains the Project barrier when cleanup fails after tombstone commit', async () => {
    let authorityCommitted = false
    const computeJobs = {
      prepareSessionJobDeletion: vi.fn(),
      commitSessionJobDeletion: vi.fn(),
      prepareProjectJobDeletion: vi.fn(async () => undefined),
      commitProjectJobDeletion: vi.fn().mockRejectedValue(new Error('remote cleanup failed')),
      abortProjectJobDeletion: vi.fn(async () => undefined)
    }
    const coordinator = new SessionPersistenceCoordinator(
      createSessionRepository({
        deleteProjectSessions: vi.fn(async () => {
          authorityCommitted = true
        }),
        getProjectSessionDeletionState: vi.fn(async () =>
          authorityCommitted ? ('prepared' as const) : ('live' as const)
        )
      }),
      createFileIndex(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createTestLogger(),
      computeJobs
    )

    await expect(coordinator.deleteProjectSessions('project-1')).rejects.toThrow(
      'remote cleanup failed'
    )
    expect(computeJobs.abortProjectJobDeletion).not.toHaveBeenCalled()
  })
})

const createSessionRepository = (
  overrides: Partial<SessionMutationRepository> = {}
): SessionMutationRepository => ({
  loadAllWithDiagnostics: vi.fn().mockResolvedValue({
    result: { sessions: [], manifest: { version: 1 } },
    isComplete: true
  }),
  loadProjectWithDiagnostics: vi.fn().mockResolvedValue({ sessions: [], isComplete: true }),
  loadCommittedProjectWithDiagnostics: vi.fn().mockResolvedValue({
    sessions: [],
    isComplete: true
  }),
  loadSessionWithDiagnostics: vi.fn().mockResolvedValue({ status: 'missing' }),
  assertSessionIdentityOwnership: vi.fn().mockResolvedValue(undefined),
  saveSession: vi.fn().mockResolvedValue(undefined),
  saveCommittedProjectSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  deleteProjectSessions: vi.fn().mockResolvedValue(undefined),
  getProjectSessionDeletionState: vi.fn().mockResolvedValue('absent'),
  markCommittedProjectSessionsPrepared: vi.fn().mockResolvedValue(undefined),
  completeProjectSessionDeletion: vi.fn().mockResolvedValue(undefined),
  listLegacyProjectSessionTombstones: vi.fn().mockResolvedValue([]),
  saveManifest: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const createFileIndex = (overrides: Partial<SessionFileIndex> = {}): SessionFileIndex => ({
  syncSession: vi.fn().mockResolvedValue(['artifact', 'upload']),
  softDeleteSession: vi.fn().mockResolvedValue('delete-session-operation'),
  restoreSession: vi.fn().mockResolvedValue(undefined),
  softDeleteProject: vi.fn().mockResolvedValue('delete-project-operation'),
  reconcileProjectSessions: vi.fn().mockResolvedValue(undefined),
  reconcileActiveSessions: vi.fn().mockResolvedValue(undefined),
  markReconciliationIncomplete: vi.fn(),
  ...overrides
})

const createSessionDeletionHandlers = (
  overrides: Partial<SessionDeletionHandlers> = {}
): SessionDeletionHandlers => ({
  commit: vi.fn().mockResolvedValue(undefined),
  reconcile: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

const createProvenancePersistence = (
  overrides: Partial<SessionProvenancePersistence> = {}
): SessionProvenancePersistence => ({
  validateFinalizedMessageBindings: vi.fn().mockResolvedValue(undefined),
  captureFinalizedMessages: vi.fn().mockResolvedValue(undefined),
  reconcileSessionDeletions: vi.fn().mockResolvedValue(undefined),
  prepareSessionDeletion: vi
    .fn()
    .mockResolvedValue({ kind: 'ordinary', projectId: 'project-1', sessionId: 'session-1' }),
  completeSessionDeletion: vi.fn().mockResolvedValue(undefined),
  abortSessionDeletion: vi.fn().mockResolvedValue(undefined),
  ...overrides
})

type DeletionDiagnosticOverrides = {
  repository?: Partial<SessionMutationRepository>
  fileIndex?: Partial<SessionFileIndex>
  provenance?: Partial<SessionProvenancePersistence>
  uploads?: ConstructorParameters<typeof SessionPersistenceCoordinator>[4]
  computeJobs?: ConstructorParameters<typeof SessionPersistenceCoordinator>[8]
}

const createDeletionDiagnosticCoordinator = (
  log: Logger,
  overrides: DeletionDiagnosticOverrides = {}
): SessionPersistenceCoordinator =>
  new SessionPersistenceCoordinator(
    createSessionRepository(overrides.repository),
    createFileIndex(overrides.fileIndex),
    undefined,
    overrides.provenance ? createProvenancePersistence(overrides.provenance) : undefined,
    overrides.uploads,
    undefined,
    undefined,
    log,
    overrides.computeJobs
  )

const createDeferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

type TestLogger = Logger & {
  [Method in keyof Logger]: ReturnType<typeof vi.fn<Logger[Method]>>
}

const createTestLogger = (): TestLogger =>
  ({
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>()
  }) satisfies Logger

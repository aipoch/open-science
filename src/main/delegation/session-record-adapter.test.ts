import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AcpAgentRuntimeUpdate } from '../../shared/acp'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { BuiltinSpecialistRegistryEntry } from '../../shared/specialist-package'
import { emptyFullAccessConfig, emptySelectedConfig } from '../../shared/specialist'
import {
  normalizeSessionFile,
  type PersistedChatMessage,
  type PersistedChatSession
} from '../../shared/session-persistence'
import {
  SessionPersistenceCoordinator,
  type SessionFileIndex,
  type SessionMutationRepository
} from '../session-persistence/coordinator'
import { SpecialistRepository } from '../specialist/repository'
import { SpecialistService } from '../specialist/service'
import {
  createDeterministicDelegateExecution,
  type ExecutionControl
} from './deterministic-execution'
import {
  type AuthenticatedDelegateCaller,
  type DurableDelegatedWork
} from './durable-delegated-work'
import { createTestDurableDelegatedWork as createDurableDelegatedWork } from './durable-delegated-work-test-fixture'
import { createSessionDelegatedWorkRecords } from './session-record-adapter'

const key = { projectId: 'project-1', sessionId: 'session-1' } as const
const rootPrompt: PersistedChatMessage = {
  id: 'root-prompt',
  role: 'user',
  content: 'Coordinate the work.',
  status: 'complete',
  eventIds: [],
  createdAt: 1,
  updatedAt: 1
}

const createSession = (): PersistedChatSession => ({
  id: key.sessionId,
  projectId: key.projectId,
  title: 'Delegated research',
  cwd: '/workspace',
  status: 'idle',
  specialistId: 'currently-bound-specialist',
  messages: [rootPrompt],
  conversationGraph: createLinearConversationGraph({
    sessionId: key.sessionId,
    messages: [rootPrompt],
    frameworkId: 'codex',
    createdAt: 1,
    updatedAt: 1
  }),
  filesRevision: 1,
  createdAt: 1,
  updatedAt: 2
})

const createHarness = (): Readonly<{
  coordinator: SessionPersistenceCoordinator
  repository: SessionMutationRepository
  readSession(): Promise<PersistedChatSession>
}> => {
  let durable = createSession()
  const repository: SessionMutationRepository = {
    loadAllWithDiagnostics: vi.fn(async () => ({
      result: { sessions: [structuredClone(durable)], manifest: { version: 1 as const } },
      isComplete: true
    })),
    loadProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    })),
    loadCommittedProjectWithDiagnostics: vi.fn(async () => ({
      sessions: [structuredClone(durable)],
      isComplete: true
    })),
    loadSessionWithDiagnostics: vi.fn(async () => ({
      status: 'found' as const,
      session: structuredClone(durable)
    })),
    assertSessionIdentityOwnership: vi.fn(async () => undefined),
    saveSession: vi.fn(async (session) => {
      durable = structuredClone(session)
    }),
    saveCommittedProjectSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    deleteProjectSessions: vi.fn(async () => undefined),
    getProjectSessionDeletionState: vi.fn(async () => 'absent' as const),
    markCommittedProjectSessionsPrepared: vi.fn(async () => undefined),
    completeProjectSessionDeletion: vi.fn(async () => undefined),
    listLegacyProjectSessionTombstones: vi.fn(async () => []),
    saveManifest: vi.fn(async () => undefined)
  }
  const fileIndex: SessionFileIndex = {
    syncSession: vi.fn(async () => []),
    softDeleteSession: vi.fn(async () => 'session-delete'),
    restoreSession: vi.fn(async () => undefined),
    softDeleteProject: vi.fn(async () => 'project-delete'),
    reconcileActiveSessions: vi.fn(async () => undefined),
    reconcileProjectSessions: vi.fn(async () => undefined),
    markReconciliationIncomplete: vi.fn()
  }
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
  return { coordinator, repository, readSession: async () => structuredClone(durable) }
}

type LateReplayScenario = Readonly<{
  caller: AuthenticatedDelegateCaller
  control: ExecutionControl
  readSession: ReturnType<typeof createHarness>['readSession']
  records: ReturnType<typeof createSessionDelegatedWorkRecords>
  repository: SessionMutationRepository
  work: DurableDelegatedWork
}>

async function createLateReplayScenario(): Promise<LateReplayScenario> {
  const { coordinator, repository, readSession } = createHarness()
  const execution = createDeterministicDelegateExecution()
  const rootFrameId = createSession().conversationGraph!.rootFrameId
  const records = createSessionDelegatedWorkRecords(
    { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'child-branch' },
    key
  )
  const ids = {
    frame: ['child-frame'],
    attempt: ['attempt-1'],
    message: ['prompt-1', 'pending-1', 'prompt-2', 'answer-1', 'answer-2'],
    runtime: ['runtime-1', 'runtime-2'],
    question: []
  }
  const work = createDurableDelegatedWork({
    execution,
    records,
    now: () => 50,
    createId: (kind) => ids[kind].shift()!
  })
  const caller: AuthenticatedDelegateCaller = {
    session: key,
    frameId: rootFrameId,
    role: 'main',
    originMessageId: rootPrompt.id,
    toolInvocationId: 'dispatch'
  }

  await work.delegate(caller, { task: 'Initial task', name: 'Initial task' }, { wait: false })
  await expect.poll(() => execution.controls()).toHaveLength(1)
  const control = execution.control('attempt-1')
  control.accept()
  await work.sendMessage(
    { ...caller, toolInvocationId: 'message-call' },
    'child-frame',
    'Additional evidence',
    { kind: 'info' }
  )

  return { caller, control, readSession, records, repository, work }
}

function createScopedToolUpdate(
  runtimeSegmentId: string,
  promptMessageId: string,
  event: AcpAgentRuntimeUpdate['event']
): AcpAgentRuntimeUpdate {
  return {
    scope: {
      projectId: key.projectId,
      sessionId: key.sessionId,
      agentFrameId: 'child-frame',
      attemptId: 'attempt-1',
      runtimeSegmentId,
      promptMessageId
    },
    event
  }
}

function createInitialToolUpdate(): AcpAgentRuntimeUpdate {
  return createScopedToolUpdate('runtime-1', 'prompt-1', {
    id: 'tool-one',
    timestamp: 40,
    kind: 'tool',
    level: 'info',
    toolCallId: 'call-1',
    title: 'Inspect evidence',
    status: 'completed'
  })
}

function createLateToolReplay(): AcpAgentRuntimeUpdate {
  return createScopedToolUpdate('runtime-1', 'prompt-1', {
    id: 'tool-one-late',
    timestamp: 41,
    kind: 'tool',
    level: 'info',
    toolCallId: 'call-1',
    status: 'completed',
    rawOutput: { replayed: true }
  })
}

function createActiveToolUpdate(): AcpAgentRuntimeUpdate {
  return createScopedToolUpdate('runtime-2', 'prompt-2', {
    id: 'tool-two',
    timestamp: 42,
    kind: 'tool',
    level: 'info',
    toolCallId: 'call-2',
    title: 'Check counterexample',
    status: 'in_progress'
  })
}

describe('Session delegated-work adapter', () => {
  it('persists delegated question drafts and atomically confirms a same-Frame continuation', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'question-child-branch'
      },
      key
    )
    const ids = {
      frame: ['question-child-frame'],
      attempt: ['question-source-attempt', 'question-answer-attempt'],
      message: ['question-child-prompt', 'question-source-answer', 'question-answer-prompt'],
      runtime: ['question-source-runtime', 'question-answer-runtime'],
      question: ['question-request']
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const rootCaller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'delegate-question-child'
    }

    await work.delegate(
      rootCaller,
      { task: 'Ask for the cohort', name: 'Cohort audit' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    await work.requestUserInput(
      {
        session: key,
        frameId: 'question-child-frame',
        role: 'delegate',
        attemptId: 'question-source-attempt',
        originMessageId: 'question-child-prompt',
        toolInvocationId: 'question-request'
      },
      {
        sessionId: key.sessionId,
        questions: [
          {
            question: 'Which cohort?',
            options: [{ label: 'Strict' }, { label: 'Broad' }]
          }
        ]
      },
      'question-request'
    )
    await work.updateQuestionDraft(key, {
      requestId: 'question-request',
      draftAnswers: [{ questionIndex: 0, value: 'Strict' }],
      questionIndex: 0
    })
    execution.controls()[0].complete('Waiting for the user.')
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0].status)
      .toBe('completed')
    const reopened = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex' },
      key
    )
    const restartedWork = createDurableDelegatedWork({
      execution,
      records: reopened,
      createId: (kind) => ids[kind].shift()!
    })
    await restartedWork.confirmQuestion(key, {
      requestId: 'question-request',
      answers: [{ questionIndex: 0, value: 'Strict' }]
    })

    await expect(reopened.snapshot()).resolves.toMatchObject({
      questionRequests: [
        {
          requestId: 'question-request',
          status: 'confirmed',
          answers: [{ questionIndex: 0, value: 'Strict' }],
          continuationAttemptId: 'question-answer-attempt'
        }
      ],
      records: [
        {
          frameId: 'question-child-frame',
          attempts: [
            { id: 'question-source-attempt', status: 'completed' },
            { id: 'question-answer-attempt', status: 'running' }
          ]
        }
      ]
    })
    const durable = await readSession()
    const rootMessages = durable.conversationGraph!.messages.filter(
      (message) => message.agentFrameId === rootFrameId
    )
    expect(rootMessages.map(({ id }) => id)).toEqual([rootPrompt.id])
    expect(durable.runtimeContext?.delegatedWork?.messageCommands ?? []).toEqual([])
  })

  it('atomically orders concurrent questions admitted through independent adapters', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    let branchSequence = 0
    const setupRecords = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `question-branch-${++branchSequence}`
      },
      key
    )
    const ids = {
      frame: ['existing-frame', 'concurrent-frame-a', 'concurrent-frame-b', 'concurrent-frame-c'],
      attempt: [
        'existing-attempt',
        'concurrent-attempt-a',
        'concurrent-attempt-b',
        'concurrent-attempt-c'
      ],
      message: [
        'existing-message',
        'concurrent-message-a',
        'concurrent-message-b',
        'concurrent-message-c'
      ],
      runtime: [
        'existing-runtime',
        'concurrent-runtime-a',
        'concurrent-runtime-b',
        'concurrent-runtime-c'
      ],
      question: []
    }
    const setupWork = createDurableDelegatedWork({
      execution,
      records: setupRecords,
      createId: (kind) => ids[kind].shift()!
    })
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const rootCaller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'delegate-concurrent-question-children'
    }

    await setupWork.delegate(
      rootCaller,
      [
        { task: 'Ask the existing question', name: 'Existing question' },
        { task: 'Ask concurrent question A', name: 'Concurrent question A' },
        { task: 'Ask concurrent question B', name: 'Concurrent question B' },
        { task: 'Ask concurrent question C', name: 'Concurrent question C' }
      ],
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(4)

    const caller = (index: number, requestId: string): AuthenticatedDelegateCaller => ({
      session: key,
      frameId: ['existing-frame', 'concurrent-frame-a', 'concurrent-frame-b', 'concurrent-frame-c'][
        index
      ],
      role: 'delegate',
      attemptId: [
        'existing-attempt',
        'concurrent-attempt-a',
        'concurrent-attempt-b',
        'concurrent-attempt-c'
      ][index],
      originMessageId: [
        'existing-message',
        'concurrent-message-a',
        'concurrent-message-b',
        'concurrent-message-c'
      ][index],
      toolInvocationId: requestId
    })
    const request = (label: string): Parameters<typeof setupWork.requestUserInput>[1] => ({
      sessionId: key.sessionId,
      questions: [
        { question: `Choose ${label}`, options: [{ label: 'First' }, { label: 'Second' }] }
      ]
    })
    await expect(
      setupWork.requestUserInput(
        caller(0, 'question-existing'),
        request('existing'),
        'question-existing'
      )
    ).resolves.toEqual({ action: 'pending' })

    const stale = await readSession()
    let waiting = 0
    let releaseFirstReads!: () => void
    const allFirstReads = new Promise<void>((resolve) => {
      releaseFirstReads = resolve
    })
    const independentWork = (): ReturnType<typeof createDurableDelegatedWork> => {
      let firstRead = true
      const records = createSessionDelegatedWorkRecords(
        {
          commands: coordinator,
          readSession: async () => {
            if (!firstRead) return readSession()
            firstRead = false
            waiting += 1
            if (waiting === 3) releaseFirstReads()
            await allFirstReads
            return structuredClone(stale)
          },
          frameworkId: 'codex'
        },
        key
      )
      return createDurableDelegatedWork({ execution, records })
    }
    const works = [independentWork(), independentWork(), independentWork()]

    await expect(
      Promise.all(
        works.map((work, index) =>
          work.requestUserInput(
            caller(index + 1, `question-${index + 1}`),
            request(`concurrent ${index + 1}`),
            `question-${index + 1}`
          )
        )
      )
    ).resolves.toEqual([{ action: 'pending' }, { action: 'pending' }, { action: 'pending' }])

    const reloaded = await readSession()
    expect(reloaded.runtimeContext?.delegatedWork).toMatchObject({
      questionRequests: [
        { requestId: 'question-existing', sequence: 1 },
        { requestId: 'question-1', sequence: 2 },
        { requestId: 'question-2', sequence: 3 },
        { requestId: 'question-3', sequence: 4 }
      ]
    })
    expect(reloaded.runtimeContext?.delegatedWork?.questionRequestsQuarantine).toBeUndefined()
  })

  it('does not report a question admission when generated owner state fails sanitization', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'invalid-question-branch'
      },
      key
    )
    const ids = {
      frame: ['invalid-question-frame'],
      attempt: ['invalid-question-attempt'],
      message: ['invalid-question-message'],
      runtime: ['invalid-question-runtime'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    await work.delegate(
      {
        session: key,
        frameId: rootFrameId,
        role: 'main',
        originMessageId: rootPrompt.id,
        toolInvocationId: 'delegate-invalid-question-child'
      },
      { task: 'Try an invalid durable question', name: 'Invalid question child' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const snapshot = await records.snapshot()
    const child = snapshot.records[0]
    const attempt = child.attempts[0]
    const revisionBeforeAdmission = (await readSession()).runtimeContext?.revision

    await expect(
      records.admitQuestion({
        requestId: 'invalid-question',
        canonicalDigest: 'not-a-digest',
        sourceFrameId: child.frameId,
        sourceAttemptId: attempt.id,
        sourceRuntimeSegmentId: attempt.runtimeSegmentIds[0],
        sourceMessageBranchId: child.messageBranchId,
        rootOriginMessageId: child.originMessageId,
        rootBranchId: snapshot.rootBranchId,
        sourceName: child.title,
        questions: [{ question: 'Scope?', options: [{ label: 'One' }, { label: 'Two' }] }],
        askedAt: 100,
        status: 'pending',
        draftAnswers: [],
        draftQuestionIndex: 0
      })
    ).rejects.toThrow('invalid delegated question owner')
    const reloaded = await readSession()
    expect(reloaded.runtimeContext?.revision).toBe(revisionBeforeAdmission)
    expect(reloaded.runtimeContext?.delegatedWork?.questionRequests).toBeUndefined()
    expect(reloaded.runtimeContext?.delegatedWork?.questionRequestsQuarantine).toBeUndefined()
  })

  it('does not reject an already-committed mutation when its projection notifier throws', async () => {
    const { coordinator, readSession } = createHarness()
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'notifier-branch',
        onRecordsChanged: () => {
          throw new Error('renderer notification failed')
        }
      },
      key
    )

    await expect(
      records.admitChildren({
        caller: {
          session: key,
          frameId: createSession().conversationGraph!.rootFrameId,
          role: 'main',
          originMessageId: rootPrompt.id,
          toolInvocationId: 'notifier-test'
        },
        children: [
          {
            frameId: 'notifier-frame',
            attemptId: 'notifier-attempt',
            userMessageId: 'notifier-message',
            name: 'Persist despite notifier failure',
            request: {
              task: 'Persist despite notifier failure',
              name: 'Persist despite notifier failure',
              inputs: []
            },
            resolvedAgent: { kind: 'main' },
            startedAt: 10
          }
        ]
      })
    ).resolves.toEqual([
      expect.objectContaining({
        frameId: 'notifier-frame',
        name: 'Persist despite notifier failure'
      })
    ])
    await expect(records.snapshot()).resolves.toMatchObject({
      records: [{ frameId: 'notifier-frame' }]
    })
  })

  it('allows only one concurrent explicit sibling name across adapter instances and CAS retries', async () => {
    const { coordinator, readSession } = createHarness()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const firstExecution = createDeterministicDelegateExecution()
    const secondExecution = createDeterministicDelegateExecution()
    const firstRecords = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'concurrent-branch-1'
      },
      key
    )
    const secondRecords = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'concurrent-branch-2'
      },
      key
    )
    const rootCaller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'concurrent-1'
    }

    const outcomes = await Promise.allSettled([
      createDurableDelegatedWork({ execution: firstExecution, records: firstRecords }).delegate(
        rootCaller,
        { task: 'Trace sources', name: 'Trace sources' },
        { wait: false }
      ),
      createDurableDelegatedWork({ execution: secondExecution, records: secondRecords }).delegate(
        { ...rootCaller, toolInvocationId: 'concurrent-2' },
        { task: 'Trace sources', name: 'Trace sources' },
        { wait: false }
      )
    ])

    expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
      reason: { code: 'admission_rejection' }
    })
    expect(
      (await readSession()).conversationGraph?.frames
        .filter(({ kind }) => kind === 'delegate')
        .map(({ delegateName }) => delegateName)
        .sort()
    ).toEqual(['Trace sources'])
  })

  it('revalidates the latest active branch after a CAS retry and releases rejected capacity', async () => {
    const { coordinator, repository, readSession } = createHarness()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const alternatePrompt: PersistedChatMessage = {
      ...rootPrompt,
      id: 'alternate-prompt',
      content: 'Coordinate the alternate branch.',
      createdAt: 20,
      updatedAt: 20
    }
    let switchBeforeFirstCommit = true
    const commands = new Proxy(coordinator, {
      get(target, property, receiver) {
        if (property === 'createChildren') {
          return async (...args: Parameters<typeof coordinator.createChildren>) => {
            if (switchBeforeFirstCommit) {
              switchBeforeFirstCommit = false
              const switched = await readSession()
              const graph = switched.conversationGraph!
              const activeBranchId = 'alternate-root-branch'
              graph.frames.find(({ id }) => id === rootFrameId)!.activeBranchId = activeBranchId
              graph.branches.push({
                id: activeBranchId,
                agentFrameId: rootFrameId,
                headMessageId: alternatePrompt.id,
                createdAt: 20,
                updatedAt: 20
              })
              graph.messages.push({
                ...alternatePrompt,
                agentFrameId: rootFrameId,
                introducedOnBranchId: activeBranchId,
                revisionRootMessageId: alternatePrompt.id
              })
              switched.messages = [alternatePrompt]
              switched.runtimeContext = {
                version: 1,
                ...switched.runtimeContext,
                revision: (switched.runtimeContext?.revision ?? 0) + 1
              }
              await repository.saveSession(switched)
            }
            return target.createChildren(...args)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const records = createSessionDelegatedWorkRecords(
      { commands, readSession, frameworkId: 'codex', createId: () => 'cas-branch' },
      key
    )
    const execution = createDeterministicDelegateExecution(1)
    const work = createDurableDelegatedWork({ execution, records })
    const staleCaller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'stale-branch-delegate'
    }

    await expect(
      work.delegate(staleCaller, { task: 'Trace sources', name: 'Trace sources' }, { wait: false })
    ).rejects.toThrow(/current Branch|active root conversation/i)
    await expect(
      work.delegate(
        {
          ...staleCaller,
          originMessageId: alternatePrompt.id,
          toolInvocationId: 'current-branch-delegate'
        },
        { task: 'Trace sources', name: 'Trace sources' },
        { wait: false }
      )
    ).resolves.toMatchObject({ children: [{ name: 'Trace sources' }] })
    expect(execution.reservationCounts()).toEqual([1, 1])
    expect(
      (await readSession()).conversationGraph?.frames.filter(({ kind }) => kind === 'delegate')
    ).toHaveLength(1)
  })

  it('persists successful running-child delivery against the addressed Attempt', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'child-branch' },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1'],
      message: ['prompt-1', 'pending-1', 'prompt-2', 'answer-1'],
      runtime: ['runtime-1', 'runtime-2'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 50,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch'
    }
    await work.delegate(caller, { task: 'Initial task', name: 'Initial task' }, { wait: false })
    await expect
      .poll(async () => {
        const prompt = (await readSession()).conversationGraph?.messages.find(
          ({ id }) => id === 'prompt-1'
        )
        return prompt?.delegatedCallerSource
      })
      .toEqual({ rootMessageId: 'root-prompt', toolInvocationId: 'dispatch' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()

    await work.sendMessage(
      { ...caller, toolInvocationId: 'message-call' },
      'child-frame',
      'Additional evidence',
      { kind: 'info' }
    )

    await expect
      .poll(async () => (await readSession()).runtimeContext?.delegatedWork?.messageCommands)
      .toMatchObject([
        {
          sourceFrameId: rootFrameId,
          targetFrameId: 'child-frame',
          targetAttemptId: 'attempt-1',
          text: 'Additional evidence',
          kind: 'info',
          requestId: 'message-call',
          queuedAt: 50,
          receipt: { status: 'accepted' }
        }
      ])
    expect(execution.control('attempt-1').deliveredMessages()).toEqual(['Additional evidence'])
    await execution.control('attempt-1').completeTurn('Initial answer')
    await expect
      .poll(async () => {
        const durable = await readSession()
        return durable.conversationGraph?.messages.find(
          ({ delegatedCallerSource }) => delegatedCallerSource?.toolInvocationId === 'message-call'
        )
      })
      .toMatchObject({
        role: 'user',
        content: 'Additional evidence',
        delegatedCallerSource: {
          rootMessageId: 'root-prompt',
          toolInvocationId: 'message-call'
        },
        runtimeSegmentId: 'runtime-2'
      })
  })

  it('completes a queued child turn when a late tool replay arrives from the previous Runtime Segment', async () => {
    const { control, readSession, records } = await createLateReplayScenario()
    const replayedToolUpdate = createScopedToolUpdate('runtime-1', 'prompt-1', {
      id: 'tool-event',
      timestamp: 40,
      kind: 'tool',
      level: 'info',
      toolCallId: 'call-1',
      title: 'Inspect evidence',
      status: 'completed'
    })

    control.emit({ kind: 'runtime', update: replayedToolUpdate })
    await control.completeTurn('Initial answer')
    control.emit({ kind: 'runtime', update: replayedToolUpdate })
    control.complete('Final answer')

    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0])
      .toMatchObject({ status: 'completed' })
    expect((await records.snapshot()).records[0].attempts[0]).not.toHaveProperty('error')
    expect((await readSession()).conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:call-1',
        runtimeSegmentId: 'runtime-1',
        status: 'completed',
        eventIds: ['tool-event']
      })
    ])
  })

  it('stages terminal Activity Group members without persisting a dangling Group reference', async () => {
    const { readSession, records } = await createLateReplayScenario()

    await expect(
      records.stageTerminalActivities!(
        'child-frame',
        'attempt-1',
        'runtime-1',
        [
          {
            id: 'grouped-activity',
            kind: 'tool',
            title: 'Inspect grouped evidence',
            activityGroupId: 'group-1',
            promptMessageId: 'prompt-1',
            status: 'completed',
            sortIndex: 1,
            eventIds: ['grouped-event'],
            createdAt: 40,
            updatedAt: 41
          }
        ],
        [
          {
            id: 'group-1',
            title: 'Grouped inspection',
            sortIndex: 1,
            activityIds: ['grouped-activity'],
            promptMessageId: 'prompt-1',
            createdAt: 40,
            updatedAt: 41,
            completedAt: 41
          }
        ]
      )
    ).resolves.toBeUndefined()
    expect((await readSession()).conversationGraph).toMatchObject({
      activities: [expect.objectContaining({ id: 'grouped-activity', activityGroupId: 'group-1' })],
      activityGroups: [
        expect.objectContaining({ id: 'group-1', activityIds: ['grouped-activity'] })
      ]
    })
  })

  it('preserves a provider error when the active child turn follows a late tool replay', async () => {
    const { control, readSession, records } = await createLateReplayScenario()

    control.emit({ kind: 'runtime', update: createInitialToolUpdate() })
    await control.completeTurn('Initial answer')
    control.emit({ kind: 'runtime', update: createLateToolReplay() })
    control.emit({ kind: 'runtime', update: createActiveToolUpdate() })
    control.fail(new Error('provider failed'))

    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0])
      .toMatchObject({
        status: 'error',
        error: { code: 'execution_failure', message: 'provider failed' }
      })
    expect((await readSession()).conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:call-1',
        runtimeSegmentId: 'runtime-1',
        status: 'completed',
        eventIds: ['tool-one']
      }),
      expect.objectContaining({
        id: 'agent-runtime:runtime-2:call-2',
        runtimeSegmentId: 'runtime-2',
        status: 'failed',
        eventIds: ['tool-two']
      })
    ])
  })

  it('cancels the active child turn when it follows a late tool replay', async () => {
    const { caller, control, readSession, records, work } = await createLateReplayScenario()

    control.emit({ kind: 'runtime', update: createInitialToolUpdate() })
    await control.completeTurn('Initial answer')
    control.emit({ kind: 'runtime', update: createLateToolReplay() })
    control.emit({ kind: 'runtime', update: createActiveToolUpdate() })

    await expect(work.stopChildren(caller, ['child-frame'])).resolves.toEqual([
      { frameId: 'child-frame', status: 'cancelled' }
    ])
    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0])
      .toMatchObject({ status: 'cancelled', cancellationReason: 'main_agent_stop' })
    expect((await records.snapshot()).records[0].attempts[0]).not.toHaveProperty('error')
    expect((await readSession()).conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:call-1',
        runtimeSegmentId: 'runtime-1',
        status: 'completed',
        eventIds: ['tool-one']
      }),
      expect.objectContaining({
        id: 'agent-runtime:runtime-2:call-2',
        runtimeSegmentId: 'runtime-2',
        status: 'failed',
        eventIds: ['tool-two']
      })
    ])
  })

  it('preserves a queued child turn begin error after the previous Runtime Segment closes', async () => {
    const { control, readSession, records, repository } = await createLateReplayScenario()
    const beginError = new Error('pending turn storage unavailable')
    let markBeginSaveStarted!: () => void
    const beginSaveStarted = new Promise<void>((resolve) => {
      markBeginSaveStarted = resolve
    })
    let rejectBeginSave!: () => void
    const beginSaveRejection = new Promise<void>((resolve) => {
      rejectBeginSave = resolve
    })
    const persistSession = vi.mocked(repository.saveSession).getMockImplementation()!
    vi.mocked(repository.saveSession).mockImplementation(async (session) => {
      if (session.conversationGraph?.messages.some(({ id }) => id === 'prompt-2')) {
        markBeginSaveStarted()
        await beginSaveRejection
        throw beginError
      }
      return persistSession(session)
    })

    control.emit({ kind: 'runtime', update: createInitialToolUpdate() })

    const completingFirstTurn = control.completeTurn('Initial answer')
    await beginSaveStarted
    control.emit({ kind: 'runtime', update: createLateToolReplay() })
    rejectBeginSave()
    await expect(completingFirstTurn).rejects.toThrow(beginError)
    control.fail(beginError)

    await expect
      .poll(async () => (await records.snapshot()).records[0].attempts[0])
      .toMatchObject({
        status: 'error',
        error: { code: 'execution_failure', message: beginError.message }
      })
    expect((await readSession()).conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:call-1',
        runtimeSegmentId: 'runtime-1',
        status: 'completed',
        eventIds: ['tool-one']
      })
    ])
  })

  it('preserves a child turn completion storage error after its transcript is durable', async () => {
    const { coordinator, repository, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'child-branch' },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1'],
      message: ['prompt-1', 'answer-1', 'fallback-answer'],
      runtime: ['runtime-1'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 50,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch'
    }
    const completionError = new Error('child turn completion storage unavailable')
    let markCompletionSaveStarted!: () => void
    const completionSaveStarted = new Promise<void>((resolve) => {
      markCompletionSaveStarted = resolve
    })
    let rejectCompletionSave!: () => void
    const completionSaveRejection = new Promise<void>((resolve) => {
      rejectCompletionSave = resolve
    })
    let completionSaveRejected = false
    const persistSession = vi.mocked(repository.saveSession).getMockImplementation()!
    vi.mocked(repository.saveSession).mockImplementation(async (session) => {
      const attempt = session.runtimeContext?.delegatedWork?.records[0]?.attempts[0]
      const completingDurableTranscript =
        !completionSaveRejected &&
        attempt?.status === 'running' &&
        session.conversationGraph?.runtimeSegments.some(
          ({ id, endedAt }) => id === 'runtime-1' && endedAt !== undefined
        ) &&
        session.conversationGraph.activities.some(
          ({ id }) => id === 'agent-runtime:runtime-1:call-1'
        )
      if (completingDurableTranscript) {
        completionSaveRejected = true
        markCompletionSaveStarted()
        await completionSaveRejection
        throw completionError
      }
      return persistSession(session)
    })

    const delegated = work.delegate(caller, { task: 'Initial task', name: 'Initial task' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.control('attempt-1')
    control.accept()
    control.emit({ kind: 'runtime', update: createInitialToolUpdate() })

    control.complete('Initial answer')
    await completionSaveStarted
    control.emit({ kind: 'runtime', update: createLateToolReplay() })
    rejectCompletionSave()

    await expect(delegated).resolves.toMatchObject({
      kind: 'results',
      children: [
        {
          status: 'error',
          error: { code: 'execution_failure', message: completionError.message }
        }
      ]
    })
    expect((await readSession()).conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:runtime-1:call-1',
        runtimeSegmentId: 'runtime-1',
        status: 'completed',
        eventIds: ['tool-one']
      })
    ])
  })

  it('starts an admitted array against revisioned Session records without sibling conflicts', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    let nextBranch = 1
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `child-branch-${nextBranch++}`
      },
      key
    )
    const work = createDurableDelegatedWork({ execution, records })
    const batchCaller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'batch-tool-call'
    }

    const outcome = await work.delegate(
      batchCaller,
      [
        { task: 'First durable child', name: 'First durable child' },
        { task: 'Second durable child', name: 'Second durable child' }
      ],
      { wait: false }
    )

    expect(outcome.children).toHaveLength(2)
    await expect.poll(() => execution.controls()).toHaveLength(2)
    await expect(work.children(batchCaller)).resolves.toMatchObject([
      { title: 'First durable child', status: 'running' },
      { title: 'Second durable child', status: 'running' }
    ])
  })

  it('executes and projects one blocking child from the durable Session conversation', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'child-branch'
      },
      key
    )
    const workspaceInputs: string[][] = []
    let nextMessage = 1
    const work = createDurableDelegatedWork({
      execution,
      records,
      validateInput: (identity) => identity.startsWith('upload-version:'),
      workspace: {
        async prepare(_session, _frameId, inputs) {
          workspaceInputs.push([...inputs])
          return { cwd: '/stable-child-workspace' }
        }
      },
      createId: (kind) =>
        kind === 'message'
          ? `child-message-${nextMessage++}`
          : {
              frame: 'child-frame',
              attempt: 'child-attempt',
              runtime: 'child-runtime',
              question: 'child-question'
            }[kind]
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'tool-call-1'
    }

    const pending = work.delegate(caller, {
      task: 'Trace the source. Prefer primary evidence.',
      name: 'Trace source',
      inputs: ['upload-version:one']
    })

    await expect.poll(() => execution.controls()).toHaveLength(1)
    expect(execution.controls()[0].input).toMatchObject({
      task: 'Trace the source. Prefer primary evidence.',
      inputs: ['upload-version:one']
    })
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual({
      kind: 'main'
    })
    expect(workspaceInputs).toEqual([['upload-version:one']])
    execution.controls()[0].accept()
    execution.controls()[0].complete('Durable answer')

    expect(await pending).toMatchObject({
      kind: 'results',
      children: [{ status: 'completed', response: 'Durable answer', artifactsCreated: [] }]
    })
    await expect(work.readAgentFrame(key, 'child-frame')).resolves.toMatchObject({
      status: 'completed',
      messages: [
        { role: 'user', content: 'Trace the source. Prefer primary evidence.' },
        { role: 'assistant', content: 'Durable answer' }
      ]
    })
    const restored = normalizeSessionFile(await readSession())
    expect(
      restored?.conversationGraph?.messages.find(
        (message) => message.agentFrameId === 'child-frame' && message.role === 'user'
      )
    ).toMatchObject({
      delegatedTask: 'Trace the source. Prefer primary evidence.',
      delegatedInputVersionIds: ['upload-version:one']
    })
    expect(
      restored?.conversationGraph?.messages.find(
        (message) => message.agentFrameId === 'child-frame' && message.role === 'user'
      )
    ).not.toHaveProperty('delegatedContext')
  })

  it('persists rich terminal transcript evidence without writing each runtime chunk', async () => {
    const { coordinator, readSession, repository } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'child-branch'
      },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['child-attempt'],
      message: ['child-prompt', 'agent-message'],
      runtime: ['child-runtime'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 14,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'rich-transcript'
    }

    const pending = work.delegate(caller, { task: 'Inspect the paper', name: 'Inspect the paper' })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.accept()
    const scope = {
      projectId: 'project-1',
      sessionId: 'session-1',
      agentFrameId: 'child-frame',
      attemptId: 'child-attempt',
      runtimeSegmentId: 'child-runtime',
      promptMessageId: 'child-prompt'
    } as const
    control.emit({
      kind: 'runtime',
      update: {
        scope,
        event: {
          id: 'message:1',
          timestamp: 10,
          kind: 'message',
          level: 'info',
          messageId: 'response-1',
          role: 'assistant',
          text: 'Evidence '
        }
      }
    })
    control.emit({
      kind: 'runtime',
      update: {
        scope,
        event: {
          id: 'message:2',
          timestamp: 11,
          kind: 'message',
          level: 'info',
          messageId: 'response-1',
          role: 'assistant',
          text: 'confirmed.'
        }
      }
    })
    control.emit({
      kind: 'runtime',
      update: {
        scope,
        event: {
          id: 'tool:start',
          timestamp: 12,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          title: 'Read paper',
          status: 'in_progress'
        }
      }
    })
    control.emit({
      kind: 'runtime',
      update: {
        scope,
        event: {
          id: 'tool:done',
          timestamp: 13,
          kind: 'tool',
          level: 'info',
          toolCallId: 'tool-1',
          status: 'completed',
          terminalOutput: 'done',
          terminalExitCode: 0
        }
      }
    })
    control.complete(
      'Evidence confirmed.',
      {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      },
      [
        {
          id: 'agent-message:model-call:0',
          index: 0,
          inputTokens: 100,
          cacheTokens: 20,
          outputTokens: 30,
          contextUsedTokens: 120,
          contextWindowSize: 200_000
        }
      ]
    )
    await pending

    const durable = await readSession()
    expect(
      durable.conversationGraph?.messages.find(
        (message) => message.id === 'agent-message' && message.role === 'agent'
      )
    ).toMatchObject({
      content: 'Evidence confirmed.',
      eventIds: ['message:1', 'message:2'],
      turnUsage: {
        inputTokens: 100,
        cacheTokens: 20,
        outputTokens: 30,
        turnCount: 1
      },
      modelCallUsage: [
        {
          id: 'agent-message:model-call:0',
          index: 0,
          inputTokens: 100,
          cacheTokens: 20,
          outputTokens: 30,
          contextUsedTokens: 120,
          contextWindowSize: 200_000
        }
      ],
      completedAt: 14,
      updatedAt: 14
    })
    expect(durable.conversationGraph?.activities).toEqual([
      expect.objectContaining({
        id: 'agent-runtime:child-runtime:tool-1',
        agentFrameId: 'child-frame',
        runtimeSegmentId: 'child-runtime',
        promptMessageId: 'child-prompt',
        status: 'completed',
        eventIds: ['tool:start', 'tool:done'],
        terminalOutput: 'done',
        terminalExitCode: 0
      })
    ])
    expect(repository.saveSession).toHaveBeenCalled()
  })

  it('keeps partial Messages and tool evidence after a provider rejection and reload', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'error-branch' },
      key
    )
    const ids = {
      frame: ['error-frame'],
      attempt: ['error-attempt'],
      message: ['error-prompt', 'partial-agent-message'],
      runtime: ['error-runtime'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 20,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'provider-reject'
    }
    const pending = work.delegate(caller, {
      task: 'Read until failure',
      name: 'Read until failure'
    })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.accept()
    const scope = {
      projectId: 'project-1',
      sessionId: 'session-1',
      agentFrameId: 'error-frame',
      attemptId: 'error-attempt',
      runtimeSegmentId: 'error-runtime',
      promptMessageId: 'error-prompt'
    } as const
    const emit = (event: AcpAgentRuntimeUpdate['event']): void =>
      control.emit({ kind: 'runtime', update: { scope, event } })
    emit({
      id: 'partial',
      timestamp: 10,
      kind: 'message',
      level: 'info',
      messageId: 'partial-stream',
      role: 'assistant',
      text: 'Recovered partial evidence'
    })
    emit({
      id: 'done-tool',
      timestamp: 11,
      kind: 'tool',
      level: 'info',
      toolCallId: 'tool-done',
      title: 'Completed read',
      status: 'completed',
      terminalOutput: 'done'
    })
    emit({
      id: 'open-tool',
      timestamp: 12,
      kind: 'tool',
      level: 'info',
      toolCallId: 'tool-open',
      title: 'Interrupted read',
      status: 'in_progress'
    })
    control.fail(new Error('provider rejected'))
    await pending

    const reloaded = normalizeSessionFile(await readSession())!
    expect(reloaded.conversationGraph?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'partial-agent-message',
          content: 'Recovered partial evidence',
          status: 'error',
          failedAt: 20,
          updatedAt: 20
        })
      ])
    )
    expect(reloaded.conversationGraph?.activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-runtime:error-runtime:tool-done',
          status: 'completed'
        }),
        expect.objectContaining({ id: 'agent-runtime:error-runtime:tool-open', status: 'failed' })
      ])
    )
  })

  it('stages partial runtime evidence before an explicit cancellation becomes durable', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'cancel-branch' },
      key
    )
    const ids = {
      frame: ['cancel-frame'],
      attempt: ['cancel-attempt'],
      message: ['cancel-prompt', 'cancel-partial-message'],
      runtime: ['cancel-runtime'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      now: () => 30,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'cancel-runtime'
    }
    const dispatched = await work.delegate(
      caller,
      { task: 'Read until stopped', name: 'Read until stopped' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    const control = execution.controls()[0]
    control.accept()
    control.emit({
      kind: 'runtime',
      update: {
        scope: {
          projectId: 'project-1',
          sessionId: 'session-1',
          agentFrameId: 'cancel-frame',
          attemptId: 'cancel-attempt',
          runtimeSegmentId: 'cancel-runtime',
          promptMessageId: 'cancel-prompt'
        },
        event: {
          id: 'cancel-partial',
          timestamp: 25,
          kind: 'message',
          level: 'info',
          messageId: 'cancel-stream',
          role: 'assistant',
          text: 'Evidence before stop'
        }
      }
    })

    await expect(work.stopChildren(caller, [dispatched.children[0].frameId])).resolves.toEqual([
      { frameId: 'cancel-frame', status: 'cancelled' }
    ])

    const reloaded = normalizeSessionFile(await readSession())!
    expect(reloaded.conversationGraph?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cancel-partial-message',
          content: 'Evidence before stop',
          status: 'error',
          failedAt: 30
        })
      ])
    )
    expect(reloaded.runtimeContext?.delegatedWork?.records[0].attempts[0]).toMatchObject({
      status: 'cancelled',
      cancellationReason: 'main_agent_stop'
    })
  })

  it('persists and projects an inherited dispatch-time Specialist label independently of Session binding', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'specialist-branch'
      },
      key
    )
    const work = createDurableDelegatedWork({
      execution,
      records,
      resolveSpecialist: async (profileId) => ({
        id: profileId,
        name: 'SOURCE_AUDITOR',
        displayName: 'Source Auditor',
        enabled: true,
        setupPending: false,
        revision: 4
      }),
      createId: (kind) =>
        ({
          frame: 'specialist-frame',
          attempt: 'specialist-attempt',
          message: 'specialist-message',
          runtime: 'specialist-runtime',
          question: 'specialist-question'
        })[kind]
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      parentSpecialistId: 'stable-specialist-id',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'specialist-tool-call'
    }

    await work.delegate(caller, { task: 'Audit sources', name: 'Audit sources' }, { wait: false })

    const expected = {
      kind: 'specialist',
      profileId: 'stable-specialist-id',
      revision: 4,
      displayName: 'Source Auditor'
    }
    expect((await records.snapshot()).records[0].attempts[0].resolvedAgent).toEqual(expected)
    await expect(work.readAgentFrame(key, 'specialist-frame')).resolves.toMatchObject({
      resolvedAgent: expected
    })
    await expect(work.sessionSummary(key)).resolves.toEqual({
      runningCount: 1,
      children: [{ frameId: 'specialist-frame', title: 'Audit sources', status: 'running' }]
    })
    expect(
      (await readSession()).conversationGraph?.frames.find(
        (frame) => frame.id === 'specialist-frame'
      )?.agentName
    ).toBe('Source Auditor')
    await expect
      .poll(
        async () =>
          (await readSession()).conversationGraph?.runtimeSegments.find(
            (segment) => segment.id === 'specialist-runtime'
          )?.agentName
      )
      .toBe('Source Auditor')
  })

  it('rejects every unavailable profile reference atomically with a bounded safe Specialist-name list before durable admission', async () => {
    const profileStorage = await mkdtemp(join(tmpdir(), 'delegated-profile-admission-'))
    try {
      const builtin = (id: string): BuiltinSpecialistRegistryEntry => ({
        kind: 'builtin',
        readonly: true,
        id,
        version: '1.0.0',
        name: 'AMBIGUOUS',
        displayName: `Ambiguous ${id}`,
        description: `SECRET_DESCRIPTION_${id}`,
        systemPrompt: `SECRET_PROMPT_${id}`,
        enabled: true,
        capabilityMode: 'selected',
        fullAccess: emptyFullAccessConfig(),
        selectedCapabilities: emptySelectedConfig()
      })
      const profileRepository = new SpecialistRepository(profileStorage)
      const profiles = new SpecialistService(profileRepository, {
        load: async () => ({
          entries: [builtin('secret-builtin-id-a'), builtin('secret-builtin-id-b')],
          diagnostics: []
        })
      })
      for (let index = 0; index < 10; index += 1) {
        await profiles.create({
          name: `AVAILABLE_${String(index).padStart(2, '0')}`,
          description: `SECRET_DESCRIPTION_${index}`,
          systemPrompt: `SECRET_PROMPT_${index}`
        })
      }
      const disabled = await profiles.create({ name: 'DISABLED_PROFILE' })
      await profiles.setEnabled(disabled.id, false)
      await profileRepository.insert({
        id: 'secret-pending-id',
        name: 'PENDING_PROFILE',
        displayName: 'Pending Profile',
        description: 'SECRET_PENDING_DESCRIPTION',
        systemPrompt: 'SECRET_PENDING_PROMPT',
        enabled: false,
        setupPending: true,
        capabilityMode: 'selected',
        fullAccess: emptyFullAccessConfig(),
        selectedCapabilities: emptySelectedConfig(),
        revision: 1,
        packageVersion: '0.1.0',
        origin: 'imported',
        ownedSkillIds: []
      })

      const { coordinator, readSession } = createHarness()
      const execution = createDeterministicDelegateExecution()
      const rootFrameId = createSession().conversationGraph!.rootFrameId
      const records = createSessionDelegatedWorkRecords(
        { commands: coordinator, readSession, frameworkId: 'codex' },
        key
      )
      const work = createDurableDelegatedWork({
        execution,
        records,
        resolveSpecialist: (profileId) => profiles.resolveRunnableById(profileId),
        resolveSpecialistReference: (reference) => profiles.resolveRunnableByReference(reference)
      })
      const baseline = await readSession()
      const caller: AuthenticatedDelegateCaller = {
        session: key,
        frameId: rootFrameId,
        role: 'main',
        originMessageId: rootPrompt.id,
        toolInvocationId: 'unavailable-profile'
      }
      const available =
        'Available Specialists: AMBIGUOUS, AVAILABLE_00, AVAILABLE_01, AVAILABLE_02, AVAILABLE_03, AVAILABLE_04, AVAILABLE_05, AVAILABLE_06 (list truncated).'
      const cases = [
        { reference: 'UNKNOWN_PROFILE', reason: 'unknown' },
        { reference: 'AMBIGUOUS', reason: 'ambiguous' },
        { reference: disabled.id, reason: 'unavailable' },
        { reference: 'PENDING_PROFILE', reason: 'unavailable' }
      ] as const

      for (const [index, { reference, reason }] of cases.entries()) {
        const error = await work
          .delegate(
            { ...caller, toolInvocationId: `unavailable-profile-${index}` },
            { task: 'Must not persist', name: 'Must not persist', profile: reference },
            { wait: false }
          )
          .then(
            () => undefined,
            (failure: unknown) => failure
          )
        expect(error).toMatchObject({
          code: 'admission_rejection',
          message: `Requested Specialist is ${reason}. ${available}`
        })
        expect(String(error)).not.toMatch(
          /secret-builtin-id|secret-pending-id|SECRET_DESCRIPTION|SECRET_PROMPT/
        )
        expect(execution.reservationCounts()).toEqual([])
        expect(await readSession()).toEqual(baseline)
      }

      await expect(
        work.delegate(
          { ...caller, toolInvocationId: 'mixed-unavailable-profile' },
          [
            { task: 'Valid Main child', name: 'Valid Main child' },
            { task: 'Invalid child', name: 'Invalid child', profile: 'UNKNOWN_PROFILE' }
          ],
          { wait: false }
        )
      ).rejects.toMatchObject({ code: 'admission_rejection' })
      expect(execution.reservationCounts()).toEqual([])
      expect(await readSession()).toEqual(baseline)
    } finally {
      await rm(profileStorage, { recursive: true, force: true })
    }
  })

  it('preserves detached child identity, title, status, and collect result across Session reopen', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    let nextBranch = 1
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `child-branch-${nextBranch++}`
      },
      key
    )
    let nextMessage = 1
    const dispatchingWork = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) =>
        kind === 'message'
          ? `child-message-${nextMessage++}`
          : {
              frame: 'child-frame',
              attempt: 'child-attempt',
              runtime: 'child-runtime',
              question: 'child-question'
            }[kind]
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'detached-tool-call'
    }

    const receipt = await dispatchingWork.delegate(
      caller,
      {
        task: 'Detached trace',
        name: 'Stable trace',
        outputSchema: {
          type: 'object',
          required: ['answer'],
          properties: { answer: { type: 'number' } },
          additionalProperties: false
        }
      },
      { wait: false }
    )
    await expect(
      dispatchingWork.collect(caller, [receipt.children[0].frameId], { timeoutSeconds: 0 })
    ).resolves.toEqual([
      expect.not.objectContaining({ structuredOutputUnsatisfied: expect.anything() })
    ])
    await expect.poll(() => execution.controls()).toHaveLength(1)
    await dispatchingWork.submitOutput(
      {
        ...caller,
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId,
        role: 'delegate',
        toolInvocationId: 'submit-output'
      },
      { answer: 42 }
    )
    execution.controls()[0].accept()
    execution.controls()[0].complete('Persisted answer')
    await expect
      .poll(async () => (await dispatchingWork.children(caller))[0]?.status)
      .toBe('completed')

    const reopenedRecords = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex' },
      key
    )
    const reopenedWork = createDurableDelegatedWork({
      execution: createDeterministicDelegateExecution(),
      records: reopenedRecords
    })

    await expect(reopenedWork.children(caller)).resolves.toEqual([
      {
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId,
        title: 'Stable trace',
        name: 'Stable trace',
        agentName: 'Main Agent',
        status: 'completed'
      }
    ])
    await expect(
      reopenedWork.collect(caller, [
        {
          frameId: receipt.children[0].frameId,
          attemptId: receipt.children[0].attemptId
        },
        {
          frameId: receipt.children[0].frameId,
          attemptId: receipt.children[0].attemptId
        }
      ])
    ).resolves.toEqual([
      {
        frameId: receipt.children[0].frameId,
        attemptId: receipt.children[0].attemptId,
        name: 'Stable trace',
        agentName: 'Main Agent',
        status: 'completed',
        terminalMessageId: expect.any(String),
        response: 'Persisted answer',
        artifactsCreated: [],
        structuredOutput: { answer: 42 },
        structuredOutputUnsatisfied: false
      },
      expect.objectContaining({
        attemptId: receipt.children[0].attemptId,
        structuredOutput: { answer: 42 },
        structuredOutputUnsatisfied: false
      })
    ])
  })

  it('atomically appends a continuation Attempt and Message to the existing Frame branch', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    let nextBranch = 1
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => `child-branch-${nextBranch++}`
      },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1', 'attempt-2'],
      message: ['prompt-1', 'answer-1', 'prompt-2'],
      runtime: ['runtime-1', 'runtime-2'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch-call'
    }
    const dispatched = await work.delegate(
      caller,
      { task: 'Initial task', name: 'Initial task' },
      { wait: false }
    )
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()
    execution.control('attempt-1').complete('Initial answer')
    await expect.poll(async () => (await work.sessionSummary(key)).runningCount).toBe(0)
    const before = await readSession()
    const frameBefore = before.conversationGraph!.frames.find(({ id }) => id === 'child-frame')!

    await work.sendMessage(
      { ...caller, toolInvocationId: 'continuation-call' },
      dispatched.children[0].frameId,
      'Follow up in place'
    )

    const after = await readSession()
    const frameAfter = after.conversationGraph!.frames.find(({ id }) => id === 'child-frame')!
    expect(after.conversationGraph!.frames.filter(({ kind }) => kind === 'delegate')).toHaveLength(
      1
    )
    expect(frameAfter).toMatchObject({
      id: frameBefore.id,
      parentFrameId: frameBefore.parentFrameId,
      originMessageId: frameBefore.originMessageId,
      activeBranchId: frameBefore.activeBranchId,
      delegateName: frameBefore.delegateName,
      status: 'running'
    })
    expect(after.runtimeContext?.delegatedWork?.records[0].attempts).toMatchObject([
      {
        id: 'attempt-1',
        initiatingTurnMessageId: rootPrompt.id,
        status: 'completed',
        terminalMessageId: 'answer-1'
      },
      {
        id: 'attempt-2',
        initiatingTurnMessageId: rootPrompt.id,
        status: 'running',
        resolvedAgent: { kind: 'main' }
      }
    ])
    expect(
      after.conversationGraph!.messages.filter(({ agentFrameId }) => agentFrameId === 'child-frame')
    ).toMatchObject([
      {
        id: 'prompt-1',
        role: 'user',
        content: 'Initial task',
        delegatedCallerSource: {
          rootMessageId: 'root-prompt',
          toolInvocationId: 'dispatch-call'
        }
      },
      { id: 'answer-1', role: 'agent', content: 'Initial answer' },
      {
        id: 'prompt-2',
        role: 'user',
        content: 'Follow up in place',
        parentMessageId: 'answer-1',
        delegatedCallerSource: {
          rootMessageId: 'root-prompt',
          toolInvocationId: 'continuation-call'
        }
      }
    ])
  })

  it('reports a clear conflict when concurrent callers continue the same terminal Attempt', async () => {
    const { coordinator, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      {
        commands: coordinator,
        readSession,
        frameworkId: 'codex',
        createId: () => 'child-branch'
      },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1', 'attempt-2', 'attempt-3'],
      message: ['prompt-1', 'answer-1', 'prompt-2', 'prompt-3'],
      runtime: ['runtime-1', 'runtime-2', 'runtime-3'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch-call'
    }
    await work.delegate(caller, { task: 'Initial task', name: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()
    execution.control('attempt-1').complete('Initial answer')
    await expect.poll(async () => (await work.sessionSummary(key)).runningCount).toBe(0)

    const outcomes = await Promise.allSettled([
      work.sendMessage(
        { ...caller, toolInvocationId: 'continuation-a' },
        'child-frame',
        'First continuation'
      ),
      work.sendMessage(
        { ...caller, toolInvocationId: 'continuation-b' },
        'child-frame',
        'Competing continuation'
      )
    ])

    expect(outcomes.map(({ status }) => status).sort()).toEqual(['fulfilled', 'fulfilled'])
    expect((await records.snapshot()).records[0].attempts).toHaveLength(2)
    expect(
      (await records.snapshot()).messages.filter(
        ({ frameId, role }) => frameId === 'child-frame' && role === 'user'
      )
    ).toHaveLength(2)
    expect(execution.reservationCounts()).toEqual([1, 1])
  })

  it('publishes no running continuation when its atomic admission save fails', async () => {
    const { coordinator, repository, readSession } = createHarness()
    const execution = createDeterministicDelegateExecution()
    const rootFrameId = createSession().conversationGraph!.rootFrameId
    const records = createSessionDelegatedWorkRecords(
      { commands: coordinator, readSession, frameworkId: 'codex', createId: () => 'child-branch' },
      key
    )
    const ids = {
      frame: ['child-frame'],
      attempt: ['attempt-1', 'attempt-2'],
      message: ['prompt-1', 'answer-1', 'prompt-2'],
      runtime: ['runtime-1', 'runtime-2'],
      question: []
    }
    const work = createDurableDelegatedWork({
      execution,
      records,
      createId: (kind) => ids[kind].shift()!
    })
    const caller: AuthenticatedDelegateCaller = {
      session: key,
      frameId: rootFrameId,
      role: 'main',
      originMessageId: rootPrompt.id,
      toolInvocationId: 'dispatch-call'
    }
    await work.delegate(caller, { task: 'Initial task', name: 'Initial task' }, { wait: false })
    await expect.poll(() => execution.controls()).toHaveLength(1)
    execution.control('attempt-1').accept()
    execution.control('attempt-1').complete('Stable evidence')
    await expect.poll(async () => (await work.sessionSummary(key)).runningCount).toBe(0)
    const before = await readSession()
    vi.mocked(repository.saveSession).mockRejectedValueOnce(new Error('continuation save failed'))

    await expect(
      work.sendMessage(
        { ...caller, toolInvocationId: 'failed-continuation' },
        'child-frame',
        'Do not publish this message'
      )
    ).rejects.toThrow('continuation save failed')

    expect(await readSession()).toEqual(before)
    await expect(work.sessionSummary(key)).resolves.toMatchObject({
      runningCount: 0,
      children: [{ frameId: 'child-frame', status: 'completed' }]
    })
    expect(execution.controls()).toHaveLength(1)
  })
})

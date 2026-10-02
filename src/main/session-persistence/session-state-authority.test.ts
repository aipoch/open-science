import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import {
  materializeSessionConversationGraph,
  setTurnOutcome,
  SessionRevisionConflictError,
  type PersistedChatSession
} from '../../shared/session-persistence'
import { forkEditedConversationMessage } from '../../shared/conversation-graph'
import { SessionRepository } from './repository'
import { sanitizeRendererSaveSessionOptions } from './renderer-save-options'
import { SessionPersistenceStateOwner } from './state-owner'

const fixture = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 's',
    projectId: 'p',
    title: 'Research',
    cwd: '/workspace',
    status: 'idle',
    agentFrameworkId: 'codex',
    revision: 0,
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        id: 'prompt',
        role: 'user',
        content: 'Research',
        status: 'complete',
        eventIds: [],
        createdAt: 2,
        updatedAt: 2
      }
    ],
    ...overrides
  })

const createOwner = (
  repository: ConstructorParameters<typeof SessionPersistenceStateOwner>[0]['repository']
): SessionPersistenceStateOwner =>
  new SessionPersistenceStateOwner({
    repository,
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (initial?: PersistedChatSession) => {
  let durable = initial && structuredClone(initial)
  const owner = createOwner({
    loadSessionWithDiagnostics: async () =>
      durable ? { status: 'found', session: structuredClone(durable) } : { status: 'missing' },
    saveSession: async (candidate, expectedRevision) => {
      const actualRevision = durable?.revision ?? 0
      if (expectedRevision !== undefined && expectedRevision !== actualRevision)
        throw new SessionRevisionConflictError(expectedRevision ?? 0, actualRevision)
      durable = structuredClone({ ...candidate, revision: actualRevision + 1 })
      return structuredClone(durable)
    }
  })
  return { owner, durable: () => structuredClone(durable) }
}

const historicalState = {
  status: 'error' as const,
  error: 'Historical provider failure',
  errorReportable: false,
  resumeRecovery: {
    kind: 'resume-required' as const,
    cause: 'app-restart' as const,
    promptMessageId: 'old-prompt'
  }
}

describe('Main Session state authority before and after transcript adoption', () => {
  it.each(['running', 'error', 'waiting-permission', 'waiting-plan-approval'] as const)(
    'creates an idle Session when the first renderer save submits %s',
    async (status) => {
      const h = harness()
      const saved = await h.owner.saveSession(fixture({ ...historicalState, status }))

      expect(saved.status).toBe('idle')
      expect(saved.error).toBeUndefined()
      expect(saved.errorReportable).toBeUndefined()
      expect(saved.resumeRecovery).toBeUndefined()
      expect(saved.runtimeTranscriptOwner).toBeUndefined()
      expect(h.durable()).toEqual(saved)
    }
  )

  describe.each([undefined, 'main'] as const)('transcript owner %s', (runtimeTranscriptOwner) => {
    it('defers an optimistic fork without replacing the active Main state or graph', async () => {
      const seed = fixture({
        runtimeTranscriptOwner,
        status: 'running',
        activeRun: { promptMessageId: 'prompt', startedAt: 2 }
      })
      const h = harness(seed)
      const saved = await h.owner.saveSession(
        {
          ...seed,
          title: 'Renamed',
          status: 'idle',
          activeRun: undefined,
          conversationGraph: forkEditedConversationMessage(
            seed.conversationGraph!,
            'prompt',
            'edited-branch',
            10
          )
        },
        {
          conflictRebaseFields: ['title'],
          conversationCommands: [
            {
              id: 'fork',
              kind: 'fork-message',
              timestamp: 10,
              branchId: 'edited-branch',
              parentBranchId: seed.conversationGraph!.branches[0].id,
              messageId: 'prompt'
            }
          ]
        }
      )

      expect(saved).toMatchObject({
        title: 'Renamed',
        status: 'running',
        activeRun: seed.activeRun
      })
      expect(saved.conversationGraph?.branches).not.toContainEqual(
        expect.objectContaining({ id: 'edited-branch' })
      )
      expect(saved.conversationGraph?.messages).toEqual(seed.conversationGraph?.messages)
      expect(saved.runtimeConversationCommandIds ?? []).not.toContain('fork')
      expect(h.durable()).toEqual(saved)
    })

    it('rejects renderer state injection while accepting named preferences', async () => {
      const seed = fixture({ runtimeTranscriptOwner })
      const h = harness(seed)
      const saved = await h.owner.saveSession(
        { ...seed, ...historicalState, title: 'Renamed' },
        { conflictRebaseFields: ['title'] }
      )

      expect(saved.title).toBe('Renamed')
      expect(saved.status).toBe('idle')
      expect(saved.error).toBeUndefined()
      expect(saved.errorReportable).toBeUndefined()
      expect(saved.resumeRecovery).toBeUndefined()
      expect(saved.runtimeTranscriptOwner).toBe(runtimeTranscriptOwner)
      expect(h.durable()).toEqual(saved)
    })

    it.each(['clear', 'replace'] as const)(
      'preserves historical state against %s attempts',
      async (attempt) => {
        const seed = fixture({ ...historicalState, runtimeTranscriptOwner })
        const h = harness(seed)
        const submitted = {
          ...seed,
          title: 'Renamed',
          status: 'idle' as const,
          error: attempt === 'clear' ? undefined : 'Renderer operation failed',
          errorReportable: attempt === 'clear' ? undefined : true,
          resumeRecovery:
            attempt === 'clear'
              ? undefined
              : { ...historicalState.resumeRecovery, promptMessageId: 'other-prompt' }
        }
        const saved = await h.owner.saveSession(submitted, { conflictRebaseFields: ['title'] })

        expect(saved).toMatchObject({ ...historicalState, title: 'Renamed' })
        expect(h.durable()).toEqual(saved)
      }
    )

    it('admits a Task turn through the validated Main path', async () => {
      const seed = fixture({ ...historicalState, runtimeTranscriptOwner })
      const h = harness(seed)
      const admitted = await h.owner.admitTaskTurn({
        session: {
          ...seed,
          activeRun: { promptMessageId: 'prompt', startedAt: 10 },
          updatedAt: 10
        },
        contextReset: false
      })

      expect(admitted.status).toBe('running')
      expect(admitted.activeRun).toEqual({ promptMessageId: 'prompt', startedAt: 10 })
      expect(admitted.error).toBeUndefined()
      expect(admitted.resumeRecovery).toBeUndefined()
      expect(admitted.runtimeTranscriptOwner).toBe(runtimeTranscriptOwner)
      expect(h.durable()).toEqual(admitted)
    })
  })

  it.each([undefined, 'main'] as const)(
    'keeps Main-executed fork and start-run commands authoritative with owner %s',
    async (runtimeTranscriptOwner) => {
      const seed = fixture({ ...historicalState, runtimeTranscriptOwner })
      const h = harness(seed)
      const parentBranchId = seed.conversationGraph!.branches[0].id
      const forked = await h.owner.saveSession(seed, {
        conversationCommands: [
          {
            id: 'fork',
            kind: 'fork-message',
            timestamp: 10,
            branchId: 'edited-branch',
            parentBranchId,
            messageId: 'prompt'
          }
        ]
      })
      expect(forked.status).toBe('idle')
      expect(forked.error).toBeUndefined()
      expect(forked.errorReportable).toBeUndefined()

      const prompt = { ...seed.messages[0], id: 'next-prompt', createdAt: 11, updatedAt: 11 }
      const admitted = await h.owner.saveSession(forked, {
        conversationCommands: [
          {
            id: 'append',
            kind: 'append-user',
            timestamp: 11,
            branchId: 'edited-branch',
            message: prompt
          },
          {
            id: 'start',
            kind: 'start-run',
            timestamp: 12,
            run: { promptMessageId: prompt.id, startedAt: 12 }
          }
        ]
      })
      expect(admitted.status).toBe('running')
      expect(admitted.error).toBeUndefined()
      expect(admitted.errorReportable).toBeUndefined()
      expect(admitted.resumeRecovery).toBeUndefined()
      expect(admitted.activeRun).toEqual({ promptMessageId: prompt.id, startedAt: 12 })
      expect(admitted.runtimeTranscriptOwner).toBe(runtimeTranscriptOwner)
    }
  )

  it('does not accept private Main admission authority in renderer options', async () => {
    const seed = fixture()
    const h = harness(seed)
    const options = sanitizeRendererSaveSessionOptions({
      mainTurnAdmission: true,
      taskRunCommit: true,
      conflictRebaseFields: ['status', 'error', 'errorReportable', 'resumeRecovery', 'title']
    })
    expect(options).toEqual({ conflictRebaseFields: ['title'] })
    const saved = await h.owner.saveSession({ ...seed, ...historicalState }, options)
    expect(saved.status).toBe('idle')
    expect(saved.error).toBeUndefined()
    expect(saved.resumeRecovery).toBeUndefined()
  })

  it('rebases a stale preference save onto current unadopted Main state', async () => {
    const stale = fixture({ revision: 1 })
    const current = { ...stale, ...historicalState, revision: 2 }
    const h = harness(current)
    const saved = await h.owner.saveSession(
      { ...stale, title: 'Renamed' },
      { conflictRebaseFields: ['title'] }
    )

    expect(saved).toMatchObject({ ...historicalState, title: 'Renamed', revision: 3 })
    expect(saved.conversationGraph?.messages).toEqual(current.conversationGraph?.messages)
    expect(saved.conversationGraph?.branches[0].headMessageId).toBe('prompt')
    expect(h.durable()).toEqual(saved)
  })

  it('rejects stale unadopted transcript replacement without changing Main state', async () => {
    const stale = fixture({ revision: 1 })
    const current = fixture({ ...historicalState, revision: 2 })
    const h = harness(current)
    await expect(h.owner.saveSession(stale)).rejects.toBeInstanceOf(SessionRevisionConflictError)
    expect(h.durable()).toEqual(current)
  })

  it('reads legacy failures after reopening and preserves them through a renderer save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'session-state-authority-'))
    try {
      const repository = new SessionRepository(root)
      const legacyState = {
        ...historicalState,
        resumeRecovery: { ...historicalState.resumeRecovery, promptMessageId: 'prompt' }
      }
      await repository.saveSession(fixture(legacyState))
      const historical = await new SessionRepository(root).loadSession('p', 's')
      expect(historical).toMatchObject(legacyState)
      const owner = createOwner(repository)
      await owner.saveSession({
        ...historical!,
        status: 'idle',
        error: undefined,
        errorReportable: true,
        resumeRecovery: undefined
      })

      const reopened = await new SessionRepository(root).loadSession('p', 's')
      expect(reopened).toMatchObject(legacyState)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Main Turn Outcome authority', () => {
  it.each(['new', 'unadopted', 'adopted', 'imported'] as const)(
    'discards forged outcomes in both representations (%s)',
    async (kind) => {
      const original = {
        kind: 'failed' as const,
        settledAt: 2,
        error: 'Historical failure',
        errorReportable: false
      }
      const seed = setTurnOutcome(
        fixture({ runtimeTranscriptOwner: kind === 'adopted' ? 'main' : undefined }),
        'prompt',
        original
      )
      if (kind === 'imported')
        seed.packageOrigin = {
          importId: 'receipt',
          sourceProjectId: 'source',
          sourceSessionId: 'source-session',
          importedAt: 1,
          manifestChecksum: 'a'.repeat(64)
        }
      const h = harness(kind === 'new' ? undefined : seed)
      const submitted = setTurnOutcome(seed, 'prompt', { kind: 'completed', settledAt: 20 })
      const saved = await h.owner.saveSession(submitted)
      expect(saved.messages[0].turnOutcome).toEqual(kind === 'new' ? undefined : original)
      expect(saved.conversationGraph?.messages[0].turnOutcome).toEqual(
        kind === 'new' ? undefined : original
      )
      const deleted = setTurnOutcome(saved, 'prompt', undefined)
      const restored = await h.owner.saveSession(deleted)
      expect(restored.messages[0].turnOutcome).toEqual(saved.messages[0].turnOutcome)
    }
  )

  it.each([undefined, 'main'] as const)(
    'strips forged outcomes from append commands for owner %s',
    async (runtimeTranscriptOwner) => {
      const seed = fixture({ runtimeTranscriptOwner })
      const graph = seed.conversationGraph!
      const h = harness(seed)
      const next = {
        ...seed.messages[0],
        id: 'next',
        turnOutcome: { kind: 'failed' as const, settledAt: 4, error: 'Forged' }
      }
      const saved = await h.owner.saveSession(seed, {
        conversationCommands: [
          {
            kind: 'append-user',
            id: 'append-next',
            timestamp: 4,
            branchId: graph.branches[0].id,
            parentMessageId: graph.branches[0].headMessageId,
            message: next
          }
        ]
      })
      expect(
        saved.conversationGraph?.messages.find(({ id }) => id === 'next')?.turnOutcome
      ).toBeUndefined()
    }
  )

  it('records a rejected Plan as cancelled atomically while preserving its document identity', async () => {
    const plan = {
      artifactId: 'plan',
      artifactVersionId: 'version',
      artifactChecksum: 'a'.repeat(64),
      originatingPromptMessageId: 'prompt',
      approval: 'pending' as const,
      stepStatuses: {}
    }
    const h = harness(
      fixture({
        status: 'waiting-plan-approval',
        runtimeContext: { version: 1, revision: 1, plan }
      })
    )
    await h.owner.patchRuntimeContext({
      projectId: 'p',
      sessionId: 's',
      expectedRevision: 1,
      patch: { plan: { ...plan, approval: 'rejected' } }
    })
    const saved = h.durable()!
    expect(saved).toMatchObject({
      status: 'idle',
      resumeRecovery: { cause: 'cancelled', promptMessageId: 'prompt' },
      runtimeContext: { plan: { artifactVersionId: 'version', approval: 'rejected' } }
    })
    expect(saved.messages[0].turnOutcome).toMatchObject({ kind: 'cancelled', recovery: 'resume' })
    expect(saved.conversationGraph?.messages[0].turnOutcome).toEqual(saved.messages[0].turnOutcome)
  })

  it.each(['failed', 'app-restart'] as const)(
    'records a Main unadopted Task %s on its exact prompt',
    async (failure) => {
      const seed = fixture({
        status: 'running',
        activeRun: { promptMessageId: 'prompt', startedAt: 2 }
      })
      const h = harness(seed)
      const saved = await h.owner.failTaskRun({
        projectId: 'p',
        sessionId: 's',
        promptMessageId: 'prompt',
        taskRunCommitId: 'task',
        artifacts: [],
        error: 'Task failed',
        updatedAt: 4,
        ...(failure === 'app-restart' ? { interruptionCause: 'app-restart' as const } : {})
      })
      expect(saved.messages[0].turnOutcome).toMatchObject({
        kind: failure === 'app-restart' ? 'interrupted' : 'failed',
        error: 'Task failed'
      })
      expect(saved.conversationGraph?.messages[0].turnOutcome).toEqual(
        saved.messages[0].turnOutcome
      )
      if (failure === 'app-restart') expect(saved.resumeRecovery?.cause).toBe('app-restart')
    }
  )
})

it.each([undefined, 'main'] as const)(
  'persists preparation acknowledgements and prevents late snapshot resurrection (owner=%s)',
  async (runtimeTranscriptOwner) => {
    const root = await mkdtemp(join(tmpdir(), 'outcome-preparation-authority-'))
    try {
      const repository = new SessionRepository(root, {
        hasLiveRuntimeSession: () => true,
        hasActiveRuntimePrompt: () => true
      })
      const seed = setTurnOutcome(
        fixture({
          runtimeTranscriptOwner,
          status: 'error',
          error: 'Original failure',
          errorReportable: false,
          resumeRecovery: {
            kind: 'resume-required',
            cause: 'connection-lost',
            promptMessageId: 'prompt'
          },
          runtimeTranscriptLastRun: { promptMessageId: 'prompt', startedAt: 1 }
        }),
        'prompt',
        {
          kind: 'interrupted',
          cause: 'connection-lost',
          settledAt: 2,
          error: 'Original failure',
          errorReportable: false,
          recovery: 'resume'
        }
      )
      await repository.saveSession(seed)
      const authority = await repository.loadSessionWithDiagnostics('p', 's', {
        preserveRuntimeState: true
      })
      if (authority.status !== 'found') throw new Error('Expected fixture authority')
      const owner = createOwner(repository)
      const prepared = await owner.saveSession(authority.session, {
        conversationCommands: [
          {
            kind: 'prepare-prompt',
            id: 'preparation',
            timestamp: 3,
            promptMessageId: 'next',
            mode: 'new'
          }
        ]
      })
      expect(prepared.runtimeTranscriptOwner).toBe('main')
      expect(prepared.runtimeSessionAdmissions).toBeUndefined()
      const graph = prepared.conversationGraph!
      const commands = [
        {
          kind: 'append-user' as const,
          id: 'append',
          timestamp: 4,
          preparationId: 'preparation',
          branchId: graph.branches[0].id,
          parentMessageId: graph.branches[0].headMessageId,
          message: { ...prepared.messages[0], id: 'next', turnOutcome: undefined }
        },
        {
          kind: 'start-run' as const,
          id: 'start',
          timestamp: 5,
          preparationId: 'preparation',
          run: { promptMessageId: 'next', startedAt: 5 }
        }
      ]
      const optimistic = await owner.saveSession(prepared, { conversationCommands: commands })
      const rolledBack = await owner.saveSession(optimistic, {
        conversationCommands: [
          { kind: 'rollback-prompt', id: 'rollback', timestamp: 6, preparationId: 'preparation' }
        ]
      })
      expect(rolledBack.runtimeTranscriptLastRun).toEqual(
        authority.session.runtimeTranscriptLastRun
      )
      expect(rolledBack.error).toBe('Original failure')
      expect(rolledBack.messages.map(({ id }) => id)).toEqual(['prompt'])
      const late = await owner.saveSession(optimistic)
      const replay = await owner.saveSession(optimistic, { conversationCommands: commands })
      for (const saved of [late, replay]) {
        expect(saved.messages.map(({ id }) => id)).toEqual(['prompt'])
        expect(saved.runtimeConversationCommandIds).toEqual(
          expect.arrayContaining(['preparation', 'append', 'start', 'rollback'])
        )
        expect(saved.runtimeSessionAdmissions).toBeUndefined()
        expect(saved.runtimeTranscriptLastRun).toEqual(authority.session.runtimeTranscriptLastRun)
        expect(saved.messages[0].turnOutcome).toEqual(authority.session.messages[0].turnOutcome)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

it.each(['waiting-permission', 'waiting-for-user', 'waiting-plan-approval'] as const)(
  'does not assign a Task terminal outcome to Main %s authority',
  async (status) => {
    const seed = fixture({ status })
    const reply = {
      ...seed.messages[0],
      id: 'answer',
      role: 'agent' as const,
      responseToMessageId: 'prompt'
    }
    seed.messages.push(reply)
    seed.conversationGraph = undefined
    const h = harness(seed)
    const settled = await h.owner.settleTaskCompletion({
      projectId: 'p',
      sessionId: 's',
      promptMessageId: 'prompt',
      messageId: 'answer',
      taskRunCommitId: 'task',
      artifacts: [],
      updatedAt: 4
    })
    expect(settled.status).toBe(status)
    expect(settled.messages[0].turnOutcome).toBeUndefined()
  }
)

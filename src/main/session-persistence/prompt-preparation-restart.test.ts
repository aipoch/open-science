import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
import {
  materializeSessionConversationGraph,
  normalizeSessionFile,
  setTurnOutcome,
  type PersistedChatSession,
  type PersistedPromptPreparation
} from '../../shared/session-persistence'
import type { SessionConversationCommand } from '../../shared/session-conversation-command'
import { initDataRoot } from '../storage-root'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import { SessionPersistenceStateOwner } from './state-owner'
import { RuntimeSessionOwner } from './runtime-session-owner'
import { SessionPersistenceCoordinator } from './coordinator'
import { createForkSession } from '../session-package/fork-session'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const stateOwner = (repository: SessionRepository): SessionPersistenceStateOwner =>
  new SessionPersistenceStateOwner({
    repository,
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })

const harness = async (
  mode: PersistedPromptPreparation['mode'] = 'new',
  owner?: 'main',
  useCoordinator = false,
  caller?: AbortSignal
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
) => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-preparation-restart-'))
  roots.push(root)
  initDataRoot(root)
  const repository = new SessionRepository(root)
  const main = useCoordinator ? coordinator(repository) : stateOwner(repository)
  const initial = await repository.saveSession(
    setTurnOutcome(
      materializeSessionConversationGraph({
        id: 's',
        projectId: 'p',
        title: 'Research',
        cwd: '/workspace',
        agentFrameworkId: 'codex',
        runtimeTranscriptOwner: owner,
        status: mode === 'rearm' ? 'idle' : 'error',
        error: mode === 'rearm' ? undefined : 'Original interruption',
        errorReportable: mode === 'rearm' ? undefined : false,
        resumeRecovery:
          mode === 'rearm'
            ? undefined
            : {
                kind: 'resume-required',
                promptMessageId: 'old',
                cause: 'connection-lost'
              },
        runtimeTranscriptLastRun: { promptMessageId: 'old', startedAt: 1 },
        messages: [
          {
            id: 'old',
            role: 'user',
            content: 'Earlier question',
            status: 'complete',
            eventIds: [],
            createdAt: 1,
            updatedAt: 1
          }
        ],
        artifacts: [{ id: 'history', kind: 'managed-file', path: '/historical/result.txt' }],
        createdAt: 1,
        updatedAt: 2
      }),
      'old',
      mode === 'rearm'
        ? { kind: 'completed', settledAt: 2 }
        : {
            kind: 'interrupted',
            cause: 'connection-lost',
            settledAt: 2,
            error: 'Original interruption',
            recovery: 'resume'
          }
    )
  )
  const promptMessageId = mode === 'new' ? 'new' : 'old'
  const commands: SessionConversationCommand[] = [
    { kind: 'prepare-prompt', id: 'prepare', promptMessageId, mode, timestamp: 10 }
  ]
  if (mode === 'new')
    commands.push({
      kind: 'append-user',
      id: 'append',
      preparationId: 'prepare',
      timestamp: 11,
      branchId: initial.conversationGraph!.frames[0].activeBranchId,
      parentMessageId: 'old',
      message: {
        id: 'new',
        role: 'user',
        content: 'Saved but not admitted',
        status: 'complete',
        eventIds: [],
        createdAt: 11,
        updatedAt: 11
      }
    })
  commands.push({
    kind: mode === 'resume' ? 'resume-run' : 'start-run',
    id: 'start',
    preparationId: 'prepare',
    timestamp: 12,
    run: { promptMessageId, startedAt: 12 }
  })
  const submitted =
    useCoordinator && mode === 'new'
      ? {
          ...initial,
          messages: [
            ...initial.messages,
            (commands[1] as Extract<SessionConversationCommand, { kind: 'append-user' }>).message
          ]
        }
      : initial
  const prepared = await main.saveSession(
    submitted,
    { conversationCommands: commands },
    caller ? { taskRunCommit: false, callerSignal: caller } : undefined
  )
  const graph = prepared.conversationGraph!
  const scope = {
    projectId: 'p',
    sessionId: 's',
    promptMessageId,
    executionId: 'execution-new',
    agentFrameId: graph.activeFrameId,
    messageBranchId: graph.frames[0].activeBranchId,
    runtimeSegmentId: graph.runtimeSegments[0].id
  }
  const raw = async (): Promise<PersistedChatSession> => {
    const loaded = await loadSessionMutationAuthority(repository, 'p', 's')
    if (loaded.status !== 'found') throw new Error('Expected durable Session')
    return loaded.session
  }
  return { root, repository, main, initial, prepared, scope, raw }
}

const coordinator = (repository: SessionRepository): SessionPersistenceCoordinator =>
  new SessionPersistenceCoordinator(repository, {
    syncSession: vi.fn(async () => []),
    softDeleteSession: vi.fn(async () => 'delete'),
    restoreSession: vi.fn(async () => undefined),
    softDeleteProject: vi.fn(async () => 'delete'),
    reconcileProjectSessions: vi.fn(async () => undefined),
    reconcileActiveSessions: vi.fn(async () => undefined),
    markReconciliationIncomplete: vi.fn()
  })

it('keeps Main display evidence authoritative over renderer-submitted baseline claims', async () => {
  const h = await harness('new', 'main')
  const expected = (await h.raw()).promptPreparation
  expect(expected?.noticeBaseline?.promptMessageId).toBe('old')
  await h.main.saveSession({
    ...h.prepared,
    promptPreparation: {
      ...h.prepared.promptPreparation!,
      noticeBaseline: {
        messageBranchId: h.prepared.conversationGraph!.frames[0].activeBranchId,
        promptMessageId: 'new',
        state: { status: 'error', error: 'Forged renderer display state' }
      }
    }
  })
  expect((await h.raw()).promptPreparation).toEqual(expected)
})

it.each(['new', 'resume', 'rearm'] as const)(
  'keeps a live %s preparation across catalog refresh and admits it after refresh',
  async (mode) => {
    const h = await harness(mode, 'main', true)
    if (!(h.main instanceof SessionPersistenceCoordinator)) throw new Error('Expected coordinator')
    const durablePreparation = (await h.raw()).promptPreparation
    for (let index = 0; index < 2; index += 1) {
      const refreshed = await h.main.loadAll()
      expect(refreshed.diagnostics?.isComplete).not.toBe(false)
      expect(refreshed.sessions.find(({ id }) => id === 's')).toMatchObject({
        activeRun: h.prepared.activeRun,
        promptPreparation: durablePreparation
      })
      expect((await h.raw()).promptPreparation).toEqual(durablePreparation)
      await h.main.prepareRuntimeResume(h.scope.projectId, h.scope.sessionId)
      expect((await h.raw()).activeRun).toEqual(h.prepared.activeRun)
    }
    const main = h.main
    const runtime = new RuntimeSessionOwner({
      loadSession: () => main.loadSessionForContinuation('p', 's'),
      mutateSession: (scope, mutate) => main.mutateRuntimeSession(scope, mutate),
      finalizeArtifacts: vi.fn(async () => []),
      scheduleFlush: () => () => undefined
    })
    await runtime.begin(h.scope)
    const admitted = await h.raw()
    expect(admitted.promptPreparation).toBeUndefined()
    expect(admitted.runtimeSessionAdmissions).toEqual([
      expect.objectContaining({ executionId: h.scope.executionId })
    ])
  }
)

it.each(['new', 'resume', 'rearm'] as const)(
  'recovers only the prior-process %s preparation during repeated catalog refresh',
  async (mode) => {
    const h = await harness(mode, 'main', true)
    const reopened = coordinator(new SessionRepository(h.root))
    const first = await reopened.loadAll()
    const recovered = first.sessions.find(({ id }) => id === 's')!
    expect(recovered.activeRun).toBeUndefined()
    expect(recovered.promptPreparation).toBeUndefined()
    expect(recovered.status).toBe(mode === 'new' ? 'idle' : h.initial.status)
    expect(recovered.resumeRecovery).toEqual(mode === 'new' ? undefined : h.initial.resumeRecovery)
    expect(recovered.messages).toEqual(h.prepared.messages)
    const second = await reopened.loadAll()
    expect(second.sessions.find(({ id }) => id === 's')).toEqual(recovered)
    expect((await h.raw()).promptPreparation).toBeUndefined()
  }
)

it.each([undefined, 'main'] as const)(
  'retains an unadmitted saved prompt without inventing restart outcome (prior owner=%s)',
  async (owner) => {
    const h = await harness('new', owner)
    expect((await h.raw()).promptPreparation).toMatchObject({
      id: 'prepare',
      mode: 'new',
      runStartedAt: 12
    })
    const reopened = new SessionRepository(h.root)
    await stateOwner(reopened).prepareRuntimeResume({ projectId: 'p', sessionId: 's' })
    const recovered = (await reopened.loadSession('p', 's'))!
    expect(recovered.promptPreparation).toBeUndefined()
    expect(recovered.status).toBe('idle')
    expect(recovered.activeRun).toBeUndefined()
    expect(recovered.error).toBeUndefined()
    expect(recovered.resumeRecovery).toBeUndefined()
    expect(recovered.runtimeTranscriptLastRun).toEqual(h.prepared.runtimeTranscriptLastRun)
    expect(recovered.messages.map(({ id }) => id)).toEqual(['old', 'new'])
    expect(recovered.messages[1].turnOutcome).toBeUndefined()
    expect(recovered.messages[1].interrupted).toBeUndefined()
    expect(recovered.messages[0].turnOutcome).toEqual(h.initial.messages[0].turnOutcome)
    expect(recovered.artifacts?.map(({ id, path }) => ({ id, path }))).toEqual(
      h.initial.artifacts?.map(({ id, path }) => ({ id, path }))
    )
  }
)

it.each(['resume', 'rearm'] as const)(
  'restores the prior settled result for a never-admitted %s attempt',
  async (mode) => {
    const h = await harness(mode, 'main')
    const graph = h.prepared.conversationGraph!
    await h.repository.saveSession({
      ...h.prepared,
      runtimeSessionAdmissions: [
        {
          ...h.scope,
          executionId: 'historical-execution',
          rootFrameId: graph.rootFrameId,
          promptRuntimeSegmentId: h.scope.runtimeSegmentId
        }
      ]
    })
    const reopened = new SessionRepository(h.root)
    await stateOwner(reopened).prepareRuntimeResume({ projectId: 'p', sessionId: 's' })
    const recovered = (await reopened.loadSession('p', 's'))!
    expect(recovered.promptPreparation).toBeUndefined()
    expect(recovered.activeRun).toBeUndefined()
    expect(recovered.status).toBe(h.initial.status)
    expect(recovered.error).toBe(h.initial.error)
    expect(recovered.resumeRecovery).toEqual(h.initial.resumeRecovery)
    expect(recovered.messages[0].turnOutcome).toEqual(h.initial.messages[0].turnOutcome)
    expect(recovered.messages[0].interrupted).toBe(mode === 'resume' ? true : undefined)
    expect(recovered.runtimeSessionAdmissions?.map(({ executionId }) => executionId)).toEqual([
      'historical-execution'
    ])
  }
)

it.each(['new', 'resume', 'rearm'] as const)(
  'atomically clears preparation when Main admits the %s execution',
  async (mode) => {
    const h = await harness(mode, 'main')
    const runtime = new RuntimeSessionOwner({
      loadSession: () => h.raw(),
      mutateSession: (scope, mutate) => h.main.mutateRuntimeSession(scope, mutate),
      finalizeArtifacts: vi.fn(async () => []),
      scheduleFlush: () => () => undefined
    })
    await runtime.begin(h.scope)
    const admitted = await h.raw()
    expect(admitted.promptPreparation).toBeUndefined()
    expect(admitted.runtimeSessionAdmissions?.map(({ executionId }) => executionId)).toEqual([
      'execution-new'
    ])
    const reopened = new SessionRepository(h.root)
    await stateOwner(reopened).prepareRuntimeResume({ projectId: 'p', sessionId: 's' })
    const recovered = (await reopened.loadSession('p', 's'))!
    expect(
      recovered.messages.find(({ id }) => id === h.scope.promptMessageId)?.turnOutcome
    ).toMatchObject({ kind: 'interrupted', cause: 'app-restart' })
  }
)

it('persists rollback removal and rejects renderer marker forgery or deletion', async () => {
  const h = await harness('new', 'main')
  const marker = h.prepared.promptPreparation
  const stale = await h.main.saveSession({
    ...h.prepared,
    promptPreparation: { ...marker!, id: 'forged', runStartedAt: 999 }
  })
  expect(stale.promptPreparation).toEqual(marker)
  const omitted = await h.main.saveSession({ ...stale, promptPreparation: undefined })
  expect(omitted.promptPreparation).toEqual(marker)
  await h.main.saveSession(omitted, {
    conversationCommands: [
      { kind: 'rollback-prompt', id: 'rollback', preparationId: 'prepare', timestamp: 15 }
    ]
  })
  const reopened = (await new SessionRepository(h.root).loadSession('p', 's'))!
  expect(reopened.promptPreparation).toBeUndefined()
  expect(reopened.messages).toEqual(h.initial.messages)
  const fresh = await h.main.saveSession({
    ...h.initial,
    id: 'new-session',
    revision: undefined,
    promptPreparation: marker
  })
  expect(fresh.promptPreparation).toBeUndefined()
})

it.each(['new', 'resume', 'rearm'] as const)(
  'clears the durable preparation atomically on validated Main Task admission (%s)',
  async (mode) => {
    const h = await harness(mode, 'main', true)
    const admitted = await h.main.admitTaskTurn({ session: h.prepared, contextReset: false })
    expect(admitted.promptPreparation).toBeUndefined()
    expect((await h.raw()).promptPreparation).toBeUndefined()
    expect((await h.raw()).activeRun).toEqual(h.prepared.activeRun)
    expect(admitted.messages.map(({ id }) => id)).toEqual(h.prepared.messages.map(({ id }) => id))
  }
)

it.each(['interrupted', 'cancelled', 'failed'] as const)(
  'preserves prior %s state when preparation has not appended a new prompt',
  async (kind) => {
    const h = await harness('new', 'main')
    const rolledBack = await h.main.saveSession(h.prepared, {
      conversationCommands: [
        { kind: 'rollback-prompt', id: 'rollback', preparationId: 'prepare', timestamp: 15 }
      ]
    })
    const prior = await h.main.mutateRuntimeSession(h.scope, () =>
      setTurnOutcome(
        {
          ...rolledBack,
          status: kind === 'cancelled' ? 'idle' : 'error',
          error: kind === 'failed' ? 'Earlier provider failure' : undefined,
          resumeRecovery:
            kind === 'failed'
              ? undefined
              : {
                  kind: 'resume-required',
                  promptMessageId: 'old',
                  cause: kind === 'cancelled' ? 'cancelled' : 'connection-lost'
                }
        },
        'old',
        kind === 'failed'
          ? { kind, settledAt: 2, error: 'Earlier provider failure' }
          : kind === 'cancelled'
            ? { kind, settledAt: 2, recovery: 'resume' }
            : { kind, settledAt: 2, recovery: 'resume', cause: 'connection-lost' }
      )
    )
    await h.main.saveSession(prior, {
      conversationCommands: [
        {
          kind: 'prepare-prompt',
          id: 'future-preparation',
          promptMessageId: 'future',
          mode: 'new',
          timestamp: 16
        }
      ]
    })
    expect((await h.raw()).promptPreparation?.runStartedAt).toBeUndefined()
    expect((await h.raw()).activeRun).toBeUndefined()
    const reopened = coordinator(new SessionRepository(h.root))
    const recovered = (await reopened.loadAll()).sessions.find(({ id }) => id === 's')!
    expect(recovered.promptPreparation).toBeUndefined()
    expect(recovered.status).toBe(prior.status)
    expect(recovered.messages).toEqual(prior.messages)
    expect(recovered.error).toEqual(prior.error)
    expect(recovered.resumeRecovery).toEqual(prior.resumeRecovery)
  }
)

it('preserves concurrent Main state while releasing only the prepared run', async () => {
  const h = await harness('new', 'main')
  await h.main.mutateRuntimeSession(h.scope, (latest) => ({
    ...latest,
    error: 'Independent Main fact',
    errorReportable: false,
    title: 'Concurrent rename'
  }))
  await stateOwner(new SessionRepository(h.root)).prepareRuntimeResume({
    projectId: 'p',
    sessionId: 's'
  })
  const saved = await h.raw()
  expect(saved.activeRun).toBeUndefined()
  expect(saved.error).toBe('Independent Main fact')
  expect(saved.errorReportable).toBe(false)
  expect(saved.title).toBe('Concurrent rename')
  expect(saved.messages[1].turnOutcome).toBeUndefined()
})

it.each([
  { sessionId: 'different' },
  { projectId: 'different' },
  { runStartedAt: 999 },
  { runStartedAt: undefined },
  { preparedAt: -1 },
  { previousState: { status: 'unknown' } }
])(
  'rejects malformed or nonmatching preparation without swallowing actual restart recovery: %j',
  async (invalid) => {
    const h = await harness('new', 'main')
    const decoded = normalizeSessionFile({
      ...h.prepared,
      promptPreparation: { ...h.prepared.promptPreparation, ...invalid }
    })!
    expect(decoded.promptPreparation).toBeUndefined()
    expect(decoded.resumeRecovery?.cause).toBe('app-restart')
  }
)

it('never transfers preparation ownership to copied research', async () => {
  const h = await harness('new', 'main')
  expect(createForkSession(h.prepared, h.prepared, 'ask', 'Copy').promptPreparation).toBeUndefined()
  expect(normalizeSessionFile({ ...h.prepared, id: 'copied' })?.promptPreparation).toBeUndefined()
})

// A renderer that reloads or crashes after prepare-prompt but before sendPrompt reaches Main takes
// its preparation id with it. The receipt must follow that caller's lease, not the app process.
const nextPrompt = (
  h: Awaited<ReturnType<typeof harness>>,
  id: string
): { session: PersistedChatSession; commands: SessionConversationCommand[] } => {
  const graph = h.prepared.conversationGraph!
  const message = {
    id,
    role: 'user' as const,
    content: 'Next question',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 30,
    updatedAt: 30
  }
  return {
    session: { ...h.prepared, messages: [...h.prepared.messages, message] },
    commands: [
      {
        kind: 'prepare-prompt',
        id: `prepare-${id}`,
        promptMessageId: id,
        mode: 'new',
        timestamp: 29
      },
      {
        kind: 'append-user',
        id: `append-${id}`,
        preparationId: `prepare-${id}`,
        timestamp: 30,
        branchId: graph.frames[0].activeBranchId,
        parentMessageId: 'new',
        message
      },
      {
        kind: 'start-run',
        id: `start-${id}`,
        preparationId: `prepare-${id}`,
        timestamp: 31,
        run: { promptMessageId: id, startedAt: 31 }
      }
    ]
  }
}

it('releases an unadmitted preparation when its caller lease ends without inventing an outcome', async () => {
  const callerA = new AbortController()
  const h = await harness('new', 'main', true, callerA.signal)
  if (!(h.main instanceof SessionPersistenceCoordinator)) throw new Error('Expected coordinator')
  await h.main.mutateRuntimeSession(h.scope, (latest) => ({
    ...latest,
    error: 'Independent Main fact',
    errorReportable: false,
    title: 'Concurrent rename'
  }))
  callerA.abort()
  await vi.waitFor(async () => expect((await h.raw()).promptPreparation).toBeUndefined())
  const released = await h.raw()
  expect(released.activeRun).toBeUndefined()
  expect(released.title).toBe('Concurrent rename')
  expect(released.error).toBe('Independent Main fact')
  expect(released.resumeRecovery).toBeUndefined()
  expect(released.runtimeTranscriptLastRun).toEqual(h.prepared.runtimeTranscriptLastRun)
  expect(released.messages.map(({ id }) => id)).toEqual(['old', 'new'])
  expect(released.messages[1].turnOutcome).toBeUndefined()
  expect(released.messages[1].interrupted).toBeUndefined()
  expect(released.messages[0].turnOutcome).toEqual(h.initial.messages[0].turnOutcome)
  expect(released.artifacts?.map(({ id }) => id)).toEqual(['history'])

  const callerB = new AbortController()
  const next = nextPrompt(h, 'next')
  const prepared = await h.main.saveSession(
    next.session,
    { conversationCommands: next.commands },
    { taskRunCommit: false, callerSignal: callerB.signal }
  )
  expect(prepared.promptPreparation).toMatchObject({ id: 'prepare-next', runStartedAt: 31 })
  expect(prepared.messages.map(({ id }) => id)).toEqual(['old', 'new', 'next'])
})

it('keeps a preparation whose caller lease is still alive', async () => {
  const callerA = new AbortController()
  const h = await harness('new', 'main', true, callerA.signal)
  if (!(h.main instanceof SessionPersistenceCoordinator)) throw new Error('Expected coordinator')
  const next = nextPrompt(h, 'next')
  await expect(
    h.main.saveSession(
      next.session,
      { conversationCommands: next.commands },
      { taskRunCommit: false, callerSignal: new AbortController().signal }
    )
  ).rejects.toThrow(/Conversation Branch changed/)
  const durable = await h.raw()
  expect(durable.promptPreparation).toEqual(h.prepared.promptPreparation)
  expect(durable.activeRun).toEqual(h.prepared.activeRun)
})

it('never releases a preparation that Main already admitted', async () => {
  const callerA = new AbortController()
  const h = await harness('new', 'main', true, callerA.signal)
  if (!(h.main instanceof SessionPersistenceCoordinator)) throw new Error('Expected coordinator')
  const main = h.main
  const runtime = new RuntimeSessionOwner({
    loadSession: () => main.loadSessionForContinuation('p', 's'),
    mutateSession: (scope, mutate) => main.mutateRuntimeSession(scope, mutate),
    finalizeArtifacts: vi.fn(async () => []),
    scheduleFlush: () => () => undefined
  })
  await runtime.begin(h.scope)
  const admitted = await h.raw()
  callerA.abort()
  await main.mutateRuntimeSession(h.scope, (latest) => latest)
  const after = await h.raw()
  expect(after.activeRun).toEqual(admitted.activeRun)
  expect(after.runtimeSessionAdmissions).toEqual(admitted.runtimeSessionAdmissions)
  expect(after.messages.map(({ id }) => id)).toEqual(['old', 'new'])
})

it('releases only the receipts owned by the caller that went away', async () => {
  const callerA = new AbortController()
  const callerB = new AbortController()
  const h = await harness('new', 'main', true, callerA.signal)
  if (!(h.main instanceof SessionPersistenceCoordinator)) throw new Error('Expected coordinator')
  const other = await h.repository.saveSession({
    ...h.initial,
    id: 'other',
    revision: undefined
  })
  const otherGraph = other.conversationGraph!
  const otherPrepared = await h.main.saveSession(
    other,
    {
      conversationCommands: [
        {
          kind: 'prepare-prompt',
          id: 'prepare-b',
          promptMessageId: 'old',
          mode: 'resume',
          timestamp: 20
        },
        {
          kind: 'resume-run',
          id: 'resume-b',
          preparationId: 'prepare-b',
          timestamp: 21,
          run: { promptMessageId: 'old', startedAt: 21 }
        }
      ]
    },
    { taskRunCommit: false, callerSignal: callerB.signal }
  )
  expect(otherGraph.messages.length).toBeGreaterThan(0)
  callerA.abort()
  await vi.waitFor(async () => expect((await h.raw()).promptPreparation).toBeUndefined())
  const loaded = await loadSessionMutationAuthority(h.repository, 'p', 'other')
  if (loaded.status !== 'found') throw new Error('Expected durable Session')
  expect(loaded.session.promptPreparation).toEqual(otherPrepared.promptPreparation)
  expect(loaded.session.activeRun).toEqual(otherPrepared.activeRun)
  callerB.abort()
  await vi.waitFor(async () => {
    const latest = await loadSessionMutationAuthority(h.repository, 'p', 'other')
    if (latest.status !== 'found') throw new Error('Expected durable Session')
    expect(latest.session.promptPreparation).toBeUndefined()
  })
})

it('rejects a prepare-prompt whose caller lease already ended', async () => {
  const callerA = new AbortController()
  callerA.abort()
  await expect(harness('new', 'main', true, callerA.signal)).rejects.toThrow(
    /Caller lease is no longer current/
  )
})

it('loads a future-version file as found and still rolls back its preparation on restart', async () => {
  const h = await harness('new', 'main')
  const file = join(h.root, 'sessions', 'p', 's.json')
  const raw = JSON.parse(await readFile(file, 'utf8')) as {
    session: {
      messages: { id: string; turnOutcome?: Record<string, unknown> }[]
      conversationGraph: { messages: { id: string; turnOutcome?: Record<string, unknown> }[] }
      promptPreparation: Record<string, unknown> & { expectedState: object }
    }
  }
  for (const message of [...raw.session.messages, ...raw.session.conversationGraph.messages])
    if (message.id === 'old' && message.turnOutcome) message.turnOutcome.futureField = 1
  raw.session.promptPreparation.futureTop = true
  raw.session.promptPreparation.expectedState = {
    ...raw.session.promptPreparation.expectedState,
    futureState: 1
  }
  await writeFile(file, JSON.stringify(raw))

  const reopened = new SessionRepository(h.root)
  const loaded = await loadSessionMutationAuthority(reopened, 'p', 's')
  expect(loaded.status).toBe('found')
  await stateOwner(reopened).prepareRuntimeResume({ projectId: 'p', sessionId: 's' })
  const recovered = (await reopened.loadSession('p', 's'))!
  expect(recovered.promptPreparation).toBeUndefined()
  expect(recovered.status).toBe('idle')
  expect(recovered.resumeRecovery).toBeUndefined()
  expect(recovered.messages[1].turnOutcome).toBeUndefined()
  expect(recovered.messages[0].turnOutcome).toEqual(h.initial.messages[0].turnOutcome)
})

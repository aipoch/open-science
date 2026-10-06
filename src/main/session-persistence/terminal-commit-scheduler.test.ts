import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import type { AcpRuntimeEvent } from '../../shared/acp'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { initDataRoot } from '../storage-root'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { loadSessionMutationAuthority, SessionRepository } from './repository'
import {
  RuntimeSessionOwner,
  TERMINAL_ADMISSION_WAIT_BUDGET_MS,
  TERMINAL_COMMIT_INITIAL_BUDGET_MS,
  TERMINAL_COMMIT_RETRY_BUDGET_MS
} from './runtime-session-owner'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

const fileIndex = (): SessionFileIndex => ({
  syncSession: vi.fn(async () => []),
  softDeleteSession: vi.fn(async () => 'unused-session-deletion'),
  restoreSession: vi.fn(async () => undefined),
  softDeleteProject: vi.fn(async () => 'unused-project-deletion'),
  reconcileProjectSessions: vi.fn(async () => undefined),
  reconcileActiveSessions: vi.fn(async () => undefined),
  markReconciliationIncomplete: vi.fn()
})

// Preserve concrete fixture signatures for the gated physical repository-write assertions.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-commit-scheduler-'))
  roots.push(root)
  initDataRoot(root)
  const repository = new SessionRepository(root, {
    hasLiveRuntimeSession: () => true,
    hasActiveRuntimePrompt: () => true
  })
  const initial = await repository.saveSession(
    materializeSessionConversationGraph({
      id: 'session',
      projectId: 'project',
      title: 'Research',
      cwd: '/workspace',
      status: 'running',
      agentFrameworkId: 'codex',
      activeRun: { promptMessageId: 'prompt', startedAt: 1 },
      messages: [
        {
          id: 'prompt',
          role: 'user',
          content: 'Research',
          status: 'complete',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      createdAt: 1,
      updatedAt: 1
    })
  )
  const graph = initial.conversationGraph!
  const scope = {
    projectId: initial.projectId,
    sessionId: initial.id,
    promptMessageId: 'prompt',
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    executionId: 'execution-1'
  }
  const coordinator = new SessionPersistenceCoordinator(repository, fileIndex())
  const owner = new RuntimeSessionOwner({
    loadSession: (identity) =>
      coordinator.loadSessionForContinuation(identity.projectId, identity.sessionId),
    mutateSession: (identity, mutate) => coordinator.mutateRuntimeSession(identity, mutate),
    finalizeArtifacts: async () => [],
    onTerminalCommitExhausted: (_scope, event, retry, waitForWriteRelease) =>
      coordinator.recordRuntimeTerminalFailure(event, retry, waitForWriteRelease),
    scheduleFlush: () => () => undefined,
    now: () => 10
  })
  await owner.begin(scope)
  const event: AcpRuntimeEvent = {
    id: 'terminal-1',
    timestamp: 20,
    sessionId: scope.sessionId,
    promptMessageId: scope.promptMessageId,
    promptExecutionId: scope.executionId,
    kind: 'stop',
    level: 'info',
    text: 'end_turn'
  }
  const nextScope = { ...scope, promptMessageId: 'next', executionId: 'execution-2' }
  const nextAdmission = {
    applicationPrompt: {
      text: 'Next question',
      attribution: {
        kind: 'application' as const,
        feature: 'background-results' as const,
        purpose: 'agent-result-delivery' as const,
        deliveryKey: 'next',
        deliveryIds: ['local-run:next']
      }
    }
  }
  return {
    repository,
    coordinator,
    owner,
    scope,
    event,
    nextScope,
    nextAdmission,
    read: () => loadSessionMutationAuthority(repository, scope.projectId, scope.sessionId)
  }
}

describe('terminal recovery through the real Session persistence scheduler', () => {
  it('bounds a follow-up behind a timed-out physical write without admitting it after rejection', async () => {
    const h = await harness()
    vi.useFakeTimers()
    const physicalWrite = deferred()
    const enteredWrite = deferred()
    const save = h.repository.saveSession.bind(h.repository)
    const saveSpy = vi
      .spyOn(h.repository, 'saveSession')
      .mockImplementationOnce(async (...args) => {
        enteredWrite.resolve()
        await physicalWrite.promise
        return save(...args)
      })
    const publish = vi.fn()
    let initialSettled = false
    const initial = h.owner.commitTerminal(h.event, publish).then(() => {
      initialSettled = true
    })
    await enteredWrite.promise
    // Unexpected close releases its ACP lease synchronously, before this initial deadline.
    // Admission must observe the in-flight terminal batch before terminalCommit exists.
    expect(initialSettled).toBe(false)
    const followUp = h.owner.begin(h.nextScope, h.nextAdmission).then(
      (session) => ({ status: 'admitted' as const, session }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    )

    await vi.advanceTimersByTimeAsync(TERMINAL_COMMIT_INITIAL_BUDGET_MS)
    await initial
    h.owner.retryTerminalCommits(h.scope.sessionId)
    await vi.advanceTimersByTimeAsync(
      TERMINAL_ADMISSION_WAIT_BUDGET_MS - TERMINAL_COMMIT_INITIAL_BUDGET_MS
    )
    // Check settlement without awaiting an unresolved regression indefinitely.
    const unsettled = Symbol('unsettled')
    const result = await Promise.race([followUp, Promise.resolve(unsettled)])
    expect(result).not.toBe(unsettled)
    expect(result).toMatchObject({
      status: 'rejected',
      error: { message: 'Main runtime completion has not committed yet.' }
    })
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ interruptionCause: 'terminal-commit-failed' })
    )

    const beforeSave = await h.read()
    if (beforeSave.status !== 'found') throw new Error('Expected durable Session authority.')
    const blockedSave = h.coordinator
      .saveSession(
        { ...beforeSave.session, title: 'Timed-out preference', updatedAt: 30 },
        { conflictRebaseFields: ['title'] }
      )
      .then(
        (session) => ({ status: 'saved' as const, session }),
        (error: unknown) => ({ status: 'rejected' as const, error })
      )
    await vi.advanceTimersByTimeAsync(
      TERMINAL_COMMIT_INITIAL_BUDGET_MS + TERMINAL_COMMIT_RETRY_BUDGET_MS
    )
    const saveResult = await Promise.race([blockedSave, Promise.resolve(unsettled)])
    expect(saveResult).not.toBe(unsettled)
    expect(saveResult).toMatchObject({
      status: 'rejected',
      error: { message: 'Main runtime completion has not committed yet.' }
    })

    physicalWrite.resolve()
    await h.owner.flush(h.scope.sessionId, h.scope.promptMessageId)
    const recovered = await h.read()
    expect(recovered.status).toBe('found')
    if (recovered.status !== 'found') throw new Error('Expected durable Session authority.')
    expect(recovered.session.title).toBe('Research')
    expect(recovered.session.conversationGraph?.messages.some(({ id }) => id === 'next')).toBe(
      false
    )
    expect(
      recovered.session.runtimeSessionAdmissions?.map(({ executionId }) => executionId)
    ).toEqual(['execution-1'])

    const admitted = await h.owner.begin(h.nextScope, h.nextAdmission)
    expect(admitted.activeRun?.promptMessageId).toBe('next')
    expect(admitted.runtimeSessionAdmissions?.map(({ executionId }) => executionId)).toEqual([
      'execution-1',
      'execution-2'
    ])
    const writesAfterAdmission = saveSpy.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    await h.owner.retryTerminalCommitNow(
      h.scope.sessionId,
      h.scope.promptMessageId,
      h.scope.executionId
    )
    expect(saveSpy).toHaveBeenCalledTimes(writesAfterAdmission)
    const latest = await h.read()
    expect(latest.status === 'found' && latest.session.activeRun?.promptMessageId).toBe('next')
  })

  it('admits a follow-up after a fast terminal write rejection before detached retries start', async () => {
    const h = await harness()
    vi.useFakeTimers()
    h.owner.accept({
      id: 'response-chunk',
      timestamp: 15,
      sessionId: h.scope.sessionId,
      promptMessageId: h.scope.promptMessageId,
      promptExecutionId: h.scope.executionId,
      kind: 'message',
      level: 'info',
      messageId: 'response',
      role: 'assistant',
      text: 'Earlier result'
    })
    vi.spyOn(h.repository, 'saveSession').mockRejectedValueOnce(
      new Error('Temporary write failure')
    )
    const publish = vi.fn()
    await h.owner.commitTerminal(h.event, publish)
    expect(publish).not.toHaveBeenCalled()

    const admitted = await h.owner.begin(h.nextScope, h.nextAdmission)
    expect(admitted.activeRun?.promptMessageId).toBe('next')
    expect(admitted.messages.find(({ content }) => content === 'Earlier result')?.status).toBe(
      'complete'
    )
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: h.event.id, kind: 'stop', publicationOwner: 'main' })
    )
    h.owner.retryTerminalCommits(h.scope.sessionId)
    await vi.runAllTimersAsync()
    const latest = await h.read()
    expect(latest.status === 'found' && latest.session.activeRun?.promptMessageId).toBe('next')
  })
})

it.each([false, true])(
  'retries the exact exhausted terminal write authority before prompt preparation (persistentFailure=%s)',
  async (persistentFailure) => {
    const h = await harness()
    vi.useFakeTimers()
    let storageUnavailable = true
    const save = h.repository.saveSession.bind(h.repository)
    vi.spyOn(h.repository, 'saveSession').mockImplementation(async (...args) => {
      if (storageUnavailable) {
        throw new Error('Temporary write failure')
      }
      return save(...args)
    })
    const published = vi.fn()
    await h.owner.commitTerminal(h.event, published)
    h.owner.retryTerminalCommits(h.scope.sessionId)
    await vi.runAllTimersAsync()
    expect(h.coordinator.listRuntimeTerminalFailures()).toHaveLength(1)
    const authority = await h.read()
    if (authority.status !== 'found') throw new Error('Expected raw authority')
    const prepare = (): ReturnType<typeof h.coordinator.saveSession> =>
      h.coordinator.saveSession(h.coordinator.projectRuntimeSession(authority.session), {
        conversationCommands: [
          {
            kind: 'prepare-prompt',
            id: 'next-preparation',
            promptMessageId: 'next',
            mode: 'new',
            timestamp: 30
          }
        ]
      })
    if (persistentFailure) {
      // Real repository I/O must settle before advancing the fake terminal deadline.
      await expect(prepare()).rejects.toMatchObject({ message: 'Temporary write failure' })
      const unchanged = await h.read()
      if (unchanged.status !== 'found') throw new Error('Expected retained authority')
      expect(unchanged.session.activeRun).toEqual(authority.session.activeRun)
      expect(unchanged.session.runtimeConversationCommandIds ?? []).not.toContain(
        'next-preparation'
      )
      expect(h.coordinator.listRuntimeTerminalFailures()).toHaveLength(1)
    }
    storageUnavailable = false
    const prepared = await prepare()
    expect(prepared.activeRun).toBeUndefined()
    expect(h.coordinator.listRuntimeTerminalFailures()).toHaveLength(0)
    expect(published).toHaveBeenCalledWith(
      expect.objectContaining({ id: h.event.id, kind: 'stop', publicationOwner: 'main' })
    )
    const graph = prepared.conversationGraph!
    const next = {
      ...prepared.messages[0],
      id: 'next',
      content: 'Follow-up',
      turnOutcome: undefined,
      interrupted: undefined,
      createdAt: 31,
      updatedAt: 31
    }
    await h.coordinator.saveSession(
      { ...prepared, messages: [...prepared.messages, next], conversationGraph: undefined },
      {
        conversationCommands: [
          {
            kind: 'append-user',
            id: 'append-next',
            timestamp: 31,
            preparationId: 'next-preparation',
            branchId: graph.branches[0].id,
            parentMessageId: graph.branches[0].headMessageId,
            message: next
          },
          {
            kind: 'start-run',
            id: 'start-next',
            timestamp: 32,
            preparationId: 'next-preparation',
            run: { promptMessageId: 'next', startedAt: 32 }
          }
        ]
      }
    )
    const admitted = await h.owner.begin(h.nextScope)
    expect(admitted.activeRun?.promptMessageId).toBe('next')
    expect(admitted.runtimeSessionAdmissions?.map(({ executionId }) => executionId)).toEqual([
      'execution-1',
      'execution-2'
    ])
    await h.owner.retryTerminalCommitNow(
      h.scope.sessionId,
      h.scope.promptMessageId,
      h.scope.executionId
    )
    const latest = await h.read()
    expect(latest.status === 'found' && latest.session.activeRun?.promptMessageId).toBe('next')
  }
)

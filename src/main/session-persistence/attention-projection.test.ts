import { SessionProjectionAfterCommitError } from './save-session'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))
import type { AcpRuntimeEvent } from '../../shared/acp'
import {
  materializeSessionConversationGraph,
  setTurnOutcome,
  SessionSizeLimitError,
  type PersistedChatSession,
  type SessionSummary
} from '../../shared/session-persistence'
import { SessionRepository } from './repository'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { buildSessionProjection } from './projection'
import { initDataRoot } from '../storage-root'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fileIndex = (): SessionFileIndex => ({
  syncSession: vi.fn(async () => []),
  softDeleteSession: vi.fn(async () => 'deleted'),
  restoreSession: vi.fn(async () => undefined),
  softDeleteProject: vi.fn(async () => 'deleted'),
  reconcileProjectSessions: vi.fn(async () => undefined),
  reconcileActiveSessions: vi.fn(async () => undefined),
  markReconciliationIncomplete: vi.fn()
})
const fixture = (status: PersistedChatSession['status'] = 'idle'): PersistedChatSession =>
  materializeSessionConversationGraph({
    id: 'session',
    projectId: 'project',
    title: 'Research',
    cwd: '/workspace',
    status,
    createdAt: 1,
    updatedAt: 2,
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
    ]
  })
const summary = (session: PersistedChatSession): SessionSummary => ({
  id: session.id,
  projectId: session.projectId,
  title: session.title,
  number: 1,
  status: session.status,
  presentedStatus: session.status,
  pinned: false,
  revision: session.revision ?? 0,
  activeMessageCount: session.messages.length,
  artifactCount: 0,
  filesRevision: 0,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  needsStartupRecovery: false
})
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = async (status: PersistedChatSession['status'] = 'idle') => {
  const root = await mkdtemp(join(tmpdir(), 'session-attention-'))
  roots.push(root)
  initDataRoot(root)
  const repository = new SessionRepository(root, {
    hasLiveRuntimeSession: () => true,
    hasActiveRuntimePrompt: () => true
  })
  const seed = fixture(status)
  if (status === 'running') {
    seed.activeRun = { promptMessageId: 'prompt', startedAt: 1 }
    seed.runtimeTranscriptOwner = 'main'
  }
  const graph = seed.conversationGraph!
  const scope = {
    projectId: 'project',
    sessionId: 'session',
    promptMessageId: 'prompt',
    executionId: 'execution',
    agentFrameId: graph.rootFrameId,
    messageBranchId: graph.branches[0].id,
    runtimeSegmentId: graph.runtimeSegments[0].id,
    startedAt: 1
  }
  if (status === 'running')
    seed.runtimeSessionAdmissions = [
      { ...scope, rootFrameId: graph.rootFrameId, promptRuntimeSegmentId: scope.runtimeSegmentId }
    ]
  const durable = await repository.saveSession(seed)
  const publish = vi.fn()
  const coordinator = new SessionPersistenceCoordinator(
    repository,
    fileIndex(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    publish
  )
  const event: AcpRuntimeEvent = {
    id: 'terminal',
    kind: 'error',
    level: 'error',
    timestamp: 3,
    sessionId: 'session',
    promptMessageId: 'prompt',
    terminalCommitFailure: 'storage',
    interruptionCause: 'terminal-commit-failed',
    terminalScope: scope
  }
  return { root, repository, durable, coordinator, publish, event }
}

describe('Main Session Attention facts', () => {
  it('records a Session size limit problem from an actual write rejection, retains it across reads, and clears only the exact committed record', async () => {
    const h = await harness()
    const save = vi
      .spyOn(h.repository, 'saveSession')
      .mockRejectedValueOnce(new SessionSizeLimitError())
    await expect(h.coordinator.saveSession({ ...h.durable, title: 'Too large' })).rejects.toThrow(
      'persistence limit'
    )
    expect(h.coordinator.projectRuntimeSession(h.durable).recordProblems).toEqual(['size-limit'])
    await h.coordinator.readSessionSnapshot('project', 'session')
    await h.coordinator.loadAll()
    expect(h.coordinator.listSessionRecordProblems('project', 'session')).toEqual(['size-limit'])
    const summaries = await h.coordinator.projectRuntimeSessionSummaries([summary(h.durable)])
    expect(summaries[0]).toMatchObject({ presentedStatus: 'error', recordProblems: ['size-limit'] })
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ recordProblems: ['size-limit'] }),
      'runtime-transcript'
    )
    await h.coordinator.saveSession({ ...fixture(), id: 'other' })
    expect(h.coordinator.listSessionRecordProblems('project', 'session')).toEqual(['size-limit'])
    await h.coordinator.saveSession({
      ...h.durable,
      title: 'Fits',
      recordProblems: ['missing-record', 'conversation-graph-sync']
    })
    expect(h.coordinator.listSessionRecordProblems('project', 'session')).toEqual([])
    expect(h.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordProblems: [] }),
      'runtime-transcript'
    )
    expect(save.mock.calls.at(-1)?.[0]).not.toHaveProperty('recordProblems')
    expect(
      JSON.parse(await readFile(join(h.root, 'sessions', 'project', 'session.json'), 'utf8'))
        .session
    ).not.toHaveProperty('recordProblems')
  })

  it('clears a size fact when JSON committed despite a derived catalog error', async () => {
    const h = await harness()
    const actualSave = h.repository.saveSession.bind(h.repository)
    const save = vi
      .spyOn(h.repository, 'saveSession')
      .mockRejectedValueOnce(new SessionSizeLimitError())
    await expect(h.coordinator.saveSession(h.durable)).rejects.toThrow('persistence limit')
    expect(h.coordinator.listSessionRecordProblems('project', 'session')).toEqual(['size-limit'])
    save.mockImplementationOnce(async (...args) => {
      const committed = await actualSave(...args)
      throw new SessionProjectionAfterCommitError(committed, new Error('catalog unavailable'))
    })
    await expect(
      h.coordinator.saveSession({ ...h.durable, title: 'Durable replacement' })
    ).rejects.toBeInstanceOf(SessionProjectionAfterCommitError)
    expect(h.coordinator.listSessionRecordProblems('project', 'session')).toEqual([])
    expect((await h.repository.loadSession('project', 'session'))?.title).toBe(
      'Durable replacement'
    )
  })

  it('does not clear a missing Session record problem on reads or a wrong exact Retry identity', async () => {
    const h = await harness('running')
    const retry = vi.fn(async () => undefined)
    h.coordinator.recordRuntimeTerminalFailure(
      { ...h.event, terminalCommitFailure: 'missing-record' },
      retry
    )
    await h.coordinator.retryRuntimeTerminalCommit({
      projectId: 'project',
      sessionId: 'session',
      promptMessageId: 'prompt',
      executionId: 'wrong'
    })
    await h.coordinator.readSessionSnapshot('project', 'session')
    expect(retry).not.toHaveBeenCalled()
    expect(h.coordinator.projectRuntimeSession(h.durable).recordProblems).toEqual([
      'missing-record'
    ])
    expect(
      (await h.coordinator.projectRuntimeSessionSummaries([summary(h.durable)]))[0]
    ).toMatchObject({ presentedStatus: 'error', recordProblems: ['missing-record'] })
  })

  it('retries the retained original terminal outside the scheduler before export reserves durable history', async () => {
    const h = await harness('running')
    const retry = vi.fn(async () => {
      await h.coordinator.mutateRuntimeSession(
        { projectId: 'project', sessionId: 'session' },
        (current) => {
          const settled = setTurnOutcome(current, 'prompt', { kind: 'completed', settledAt: 3 })
          return { ...settled, activeRun: undefined, status: 'idle', updatedAt: 3 }
        }
      )
    })
    h.coordinator.recordRuntimeTerminalFailure(h.event, retry)
    const live = h.coordinator.projectRuntimeSession(h.durable)
    expect(buildSessionProjection(live).summary.presentedStatus).toBe('idle')
    expect(
      (await h.coordinator.projectRuntimeSessionSummaries([summary(h.durable)]))[0].presentedStatus
    ).toBe('idle')
    const release = await h.coordinator.reserveSessionExport('project', 'session')
    expect(retry).toHaveBeenCalledOnce()
    expect(h.coordinator.listRuntimeTerminalFailures()).toEqual([])
    const stored = await h.repository.loadSession('project', 'session')
    expect(stored?.messages[0].turnOutcome?.kind).toBe('completed')
    expect(stored?.status).toBe('idle')
    release()
  })

  it('returns the original operation error and leaves no export reservation when the retained commit still fails', async () => {
    const h = await harness('running')
    const retry = vi.fn<() => Promise<void>>(async () => {
      throw new Error('disk unavailable')
    })
    h.coordinator.recordRuntimeTerminalFailure(h.event, retry)
    await expect(h.coordinator.reserveSessionExport('project', 'session')).rejects.toThrow(
      'disk unavailable'
    )
    expect((await h.repository.loadSession('project', 'session'))?.status).toBe('running')
    expect(h.coordinator.listRuntimeTerminalFailures()).toHaveLength(1)
    expect(h.coordinator.projectRuntimeSession(h.durable).recordProblems).toEqual([])
    retry.mockImplementationOnce(async () => {
      await h.coordinator.mutateRuntimeSession(
        { projectId: 'project', sessionId: 'session' },
        (current) => ({ ...current, status: 'idle', activeRun: undefined })
      )
    })
    const release = await h.coordinator.reserveSessionExport('project', 'session')
    release()
  })

  it.each([
    [{ kind: 'failed', settledAt: 3 }, 'error'],
    [{ kind: 'cancelled', settledAt: 3, recovery: 'resume' }, 'idle'],
    [
      { kind: 'interrupted', settledAt: 3, cause: 'terminal-commit-failed', recovery: 'resume' },
      'idle'
    ],
    [{ kind: 'interrupted', settledAt: 3, cause: 'app-restart', recovery: 'resume' }, 'error']
  ] as const)('uses shared Attention for summary %j', (outcome, expected) => {
    const session = setTurnOutcome({ ...fixture(), status: 'error' }, 'prompt', outcome)
    expect(buildSessionProjection(session).summary.presentedStatus).toBe(expected)
    expect(buildSessionProjection({ ...session, status: 'running' }).summary.presentedStatus).toBe(
      'running'
    )
  })
})

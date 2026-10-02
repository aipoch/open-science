import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/home/user', isPackaged: true }
}))

import { initDataRoot } from '../storage-root'
import {
  materializeSessionConversationGraph,
  type PersistedChatSession
} from '../../shared/session-persistence'
import type { AcpRuntimeEvent } from '../../shared/acp'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { SessionRepository } from './repository'
import { RuntimeSessionOwner } from './runtime-session-owner'

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

const createFileIndex = (): SessionFileIndex => ({
  syncSession: vi.fn().mockResolvedValue([]),
  softDeleteSession: vi.fn().mockResolvedValue('delete-session-operation'),
  restoreSession: vi.fn().mockResolvedValue(undefined),
  softDeleteProject: vi.fn().mockResolvedValue('delete-project-operation'),
  reconcileProjectSessions: vi.fn().mockResolvedValue(undefined),
  reconcileActiveSessions: vi.fn().mockResolvedValue(undefined),
  markReconciliationIncomplete: vi.fn()
})

const roots: string[] = []

const harness = async (): Promise<{
  root: string
  repository: SessionRepository
  coordinator: SessionPersistenceCoordinator
}> => {
  const root = await mkdtemp(join(tmpdir(), 'open-science-missing-runtime-session-'))
  roots.push(root)
  initDataRoot(root)
  const repository = new SessionRepository(root)
  const coordinator = new SessionPersistenceCoordinator(repository, createFileIndex())
  return { root, repository, coordinator }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('missing runtime Session authority regression', () => {
  it.each(['session-file', 'project-directory'] as const)(
    'releases an admitted turn after %s disappears without recreating its record',
    async (missing) => {
      const { root, repository, coordinator } = await harness()
      const durable = materializeSessionConversationGraph(
        createSession({
          status: 'running',
          activeRun: { promptMessageId: 'prompt', startedAt: 1 },
          messages: [
            {
              id: 'prompt',
              role: 'user',
              content: 'Analyze the data',
              status: 'complete',
              eventIds: [],
              createdAt: 1,
              updatedAt: 1
            }
          ]
        })
      )
      await repository.saveSession(durable)
      const graph = durable.conversationGraph!
      const scope = {
        projectId: durable.projectId,
        sessionId: durable.id,
        promptMessageId: 'prompt',
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.branches[0].id,
        runtimeSegmentId: graph.runtimeSegments[0].id,
        executionId: 'admitted-execution'
      }
      const owner = new RuntimeSessionOwner({
        loadSession: async (scope) => {
          const loaded = await repository.loadSessionWithDiagnostics(
            scope.projectId,
            scope.sessionId,
            { preserveRuntimeState: true }
          )
          return loaded.status === 'found' ? loaded.session : undefined
        },
        mutateSession: (scope, mutate) => coordinator.mutateRuntimeSession(scope, mutate),
        finalizeArtifacts: async () => [],
        onTerminalCommitExhausted: (_scope, event, retry) =>
          coordinator.recordRuntimeTerminalFailure(event, retry)
      })
      await owner.begin(scope)
      const path =
        missing === 'session-file'
          ? join(root, 'sessions', durable.projectId, durable.id + '.json')
          : join(root, 'sessions', durable.projectId)
      await rm(path, { recursive: true, force: true })
      const published: AcpRuntimeEvent[] = []
      await owner.commitTerminal(
        {
          id: 'terminal',
          kind: 'stop',
          level: 'info',
          timestamp: Date.now(),
          sessionId: durable.id,
          promptMessageId: 'prompt',
          text: 'end_turn'
        },
        (event) => published.push(event)
      )
      owner.retryTerminalCommits(durable.id)
      await vi.waitFor(() => expect(published).toHaveLength(1))
      expect(published[0]).toMatchObject({
        publicationOwner: 'main',
        interruptionCause: 'terminal-commit-failed',
        terminalCommitFailure: 'missing-record',
        errorReportable: false,
        terminalScope: { executionId: 'admitted-execution', startedAt: 1 }
      })
      expect(coordinator.listRuntimeTerminalFailures()).toEqual(published)
      expect(await repository.loadSessionWithDiagnostics(durable.projectId, durable.id)).toEqual({
        status: 'missing'
      })
    }
  )
  it('control: an in-process deletion is blocked by the deletion tombstone, not the missing error', async () => {
    const { coordinator } = await harness()
    await coordinator.saveSession(createSession())

    await coordinator.deleteSession('project-1', 'session-1')

    await expect(
      coordinator.mutateRuntimeSession({ projectId: 'project-1', sessionId: 'session-1' }, (s) => s)
    ).rejects.toThrow('Cannot mutate a session that has been deleted.')
  })

  it('out-of-band JSON removal rejects admission and runtime mutation against missing authority', async () => {
    const { root, coordinator } = await harness()
    await coordinator.saveSession(createSession())

    // The renderer/runtime still believes the Session exists (e.g. an active turn or an open
    // conversation), but the file vanished outside this process's delete paths.
    await rm(join(root, 'sessions', 'project-1', 'session-1.json'))

    // RuntimeSessionOwner.begin() pre-loads through this path: it succeeds only while the file
    // exists. The subsequent admission mutation is what throws the user-facing error.
    await expect(coordinator.loadSessionForContinuation('project-1', 'session-1')).rejects.toThrow(
      'Cannot prepare a durable continuation for a missing Session.'
    )
    await expect(
      coordinator.mutateRuntimeSession({ projectId: 'project-1', sessionId: 'session-1' }, (s) => ({
        ...s,
        status: 'running' as const
      }))
    ).rejects.toThrow('Cannot update a missing runtime Session.')
  })

  it('a deletion committed by a previous process remains missing after its tombstone is gone', async () => {
    const { root, repository, coordinator } = await harness()
    await coordinator.saveSession(createSession())
    await coordinator.deleteSession('project-1', 'session-1')

    // Simulate an app restart: a new Coordinator over the same storage root has no in-memory
    // deletion tombstone, while the durable JSON is already gone.
    const restarted = new SessionPersistenceCoordinator(repository, createFileIndex())
    void root

    await expect(
      restarted.mutateRuntimeSession({ projectId: 'project-1', sessionId: 'session-1' }, (s) => s)
    ).rejects.toThrow('Cannot update a missing runtime Session.')
  })

  it('a missing Project directory rejects runtime mutation for its Sessions', async () => {
    const { root, coordinator } = await harness()
    await coordinator.saveSession(createSession())

    await rm(join(root, 'sessions', 'project-1'), { recursive: true, force: true })

    await expect(
      coordinator.mutateRuntimeSession({ projectId: 'project-1', sessionId: 'session-1' }, (s) => s)
    ).rejects.toThrow('Cannot update a missing runtime Session.')
  })
})

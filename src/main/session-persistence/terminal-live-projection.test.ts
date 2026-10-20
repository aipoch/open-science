import { configureTestElectronHost } from '../../../test/runtime-host'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import type { AcpRuntimeEvent } from '../../shared/acp'
import { materializeSessionConversationGraph } from '../../shared/session-persistence'
import { applyRuntimeSessionEvents } from '../../shared/runtime-session-projection'
import { SessionRepository } from './repository'
import { SessionPersistenceStateOwner } from './state-owner'

const createOwner = (repository: SessionRepository): SessionPersistenceStateOwner =>
  new SessionPersistenceStateOwner({
    repository,
    fileIndex: { syncSession: vi.fn(async () => []) },
    assertMutable: vi.fn(),
    notifyFilesChanged: vi.fn(),
    notifyRuntimeContextSessionUpdated: vi.fn(),
    notifyRuntimeTranscriptSessionUpdated: vi.fn(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  })

describe('terminal failure live projection with real Session storage', () => {
  it('keeps temporary interruption out of JSON, preserves it through saves, and clears it after exact Retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'terminal-live-projection-'))
    try {
      const repository = new SessionRepository(root)
      const owner = createOwner(repository)
      const seed = materializeSessionConversationGraph({
        id: 'session',
        projectId: 'project',
        title: 'Research',
        cwd: '/workspace',
        status: 'running',
        runtimeTranscriptOwner: 'main',
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
        agentFrameworkId: 'codex',
        createdAt: 1,
        updatedAt: 1
      })
      const graph = seed.conversationGraph!
      const scope = {
        promptMessageId: 'prompt',
        agentFrameId: graph.rootFrameId,
        messageBranchId: graph.branches[0].id,
        runtimeSegmentId: graph.runtimeSegments[0].id
      }
      await repository.saveSession({
        ...seed,
        runtimeSessionAdmissions: [
          {
            ...scope,
            executionId: 'execution',
            rootFrameId: graph.rootFrameId,
            promptRuntimeSegmentId: scope.runtimeSegmentId
          }
        ]
      })
      const event: AcpRuntimeEvent = {
        id: 'terminal:uncommitted',
        sessionId: seed.id,
        promptMessageId: 'prompt',
        timestamp: 2,
        kind: 'error',
        level: 'error',
        publicationOwner: 'main',
        errorReportable: false,
        interruptionCause: 'terminal-commit-failed',
        terminalCommitFailure: 'storage',
        terminalCommitError: 'disk unavailable',
        terminalScope: {
          ...scope,
          projectId: seed.projectId,
          executionId: 'execution',
          startedAt: 1
        }
      }
      const retry = vi.fn(async () => {
        const loaded = await repository.loadSession(seed.projectId, seed.id)
        const settled = applyRuntimeSessionEvents(loaded!, scope, [
          {
            id: 'terminal',
            sessionId: seed.id,
            promptMessageId: 'prompt',
            timestamp: 2,
            kind: 'stop',
            level: 'info',
            text: 'end_turn'
          }
        ])
        const saved = await repository.saveSession(settled, loaded!.revision)
        owner.recordSession(saved)
      })
      owner.recordRuntimeTerminalFailure(event, retry)
      const raw = (await repository.loadSession(seed.projectId, seed.id))!
      expect(raw.status).toBe('running')
      expect(raw.resumeRecovery).toBeUndefined()
      const live = owner.projectRuntimeSession(raw)
      expect(live.activeRun).toBeUndefined()
      expect(live.resumeRecovery?.cause).toBe('connection-lost')
      await owner.saveSession({ ...live, title: 'Renamed' }, { conflictRebaseFields: ['title'] })
      const afterSave = (await repository.loadSession(seed.projectId, seed.id))!
      expect(afterSave).toMatchObject({
        title: 'Renamed',
        status: 'running',
        activeRun: seed.activeRun
      })
      expect(afterSave.resumeRecovery).toBeUndefined()
      expect(owner.projectRuntimeSession(afterSave).resumeRecovery?.cause).toBe('connection-lost')
      expect(owner.listRuntimeTerminalFailures()).toHaveLength(1)

      const reopened = (await new SessionRepository(root).loadSession(seed.projectId, seed.id))!
      expect(reopened.resumeRecovery?.cause).toBe('app-restart')
      const request = {
        projectId: seed.projectId,
        sessionId: seed.id,
        promptMessageId: 'prompt',
        executionId: 'execution'
      }
      await owner.retryRuntimeTerminalCommit({ ...request, executionId: 'wrong-execution' })
      expect(retry).not.toHaveBeenCalled()
      await owner.retryRuntimeTerminalCommit(request)
      expect(retry).toHaveBeenCalledOnce()
      expect(owner.listRuntimeTerminalFailures()).toEqual([])
      const settled = (await new SessionRepository(root).loadSession(seed.projectId, seed.id))!
      expect(settled.status).toBe('idle')
      expect(settled.resumeRecovery).toBeUndefined()
      expect(settled.messages.map(({ id }) => id)).toEqual(['prompt'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

await configureTestElectronHost(await import('electron'))

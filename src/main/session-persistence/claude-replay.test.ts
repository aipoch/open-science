import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/home/user', isPackaged: true } }))

import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  createClaudeCodeCompletionGateRuntime,
  type ClaudeCodeReplayInput
} from '../agents/claude-code-handoff'
import { SessionPersistenceCoordinator, type SessionFileIndex } from './coordinator'
import { SessionRepository } from './repository'
import { createPersistedClaudeReplayPreparer } from './claude-replay'

const fileIndex: SessionFileIndex = {
  syncSession: async () => [],
  softDeleteSession: async () => 'deleted',
  restoreSession: async () => undefined,
  softDeleteProject: async () => 'deleted',
  reconcileActiveSessions: async () => undefined,
  reconcileProjectSessions: async () => undefined,
  markReconciliationIncomplete: () => undefined
}
const session = (id: string): PersistedChatSession => ({
  id,
  projectId: 'project-1',
  title: id,
  cwd: '/workspace',
  status: 'idle',
  agentFrameworkId: 'claude-code',
  createdAt: 1,
  updatedAt: 1,
  messages: [
    {
      id: `${id}-user`,
      role: 'user',
      content: id,
      status: 'complete',
      eventIds: [],
      createdAt: 1,
      updatedAt: 1
    }
  ]
})
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('persisted Claude handoff replay', () => {
  it.each([false, true])('resolves current context with hydrated ownership %s', async (hydrate) => {
    const root = await mkdtemp(join(tmpdir(), 'claude-replay-owner-'))
    roots.push(root)
    const repository = new SessionRepository(root)
    await repository.saveSession(session('current'))
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    if (hydrate) await coordinator.loadAllReadOnly()
    const prepareReplay = vi.fn()
    const prepare = createPersistedClaudeReplayPreparer({ repository, coordinator, prepareReplay })
    await prepare({
      sessionId: 'current',
      capturedCompletion: { kind: 'returned', value: 'done' },
      switchReadBack: {
        status: 'approved',
        operation: 'switch',
        binding: { sessionId: 'current', specialistId: undefined, targetName: null }
      }
    })
    expect(prepareReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        supportedTaskContext: [{ messageId: 'current-user', text: 'current' }]
      })
    )
  })

  it('refuses replay after another Project claims the same Session identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-replay-duplicate-'))
    roots.push(root)
    const repository = new SessionRepository(root)
    await repository.saveSession(session('current'))
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    await coordinator.loadAllReadOnly()
    await repository.saveSession({ ...session('current'), projectId: 'project-2' })
    const prepareReplay = vi.fn()
    const prepare = createPersistedClaudeReplayPreparer({ repository, coordinator, prepareReplay })
    await expect(
      prepare({
        sessionId: 'current',
        capturedCompletion: { kind: 'returned', value: 'done' },
        switchReadBack: {
          status: 'approved',
          operation: 'switch',
          binding: { sessionId: 'current', specialistId: undefined, targetName: null }
        }
      })
    ).rejects.toThrow()
    expect(prepareReplay).not.toHaveBeenCalled()
  })

  it('reconfigures with fresh task context while unrelated Session reads are blocked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-replay-'))
    roots.push(root)
    let hold = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let observed!: (value: string) => void
    const unrelated = new Promise<string>((resolve) => {
      observed = resolve
    })
    const repository = new SessionRepository(root, {
      readSessionFile: async (path) => {
        if (hold && basename(path) === 'unrelated.json') {
          observed('blocked on unrelated Session')
          await gate
        }
        return readFile(path, 'utf8')
      }
    })
    await repository.saveSession(session('current'))
    await repository.saveSession(session('unrelated'))
    const coordinator = new SessionPersistenceCoordinator(repository, fileIndex)
    await coordinator.loadAllReadOnly()
    const fresh = session('current')
    fresh.messages[0].content = 'Continue the latest saved task'
    await repository.saveSession(fresh)
    let replay: ClaudeCodeReplayInput | undefined
    const readBack = {
      status: 'approved' as const,
      operation: 'switch' as const,
      binding: { sessionId: 'current', specialistId: 'approved', targetName: 'Specialist' }
    }
    const runtime = createClaudeCodeCompletionGateRuntime({
      sessionFramework: () => 'claude-code',
      cancelPrompt: async () => undefined,
      waitForPromptOwnershipRelease: async () => undefined,
      resolveSpecialistId: () => 'approved',
      resolveSwitchReadBack: async () => readBack,
      prepareReplayContext: createPersistedClaudeReplayPreparer({
        repository,
        coordinator,
        prepareReplay: (input) => {
          replay = input
        }
      }),
      discardReplayContext: async () => undefined,
      switchSpecialist: async () => ({ contextReset: true }),
      createContinuationRequest: vi.fn(),
      sendAppContinuation: vi.fn()
    })
    hold = true
    const work = runtime.reconfigure(
      {
        kind: 'capture-for-handoff',
        targetName: 'Specialist',
        generation: 1,
        envelope: { kind: 'returned', value: 'finished tool' }
      },
      {
        sessionId: 'current',
        turnId: 'turn',
        controlInvocationGeneration: 1,
        toolInvocationId: 'tool'
      }
    )
    try {
      expect(await Promise.race([work.then(() => 'reconfigured'), unrelated])).toBe('reconfigured')
      expect(replay?.supportedTaskContext).toEqual([
        { messageId: 'current-user', text: 'Continue the latest saved task' }
      ])
    } finally {
      release()
      await work
    }
  })
})

import { updateContextRecoveryRecord } from '../session-persistence/context-recovery-admission'
import { describe, expect, it, vi } from 'vitest'
import { AcpContextRecoveryOwner, type ContextRecoveryDependencies } from './context-recovery-owner'
import {
  recoverySourceBranch,
  type PersistedChatSession,
  type SessionContextRecoveryRecord
} from '../../shared/session-persistence'

const fixture = (): {
  owner: AcpContextRecoveryOwner
  deps: ContextRecoveryDependencies
  session: () => PersistedChatSession
  setSession: (value: PersistedChatSession) => void
} => {
  let session = {
    id: 'session',
    projectId: 'project',
    title: 'Task',
    cwd: '/workspace',
    status: 'error',
    agentFrameworkId: 'opencode',
    messages: [],
    activities: [],
    createdAt: 1,
    updatedAt: 1,
    conversationGraph: {
      version: 1,
      activeFrameId: 'frame',
      frames: [{ id: 'frame', activeBranchId: 'branch' }],
      branches: [{ id: 'branch', agentFrameId: 'frame', headMessageId: 'user' }],
      messages: [
        {
          id: 'user',
          role: 'user',
          content: 'Continue',
          status: 'complete',
          agentFrameId: 'frame',
          introducedOnBranchId: 'branch'
        }
      ],
      activities: [],
      activityGroups: [],
      runtimeSegments: []
    }
  } as unknown as PersistedChatSession
  const deps: ContextRecoveryDependencies = {
    load: vi.fn(async () => structuredClone(session)),
    save: vi.fn(async (_id, record, providerSessionId, expectedRecoveryId) => {
      session = updateContextRecoveryRecord(session, record, expectedRecoveryId, providerSessionId)
    }),
    prepare: vi.fn(() => ({
      status: 'ready' as const,
      text: 'Preserved task and results',
      historyText: 'Preserved task and results',
      estimatedTokens: 100,
      pendingPromptMessageId: 'user'
    })),
    adoptExistingCandidate: vi.fn(async (request, hooks) => {
      await hooks.onBeforeCommit(request.providerSessionId!)
      return { sessionId: request.sessionId, providerSessionId: request.providerSessionId }
    }),
    compact: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
    replace: vi.fn(async (_request, hooks) => {
      await hooks.onCandidateCreated('candidate')
      await hooks.onBeforeCommit('candidate')
      hooks.assertCurrent()
    }),
    continue: vi.fn(async () => ({ stopReason: 'end_turn' as const })),
    changed: vi.fn()
  }
  const owner = new AcpContextRecoveryOwner(deps)
  return {
    owner,
    deps,
    session: () => session,
    setSession: (value: PersistedChatSession) => {
      session = value
    }
  }
}
const failure = (
  error = 'Session too large to compact - context exceeds model limit even after stripping media'
): {
  error: Error
  request: { sessionId: string; text: string; provenanceContext: { promptMessageId: string } }
} => ({
  error: new Error(error),
  request: {
    sessionId: 'session',
    text: 'Continue',
    provenanceContext: { promptMessageId: 'user' }
  }
})

describe('main context recovery ownership', () => {
  it('skips exhausted native compaction, commits binding before continuation, and preserves task identity', async () => {
    const f = fixture()
    f.deps.continue = vi.fn(async (request) => {
      expect(f.session().providerSessionId).toBe('candidate')
      expect(f.session().runtimeContext?.contextRecovery?.phase).toBe('continuing')
      expect(request.provenanceContext?.promptMessageId).toBe('user')
      return { stopReason: 'end_turn' as const }
    })
    await f.owner.recover('session', failure())
    expect(f.deps.compact).not.toHaveBeenCalled()
    expect(f.deps.replace).toHaveBeenCalledTimes(1)
    expect(f.deps.continue).toHaveBeenCalledTimes(1)
    expect(f.owner.snapshot().session.phase).toBe('completed')
    await f.owner.recover('session', failure())
    expect(f.deps.replace).toHaveBeenCalledTimes(1)
  })
  it('uses successful native compaction without replacement', async () => {
    const f = fixture()
    f.deps.prepare = vi.fn(() => ({
      status: 'blocked' as const,
      reason: 'Replacement budget is too small'
    }))
    await f.owner.recover('session', failure('maximum context length exceeded'))
    expect(f.deps.prepare).not.toHaveBeenCalled()
    expect(f.deps.compact).toHaveBeenCalledTimes(1)
    expect(f.deps.replace).not.toHaveBeenCalled()
    expect(f.owner.snapshot().session).toEqual({ phase: 'completed', canRetry: false })
    expect(f.deps.continue).toHaveBeenCalledTimes(1)
  })
  it('replaces only once after unsuccessful native compaction and stops after continuation refusal', async () => {
    const f = fixture()
    f.deps.compact = vi.fn(async () => {
      throw new Error('Cannot compact')
    })
    f.deps.continue = vi.fn(async () => {
      throw new Error('maximum context length exceeded')
    })
    await f.owner.recover('session', failure('maximum context length exceeded'))
    expect(f.deps.compact).toHaveBeenCalledTimes(1)
    expect(f.deps.replace).toHaveBeenCalledTimes(1)
    expect(f.deps.continue).toHaveBeenCalledTimes(1)
    expect(f.owner.snapshot().session).toEqual({
      phase: 'blocked',
      canRetry: false,
      reason:
        'Recovery continuation outcome is unknown. Verify completed operations before continuing.'
    })
    await f.owner.recover('session')
    expect(f.deps.continue).toHaveBeenCalledTimes(1)
  })
  it('abandons durable admission if cancellation arrives before provider dispatch', async () => {
    const f = fixture()
    f.deps.admitContinuation = vi.fn(async (request) => {
      f.owner.cancel('session')
      return request
    })
    f.deps.abandonContinuation = vi.fn(async () => undefined)
    await f.owner.recover('session', failure())
    expect(f.deps.abandonContinuation).toHaveBeenCalledWith('session')
    expect(f.deps.continue).not.toHaveBeenCalled()
    expect(f.owner.snapshot().session.phase).toBe('cancelled')
  })

  it('preserves current-turn semantic inputs while excluding historical replay media', async () => {
    const f = fixture()
    const failed = failure()
    const request = {
      ...failed.request,
      turnIntent: 'plan-first' as const,
      forcedSkillIds: ['skill'],
      currentImages: [{ mimeType: 'image/png' as const, data: 'AAA=', byteLength: 2 }],
      referencedSessions: [{ type: 'session' as const, sessionId: 'other', title: 'Reference' }],
      parts: [{ type: 'text' as const, text: 'Task' }],
      historyPreamble: 'obsolete history'
    } satisfies import('../../shared/acp').AcpPromptRequest
    await f.owner.recover('session', { error: failed.error, request })
    expect(f.deps.continue).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIntent: 'plan-first',
        forcedSkillIds: ['skill'],
        currentImages: request.currentImages,
        referencedSessions: request.referencedSessions,
        parts: request.parts,
        historyPreamble: undefined
      })
    )
  })

  it('coalesces concurrent recover commands', async () => {
    const f = fixture()
    const a = f.owner.recover('session', failure())
    const b = f.owner.recover('session', failure())
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect(f.deps.replace).toHaveBeenCalledTimes(1)
  })
  it('preserves the old binding when cancelled after candidate creation', async () => {
    const f = fixture()
    f.deps.replace = vi.fn(async (_request, hooks) => {
      await hooks.onCandidateCreated('candidate')
      f.owner.cancel('session')
      hooks.assertCurrent()
      await hooks.onBeforeCommit('candidate')
    })
    await f.owner.recover('session', failure())
    expect(f.session().providerSessionId).toBeUndefined()
    expect(f.owner.snapshot().session.phase).toBe('cancelled')
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
  it('rejects a changed conversation branch before binding commit', async () => {
    const f = fixture()
    f.deps.replace = vi.fn(async (_request, hooks) => {
      await hooks.onCandidateCreated('candidate')
      f.setSession({
        ...f.session(),
        conversationGraph: { ...f.session().conversationGraph!, activeFrameId: 'other' }
      })
      await hooks.onBeforeCommit('candidate')
    })
    await f.owner.recover('session', failure())
    expect(f.session().providerSessionId).toBeUndefined()
    expect(f.owner.snapshot().session.phase).toBe('failed')
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
  it('blocks unknown side effects without compacting, replacing, or dispatching', async () => {
    const f = fixture()
    f.deps.prepare = vi.fn(() => ({
      status: 'blocked' as const,
      reason: 'Verify write tool-1',
      activityIds: ['tool-1']
    }))
    await f.owner.recover('session', failure())
    expect(f.owner.snapshot().session).toEqual({
      phase: 'blocked',
      canRetry: false,
      reason: 'Verify write tool-1'
    })
    expect(f.deps.compact).not.toHaveBeenCalled()
    expect(f.deps.replace).not.toHaveBeenCalled()
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
  it('restores a bad session with no unanswered user message to ready', async () => {
    const f = fixture()
    f.deps.prepare = vi.fn(() => ({
      status: 'ready' as const,
      text: 'History',
      historyText: 'History',
      estimatedTokens: 10
    }))
    await f.owner.recover('session')
    expect(f.owner.snapshot().session.phase).toBe('ready')
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
  it('does not replay an uncertain continuation after restart, including an explicit recovery', async () => {
    const f = fixture()
    const record: SessionContextRecoveryRecord = {
      version: 1,
      id: 'recovery',
      phase: 'continuing',
      sourceBranch: recoverySourceBranch(f.session()),
      sourceRevision: 0,
      compactAttempts: 1,
      replacementAttempts: 1,
      candidateProviderSessionId: 'candidate'
    }
    f.setSession({
      ...f.session(),
      providerSessionId: 'candidate',
      runtimeContext: { version: 1, revision: 1, contextRecovery: record }
    })
    await f.owner.reconcile('session')
    await f.owner.recover('session')
    expect(f.owner.snapshot().session.phase).toBe('blocked')
    expect(f.session().providerSessionId).toBe('candidate')
    expect(f.deps.replace).not.toHaveBeenCalled()
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
  it('carries the handoff into the next new user request after a ready recovery', async () => {
    const f = fixture()
    f.deps.prepare = vi.fn(() => ({
      status: 'ready' as const,
      text: 'Preserved historical constraints',
      historyText: 'Preserved historical constraints',
      estimatedTokens: 10
    }))
    await f.owner.recover('session')
    const { request, recoveryId } = await f.owner.prepareUserPrompt({
      sessionId: 'session',
      text: 'Next instruction'
    })
    expect(request.text).toBe('Next instruction')
    expect(request.historyPreamble).toBe('Preserved historical constraints')
    expect(request.contextReset).toBe(true)
    await f.owner.completeUserPrompt('session', recoveryId)
    expect(f.owner.snapshot().session.phase).toBe('completed')
  })
  it.each(['blocked', 'failed', 'cancelled'] as const)(
    'retires a %s receipt after a new explicit user turn succeeds',
    async (phase) => {
      const f = fixture()
      const record: SessionContextRecoveryRecord = {
        version: 1,
        id: 'old-recovery',
        phase,
        reason: 'Previous recovery could not finish',
        sourceBranch: recoverySourceBranch(f.session()),
        sourceRevision: 0,
        compactAttempts: 0,
        replacementAttempts: 0
      }
      f.setSession({
        ...f.session(),
        runtimeContext: { version: 1, revision: 1, contextRecovery: record }
      })
      await f.owner.reconcile('session')
      expect(() => f.owner.assertContinuationAllowed('session')).toThrow()
      const prepared = await f.owner.prepareUserPrompt({
        sessionId: 'session',
        text: 'Adjusted input'
      })
      // Preparation alone must not unblock automatic continuation of the failed turn.
      expect(() => f.owner.assertContinuationAllowed('session')).toThrow()
      await f.owner.completeUserPrompt('session', prepared.recoveryId)
      expect(f.session().runtimeContext?.contextRecovery).toMatchObject({
        phase: 'completed',
        reason: undefined
      })
      expect(() => f.owner.assertContinuationAllowed('session')).not.toThrow()
      expect(f.owner.snapshot().session).toEqual({ phase: 'completed', canRetry: false })
    }
  )

  it('does not retire a successor recovery receipt when an older user turn completes', async () => {
    const f = fixture()
    f.deps.prepare = vi.fn(() => ({ status: 'blocked' as const, reason: 'Budget too small' }))
    await f.owner.recover('session')
    const prepared = await f.owner.prepareUserPrompt({
      sessionId: 'session',
      text: 'Adjusted input'
    })
    await f.owner.recover('session')
    const successor = f.session().runtimeContext?.contextRecovery
    expect(successor?.id).not.toBe(prepared.recoveryId)
    await f.owner.completeUserPrompt('session', prepared.recoveryId)
    expect(f.session().runtimeContext?.contextRecovery).toEqual(successor)
    expect(f.owner.snapshot().session.phase).toBe('blocked')
  })

  it('preserves a successor that wins the save queue during explicit prompt completion', async () => {
    const f = fixture()
    f.deps.prepare = vi.fn(() => ({ status: 'blocked' as const, reason: 'Budget too small' }))
    await f.owner.recover('session')
    const prepared = await f.owner.prepareUserPrompt({
      sessionId: 'session',
      text: 'Adjusted input'
    })
    const save = f.deps.save
    f.deps.save = vi.fn(async (...args: Parameters<ContextRecoveryDependencies['save']>) => {
      f.setSession({
        ...f.session(),
        runtimeContext: {
          ...f.session().runtimeContext!,
          contextRecovery: { ...f.session().runtimeContext!.contextRecovery!, id: 'successor' }
        }
      })
      await save(...args)
    })
    await expect(
      f.owner.completeUserPrompt('session', prepared.recoveryId)
    ).resolves.toBeUndefined()
    expect(f.session().runtimeContext?.contextRecovery).toMatchObject({
      id: 'successor',
      phase: 'blocked'
    })
    expect(f.owner.snapshot().session.phase).toBe('blocked')
  })

  it('blocks new prompt admission during recovery and publishes release after cancellation', async () => {
    const f = fixture()
    let resolve!: () => void
    f.deps.prepare = vi.fn(async () => {
      await new Promise<void>((done) => {
        resolve = done
      })
      return {
        status: 'ready' as const,
        text: 'History',
        historyText: 'History',
        estimatedTokens: 10
      }
    })
    const recovery = f.owner.recover('session')
    await vi.waitFor(() => expect(resolve).toBeDefined())
    await expect(f.owner.prepareUserPrompt({ sessionId: 'session', text: 'Race' })).rejects.toThrow(
      'already running'
    )
    f.owner.cancel('session')
    resolve()
    await recovery
    expect(f.owner.activeSessionIds()).toEqual([])
    expect(f.owner.snapshot().session.phase).toBe('cancelled')
    expect(f.deps.changed).toHaveBeenCalled()
  })

  it('adopts a recorded precommit candidate after restart without creating or dispatching another one', async () => {
    const f = fixture()
    const record: SessionContextRecoveryRecord = {
      version: 1,
      id: 'recovery',
      phase: 'replacing',
      sourceBranch: recoverySourceBranch(f.session()),
      sourceRevision: 0,
      compactAttempts: 1,
      replacementAttempts: 1,
      oldProviderSessionId: 'old',
      candidateProviderSessionId: 'candidate'
    }
    f.setSession({
      ...f.session(),
      providerSessionId: 'old',
      runtimeContext: { version: 1, revision: 1, contextRecovery: record }
    })
    f.deps.adoptExistingCandidate = vi.fn(async (request, hooks) => {
      expect(request.providerSessionId).toBe('candidate')
      await hooks.onBeforeCommit('candidate')
    })
    await Promise.all([f.owner.reconcile('session'), f.owner.reconcile('session')])
    expect(f.deps.adoptExistingCandidate).toHaveBeenCalledTimes(1)
    expect(f.session().providerSessionId).toBe('candidate')
    expect(f.owner.snapshot().session.phase).toBe('ready')
    await f.owner.recover('session')
    expect(f.deps.replace).not.toHaveBeenCalled()
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
  it('retains a missing candidate receipt and refuses to silently create a replacement on explicit retry', async () => {
    const f = fixture()
    const record: SessionContextRecoveryRecord = {
      version: 1,
      id: 'recovery',
      phase: 'replacing',
      sourceBranch: recoverySourceBranch(f.session()),
      sourceRevision: 0,
      compactAttempts: 0,
      replacementAttempts: 1,
      candidateProviderSessionId: 'candidate'
    }
    f.setSession({
      ...f.session(),
      runtimeContext: { version: 1, revision: 1, contextRecovery: record }
    })
    f.deps.adoptExistingCandidate = vi.fn(async () => {
      throw new Error('Provider session unavailable')
    })
    await f.owner.reconcile('session')
    await f.owner.recover('session')
    expect(f.owner.snapshot().session.phase).toBe('blocked')
    expect(f.session().runtimeContext?.contextRecovery?.candidateProviderSessionId).toBe(
      'candidate'
    )
    expect(f.deps.replace).not.toHaveBeenCalled()
  })

  it('keeps a committed ready binding after restart without recreating a candidate', async () => {
    const f = fixture()
    const record: SessionContextRecoveryRecord = {
      version: 1,
      id: 'recovery',
      phase: 'ready',
      sourceBranch: recoverySourceBranch(f.session()),
      sourceRevision: 0,
      compactAttempts: 1,
      replacementAttempts: 1,
      candidateProviderSessionId: 'candidate'
    }
    f.setSession({
      ...f.session(),
      providerSessionId: 'candidate',
      runtimeContext: { version: 1, revision: 1, contextRecovery: record }
    })
    await f.owner.reconcile('session')
    expect(f.owner.snapshot().session.phase).toBe('ready')
    expect(f.deps.replace).not.toHaveBeenCalled()
    expect(f.deps.continue).not.toHaveBeenCalled()
  })
})

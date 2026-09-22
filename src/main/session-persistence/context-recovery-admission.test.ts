import { describe, expect, it } from 'vitest'
import { createLinearConversationGraph } from '../../shared/conversation-graph'
import type { PersistedChatSession } from '../../shared/session-persistence'
import {
  abandonContextRecoveryAdmission,
  admitContextRecoveryContinuation,
  updateContextRecoveryRecord
} from './context-recovery-admission'

const fixture = (): PersistedChatSession => {
  const message = {
    id: 'user',
    role: 'user' as const,
    content: 'Task',
    status: 'complete' as const,
    eventIds: [],
    createdAt: 1,
    updatedAt: 1
  }
  const graph = createLinearConversationGraph({
    sessionId: 'session',
    messages: [message],
    frameworkId: 'opencode',
    createdAt: 1,
    updatedAt: 1
  })
  return {
    id: 'session',
    projectId: 'project',
    cwd: '/workspace',
    title: 'Task',
    status: 'error',
    createdAt: 1,
    updatedAt: 1,
    messages: [message],
    conversationGraph: graph,
    runtimeContext: {
      version: 1,
      revision: 1,
      contextRecovery: {
        version: 1,
        id: 'episode',
        phase: 'continuing',
        failedPromptMessageId: 'user',
        compactAttempts: 0,
        replacementAttempts: 1,
        sourceRevision: 1,
        sourceBranch: JSON.stringify([graph.activeFrameId, graph.frames[0].activeBranchId, 'user'])
      }
    }
  }
}
const request = {
  sessionId: 'session',
  text: 'Continue',
  provenanceContext: { promptMessageId: 'user' }
}

describe('durable context recovery admission', () => {
  it('rejects a delayed old provider commit after a successor episode starts', () => {
    const original = fixture()
    const oldRecord = original.runtimeContext!.contextRecovery!
    const successor = { ...oldRecord, id: 'successor', phase: 'preparing' as const }
    const current = updateContextRecoveryRecord(original, successor, oldRecord.id)
    expect(() =>
      updateContextRecoveryRecord(
        current,
        { ...oldRecord, phase: 'ready' },
        oldRecord.id,
        'old-candidate'
      )
    ).toThrow('superseded')
    expect(current.runtimeContext?.contextRecovery?.id).toBe('successor')
    expect(current.providerSessionId).toBeUndefined()
    expect(() =>
      updateContextRecoveryRecord(current, { ...successor, id: 'third' }, oldRecord.id)
    ).toThrow('superseded')
  })

  it('compares absence for the first episode then requires its own identity for updates', () => {
    const initial = fixture()
    const record = initial.runtimeContext!.contextRecovery!
    initial.runtimeContext = { version: 1, revision: 0 }
    const started = updateContextRecoveryRecord(initial, { ...record, phase: 'preparing' }, null)
    expect(() => updateContextRecoveryRecord(started, { ...record, id: 'racer' }, null)).toThrow(
      'superseded'
    )
    const updated = updateContextRecoveryRecord(
      started,
      { ...record, phase: 'ready' },
      record.id,
      'candidate'
    )
    expect(updated.providerSessionId).toBe('candidate')
    expect(updated.runtimeContext?.contextRecovery?.phase).toBe('ready')
  })

  it('fences a branch switch retaining the same original user message', () => {
    const session = fixture()
    const graph = session.conversationGraph!
    graph.branches.push({ ...graph.branches[0], id: 'fork' })
    graph.frames[0].activeBranchId = 'fork'
    expect(() => admitContextRecoveryContinuation(session, request, 10)).toThrow('no longer owns')
    expect(session.activeRun).toBeUndefined()
  })
  it('rolls back only a not-dispatched recovery admission without modifying historical records', () => {
    const session = fixture()
    const admitted = admitContextRecoveryContinuation(session, request, 10)
    expect(admitted.session.activeRun?.promptMessageId).toBe('user')
    const abandoned = abandonContextRecoveryAdmission(admitted.session)
    expect(abandoned.activeRun).toBeUndefined()
    expect(abandoned.status).toBe('error')
    expect(abandoned.conversationGraph).toEqual(session.conversationGraph)
    expect(abandoned.messages).toEqual(session.messages)
    expect(abandoned.runtimeSessionAdmissions).toEqual([])
  })
  it('does not clear a successor user run while abandoning recovery', () => {
    const admitted = admitContextRecoveryContinuation(fixture(), request, 10).session
    admitted.activeRun = { promptMessageId: 'new-user', startedAt: 20 }
    expect(abandonContextRecoveryAdmission(admitted)).toBe(admitted)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DesktopRuntimeDisconnectedError,
  DesktopRuntimeWriteNotSubmittedError
} from '../../../../shared/desktop-runtime-recovery'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import { useDesktopRuntimeRecoveryStore } from '../../stores/desktop-runtime-recovery-store'
import { createOrderedSessionPersistence } from './session-persistence'

const session = (overrides: Partial<PersistedChatSession> = {}): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-1',
  title: 'Original',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  runtimeTranscriptOwner: 'main',
  ...overrides
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const harness = (base = session()) => {
  const saveSession = vi.fn(async (candidate: PersistedChatSession) => candidate)
  const saveManifest = vi.fn(async () => undefined)
  const persistence = createOrderedSessionPersistence({ saveSession, saveManifest })
  persistence.seedAcknowledgedSessions([base])
  return { persistence, saveSession, saveManifest, base }
}

beforeEach(() =>
  useDesktopRuntimeRecoveryStore.setState({ phase: 'connected', epoch: 0, closing: false })
)

afterEach(() => vi.unstubAllGlobals())

describe('unconfirmed Session writes', () => {
  it('keeps normal successful saves out of recovery diagnostics', async () => {
    const reportRendererFailure = vi.fn()
    vi.stubGlobal('window', { api: { diagnostics: { reportRendererFailure } } })
    const h = harness()
    await h.persistence.saveSession(
      { ...h.base, pinned: true },
      { conflictRebaseFields: ['pinned'] }
    )
    expect(reportRendererFailure).not.toHaveBeenCalled()
  })

  it('records why a background Session warning can clear after a lost save acknowledgement', async () => {
    const reportRendererFailure = vi.fn()
    vi.stubGlobal('window', { api: { diagnostics: { reportRendererFailure } } })
    const h = harness(session({ title: 'Private conversation title', cwd: '/private/workspace' }))
    const desired = { ...h.base, pinned: true }
    h.saveSession.mockRejectedValueOnce(
      new DesktopRuntimeDisconnectedError('private error with credential=secret')
    )
    await expect(
      h.persistence.saveSession(desired, { conflictRebaseFields: ['pinned'] })
    ).rejects.toThrow()
    await h.persistence.recovery.reconcile(
      async () => ({ ...desired, revision: 8 }),
      {},
      () => true
    )

    const writes = reportRendererFailure.mock.calls.map(([report]) => report.sessionWrite)
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'session-1',
          projectId: 'project-1',
          code: 'desktop-runtime-disconnected',
          epoch: 0,
          recovery: expect.objectContaining({
            event: 'retained',
            state: 'checking',
            attempt: expect.any(Number),
            runtimePhase: 'connected'
          })
        }),
        expect.objectContaining({
          sessionId: 'session-1',
          recovery: expect.objectContaining({ event: 'reconcile-started' })
        }),
        expect.objectContaining({
          sessionId: 'session-1',
          recovery: expect.objectContaining({
            event: 'resolved',
            reason: 'authority-confirmed',
            actualRevision: 8
          })
        })
      ])
    )
    const serialized = JSON.stringify(reportRendererFailure.mock.calls)
    expect(serialized).not.toContain('Private conversation title')
    expect(serialized).not.toContain('/private/workspace')
    expect(serialized).not.toContain('credential=secret')
    expect(h.persistence.recovery.getSnapshot()).toEqual([])
    expect(h.saveSession).toHaveBeenCalledOnce()
  })

  it.each(['claude-code', 'opencode', 'codex', 'codebuddy', 'pi'] as const)(
    'verifies a durable write with a lost acknowledgement without replaying it for %s',
    async (agentFrameworkId) => {
      const h = harness(session({ agentFrameworkId }))
      const desired = { ...h.base, pinned: true }
      h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
      await expect(
        h.persistence.saveSession(desired, { conflictRebaseFields: ['pinned'] })
      ).rejects.toMatchObject({ code: 'desktop-runtime-disconnected' })
      expect(h.persistence.recovery.getSnapshot()).toEqual([
        expect.objectContaining({
          sessionId: desired.id,
          projectId: desired.projectId,
          title: desired.title,
          state: 'checking',
          kind: 'connection'
        })
      ])
      await h.persistence.recovery.reconcile(
        async () => ({ ...desired, revision: 8 }),
        {},
        () => true
      )
      expect(h.persistence.recovery.getSnapshot()).toEqual([])
      expect(h.saveSession).toHaveBeenCalledOnce()
    }
  )

  it('does not treat a higher revision as proof that the intended field was saved', async () => {
    const h = harness()
    h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(
      h.persistence.saveSession(
        { ...h.base, title: 'Retained' },
        { conflictRebaseFields: ['title'] }
      )
    ).rejects.toThrow()
    // Hydration must not erase the retained intent or lift the quit/send barrier.
    h.persistence.seedAcknowledgedSessions([{ ...h.base, revision: 9 }])
    await h.persistence.recovery.reconcile(
      async () => ({ ...h.base, revision: 9 }),
      {},
      () => true
    )
    expect(h.persistence.recovery.get('session:session-1')).toMatchObject({
      state: 'failed',
      reviewRequired: true,
      intent: { session: { title: 'Retained' } }
    })
    await expect(h.persistence.flush()).rejects.toMatchObject({ code: 'session-save-unconfirmed' })
    expect(h.saveSession).toHaveBeenCalledOnce()
  })

  it('does not mistake transient Main record diagnostics for an unconfirmed local edit', async () => {
    const h = harness(session({ runtimeTranscriptOwner: undefined, recordProblems: [] }))
    const desired = { ...h.base, pinned: true, recordProblems: undefined }
    h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(
      h.persistence.saveSession(desired, { conflictRebaseFields: ['pinned'] })
    ).rejects.toThrow()
    // toPersistedSession strips recordProblems; a fresh Main read attaches it again.
    await h.persistence.recovery.reconcile(
      async () => ({ ...desired, recordProblems: [], revision: 2 }),
      {},
      () => true
    )
    expect(h.persistence.recovery.getSnapshot()).toEqual([])
    expect(h.saveSession).toHaveBeenCalledOnce()
  })

  it('retains a write that was rejected before submission across hydration', async () => {
    const h = harness()
    useDesktopRuntimeRecoveryStore.setState({ phase: 'disconnected', epoch: 1 })
    await expect(
      h.persistence.saveSession({ ...h.base, pinned: true }, { conflictRebaseFields: ['pinned'] })
    ).rejects.toBeInstanceOf(DesktopRuntimeWriteNotSubmittedError)
    expect(h.saveSession).not.toHaveBeenCalled()
    h.persistence.seedAcknowledgedSessions([h.base])
    await h.persistence.recovery.reconcile(
      async () => h.base,
      {},
      () => true
    )
    await expect(h.persistence.flush()).rejects.toMatchObject({ code: 'session-save-unconfirmed' })
    expect(h.persistence.recovery.getSnapshot()[0]).toMatchObject({
      kind: 'connection',
      state: 'failed'
    })
  })

  it('blocks a concurrent quit flush when a queued write is never submitted', async () => {
    const h = harness()
    useDesktopRuntimeRecoveryStore.setState({ phase: 'disconnected', epoch: 1 })
    const pending = h.persistence.saveSession(
      { ...h.base, pinned: true },
      { conflictRebaseFields: ['pinned'] }
    )
    const failure = expect(pending).rejects.toMatchObject({ code: 'desktop-runtime-not-submitted' })
    const barrier = h.persistence.flush()
    await expect(barrier).rejects.toThrow()
    await failure
    expect(h.saveSession).not.toHaveBeenCalled()
  })

  it('a successful write to another Session cannot clear the unconfirmed write', async () => {
    const h = harness()
    h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(
      h.persistence.saveSession({ ...h.base, pinned: true }, { conflictRebaseFields: ['pinned'] })
    ).rejects.toThrow()
    await h.persistence.saveSession(session({ id: 'session-2' }))
    expect(h.persistence.recovery.getSnapshot().map(({ sessionId }) => sessionId)).toEqual([
      'session-1'
    ])
    await expect(h.persistence.flush()).rejects.toThrow()
  })

  it('requires durable command receipts even when preference fields already match', async () => {
    const h = harness()
    h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(
      h.persistence.saveSession(h.base, {
        conversationCommands: [
          {
            id: 'select-1',
            kind: 'select-branch',
            timestamp: 2,
            branchId: 'branch-2',
            previousBranchId: 'branch-1'
          }
        ]
      })
    ).rejects.toThrow()
    await h.persistence.recovery.reconcile(
      async () => ({ ...h.base, revision: 20 }),
      {},
      () => true
    )
    expect(h.persistence.recovery.has('session:session-1')).toBe(true)
    await h.persistence.recovery.reconcile(
      async () => ({ ...h.base, runtimeConversationCommandIds: ['select-1'] }),
      {},
      () => true
    )
    expect(h.persistence.recovery.has('session:session-1')).toBe(false)
    expect(h.saveSession).toHaveBeenCalledOnce()
  })

  it('an old authoritative read cannot clear a newer retained edit', async () => {
    const reportRendererFailure = vi.fn()
    vi.stubGlobal('window', { api: { diagnostics: { reportRendererFailure } } })
    const h = harness()
    h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(
      h.persistence.saveSession({ ...h.base, title: 'First' }, { conflictRebaseFields: ['title'] })
    ).rejects.toThrow()
    let finishRead!: (value: PersistedChatSession) => void
    const checking = h.persistence.recovery.reconcile(
      () =>
        new Promise((resolve) => {
          finishRead = resolve
        }),
      {},
      () => true
    )
    h.persistence.recovery.retainChanges('session:session-1', () => ({
      base: { ...h.base, title: 'First' },
      session: { ...h.base, title: 'Second' },
      options: { conflictRebaseFields: ['title'] }
    }))
    finishRead({ ...h.base, title: 'First' })
    await checking
    expect(h.persistence.recovery.get('session:session-1')?.intent).toMatchObject({
      base: { title: 'Original' },
      session: { title: 'Second' }
    })
    expect(reportRendererFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionWrite: expect.objectContaining({
          recovery: expect.objectContaining({
            event: 'reconcile-stale',
            reason: 'write-replaced'
          })
        })
      })
    )
    expect(
      reportRendererFailure.mock.calls.some(
        ([report]) => report.sessionWrite?.recovery?.event === 'resolved'
      )
    ).toBe(false)
  })

  it.each(['session-missing', 'intent-mismatch', 'read-failed'] as const)(
    'explains why reconciliation leaves a warning unresolved: %s',
    async (reason) => {
      const reportRendererFailure = vi.fn()
      vi.stubGlobal('window', { api: { diagnostics: { reportRendererFailure } } })
      const h = harness()
      h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
      await expect(
        h.persistence.saveSession({ ...h.base, pinned: true }, { conflictRebaseFields: ['pinned'] })
      ).rejects.toThrow()
      await h.persistence.recovery.reconcile(
        async () => {
          if (reason === 'read-failed') throw new Error('private storage read failure')
          return reason === 'session-missing' ? undefined : { ...h.base, revision: 9 }
        },
        {},
        () => true
      )
      expect(reportRendererFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionWrite: expect.objectContaining({
            sessionId: 'session-1',
            recovery: expect.objectContaining({
              event: 'reconcile-unconfirmed',
              state: 'failed',
              reason,
              elapsedMs: expect.any(Number)
            })
          })
        })
      )
      expect(JSON.stringify(reportRendererFailure.mock.calls)).not.toContain(
        'private storage read failure'
      )
      await expect(h.persistence.flush()).rejects.toThrow()
      expect(h.saveSession).toHaveBeenCalledOnce()
    }
  )

  it('preserves save and recovery outcomes when the diagnostics bridge throws', async () => {
    vi.stubGlobal('window', {
      api: {
        diagnostics: {
          reportRendererFailure: () => {
            throw new Error('diagnostics unavailable')
          }
        }
      }
    })
    const h = harness()
    const failure = new DesktopRuntimeDisconnectedError()
    const desired = { ...h.base, pinned: true }
    h.saveSession.mockRejectedValueOnce(failure)
    await expect(
      h.persistence.saveSession(desired, { conflictRebaseFields: ['pinned'] })
    ).rejects.toBe(failure)
    await expect(h.persistence.flush()).rejects.toThrow()
    await h.persistence.recovery.reconcile(
      async () => desired,
      {},
      () => true
    )
    expect(h.persistence.recovery.getSnapshot()).toEqual([])
    expect(() => h.persistence.recovery.assertSettled()).not.toThrow()
    expect(h.saveSession).toHaveBeenCalledOnce()
  })

  it('ignores a late rejection after authoritative deletion', async () => {
    const h = harness()
    let rejectSave!: (error: Error) => void
    h.saveSession.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject
        })
    )
    const pending = h.persistence.saveSession(
      { ...h.base, pinned: true },
      { conflictRebaseFields: ['pinned'] }
    )
    const rejected = expect(pending).rejects.toThrow('deleted')
    await vi.waitFor(() => expect(h.saveSession).toHaveBeenCalledOnce())
    h.persistence.recovery.forget('session:session-1')
    rejectSave(new Error('deleted'))
    await rejected
    expect(h.persistence.recovery.getSnapshot()).toEqual([])
  })

  it('does not clear a changed manifest selection using an older receipt', async () => {
    const h = harness()
    h.saveManifest.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(h.persistence.saveManifest({ lastSessionId: 'first' })).rejects.toThrow()
    await h.persistence.recovery.reconcile(
      async () => undefined,
      { lastSessionId: 'second' },
      () => true
    )
    expect(h.persistence.recovery.has('manifest')).toBe(true)
    await expect(h.persistence.flush()).rejects.toThrow()
  })

  it('keeps the latest navigation intent when an older explicit retry fails', async () => {
    const h = harness()
    h.saveManifest.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(h.persistence.saveManifest({ lastSessionId: 'first' })).rejects.toThrow()
    let rejectRetry!: (error: Error) => void
    h.saveManifest.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetry = reject
        })
    )
    const pending = h.persistence.saveManifest({ lastSessionId: 'first' })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(h.saveManifest).toHaveBeenCalledTimes(2))
    h.persistence.recovery.retainManifest({ lastSessionId: 'latest' })
    rejectRetry(new DesktopRuntimeDisconnectedError())
    await rejected
    expect(h.persistence.recovery.get('manifest')?.manifest).toEqual({ lastSessionId: 'latest' })
  })

  it('keeps a newer edit when an older explicit retry rejects', async () => {
    const h = harness()
    h.saveSession.mockRejectedValueOnce(new DesktopRuntimeDisconnectedError())
    await expect(
      h.persistence.saveSession({ ...h.base, title: 'First' }, { conflictRebaseFields: ['title'] })
    ).rejects.toThrow()
    let rejectRetry!: (error: Error) => void
    h.saveSession.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetry = reject
        })
    )
    const pending = h.persistence.saveSession(
      { ...h.base, title: 'First' },
      { conflictRebaseFields: ['title'] }
    )
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(h.saveSession).toHaveBeenCalledTimes(2))
    h.persistence.recovery.retainChanges('session:session-1', () => ({
      base: { ...h.base, title: 'First' },
      session: { ...h.base, title: 'Latest' },
      options: { conflictRebaseFields: ['title'] }
    }))
    rejectRetry(new DesktopRuntimeDisconnectedError())
    await rejected
    expect(h.persistence.recovery.get('session:session-1')?.intent?.session.title).toBe('Latest')
  })
})

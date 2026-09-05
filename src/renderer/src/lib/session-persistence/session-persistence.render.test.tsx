// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SESSION_MANIFEST_VERSION,
  type LoadAllSessionsResult,
  type PersistedChatSession,
  type SessionSummary
} from '../../../../shared/session-persistence'
import { i18next } from '@/i18n'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import {
  flushSessionPersistence,
  useSessionPersistence,
  type SessionPersistenceState
} from './session-persistence'

const emptyLoadResult = (): LoadAllSessionsResult => ({
  sessions: [],
  manifest: { version: SESSION_MANIFEST_VERSION },
  diagnostics: {
    isComplete: true,
    warnings: [],
    isProjectDeletionRecoveryComplete: true
  }
})

const createPersistedSession = (
  overrides: Partial<PersistedChatSession> = {}
): PersistedChatSession => ({
  id: 'session-1',
  projectId: 'project-a',
  title: 'Restored',
  cwd: '/workspace/project-a',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides
})

describe('session persistence startup', () => {
  let container: HTMLDivElement
  let root: Root
  let loadAll: ReturnType<typeof vi.fn>
  let saveSession: ReturnType<typeof vi.fn>
  let saveManifest: ReturnType<typeof vi.fn>
  let reconcilePendingArtifactsApi: ReturnType<typeof vi.fn>
  let reportRendererFailure: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await i18next.changeLanguage('en')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    loadAll = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('EACCES: /Users/private/.open-science/sessions could not be read')
      )
    saveSession = vi.fn(async (session) => session)
    saveManifest = vi.fn().mockResolvedValue(undefined)
    reconcilePendingArtifactsApi = vi.fn().mockResolvedValue([])
    reportRendererFailure = vi.fn()
    window.api = {
      sessions: {
        loadAll,
        saveSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        saveManifest
      },
      artifacts: {
        reconcilePendingArtifacts: reconcilePendingArtifactsApi
      },
      diagnostics: {
        reportRendererFailure
      }
    } as unknown as Window['api']
    useSessionStore.setState(createInitialSessionState())
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
      await i18next.changeLanguage('en')
    })
    container.remove()
  })

  const Probe = (): React.JSX.Element => {
    const persistence: SessionPersistenceState = useSessionPersistence()

    return (
      <div
        data-hydrated={String(persistence.isHydrated)}
        data-loading={String(persistence.isLoading)}
        data-ready={String(persistence.isReady)}
        data-catalog-complete={String(persistence.hasCompleteSessionCatalog)}
        data-catalog-recovery={persistence.catalogRecovery.kind}
        data-catalog-recovery-reason={
          persistence.catalogRecovery.kind === 'repairable'
            ? persistence.catalogRecovery.reason
            : undefined
        }
        data-deletion-ready={String(persistence.canDeleteSessionsAndProjects)}
        data-write-retryable={String(persistence.writeErrorRetryable)}
        data-persistence-blocked={persistence.persistenceBlockedSessionIds.join(',')}
      >
        <span data-testid="load-error">{persistence.loadError ?? 'sessions available'}</span>
        <span data-testid="load-warning">{persistence.loadWarning ?? 'no load warnings'}</span>
        <span data-testid="write-error">{persistence.writeError ?? 'changes saved'}</span>
        <button type="button" data-testid="retry-load" onClick={persistence.retryLoad}>
          Retry load
        </button>
        <button type="button" data-testid="retry-writes" onClick={persistence.retryWrites}>
          Retry writes
        </button>
        <button
          type="button"
          data-testid="new-conversation-after-size-limit"
          onClick={persistence.startNewConversationAfterSizeLimit}
        >
          New conversation
        </button>
        <button
          type="button"
          data-testid="report-plan-size-limit"
          onClick={() => persistence.reportSessionSizeLimit('session-plan')}
        >
          Report Plan size limit
        </button>
        <button
          type="button"
          data-testid="dismiss-load-warning"
          onClick={persistence.dismissLoadWarning}
        >
          Dismiss warning
        </button>
      </div>
    )
  }

  it('does not reload persisted sessions when the locale changes', async () => {
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    await act(async () => root.render(<Probe />))

    expect(loadAll).toHaveBeenCalledOnce()

    await act(async () => i18next.changeLanguage('ja'))

    expect(loadAll).toHaveBeenCalledOnce()
  })

  it('does not resurrect a deleted Session when lazy hydration finishes', async () => {
    const selected = createPersistedSession({ id: 'session-1' })
    const lazy = createPersistedSession({ id: 'session-2', updatedAt: 2 })
    let resolveLazyLoad: ((session: PersistedChatSession) => void) | undefined
    const loadOne = vi.fn(({ sessionId }: { sessionId: string }): Promise<PersistedChatSession> => {
      if (sessionId === selected.id) return Promise.resolve(selected)
      return new Promise<PersistedChatSession>((resolve) => {
        resolveLazyLoad = resolve
      })
    })
    const summary = (persisted: PersistedChatSession, number: number): SessionSummary => ({
      number,
      id: persisted.id,
      projectId: persisted.projectId,
      title: persisted.title,
      status: persisted.status,
      presentedStatus: persisted.status,
      pinned: false,
      revision: 0,
      activeMessageCount: persisted.messages.length,
      artifactCount: 0,
      filesRevision: 0,
      createdAt: persisted.createdAt,
      updatedAt: persisted.updatedAt,
      needsStartupRecovery: false
    })
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    window.api = {
      ...window.api,
      sessions: {
        list: vi.fn().mockResolvedValue({
          sessions: [summary(selected, 1), summary(lazy, 2)],
          manifest: { version: SESSION_MANIFEST_VERSION, lastSessionId: selected.id },
          diagnostics: {
            isComplete: true,
            warnings: [],
            isProjectDeletionRecoveryComplete: true
          }
        }),
        loadAll,
        loadOne,
        saveSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        saveManifest
      }
    } as unknown as Window['api']

    await act(async () => root.render(<Probe />))
    expect(useSessionStore.getState().selectedSessionId).toBe(selected.id)
    expect(loadOne).not.toHaveBeenCalled()

    // Entering Workspace selects the summary again. The whole-store subscription observes that
    // navigation write even when the selected id is unchanged and starts transcript hydration.
    await act(async () => {
      useSessionStore.getState().selectSession(selected.id)
      await Promise.resolve()
    })
    expect(loadOne).toHaveBeenCalledOnce()
    expect(loadOne).toHaveBeenLastCalledWith({
      projectId: selected.projectId,
      sessionId: selected.id
    })

    await act(async () => {
      useSessionStore.getState().selectSession(lazy.id)
      await Promise.resolve()
    })
    expect(loadOne).toHaveBeenCalledTimes(2)
    expect(loadOne).toHaveBeenLastCalledWith({ projectId: lazy.projectId, sessionId: lazy.id })

    await act(async () => {
      useSessionStore.getState().deleteSession(lazy.id)
      resolveLazyLoad?.(lazy)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual([selected.id])
  })

  it('keeps session actions blocked after a load failure and recovers on retry', async () => {
    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.hydrated).toBe('false')
    expect(container.querySelector('div')?.dataset.loading).toBe('false')
    expect(container.querySelector('[data-testid="load-error"]')?.textContent).toBe(
      'Open Science could not read saved conversation data. Retry to continue.'
    )
    expect(container.querySelector('[data-testid="load-error"]')?.textContent).not.toContain(
      '/Users/private'
    )

    loadAll.mockResolvedValueOnce(emptyLoadResult())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
    )

    expect(loadAll).toHaveBeenCalledTimes(2)
    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('div')?.dataset.catalogComplete).toBe('true')
    expect(container.querySelector('div')?.dataset.deletionReady).toBe('true')
    expect(container.querySelector('div')?.dataset.hydrated).toBe('true')
    expect(container.querySelector('div')?.dataset.loading).toBe('false')
    expect(container.querySelector('[data-testid="load-error"]')?.textContent).toContain(
      'sessions available'
    )
  })

  it('keeps startup blocked while a failed load retry is pending', async () => {
    await act(async () => root.render(<Probe />))

    let resolveRetry: ((result: LoadAllSessionsResult) => void) | undefined
    loadAll.mockImplementationOnce(
      () =>
        new Promise<LoadAllSessionsResult>((resolve) => {
          resolveRetry = resolve
        })
    )

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
    )

    expect(container.querySelector('div')?.dataset.hydrated).toBe('false')
    expect(container.querySelector('div')?.dataset.loading).toBe('true')
    expect(container.querySelector('div')?.dataset.ready).toBe('false')

    await act(async () => resolveRetry?.(emptyLoadResult()))

    expect(container.querySelector('div')?.dataset.hydrated).toBe('true')
    expect(container.querySelector('div')?.dataset.loading).toBe('false')
    expect(container.querySelector('div')?.dataset.ready).toBe('true')
  })

  it('surfaces a save failure and retries the latest in-memory session', async () => {
    let writesFail = true
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    saveSession.mockImplementation(async (session) => {
      if (writesFail) {
        throw new Error(
          'ENOENT: could not write /Users/private/.open-science/sessions/project-a/session-1.json'
        )
      }
      return session
    })

    await act(async () => root.render(<Probe />))

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'First version',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toBe(
      'Open Science could not save the latest conversation changes. Retry before closing the app.'
    )
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).not.toContain(
      '/Users/private'
    )
    expect(reportRendererFailure).toHaveBeenCalledWith({
      source: 'handled-error',
      surface: 'unknown',
      context: 'session-save',
      errorCategory: 'error',
      fingerprint: expect.stringMatching(/^[a-f0-9]{8}$/)
    })
    await expect(flushSessionPersistence()).rejects.toThrow('could not write')

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'Latest version',
        cwd: '/workspace/project'
      })
      await Promise.resolve()
    })

    writesFail = false
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-writes"]')?.click()
    )

    expect(saveSession.mock.calls.at(-1)?.[0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'Latest version' })])
    )
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'changes saved'
    )
    await expect(flushSessionPersistence()).resolves.toBeUndefined()
  })

  it('classifies a Session size limit as non-retryable and blocks only that Session', async () => {
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    saveSession.mockRejectedValue(
      Object.assign(new Error('Session exceeds the persistence limit.'), {
        code: 'session-size-limit'
      })
    )

    await act(async () => root.render(<Probe />))
    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'Grow beyond the limit',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })

    const probe = container.querySelector('div')
    expect(probe?.dataset.writeRetryable).toBe('false')
    expect(probe?.dataset.persistenceBlocked).toBe('session-1')
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'exceeded the 256 MiB storage limit'
    )

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="retry-writes"]')?.click()
      await Promise.resolve()
    })
    expect(saveSession).toHaveBeenCalledOnce()

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-conversation-after-size-limit"]')
        ?.click()
    })
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toBe(
      'changes saved'
    )
    expect(probe?.dataset.persistenceBlocked).toBe('session-1')
    await expect(flushSessionPersistence()).resolves.toBeUndefined()
  })

  it('accepts an external Plan size-limit report into the shared recovery state', async () => {
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    await act(async () => root.render(<Probe />))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="report-plan-size-limit"]')?.click()
    )

    const probe = container.querySelector('div')
    expect(probe?.dataset.persistenceBlocked).toBe('session-plan')
    expect(probe?.dataset.writeRetryable).toBe('false')
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'exceeded the 256 MiB storage limit'
    )
  })

  it('keeps an unrelated Session write failure retryable after a size-limit failure', async () => {
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    let ordinaryWriteFails = true
    saveSession.mockImplementation(async (session) => {
      if (session.id === 'session-1') {
        throw Object.assign(new Error('Session exceeds the persistence limit.'), {
          code: 'session-size-limit'
        })
      }
      if (ordinaryWriteFails) throw new Error('disk full')
      return session
    })

    await act(async () => root.render(<Probe />))
    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'Oversized Session',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-2',
        content: 'Ordinary failed Session',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })

    const probe = container.querySelector('div')
    expect(probe?.dataset.persistenceBlocked).toBe('session-1')
    expect(probe?.dataset.writeRetryable).toBe('true')
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toBe(
      'Open Science could not save the latest conversation changes. Retry before closing the app.'
    )

    ordinaryWriteFails = false
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="retry-writes"]')?.click()
      await Promise.resolve()
    })

    expect(probe?.dataset.writeRetryable).toBe('false')
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'exceeded the 256 MiB storage limit'
    )
  })

  it('keeps a failed Session blocking flush when another Session saves successfully', async () => {
    let failedSessionWritesFail = true
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    saveSession.mockImplementation(async (session) => {
      if (session.id === 'session-1' && failedSessionWritesFail) throw new Error('disk full')
      return session
    })

    await act(async () => root.render(<Probe />))

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'Unsaved Session',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-2',
        content: 'Durable Session',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })

    await expect(flushSessionPersistence()).rejects.toThrow('disk full')
    expect(saveSession.mock.calls.map(([session]) => session.id)).toEqual([
      'session-1',
      'session-2'
    ])

    failedSessionWritesFail = false
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="retry-writes"]')?.click()
      await Promise.resolve()
    })

    await expect(flushSessionPersistence()).resolves.toBeUndefined()
    expect(saveSession.mock.calls.at(-1)?.[0].id).toBe('session-1')
  })

  it('reloads after a Session revision conflict instead of resending stale JSON', async () => {
    const restored = createPersistedSession({ revision: 1 })
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      sessions: [restored]
    })
    saveSession.mockRejectedValue(
      Object.assign(new Error('Session revision conflict: expected 1, actual 2.'), {
        code: 'session-revision-conflict'
      })
    )

    await act(async () => root.render(<Probe />))
    await act(async () => {
      useSessionStore.getState().renameSession('session-1', 'Local title')
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toBe(
      'This conversation changed in another window. Your local changes were not saved. Retry to reload the latest version before closing the app.'
    )
    expect(saveSession).toHaveBeenCalledOnce()

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="retry-writes"]')?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    // Web has no loadOne command: conflict recovery falls back to loadAll once, then the explicit
    // retry reloads the full durable snapshot again.
    expect(loadAll).toHaveBeenCalledTimes(3)
    expect(saveSession).toHaveBeenCalledOnce()
  })

  it('clears an unresolved revision conflict after its Session is durably deleted', async () => {
    const restored = createPersistedSession({ revision: 1 })
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      sessions: [restored]
    })
    saveSession.mockRejectedValue(
      Object.assign(new Error('Session revision conflict: expected 1, actual 2.'), {
        code: 'session-revision-conflict'
      })
    )

    await act(async () => root.render(<Probe />))
    await act(async () => {
      useSessionStore.getState().renameSession('session-1', 'Conflicting title')
      await Promise.resolve()
    })
    await expect(flushSessionPersistence()).rejects.toMatchObject({
      code: 'session-revision-conflict'
    })

    await act(async () => {
      // Production removes renderer state only after the authoritative delete IPC succeeds.
      useSessionStore.getState().deleteSession('session-1')
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'changes saved'
    )
    await expect(flushSessionPersistence()).resolves.toBeUndefined()
  })

  it('automatically clears a failed write target after its session is durably deleted', async () => {
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    saveSession.mockRejectedValue(new Error('disk full'))

    await act(async () => root.render(<Probe />))

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'Delete me after the failed save',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toBe(
      'Open Science could not save the latest conversation changes. Retry before closing the app.'
    )
    await expect(flushSessionPersistence()).rejects.toThrow('disk full')

    await act(async () => {
      // Production removes renderer state only after the authoritative delete IPC succeeds.
      useSessionStore.getState().deleteSession('session-1')
      await Promise.resolve()
    })

    expect(saveSession).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'changes saved'
    )
    await expect(flushSessionPersistence()).resolves.toBeUndefined()
  })

  it('ignores a save failure that arrives after its Session was deleted', async () => {
    let rejectSave: ((reason: Error) => void) | undefined
    loadAll.mockReset().mockResolvedValue(emptyLoadResult())
    saveSession.mockImplementation(
      () =>
        new Promise<PersistedChatSession>((_resolve, reject) => {
          rejectSave = reject
        })
    )

    await act(async () => root.render(<Probe />))

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-1',
        content: 'Delete me while the save is pending',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    expect(saveSession).toHaveBeenCalledOnce()

    await act(async () => {
      useSessionStore.getState().deleteSession('session-1')
      rejectSave?.(new Error('Session was deleted'))
      await Promise.resolve()
    })

    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'changes saved'
    )
  })

  it('keeps persistence blocked when the durable Session scan is incomplete', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: false,
        isProjectDeletionRecoveryComplete: true,
        warnings: [
          {
            kind: 'unreadable',
            projectId: 'project-a',
            fileName: 'session-1.json',
            recovered: false
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.hydrated).toBe('true')
    expect(container.querySelector('div')?.dataset.deletionReady).toBe('true')
    expect(container.querySelector('div')?.dataset.catalogRecovery).toBe('repairable')
    expect(container.querySelector('div')?.dataset.catalogRecoveryReason).toBe('session-scan')
    expect(container.querySelector('[data-testid="load-error"]')?.textContent).toContain(
      'could not be read'
    )

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-2',
        content: 'Must not save against a partial scan',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('projects an unsupported Session version without starting persistence', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: false,
        isProjectDeletionRecoveryComplete: true,
        warnings: [
          {
            kind: 'unsupported-version',
            projectId: 'project-a',
            fileName: 'future.json',
            recovered: false
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.catalogRecovery).toBe('unsupported-version')

    await act(async () => {
      useSessionStore.getState().appendUserMessage({
        sessionId: 'session-2',
        content: 'Must not overwrite future Session authority',
        cwd: '/workspace/project',
        projectId: 'project-a'
      })
      await Promise.resolve()
    })
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('preserves a live session selection when retrying a partial recovery', async () => {
    const manifestSession = createPersistedSession({ id: 'manifest-session' })
    const selectedSession = createPersistedSession({
      id: 'selected-session',
      projectId: 'project-b',
      cwd: '/workspace/project-b',
      updatedAt: 2
    })
    const sessions = [manifestSession, selectedSession]
    const manifest = {
      version: SESSION_MANIFEST_VERSION,
      lastSessionId: manifestSession.id
    }
    loadAll
      .mockReset()
      .mockResolvedValueOnce({
        sessions,
        manifest,
        diagnostics: { isComplete: false, warnings: [] }
      })
      .mockResolvedValueOnce({ sessions, manifest })
    let finishManifestSave: (() => void) | undefined
    const manifestSave = new Promise<void>((resolve) => {
      finishManifestSave = resolve
    })
    saveManifest.mockReturnValueOnce(manifestSave)

    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().selectedSessionId).toBe(manifestSession.id)
    act(() => useSessionStore.getState().selectSession(selectedSession.id))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
      await Promise.resolve()
    })

    expect(useSessionStore.getState().selectedSessionId).toBe(selectedSession.id)
    expect(saveManifest).toHaveBeenCalledOnce()
    expect(saveManifest).toHaveBeenCalledWith({
      lastSessionId: selectedSession.id
    })
    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.loading).toBe('true')

    await act(async () => {
      finishManifestSave?.()
      await manifestSave
    })

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('div')?.dataset.loading).toBe('false')
  })

  it('preserves an explicitly empty selection when retrying a partial recovery', async () => {
    const manifestSession = createPersistedSession({ id: 'manifest-session' })
    const result = {
      sessions: [manifestSession],
      manifest: {
        version: SESSION_MANIFEST_VERSION,
        lastSessionId: manifestSession.id
      }
    }
    loadAll
      .mockReset()
      .mockResolvedValueOnce({
        ...result,
        diagnostics: { isComplete: false, warnings: [] }
      })
      .mockResolvedValueOnce(result)

    await act(async () => root.render(<Probe />))

    act(() => useSessionStore.getState().clearSelection())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
    )

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(saveManifest).toHaveBeenCalledOnce()
    expect(saveManifest).toHaveBeenCalledWith({ lastSessionId: undefined })
  })

  it('keeps persistence blocked until a failed retry manifest write succeeds', async () => {
    const pendingArtifactPath =
      '/data/artifacts/project-a/manifest-session/.pending/run-1/chart.png'
    const manifestSession = createPersistedSession({
      id: 'manifest-session',
      messages: [
        {
          id: 'message-1',
          role: 'agent',
          content: 'Recovered output',
          status: 'complete',
          eventIds: [],
          artifactIds: ['artifact-session:run-1:chart.png'],
          createdAt: 1,
          updatedAt: 1
        }
      ],
      artifacts: [
        {
          id: 'artifact-session:run-1:chart.png',
          kind: 'managed-file',
          path: pendingArtifactPath,
          name: 'chart.png',
          mimeType: 'image/png'
        }
      ]
    })
    const result = {
      sessions: [manifestSession],
      manifest: {
        version: SESSION_MANIFEST_VERSION,
        lastSessionId: manifestSession.id
      }
    }
    loadAll
      .mockReset()
      .mockResolvedValueOnce({
        ...result,
        diagnostics: { isComplete: false, warnings: [] }
      })
      .mockResolvedValueOnce(result)
    saveManifest
      .mockRejectedValueOnce(new Error('manifest disk full'))
      .mockResolvedValueOnce(undefined)

    await act(async () => root.render(<Probe />))

    act(() => useSessionStore.getState().clearSelection())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
    )

    expect(saveManifest).toHaveBeenCalledOnce()
    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.loading).toBe('false')
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toBe(
      'Open Science could not save the latest conversation changes. Retry before closing the app.'
    )
    expect(reconcilePendingArtifactsApi).not.toHaveBeenCalled()

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-writes"]')?.click()
    )

    expect(saveManifest).toHaveBeenCalledTimes(2)
    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'changes saved'
    )
    expect(reconcilePendingArtifactsApi).toHaveBeenCalledOnce()
  })

  it('keeps persistence blocked when startup storage recovery is incomplete', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: false,
        warnings: [],
        failure: 'startup-reconciliation-failed',
        isProjectDeletionRecoveryComplete: false
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.deletionReady).toBe('false')
    expect(container.querySelector('div')?.dataset.catalogRecovery).toBe(
      'project-deletion-recovery'
    )
    expect(container.querySelector('[data-testid="load-error"]')?.textContent).toContain(
      'storage recovery could not finish'
    )
  })

  it('loads healthy conversations while warning about quarantined corrupt files', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: true,
        warnings: [
          {
            kind: 'corrupt',
            projectId: 'project-a',
            fileName: 'broken.json',
            recovered: true
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('div')?.dataset.catalogComplete).toBe('false')
    expect(container.querySelector('div')?.dataset.catalogRecovery).toBe('damaged-authority')
    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toContain(
      'damaged and moved aside'
    )
  })

  it('dismisses a recovery warning without blocking healthy conversations', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: true,
        warnings: [
          {
            kind: 'corrupt',
            projectId: 'project-a',
            fileName: 'broken.json',
            recovered: true
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toContain(
      'damaged and moved aside'
    )
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="dismiss-load-warning"]')?.click()
    })
    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toBe(
      'no load warnings'
    )
    expect(container.querySelector('div')?.dataset.ready).toBe('true')
  })

  it('loads conversations after corrupt selection data is isolated', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: true,
        warnings: [
          {
            kind: 'manifest-corrupt',
            fileName: 'manifest.json',
            recovered: true
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toContain(
      'Conversation selection data was damaged and moved aside'
    )
  })

  it('keeps conversations writable when selection data is unreadable', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: true,
        warnings: [
          {
            kind: 'manifest-unreadable',
            fileName: 'manifest.json',
            recovered: false
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('div')?.dataset.catalogComplete).toBe('true')
    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toContain(
      'Conversation selection data could not be read, so no conversation was selected'
    )
  })

  it('does not claim damaged selection data was moved when quarantine failed', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: true,
        warnings: [
          {
            kind: 'manifest-corrupt',
            fileName: 'manifest.json',
            recovered: false
          }
        ]
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toContain(
      'Conversation selection data was damaged and could not be moved aside'
    )
  })
})

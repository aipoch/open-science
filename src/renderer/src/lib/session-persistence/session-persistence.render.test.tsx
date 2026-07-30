// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  SESSION_MANIFEST_VERSION,
  type LoadAllSessionsResult,
  type PersistedChatSession
} from '../../../../shared/session-persistence'
import { createInitialSessionState, useSessionStore } from '../../stores/session-store'
import { useSessionPersistence, type SessionPersistenceState } from './session-persistence'

const emptyLoadResult = (): LoadAllSessionsResult => ({
  sessions: [],
  manifest: { version: SESSION_MANIFEST_VERSION }
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

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    loadAll = vi.fn().mockRejectedValueOnce(new Error('sessions directory unavailable'))
    saveSession = vi.fn(async (session) => session)
    window.api = {
      sessions: {
        loadAll,
        saveSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        saveManifest: vi.fn().mockResolvedValue(undefined)
      },
      artifacts: {
        reconcilePendingArtifacts: vi.fn().mockResolvedValue([])
      }
    } as unknown as Window['api']
    useSessionStore.setState(createInitialSessionState())
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  const Probe = (): React.JSX.Element => {
    const persistence: SessionPersistenceState = useSessionPersistence()

    return (
      <div
        data-hydrated={String(persistence.isHydrated)}
        data-loading={String(persistence.isLoading)}
        data-ready={String(persistence.isReady)}
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
      </div>
    )
  }

  it('keeps session actions blocked after a load failure and recovers on retry', async () => {
    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('false')
    expect(container.querySelector('div')?.dataset.hydrated).toBe('false')
    expect(container.querySelector('div')?.dataset.loading).toBe('false')
    expect(container.querySelector('[data-testid="load-error"]')?.textContent).toContain(
      'sessions directory unavailable'
    )

    loadAll.mockResolvedValueOnce(emptyLoadResult())
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
    )

    expect(loadAll).toHaveBeenCalledTimes(2)
    expect(container.querySelector('div')?.dataset.ready).toBe('true')
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
      if (writesFail) throw new Error('disk full')
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
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'disk full'
    )

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
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'disk full'
    )

    await act(async () => {
      // Production removes renderer state only after the authoritative delete IPC succeeds.
      useSessionStore.getState().deleteSession('session-1')
      await Promise.resolve()
    })

    expect(saveSession).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-testid="write-error"]')?.textContent).toContain(
      'changes saved'
    )
  })

  it('keeps persistence blocked when the durable Session scan is incomplete', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: false,
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
      lastProjectId: manifestSession.projectId,
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

    await act(async () => root.render(<Probe />))

    expect(useSessionStore.getState().selectedSessionId).toBe(manifestSession.id)
    act(() => useSessionStore.getState().selectSession(selectedSession.id))

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="retry-load"]')?.click()
    )

    expect(container.querySelector('div')?.dataset.ready).toBe('true')
    expect(useSessionStore.getState().selectedSessionId).toBe(selectedSession.id)
  })

  it('keeps persistence blocked when startup storage recovery is incomplete', async () => {
    loadAll.mockReset().mockResolvedValue({
      ...emptyLoadResult(),
      diagnostics: {
        isComplete: false,
        warnings: [],
        failure: 'startup-reconciliation-failed'
      }
    })

    await act(async () => root.render(<Probe />))

    expect(container.querySelector('div')?.dataset.ready).toBe('false')
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
    expect(container.querySelector('[data-testid="load-warning"]')?.textContent).toContain(
      'damaged and moved aside'
    )
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

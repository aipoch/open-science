// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useArchiveUndoStore } from '@/stores/archive-undo-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import {
  createInitialSessionState,
  type ChatSession,
  useSessionStore
} from '@/stores/session-store'
import { ArchivedPanel } from './ArchivedPanel'

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: ChatSession = {
  id: 'session-1',
  projectId: project.id,
  title: 'Archived session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
  archivedAt: 2
}

describe('ArchivedPanel', () => {
  let container: HTMLDivElement
  let root: Root
  const updateArchive = vi.fn()
  const deleteProject = vi.fn()
  const deleteSession = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    updateArchive.mockReset().mockResolvedValue({ ...session, archivedAt: undefined })
    deleteProject.mockReset().mockResolvedValue({ status: 'deleted' })
    deleteSession.mockReset().mockResolvedValue({ status: 'deleted', runtimeDetached: true })
    window.api = {
      sessions: { updateArchive, deleteSession },
      acp: { getState: vi.fn().mockResolvedValue({ sessionIds: [] }), deleteSession: vi.fn() }
    } as unknown as Window['api']
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true,
      deleteProject
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [session] })
    useArchiveUndoStore.setState({ notices: [], restoringKey: undefined })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('restores an individually archived session from Settings', async () => {
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    )

    const restore = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Restore')
    )
    await act(async () => restore?.click())

    expect(updateArchive).toHaveBeenCalledWith({
      projectId: project.id,
      sessionId: session.id,
      archived: false,
      expectedArchivedAt: 2
    })
    expect(useSessionStore.getState().sessions[0]?.archivedAt).toBeUndefined()
  })

  it('keeps each concurrent restore busy until that operation finishes', async () => {
    const secondSession = { ...session, id: 'session-2', title: 'Second archived session' }
    const firstRestore = createDeferred<ChatSession>()
    const secondRestore = createDeferred<ChatSession>()
    updateArchive.mockImplementation(({ sessionId }: { sessionId: string }) =>
      sessionId === session.id ? firstRestore.promise : secondRestore.promise
    )
    useSessionStore.setState({
      ...createInitialSessionState(),
      sessions: [session, secondSession]
    })
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    )

    const restoreButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).filter((button) => button.textContent?.includes('Restore'))
    await act(async () => restoreButtons[0]?.click())
    await act(async () => restoreButtons[1]?.click())

    expect(restoreButtons.map((button) => button.disabled)).toEqual([true, true])

    await act(async () => {
      firstRestore.resolve({ ...session, archivedAt: undefined })
      await firstRestore.promise
    })

    const remainingRestore = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button')
    ).find((button) => button.textContent?.includes('Restore'))
    expect(remainingRestore?.disabled).toBe(true)

    await act(async () => {
      secondRestore.resolve({ ...secondSession, archivedAt: undefined })
      await secondRestore.promise
    })
  })

  it('delegates archived project selection to Settings navigation', async () => {
    const onNavigate = vi.fn()
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [{ ...project, archivedAt: 2 }],
      isLoaded: true
    })
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={onNavigate} />)
    )

    const manage = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Manage')
    )
    await act(async () => manage?.click())

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'project', projectId: project.id })
  })

  it('shows retry detail and offers immediate cleanup recovery', async () => {
    const retryDeletionCleanup = vi.fn().mockResolvedValue(undefined)
    useProjectStore.setState({
      deletionCleanup: [
        {
          projectId: project.id,
          projectName: project.name,
          phase: 'retry-scheduled',
          failureCount: 2,
          nextRetryAt: 6_000
        }
      ],
      retryDeletionCleanup
    })
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    )

    expect(container.querySelector('[role="status"]')?.textContent).toContain('Failed attempts: 2')
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Retry now'
    )
    await act(async () => retry?.click())

    expect(retryDeletionCleanup).toHaveBeenCalledOnce()
  })

  it('removes a stale Undo notice after permanently deleting its session', async () => {
    useArchiveUndoStore.getState().enqueueSession(session)
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    )

    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete')
    )
    await act(async () => openDelete?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const confirmDelete = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent === 'Delete')
    await act(async () => confirmDelete?.click())

    expect(deleteSession).toHaveBeenCalledWith({
      projectId: project.id,
      sessionId: session.id
    })
    expect(window.api.acp.getState).not.toHaveBeenCalled()
    expect(window.api.acp.deleteSession).not.toHaveBeenCalled()
    expect(useArchiveUndoStore.getState().notices).toEqual([])
  })

  it('reports unfinished cleanup after committed deletion and removes the Undo notice', async () => {
    deleteSession.mockResolvedValue({
      status: 'deleted',
      runtimeDetached: true,
      cleanupPending: true
    })
    useArchiveUndoStore.getState().enqueueSession(session)
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    )
    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete')
    )
    await act(async () => openDelete?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent === 'Delete'
    )
    await act(async () => confirm?.click())

    expect(useArchiveUndoStore.getState().notices).toEqual([])
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The Session was deleted, but some cleanup could not be completed.'
    )
  })

  it('keeps the archived Session dialog open and retries the unified deletion command', async () => {
    deleteSession
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'persistence',
        runtimeDetached: true
      })
      .mockResolvedValueOnce({ status: 'deleted', runtimeDetached: true })
    await act(async () =>
      root.render(<ArchivedPanel view={{ kind: 'list' }} onNavigate={vi.fn()} />)
    )

    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete')
    )
    await act(async () => openDelete?.click())
    let dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    let confirmDelete = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent === 'Delete')
    await act(async () => confirmDelete?.click())

    dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
      "couldn't delete the saved Session"
    )
    expect(deleteSession).toHaveBeenCalledTimes(1)

    confirmDelete = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent === 'Retry'
    )
    await act(async () => confirmDelete?.click())

    expect(deleteSession).toHaveBeenCalledTimes(2)
    expect(deleteSession).toHaveBeenNthCalledWith(2, {
      projectId: project.id,
      sessionId: session.id
    })
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('clears a failed Project deletion error before opening the next confirmation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deleteProject = vi
      .fn()
      .mockRejectedValue(
        new Error('ENOENT: no such file or directory, unlink /Users/private/OpenScience/project-1')
      )
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [{ ...project, archivedAt: 2 }],
      isLoaded: true,
      deleteProject
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [] })
    await act(async () =>
      root.render(
        <ArchivedPanel view={{ kind: 'project', projectId: project.id }} onNavigate={vi.fn()} />
      )
    )

    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete project')
    )
    await act(async () => openDelete?.click())
    let dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    const confirmDelete = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent === 'Delete')
    await act(async () => confirmDelete?.click())

    expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe('Could not delete project.')
    expect(dialog?.querySelector('[role="alert"]')?.textContent).not.toContain('/Users/private')

    const close = dialog?.querySelector<HTMLButtonElement>('[aria-label="Close"]')
    await act(async () => close?.click())
    await act(async () => openDelete?.click())
    dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')

    expect(dialog?.querySelector('[role="alert"]')).toBeNull()
    warn.mockRestore()
  })

  it('delegates archived Project runtime cleanup to the main deletion coordinator', async () => {
    const archivedProject = { ...project, archivedAt: 2 }
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [archivedProject],
      isLoaded: true,
      deleteProject
    })
    const onNavigate = vi.fn()
    await act(async () =>
      root.render(
        <ArchivedPanel
          view={{ kind: 'project', projectId: archivedProject.id }}
          onNavigate={onNavigate}
        />
      )
    )

    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete project')
    )
    await act(async () => openDelete?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role=alertdialog]')
    const confirmDelete = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent === 'Delete')
    await act(async () => confirmDelete?.click())

    expect(deleteProject).toHaveBeenCalledWith(project.id)
    expect(window.api.acp.getState).not.toHaveBeenCalled()
    expect(window.api.acp.deleteSession).not.toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })
  })

  it('removes committed archived Project state and explains pending background cleanup', async () => {
    const archivedProject = { ...project, archivedAt: 2 }
    deleteProject.mockImplementationOnce(async () => {
      useProjectStore.setState({
        deletionCleanup: [
          {
            projectId: project.id,
            projectName: project.name,
            phase: 'running',
            failureCount: 0
          }
        ]
      } as never)
      return { status: 'cleanup-pending' }
    })
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [archivedProject],
      isLoaded: true,
      deleteProject
    })
    const onNavigate = vi.fn()
    await act(async () =>
      root.render(
        <ArchivedPanel
          view={{ kind: 'project', projectId: archivedProject.id }}
          onNavigate={onNavigate}
        />
      )
    )

    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete project')
    )
    await act(async () => openDelete?.click())
    const dialog = document.body.querySelector<HTMLElement>('[role=alertdialog]')
    const confirmDelete = Array.from(
      dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent === 'Delete')
    await act(async () => confirmDelete?.click())

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      `Cleaning up ${project.name}…`
    )
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull()
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'list' })

    await act(async () => useProjectStore.getState().removeProject(project.id))

    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('shows Project recovery in Settings and keeps deletion unavailable until retry succeeds', async () => {
    const archivedProject = { ...project, archivedAt: 2 }
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [archivedProject],
      isLoaded: true,
      deleteProject
    })
    const onRetryCatalogRecovery = vi.fn()

    await act(async () =>
      root.render(
        <ArchivedPanel
          view={{ kind: 'project', projectId: archivedProject.id }}
          onNavigate={vi.fn()}
          canDeleteProjects={false}
          hasCompleteSessionCatalog={false}
          catalogRecovery={{ kind: 'project-deletion-recovery' }}
          onRetryCatalogRecovery={onRetryCatalogRecovery}
        />
      )
    )

    expect(container.textContent).toContain('Project recovery needs attention')
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="session-persistence-retry"]'
    )
    await act(async () => retry?.click())
    expect(onRetryCatalogRecovery).toHaveBeenCalledOnce()

    const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete project')
    )
    expect(deleteButton?.disabled).toBe(true)
  })

  it('keeps whole-Project deletion available with conservative copy for damaged authority', async () => {
    const archivedProject = { ...project, archivedAt: 2 }
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [archivedProject],
      isLoaded: true,
      deleteProject
    })

    await act(async () =>
      root.render(
        <ArchivedPanel
          view={{ kind: 'project', projectId: archivedProject.id }}
          onNavigate={vi.fn()}
          canDeleteProjects
          hasCompleteSessionCatalog={false}
          catalogRecovery={{
            kind: 'damaged-authority',
            affectedFiles: [{ projectId: archivedProject.id, fileName: 'damaged.json' }]
          }}
        />
      )
    )

    const openDelete = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Delete project')
    )
    expect(openDelete?.disabled).toBe(false)
    await act(async () => openDelete?.click())

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]')
    expect(dialog?.textContent).toContain(
      'all of its saved conversations, including any that could not be loaded during recovery'
    )
  })
})

const createDeferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

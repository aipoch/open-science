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
  const deleteSession = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    updateArchive.mockReset().mockResolvedValue({ ...session, archivedAt: undefined })
    deleteSession.mockReset().mockResolvedValue(undefined)
    window.api = {
      sessions: { updateArchive, deleteSession },
      acp: { getState: vi.fn().mockResolvedValue({ sessionIds: [] }), deleteSession: vi.fn() }
    } as unknown as Window['api']
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
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
    expect(useArchiveUndoStore.getState().notices).toEqual([])
  })
})

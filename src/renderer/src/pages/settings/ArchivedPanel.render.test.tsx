// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  const setArchived = vi.fn()

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setArchived.mockReset().mockResolvedValue({ ...session, archivedAt: undefined })
    window.api = {
      sessions: { setArchived },
      acp: { getState: vi.fn(), deleteSession: vi.fn() }
    } as unknown as Window['api']
    useProjectStore.setState({
      ...createInitialProjectState(),
      projects: [project],
      isLoaded: true
    })
    useSessionStore.setState({ ...createInitialSessionState(), sessions: [session] })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('restores an individually archived session from Settings', async () => {
    await act(async () => root.render(<ArchivedPanel />))

    const restore = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Restore')
    )
    await act(async () => restore?.click())

    expect(setArchived).toHaveBeenCalledWith({
      projectId: project.id,
      sessionId: session.id,
      archived: false,
      expectedArchivedAt: 2
    })
    expect(useSessionStore.getState().sessions[0]?.archivedAt).toBeUndefined()
  })
})

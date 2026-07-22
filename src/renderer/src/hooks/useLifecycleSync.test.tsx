// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ProjectDeletedEvent,
  SessionDeletedEvent,
  SessionSavedEvent
} from '../../../shared/lifecycle-events'
import type { Project } from '../../../shared/projects'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useLifecycleSync, type LifecycleSyncResult } from './useLifecycleSync'

const listeners: {
  projectCreated?: (project: Project) => void
  projectUpdated?: (project: Project) => void
  projectDeleted?: (event: ProjectDeletedEvent) => void
  sessionSaved?: (event: SessionSavedEvent) => void
  sessionDeleted?: (event: SessionDeletedEvent) => void
} = {}

let current: LifecycleSyncResult | undefined

const Harness = (): null => {
  current = useLifecycleSync()
  return null
}

const project: Project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1
}

const session: SessionSavedEvent['session'] = {
  id: 'session-1',
  projectId: project.id,
  title: 'External session',
  cwd: '/workspace',
  status: 'idle',
  messages: [],
  createdAt: 1,
  updatedAt: 1
}

describe('useLifecycleSync', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    useProjectStore.setState(createInitialProjectState())
    useSessionStore.setState(createInitialSessionState())
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    current = undefined

    const subscribe =
      <Payload,>(key: keyof typeof listeners) =>
      (listener: (payload: Payload) => void): (() => void) => {
        listeners[key] = listener as never
        return vi.fn()
      }

    window.api = {
      projects: {
        onCreated: subscribe<Project>('projectCreated'),
        onUpdated: subscribe<Project>('projectUpdated'),
        onDeleted: subscribe<ProjectDeletedEvent>('projectDeleted')
      },
      sessions: {
        onSaved: subscribe<SessionSavedEvent>('sessionSaved'),
        onDeleted: subscribe<SessionDeletedEvent>('sessionDeleted')
      }
    } as unknown as Window['api']

    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('upserts external projects and sessions and opens the toast target', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionSaved?.({ session, created: true })
    })

    expect(useProjectStore.getState().projects).toEqual([project])
    expect(useSessionStore.getState().sessions[0]?.id).toBe(session.id)
    expect(current?.notice).toMatchObject({ sessionId: session.id, projectId: project.id })

    await act(async () => current?.viewNotice())

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: project.id
    })
    expect(useSessionStore.getState().selectedSessionId).toBe(session.id)
    expect(current?.notice).toBeUndefined()
  })

  it('removes externally deleted data and returns an active project to Home', async () => {
    await act(async () => {
      listeners.projectCreated?.(project)
      listeners.sessionSaved?.({ session, created: true })
    })
    await act(async () => current?.viewNotice())
    await act(async () => {
      listeners.projectDeleted?.({ projectId: project.id })
    })

    expect(useProjectStore.getState().projects).toEqual([])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useNavigationStore.getState().view).toBe('home')
  })
})

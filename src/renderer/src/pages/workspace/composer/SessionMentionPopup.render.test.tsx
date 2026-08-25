// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Project } from '../../../../../shared/projects'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore, type ChatSession } from '@/stores/session-store'

import { SessionMentionPopup } from './SessionMentionPopup'

let container: HTMLDivElement
let root: Root

const project = (id: string, name: string, archivedAt?: number): Project => ({
  id,
  name,
  description: '',
  agentContext: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 1,
  ...(archivedAt === undefined ? {} : { archivedAt })
})

const session = (
  id: string,
  projectId: string,
  title: string,
  updatedAt: number,
  overrides: Partial<ChatSession> = {}
): ChatSession =>
  ({
    id,
    projectId,
    title,
    cwd: '',
    status: 'idle',
    messages: [],
    number: 99,
    createdAt: 1,
    updatedAt,
    ...overrides
  }) as ChatSession

beforeEach(() => {
  useNavigationStore.setState({ activeProjectId: 'project-current' })
  useProjectStore.setState({
    projects: [
      project('project-current', 'Current study'),
      project('project-other', 'Other study'),
      project('project-archived', 'Archived study', 5)
    ]
  })
  useSessionStore.setState({
    selectedSessionId: 'session-current',
    sessions: [
      session('session-current', 'project-current', 'Open conversation', 500, { number: 1 }),
      session(
        'session-local',
        'project-current',
        'A very long current Project Session title that should stay on one line and truncate',
        100,
        { number: 11 }
      ),
      session('session-other', 'project-other', 'Other Project result', 1000, { number: 22 }),
      session('session-pending', 'project-current', 'Pending', 2000, { isPending: true }),
      session('session-archived', 'project-current', 'Archived', 3000, { archivedAt: 5 }),
      session('session-hidden-project', 'project-archived', 'Hidden Project', 4000)
    ]
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'))

describe('SessionMentionPopup', () => {
  it('shows current-Project Sessions first and excludes current, pending, and archived rows', () => {
    act(() => {
      root.render(<SessionMentionPopup query="" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    expect(options().map((option) => option.textContent)).toEqual([
      expect.stringContaining('A very long current Project Session title'),
      expect.stringContaining('Other Project result')
    ])
    expect(options()[0].getAttribute('title')).toContain(
      'A very long current Project Session title'
    )
    expect(options()[0].querySelector('.truncate')).not.toBeNull()
    expect(options()[0].querySelector('[data-slot="session-mention-number"]')?.textContent).toBe(
      '#11'
    )
    expect(
      Array.from(options()[0].querySelectorAll('[data-slot="session-mention-meta"] > span')).map(
        (item) => item.textContent
      )
    ).toEqual([expect.stringMatching(/\S/), '·', 'Current study'])
  })

  it('uses pure numeric queries for Session-number prefixes and ranks an exact number first', () => {
    useSessionStore.setState({
      selectedSessionId: 'session-current',
      sessions: [
        session('session-prefix-current', 'project-current', 'Current prefix', 300, {
          number: 110
        }),
        session('session-exact-other', 'project-other', 'Exact other Project', 100, { number: 11 }),
        session('session-text-only', 'project-current', 'Title contains 11', 500, { number: 7 })
      ]
    })

    act(() => {
      root.render(<SessionMentionPopup query="11" onSelect={vi.fn()} onClose={vi.fn()} />)
    })

    expect(options().map((option) => option.textContent)).toEqual([
      expect.stringContaining('Exact other Project'),
      expect.stringContaining('Current prefix')
    ])
    expect(
      options().map(
        (option) => option.querySelector('[data-slot="session-mention-number"]')?.textContent
      )
    ).toEqual(['#11', '#110'])
  })

  it('returns only Session identity and the title snapshot', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(<SessionMentionPopup query="Other study" onSelect={onSelect} onClose={vi.fn()} />)
    })

    act(() => options()[0].click())

    expect(onSelect).toHaveBeenCalledWith({
      type: 'session',
      sessionId: 'session-other',
      title: 'Other Project result'
    })
  })
})

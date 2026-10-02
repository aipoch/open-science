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
  it('excludes the discussion source even when current or explicitly searched', () => {
    for (const query of ['', 'Open conversation', '1', '#1']) {
      act(() =>
        root.render(
          <SessionMentionPopup
            inline
            writableOnly
            excludedSessionId="session-current"
            query={query}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />
        )
      )
      expect(options().some((option) => option.getAttribute('title') === 'Open conversation')).toBe(
        false
      )
      expect(container.querySelector('[data-slot="session-mention-current"]')).toBeNull()
    }
    act(() =>
      root.render(
        <SessionMentionPopup
          inline
          writableOnly
          excludedSessionId="session-other"
          query=""
          onSelect={vi.fn()}
          onClose={vi.fn()}
        />
      )
    )
    expect(options()[0].getAttribute('title')).toBe('Open conversation')
    expect(options()[0].querySelector('[data-slot="session-mention-current"]')).not.toBeNull()
  })
  it('pins and labels the open conversation, follows selection changes, and respects search', () => {
    const onSelect = vi.fn()
    useSessionStore.setState({ selectedSessionId: 'session-local' })
    const render = (query: string): void => {
      act(() =>
        root.render(
          <SessionMentionPopup
            inline
            writableOnly
            query={query}
            onSelect={onSelect}
            onClose={vi.fn()}
          />
        )
      )
    }
    render('')
    expect(options()[0].getAttribute('title')).toContain('A very long')
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
    expect(options()[0].querySelector('[data-slot="session-mention-current"]')?.textContent).toBe(
      'Current'
    )
    expect(container.querySelectorAll('[data-slot="session-mention-current"]')).toHaveLength(1)
    const input = document.createElement('input')
    document.body.appendChild(input)
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-local' }))
    act(() => useSessionStore.setState({ selectedSessionId: 'session-current' }))
    expect(options()[0].getAttribute('title')).toBe('Open conversation')
    expect(options()[0].querySelector('[data-slot="session-mention-current"]')).not.toBeNull()
    render('22')
    expect(options()).toHaveLength(1)
    expect(options()[0].getAttribute('title')).toBe('Other Project result')
    expect(container.querySelector('[data-slot="session-mention-current"]')).toBeNull()
  })
  it('offers the current ordinary conversation and excludes imported history in writable mode', () => {
    useSessionStore.setState((state) => ({
      sessions: [
        ...state.sessions,
        session('imported', 'project-current', 'Read-only history', 600, {
          packageOrigin: {
            importId: 'import',
            sourceProjectId: 'origin',
            sourceSessionId: 'source',
            importedAt: 1,
            manifestChecksum: 'a'.repeat(64)
          }
        })
      ]
    }))
    act(() =>
      root.render(
        <SessionMentionPopup inline writableOnly query="" onSelect={vi.fn()} onClose={vi.fn()} />
      )
    )
    expect(
      options()
        .map((row) => row.textContent)
        .join(' ')
    ).toContain('Open conversation')
    expect(
      options()
        .map((row) => row.textContent)
        .join(' ')
    ).toContain('Other Project result')
    expect(
      options()
        .map((row) => row.textContent)
        .join(' ')
    ).not.toContain('Read-only history')
    expect(options()).toHaveLength(3)
  })
  it('verifies unloaded summaries before offering them as writable and excludes imported history', async () => {
    const imported = session('unopened-history', 'project-current', 'Unopened history', 800, {
      contentLoaded: false
    })
    const ordinary = session(
      'unopened-conversation',
      'project-current',
      'Unopened conversation',
      700,
      { contentLoaded: false }
    )
    useSessionStore.setState({ sessions: [imported, ordinary] })
    let resolveHistory!: (value: unknown) => void
    const history = new Promise((resolve) => {
      resolveHistory = resolve
    })
    const loadOne = vi.fn(async ({ sessionId }: { sessionId: string }) =>
      sessionId === imported.id ? await history : ordinary
    )
    vi.stubGlobal('api', { sessions: { loadOne } })
    act(() =>
      root.render(
        <SessionMentionPopup inline writableOnly query="" onSelect={vi.fn()} onClose={vi.fn()} />
      )
    )
    expect(options()).toHaveLength(0)
    expect(container.textContent).toContain('Loading…')
    await act(async () => {
      resolveHistory({ ...imported, packageOrigin: { importId: 'saved-import' } })
    })
    expect(options()).toHaveLength(1)
    expect(options()[0].textContent).toContain('Unopened conversation')
    expect(container.textContent).not.toContain('Unopened history')
    expect(useSessionStore.getState().selectedSessionId).toBe('session-current')
    expect(useSessionStore.getState().sessions.every((row) => row.contentLoaded === false)).toBe(
      true
    )
    vi.unstubAllGlobals()
  })
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

  it.each([
    [false, '11'],
    [false, '#11'],
    [true, '11'],
    [true, '#11'],
    [true, '  #11  ']
  ])(
    'matches number prefixes and ranks exact numbers first (writableOnly=%s, query=%s)',
    (writableOnly, query) => {
      useSessionStore.setState({
        selectedSessionId: 'session-current',
        sessions: [
          session('session-prefix-current', 'project-current', 'Current prefix', 300, {
            number: 110
          }),
          session('session-exact-other', 'project-other', 'Exact other Project', 100, {
            number: 11
          }),
          session('session-text-only', 'project-current', 'Title contains 11', 500, { number: 7 })
        ]
      })

      act(() => {
        root.render(
          <SessionMentionPopup
            writableOnly={writableOnly}
            query={query}
            onSelect={vi.fn()}
            onClose={vi.fn()}
          />
        )
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
    }
  )

  it('keeps nonnumeric hash queries as title searches', () => {
    useSessionStore.setState({
      sessions: [
        session('tagged', 'project-current', '#notes', 100),
        session('untagged', 'project-current', 'notes', 200)
      ]
    })
    act(() => {
      root.render(<SessionMentionPopup query="#notes" onSelect={vi.fn()} onClose={vi.fn()} />)
    })
    expect(options().map((option) => option.getAttribute('title'))).toEqual(['#notes'])
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

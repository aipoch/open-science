// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChatSession } from '@/stores/session-store'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'

import { GlobalSearchDialog } from './GlobalSearchDialog'

let container: HTMLDivElement
let root: Root

const artifact = {
  id: 'artifact-1',
  source: 'artifact' as const,
  sourceFileId: 'artifact-1',
  sourceVersionId: 'version-1',
  projectId: 'project-a',
  sessionId: 'session-a',
  name: 'sin.png',
  path: 'artifact-version:project-a/session-a/artifact-1/version-1',
  size: 12,
  sortAtMs: Date.now() - 3 * 24 * 60 * 60 * 1_000,
  originSession: { state: 'active' as const }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
  useProjectStore.setState({
    ...createInitialProjectState(),
    isLoaded: true,
    projects: [
      {
        id: 'project-a',
        name: 'Alpha',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 2
      },
      {
        id: 'project-b',
        name: 'Beta',
        description: '',
        isExample: false,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
  useSessionStore.setState({
    ...createInitialSessionState(),
    sessions: [
      {
        id: 'session-a',
        projectId: 'project-a',
        title: 'Python 绘制 sin 函数图',
        cwd: '/workspace',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        artifacts: []
      },
      {
        id: 'session-b',
        projectId: 'project-b',
        title: 'Other sin session',
        cwd: '/workspace',
        status: 'idle',
        createdAt: Date.now() - 1,
        updatedAt: Date.now() - 1,
        messages: [],
        artifacts: []
      }
    ] as ChatSession[]
  })
  useNavigationStore.setState({
    view: 'workspace',
    activeProjectId: 'project-a',
    userNavigationRevision: 0,
    explicitNavigationRevision: 0,
    pendingCustomizePrefill: undefined,
    pendingArtifactMention: undefined,
    artifactMentionAvailability: { projectId: 'project-a', canMention: true }
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      projectFiles: {
        searchArtifacts: vi.fn().mockResolvedValue({
          primary: { items: [artifact], totalCount: 1 },
          other: [],
          isIndexComplete: true
        })
      },
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'preview-resource-1',
          url: 'open-science-preview://preview-resource-1',
          mimeType: 'image/png'
        }),
        release: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('GlobalSearchDialog', () => {
  it('shows recent groups and sends a current-Project artifact to the composer mention handoff', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(document.body.textContent).toContain('Recent artifacts')
    expect(document.body.textContent).toContain('Recent sessions')
    expect(document.body.textContent).toContain('New session')

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    expect(artifactRow.classList).toContain('cursor-pointer')
    expect(artifactRow.classList).toContain('select-none')
    expect(
      artifactRow.querySelector<HTMLImageElement>('img[alt="Preview of sin.png"]')
    ).not.toBeNull()
    expect(artifactRow.textContent).toContain('Python 绘制 sin 函数图 · 3 days ago')
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLElement>('[aria-label="Mention sin.png"]')
    expect(mention).not.toBeNull()
    act(() => mention?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({ id: 'artifact-1' })
  })

  it('keeps the result list scrollable and the shortcut footer outside the scroll viewport', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const dialog = document.body.querySelector<HTMLElement>('[data-testid="global-search-dialog"]')
    const results = document.body.querySelector<HTMLElement>(
      '[data-testid="global-search-results"]'
    )
    const footer = document.body.querySelector<HTMLElement>('[data-testid="global-search-footer"]')
    const input = dialog?.querySelector<HTMLInputElement>('input[role="combobox"]')
    const searchHeader = input?.parentElement

    expect(dialog?.classList).toContain('h-[calc(100dvh_-_1rem)]')
    expect(input?.classList).toContain('focus-visible:ring-0')
    expect(input?.classList).not.toContain('focus-visible:outline-ring')
    expect(searchHeader?.classList).toContain('focus-within:ring-[3px]')
    expect(searchHeader?.classList).toContain('focus-within:ring-inset')
    expect(results?.classList).toContain('min-h-0')
    expect(results?.classList).toContain('flex-1')
    expect(footer?.classList).toContain('shrink-0')
    expect(footer?.classList).toContain('grid-cols-2')
    expect(footer?.querySelectorAll('kbd')).toHaveLength(4)
    expect(results?.contains(footer ?? null)).toBe(false)
  })

  it('uses the source message creation time for a legacy artifact', async () => {
    const createdAt = Date.now() - 4 * 24 * 60 * 60 * 1_000
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a'
          ? {
              ...session,
              messages: [
                {
                  id: 'message-a',
                  role: 'agent',
                  content: 'Created legacy artifact',
                  status: 'complete',
                  eventIds: [],
                  artifactIds: ['artifact-1'],
                  createdAt,
                  updatedAt: Date.now()
                }
              ]
            }
          : session
      )
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValueOnce({
      primary: {
        items: [
          {
            ...artifact,
            sourceVersionId: undefined,
            messageId: 'message-a',
            path: '/workspace/sin.png',
            sortAtMs: Date.now()
          }
        ],
        totalCount: 1
      },
      other: [],
      isIndexComplete: true
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    )
    expect(artifactRow?.textContent).toContain('Python 绘制 sin 函数图 · 4 days ago')
  })

  it('disables the current-Project mention action when the composer cannot accept another Artifact', async () => {
    useNavigationStore.setState({
      artifactMentionAvailability: { projectId: 'project-a', canMention: false }
    })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLButtonElement>('[aria-label="Mention sin.png"]')
    expect(mention?.disabled).toBe(true)
    act(() => mention?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
  })

  it('uses the valid last-opened Project as Home search scope', async () => {
    window.localStorage.setItem('open-science:last-opened-project', 'project-b')
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(document.body.textContent).toContain('Beta')
  })
})

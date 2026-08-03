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
  sortAtMs: Date.now(),
  originSession: { state: 'active' as const, title: 'Draw sin' }
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
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLElement>('[aria-label="Mention sin.png"]')
    expect(mention).not.toBeNull()
    act(() => mention?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({ id: 'artifact-1' })
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

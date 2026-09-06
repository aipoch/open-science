// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18next } from '@/i18n'
import type { ChatSession } from '@/stores/session-store'
import type { LiteratureItemView } from '../../../../shared/literature'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import { createInitialProjectState, useProjectStore } from '@/stores/project-store'
import { createInitialSessionState, useSessionStore } from '@/stores/session-store'
import { useNavigationStore } from '@/stores/navigation-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'

import { createCachedImageFetchResponse } from '../../pages/workspace/previews/cached-preview-image.test-support'
import { GlobalSearchDialog } from './GlobalSearchDialog'

let container: HTMLDivElement
let root: Root
let scrollIntoView: ReturnType<typeof vi.fn>

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

const literatureItem: LiteratureItemView = {
  id: 'literature-item-1',
  item: {
    itemType: 'journalArticle',
    title: 'Corrective Retrieval Augmented Generation',
    abstract: '',
    issuedText: '2024',
    issuedYear: 2024,
    containerTitle: 'arXiv',
    shortTitle: 'CRAG',
    language: 'en',
    rights: '',
    url: '',
    extra: '',
    typeFields: {},
    creators: [
      {
        nameMode: 'person',
        givenName: 'Shi-Qi',
        familyName: 'Yan',
        creatorType: 'author'
      }
    ],
    identifiers: []
  },
  attachments: [
    {
      id: 'literature-attachment-1',
      kind: 'fullText',
      title: '',
      sortOrder: 0,
      versions: [
        {
          id: 'literature-version-1',
          versionNumber: 1,
          filename: 'crag.pdf',
          contentType: 'application/pdf',
          sizeBytes: 629,
          checksum: 'a'.repeat(64),
          pageCount: 14,
          createdAt: 2
        }
      ],
      createdAt: 2,
      updatedAt: 2
    }
  ],
  projectIds: [],
  collectionIds: [],
  metadataRevision: 1,
  createdAt: 1,
  updatedAt: 2
}

beforeEach(() => {
  scrollIntoView = vi.fn()
  Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView
  })
  previewLeaveGuards.clear()
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
    selectedSessionId: 'session-a',
    sessions: [
      {
        id: 'session-a',
        projectId: 'project-a',
        title: 'Python 绘制 sin 函数图',
        number: 12,
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
        number: 123,
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
    pendingProjectCreation: false,
    pendingArtifactMention: undefined,
    artifactMentionAvailability: { projectId: 'project-a', canMention: true }
  })
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(createCachedImageFetchResponse()))
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
      managedFileVersions: {
        inspect: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            source: 'artifact',
            projectId: 'project-a',
            fileId: 'artifact-1',
            sessionId: 'session-a',
            displayName: 'sin-head.png',
            headVersionId: 'version-2',
            selectedVersionId: 'version-2',
            versions: [
              {
                id: 'version-2',
                source: 'artifact',
                fileId: 'artifact-1',
                versionNumber: 2,
                displayName: 'sin-head.png',
                originKind: 'user_edit',
                basedOnVersionId: 'version-1',
                contentType: 'image/png',
                sizeBytes: 14,
                checksum: '2'.repeat(64),
                createdAt: '2026-08-14T00:00:00.000Z'
              }
            ],
            canEdit: false,
            canDiff: false
          }
        })
      },
      previewResources: {
        acquire: vi.fn().mockResolvedValue({
          id: 'preview-resource-1',
          url: 'open-science-preview://preview-resource-1',
          mimeType: 'image/png'
        }),
        release: vi.fn().mockResolvedValue(undefined)
      },
      literature: {
        search: vi.fn().mockResolvedValue({ entries: [] })
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Reflect.deleteProperty(window.HTMLElement.prototype, 'scrollIntoView')
  vi.useRealTimers()
  vi.restoreAllMocks()
  void i18next.changeLanguage('en')
  vi.unstubAllGlobals()
})

describe('GlobalSearchDialog', () => {
  it('opens a Literature PDF from Workspace search in the Preview panel only', async () => {
    vi.mocked(window.api.literature.search).mockResolvedValue({ entries: [literatureItem] })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.focus()
      input?.setRangeText('Corrective')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    expect(window.api.literature.search).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-a' })
    )

    const literatureRow = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Corrective Retrieval Augmented Generation')
    )
    expect(literatureRow?.textContent).toContain('Shi-Qi Yan · 2024 · arXiv')
    act(() => literatureRow?.click())

    expect(useNavigationStore.getState().view).toBe('workspace')
    expect(usePreviewWorkbenchStore.getState().activeItemId).toBe('literature:literature-version-1')
    expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
      source: 'literature',
      path: 'literature-attachment-version:literature-version-1',
      format: 'pdf'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens a Literature result from Home in its Library detail', async () => {
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    vi.mocked(window.api.literature.search).mockResolvedValue({ entries: [literatureItem] })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.focus()
      input?.setRangeText('Corrective')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    const literatureRow = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Corrective Retrieval Augmented Generation')
    )
    act(() => literatureRow?.click())

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'library',
      pendingLiteratureItemId: 'literature-item-1'
    })
  })

  it('opens a metadata-only Literature result linked to the current Project in Library detail', async () => {
    vi.mocked(window.api.literature.search).mockResolvedValue({
      entries: [{ ...literatureItem, attachments: [], projectIds: ['project-a'] }]
    })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.focus()
      input?.setRangeText('Corrective')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    expect(window.api.literature.search).toHaveBeenCalledWith({
      scope: 'library',
      query: 'Corrective',
      limit: 8,
      projectId: 'project-a'
    })
    const literatureRow = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent?.includes('Corrective Retrieval Augmented Generation')
    )
    act(() => literatureRow?.click())

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'library',
      activeProjectId: 'project-a',
      pendingLiteratureItemId: 'literature-item-1'
    })
  })

  it('shows recent groups and sends a current-Project artifact to the composer mention handoff', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(document.body.textContent).toContain('Recent artifacts')
    expect(document.body.textContent).toContain('Recent sessions')
    const sessionRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.querySelector('[data-testid="global-search-session-icon"]')
    ) as HTMLElement
    expect(sessionRow.textContent).toContain('#12')
    expect(sessionRow.querySelector('[data-testid="global-search-session-icon"]')).not.toBeNull()
    expect(sessionRow.querySelector('.font-mono.tabular-nums')?.textContent).toBe('#12')
    expect(document.body.textContent).toContain('New session')
    const newSession = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) => element.textContent?.includes('New session')
    )
    const newSessionIcon = newSession?.querySelector('[data-testid="global-search-command-icon"]')
    expect(newSessionIcon?.classList.contains('size-10')).toBe(true)
    expect(newSessionIcon?.classList.contains('shrink-0')).toBe(true)
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    expect(input?.placeholder).toBe('Search this project…')
    expect(input?.parentElement?.textContent).toContain('Alpha')
    expect(
      document.body.querySelector('[data-testid="global-search-footer"]')?.textContent
    ).toContain('mention')

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    expect(artifactRow.classList).toContain('cursor-pointer')
    expect(artifactRow.classList).toContain('select-none')
    await waitFor(() => {
      expect(
        artifactRow.querySelector<HTMLImageElement>('img[alt="Preview of sin.png"]')
      ).not.toBeNull()
    })
    expect(artifactRow.textContent).toContain('Python 绘制 sin 函数图 · 3 days ago')
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLElement>('[aria-label="Mention sin.png"]')
    expect(mention).not.toBeNull()
    await act(async () => {
      mention?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
      id: 'artifact-1',
      sourceFileId: 'artifact-1',
      sourceVersionId: 'version-2',
      name: 'sin-head.png'
    })
  })

  it('keeps Global Search open and inserts nothing when mention head resolution fails', async () => {
    window.api.managedFileVersions.inspect = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'VERSION_NOT_FOUND', message: 'Current file head is unavailable.' }
    })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLElement>('[aria-label="Mention sin.png"]')
    await act(async () => i18next.changeLanguage('zh-Hans'))

    await act(async () => {
      mention?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(document.body.textContent).toContain('无法解析文件版本。')
    expect(document.body.textContent).not.toContain('Current file head is unavailable.')
  })

  it('prioritizes Artifacts and selects the first Artifact for a keyword search', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    const groupHeadings = [...document.body.querySelectorAll('[role="group"] h2')].map(
      (heading) => heading.textContent
    )
    const selectedOption = document.body.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]'
    )

    expect(groupHeadings.slice(0, 2)).toEqual(['Artifacts', 'Sessions'])
    expect(selectedOption?.textContent).toContain('sin.png')
    expect(document.body.textContent).toContain('New session')

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem?.selectedVersionId).toBeUndefined()
  })

  it('finds Sessions by number while keeping the number visible as trailing metadata', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, '12')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    const sessionRows = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].filter(
      (element) => element.querySelector('[data-testid="global-search-session-icon"]')
    )
    expect(sessionRows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Python 绘制 sin 函数图'),
      expect.stringContaining('Other sin session')
    ])
    expect(sessionRows[0].querySelector('.font-mono.tabular-nums')?.textContent).toBe('#12')
    expect(sessionRows[1].querySelector('.font-mono.tabular-nums')?.textContent).toBe('#123')
  })

  it('selects an exact Session number from another Project before a local prefix match', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [],
      isIndexComplete: true
    })
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a'
          ? { ...session, number: 123 }
          : session.id === 'session-b'
            ? { ...session, number: 12 }
            : session
      )
    }))
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, '12')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    const selectedOption = document.body.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]'
    )
    expect(selectedOption?.textContent).toContain('Other sin session')
    expect(selectedOption?.textContent).toContain('Beta')
    expect(selectedOption?.textContent).toContain('#12')

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(useSessionStore.getState().selectedSessionId).toBe('session-b')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('waits for Artifact search before showing a complete keyword result set', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const delayedResult = {
      primary: { items: [artifact], totalCount: 1 },
      other: [],
      isIndexComplete: true
    }
    let resolveSearch!: (value: typeof delayedResult) => void
    const pendingSearch = new Promise<typeof delayedResult>((resolve) => {
      resolveSearch = resolve
    })
    vi.mocked(window.api.projectFiles.searchArtifacts).mockImplementationOnce(() => pendingSearch)
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set

    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    expect(document.body.textContent).toContain('Searching…')
    expect(document.body.querySelector('[role="group"][aria-label="Sessions"]')).toBeNull()
    expect(
      document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent
    ).toBeUndefined()

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 170))
    })

    expect(document.body.textContent).toContain('Searching…')
    expect(document.body.querySelector('[role="group"][aria-label="Sessions"]')).toBeNull()
    expect(
      document.body.querySelector('[role="option"][aria-selected="true"]')?.textContent
    ).toBeUndefined()

    await act(async () => {
      resolveSearch(delayedResult)
      await pendingSearch
    })

    const groupHeadings = [...document.body.querySelectorAll('[role="group"] h2')].map(
      (heading) => heading.textContent
    )
    expect(groupHeadings.slice(0, 2)).toEqual(['Artifacts', 'Sessions'])
  })

  it('scrolls active results for keyboard navigation but not pointer hover', async () => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    scrollIntoView.mockClear()

    const sessionRow = document.body.querySelector<HTMLElement>(
      '[role="group"][aria-label="Recent sessions"] [role="option"]'
    )
    act(() => sessionRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))

    expect(scrollIntoView).not.toHaveBeenCalled()

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    act(() =>
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
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
    expect(searchHeader?.classList).not.toContain('focus-within:ring-[3px]')
    expect(searchHeader?.classList).not.toContain('focus-within:ring-inset')
    expect(results?.classList).toContain('min-h-0')
    expect(results?.classList).toContain('flex-1')
    expect(footer?.classList).toContain('shrink-0')
    expect(footer?.classList).toContain('grid-cols-2')
    expect(footer?.querySelectorAll('kbd')).toHaveLength(4)
    expect(results?.contains(footer ?? null)).toBe(false)
  })

  it('closes with Escape when an artifact row action holds focus', async () => {
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const artifactRow = [...document.body.querySelectorAll('[role="option"]')].find((element) =>
      element.textContent?.includes('sin.png')
    ) as HTMLElement
    act(() => artifactRow.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })))
    const mention = document.body.querySelector<HTMLButtonElement>('[aria-label="Mention sin.png"]')
    mention?.focus()

    await act(async () => {
      mention?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the active Artifact on Shift+Enter when no Session is active', async () => {
    window.localStorage.setItem('open-science:last-opened-project', 'project-a')
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens the active Artifact on Shift+Enter from a Project draft without a Session', async () => {
    useSessionStore.setState({ selectedSessionId: undefined })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('mentions the active Artifact on Shift+Enter inside the current Session', async () => {
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
      id: 'artifact-1',
      projectId: 'project-a'
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each(['closed', 'escape', 'unmounted'] as const)(
    'ignores a late mention inspection after the dialog is %s',
    async (lifecycle) => {
      let resolveInspect!: (
        result: Awaited<ReturnType<typeof window.api.managedFileVersions.inspect>>
      ) => void
      const inspection = new Promise<
        Awaited<ReturnType<typeof window.api.managedFileVersions.inspect>>
      >((resolve) => {
        resolveInspect = resolve
      })
      vi.mocked(window.api.managedFileVersions.inspect).mockReturnValueOnce(inspection)
      const onOpenChange = vi.fn()
      await act(async () => {
        root.render(
          <GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />
        )
        await new Promise((resolve) => window.setTimeout(resolve, 20))
      })

      const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
      await act(async () => {
        input?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            shiftKey: true,
            bubbles: true,
            cancelable: true
          })
        )
      })

      if (lifecycle === 'closed') {
        await act(async () => {
          root.render(
            <GlobalSearchDialog
              open={false}
              onOpenChange={onOpenChange}
              isSessionPersistenceReady
            />
          )
        })
      } else if (lifecycle === 'escape') {
        await act(async () => {
          input?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        })
        expect(onOpenChange).toHaveBeenCalledTimes(1)
      } else {
        act(() => root.unmount())
      }

      await act(async () => {
        resolveInspect({
          ok: true,
          value: {
            source: 'artifact',
            projectId: 'project-a',
            fileId: 'artifact-1',
            sessionId: 'session-a',
            displayName: 'late-head.png',
            headVersionId: 'version-late',
            selectedVersionId: 'version-late',
            versions: [
              {
                id: 'version-late',
                source: 'artifact',
                fileId: 'artifact-1',
                versionNumber: 3,
                displayName: 'late-head.png',
                originKind: 'user_edit',
                basedOnVersionId: 'version-2',
                contentType: 'image/png',
                sizeBytes: 15,
                checksum: '3'.repeat(64),
                createdAt: '2026-08-14T01:00:00.000Z'
              }
            ],
            canEdit: false,
            canDiff: false
          }
        })
        await Promise.resolve()
      })

      expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
      expect(onOpenChange).toHaveBeenCalledTimes(lifecycle === 'escape' ? 1 : 0)
    }
  )

  it('opens the active Artifact on Shift+Enter when the current Session cannot accept a mention', async () => {
    useNavigationStore.setState({
      artifactMentionAvailability: { projectId: 'project-a', canMention: false }
    })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-1',
      projectId: 'project-a'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens a cross-Project Artifact on Shift+Enter instead of mentioning it', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [
        {
          ...artifact,
          id: 'artifact-2',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'version-2',
          projectId: 'project-b',
          sessionId: 'session-b',
          name: 'other.png',
          path: 'artifact-version:project-b/session-b/artifact-2/version-2'
        }
      ],
      isIndexComplete: true
    })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'other.png')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState()).toMatchObject({
      view: 'workspace',
      activeProjectId: 'project-b',
      pendingArtifactMention: undefined
    })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-2',
      projectId: 'project-b'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('opens a cross-project preview after deferred leave confirmation resumes navigation', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [], totalCount: 0 },
      other: [
        {
          ...artifact,
          id: 'artifact-2',
          sourceFileId: 'artifact-2',
          sourceVersionId: 'version-2',
          projectId: 'project-b',
          sessionId: 'session-b',
          name: 'other.png',
          path: 'artifact-version:project-b/session-b/artifact-2/version-2'
        }
      ],
      isIndexComplete: true
    })
    usePreviewWorkbenchStore.setState({
      activeProjectId: 'project-a',
      activeItemId: 'dirty-file'
    })
    let resumeNavigation: (() => boolean | void) | undefined
    previewLeaveGuards.register('workbench:project-a:dirty-file', (action) => {
      resumeNavigation = action
      return false
    })
    const onOpenChange = vi.fn()
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'other.png')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    onOpenChange.mockClear()
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(useNavigationStore.getState().activeProjectId).toBe('project-a')
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    await act(async () => resumeNavigation?.())

    expect(useNavigationStore.getState().activeProjectId).toBe('project-b')
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toMatchObject({
      artifactId: 'artifact-2',
      projectId: 'project-b'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('uses the indexed current Version time instead of the older source message time', async () => {
    const sourceCreatedAt = Date.now() - 4 * 24 * 60 * 60 * 1_000
    const versionCreatedAt = Date.now() - 2 * 24 * 60 * 60 * 1_000
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a'
          ? {
              ...session,
              messages: [
                {
                  id: 'message-a',
                  role: 'agent',
                  content: 'Created artifact',
                  status: 'complete',
                  eventIds: [],
                  artifactIds: ['artifact-1'],
                  createdAt: sourceCreatedAt,
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
            messageId: 'message-a',
            path: '/workspace/sin.png',
            sortAtMs: versionCreatedAt
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
    expect(artifactRow?.textContent).toContain('Python 绘制 sin 函数图 · 2 days ago')
  })

  it('uses indexed current Version time when Session messages are not loaded', async () => {
    const createdAt = Date.now() - 4 * 24 * 60 * 60 * 1_000
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a'
          ? { ...session, contentLoaded: false, messages: [], conversationGraph: undefined }
          : session
      )
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValueOnce({
      primary: {
        items: [
          {
            ...artifact,
            messageId: 'message-a',
            path: '/workspace/sin.png',
            sortAtMs: createdAt
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

  it('limits Other projects to five mixed Session and Artifact results', async () => {
    const now = Date.now()
    useSessionStore.setState((state) => ({
      sessions: [
        ...state.sessions,
        ...Array.from({ length: 5 }, (_, index) => ({
          ...state.sessions[1],
          id: `other-session-${index}`,
          title: `Other sin ${index}`,
          updatedAt: now - (index + 1) * 20
        }))
      ] as ChatSession[]
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [artifact], totalCount: 1 },
      other: Array.from({ length: 3 }, (_, index) => ({
        ...artifact,
        id: `other-artifact-${index}`,
        sourceFileId: `other-artifact-${index}`,
        sourceVersionId: `other-version-${index}`,
        projectId: 'project-b',
        sessionId: 'session-b',
        name: `other-sin-${index}.png`,
        path: `artifact-version:project-b/session-b/other-artifact-${index}/other-version-${index}`,
        sortAtMs: now - index * 30
      })),
      isIndexComplete: true
    })

    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })

    const otherGroup = document.body.querySelector<HTMLElement>(
      '[role="group"][aria-label="Other projects"]'
    )
    expect(otherGroup?.querySelectorAll('[role="option"]')).toHaveLength(5)
    expect(otherGroup?.textContent).toContain('other-sin-0.png')
    expect(otherGroup?.textContent).toContain('Other sin session')
  })

  it('uses the global Home context and offers New Project without mention', async () => {
    window.localStorage.setItem('open-science:last-opened-project', 'project-b')
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')
    const footer = document.body.querySelector<HTMLElement>('[data-testid="global-search-footer"]')
    expect(input?.placeholder).toBe('Search sessions and artifacts…')
    expect(input?.parentElement?.textContent).not.toContain('Beta')
    expect(footer?.textContent).not.toContain('mention')
    expect(footer?.querySelectorAll('kbd')).toHaveLength(3)
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ primaryProjectIds: ['project-b'], otherLimit: 5 })
    )

    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set
    await act(async () => {
      valueSetter?.call(input, 'sin')
      input?.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((resolve) => window.setTimeout(resolve, 180))
    })
    expect(document.body.querySelector('[role="group"][aria-label="Other projects"]')).toBeNull()

    const newProject = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (element) => element.textContent?.includes('New project')
    )
    const newProjectIcon = newProject?.querySelector('[data-testid="global-search-command-icon"]')
    expect(newProjectIcon?.classList.contains('size-10')).toBe(true)
    expect(newProjectIcon?.classList.contains('shrink-0')).toBe(true)
    await act(async () => newProject?.click())
    expect(useNavigationStore.getState()).toMatchObject({
      view: 'home',
      pendingProjectCreation: true
    })
  })

  it('does not reload artifacts while terminal output streams', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a'
          ? {
              ...session,
              status: 'running',
              activeRun: { promptMessageId: 'prompt-a', startedAt: 1 }
            }
          : session
      )
    }))
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    const searchArtifacts = vi.mocked(window.api.projectFiles.searchArtifacts)
    const initialCallCount = searchArtifacts.mock.calls.length

    await act(async () => {
      useSessionStore.getState().upsertToolActivity({
        sessionId: 'session-a',
        toolCallId: 'terminal-a',
        eventId: 'terminal-output-a',
        title: 'python analysis.py',
        status: 'in_progress',
        terminalOutput: 'processing row 1\n'
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(searchArtifacts).toHaveBeenCalledTimes(initialCallCount)
  })

  it('excludes individually archived sessions from artifact queries', async () => {
    useSessionStore.setState((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === 'session-a' ? { ...session, archivedAt: 3 } : session
      )
    }))
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={vi.fn()} isSessionPersistenceReady />)
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })

    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ excludedSessionIds: ['session-a'] })
    )
  })
})

describe('Global Search result accessibility', () => {
  const emptyResult = {
    primary: { items: [], totalCount: 0 },
    other: [],
    isIndexComplete: true
  }
  const options = (): HTMLElement[] => [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"]')
  ]
  const optionWithText = (text: string): HTMLElement => {
    const row = options().find((option) => option.textContent?.includes(text))
    expect(row, `Expected a selectable row containing "${text}"`).toBeDefined()
    return row!
  }
  const mount = async (onOpenChange = vi.fn()): Promise<HTMLInputElement> => {
    await act(async () => {
      root.render(<GlobalSearchDialog open onOpenChange={onOpenChange} isSessionPersistenceReady />)
    })
    // Control only the debounce; Radix and React retain their normal microtask behavior.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!
    act(() => input.focus())
    return input
  }
  const search = async (input: HTMLInputElement): Promise<void> => {
    act(() => fireEvent.change(input, { target: { value: 'sin' } }))
    await act(async () => vi.advanceTimersByTimeAsync(150))
  }
  const enter = (input: HTMLInputElement): void => {
    act(() => fireEvent.keyDown(input, { key: 'Enter' }))
  }

  it('makes every matching artifact in another Project reachable from Home', async () => {
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    window.localStorage.setItem('open-science:last-opened-project', 'project-a')
    const files = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((name) => ({
      ...artifact,
      id: name,
      sourceFileId: name,
      sourceVersionId: `version-${name}`,
      name: `sin-${name}.png`,
      projectId: 'project-b',
      sessionId: 'session-b'
    }))
    // Honor the paged collection and bounded recommendation contract.
    vi.mocked(window.api.projectFiles.searchArtifacts).mockImplementation(async (request) => {
      const primaryIds = request.primaryProjectIds
      const matching = primaryIds.includes('project-b') ? files : []
      return {
        ...emptyResult,
        primary: { items: matching.slice(0, request.primaryLimit), totalCount: matching.length },
        other: request.otherProjectIds.includes('project-b')
          ? files.slice(0, request.otherLimit)
          : []
      }
    })
    const input = await mount()
    await search(input)
    const more = options().find((row) => row.textContent?.includes('show more'))
    if (more) await act(async () => more.click())
    expect.soft(options().filter((row) => row.textContent?.includes('sin-'))).toHaveLength(6)
    expect.soft(document.body.textContent).toContain('sin-zeta.png')
    expect(document.body.textContent).not.toContain('Some artifact results may be missing')
  })

  it.each(['workspace', 'home'] as const)(
    'does not enter creation from %s when Enter arrives during the debounce',
    async (view) => {
      useNavigationStore.setState({
        view,
        activeProjectId: view === 'workspace' ? 'project-a' : undefined
      })
      const onOpenChange = vi.fn()
      const input = await mount(onOpenChange)
      act(() => fireEvent.change(input, { target: { value: 'sin' } }))
      enter(input)
      expect.soft(useSessionStore.getState().selectedSessionId).toBe('session-a')
      expect.soft(useNavigationStore.getState().pendingProjectCreation).toBe(false)
      expect.soft(onOpenChange).not.toHaveBeenCalledWith(false)
      expect.soft(input.getAttribute('aria-activedescendant')).toBeNull()
      expect.soft(options().some((row) => row.getAttribute('aria-selected') === 'true')).toBe(false)
    }
  )

  it('does not enter creation while the artifact request is unresolved', async () => {
    const onOpenChange = vi.fn()
    const input = await mount(onOpenChange)
    let resolveSearch!: (value: typeof emptyResult) => void
    vi.mocked(window.api.projectFiles.searchArtifacts).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSearch = resolve
      })
    )
    await search(input)
    enter(input)
    expect.soft(useSessionStore.getState().selectedSessionId).toBe('session-a')
    expect.soft(onOpenChange).not.toHaveBeenCalledWith(false)
    await act(async () => resolveSearch(emptyResult))
    enter(input)
    expect(useSessionStore.getState().selectedSessionId).toBe('session-a')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each(['ArrowDown', 'ArrowUp', 'Home', 'End', 'hover', 'click'])(
    'allows explicit command selection with %s while search is pending',
    async (method) => {
      const onOpenChange = vi.fn()
      const input = await mount(onOpenChange)
      act(() => fireEvent.change(input, { target: { value: 'sin' } }))
      const command = optionWithText('New session')
      if (method === 'click') act(() => command.click())
      else {
        act(() =>
          method === 'hover'
            ? fireEvent.mouseOver(command)
            : fireEvent.keyDown(input, { key: method })
        )
        expect(command.getAttribute('aria-selected')).toBe('true')
        expect(input.getAttribute('aria-activedescendant')).toBe(command.id)
        enter(input)
      }
      expect(onOpenChange).toHaveBeenCalledWith(false)
      expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    }
  )

  it('keeps Enter inert when only Literature is still loading', async () => {
    const onOpenChange = vi.fn()
    const input = await mount(onOpenChange)
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue(emptyResult)
    let resolveLiterature!: (value: { entries: [] }) => void
    vi.mocked(window.api.literature.search).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLiterature = resolve
      })
    )
    await search(input)
    enter(input)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(input.getAttribute('aria-activedescendant')).toBeNull()
    await act(async () => resolveLiterature({ entries: [] }))
    enter(input)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useSessionStore.getState().selectedSessionId).toBe('session-a')
  })

  it('retries the hovered artifact failure while Literature is still pending', async () => {
    const onOpenChange = vi.fn()
    const input = await mount(onOpenChange)
    let resolveLiterature!: (value: { entries: [] }) => void
    vi.mocked(window.api.literature.search).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLiterature = resolve
      })
    )
    vi.mocked(window.api.projectFiles.searchArtifacts)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(emptyResult)
    await search(input)
    const retry = optionWithText('Could not load artifacts — retry')
    act(() => fireEvent.mouseOver(retry))
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect.soft(onOpenChange).not.toHaveBeenCalledWith(false)
    expect.soft(window.api.projectFiles.searchArtifacts).toHaveBeenCalledTimes(3)
    await act(async () => resolveLiterature({ entries: [] }))
  })

  it('pages all Home artifact matches and announces their total', async () => {
    useNavigationStore.setState({ view: 'home', activeProjectId: undefined })
    const files = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota'
    ].map((name) => ({
      ...artifact,
      id: name,
      name: `sin-${name}.png`,
      projectId: 'project-b',
      sessionId: 'session-b'
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockImplementation(async (request) => {
      const matching = request.primaryProjectIds.includes('project-b') ? files : []
      const offset = request.primaryCursor ? Number(request.primaryCursor) : 0
      const end = offset + request.primaryLimit
      return {
        ...emptyResult,
        primary: {
          items: matching.slice(offset, end),
          totalCount: matching.length,
          nextCursor: end < matching.length ? String(end) : undefined
        }
      }
    })
    const input = await mount()
    await search(input)
    expect(document.body.querySelector('[aria-live="polite"]')?.textContent).toBe('11 results')
    expect(options().filter((row) => row.textContent?.includes('sin-'))).toHaveLength(8)
    act(() => fireEvent.mouseOver(optionWithText('show more')))
    await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
    expect(options().filter((row) => row.textContent?.includes('sin-'))).toHaveLength(9)
    expect(document.body.textContent).toContain('sin-iota.png')
    expect(options().some((row) => row.textContent?.includes('show more'))).toBe(false)
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenLastCalledWith(
      expect.objectContaining({
        primaryProjectIds: ['project-a', 'project-b'],
        otherProjectIds: [],
        otherLimit: 0,
        primaryCursor: '8'
      })
    )
  })

  it.each(['sessions', 'artifacts', 'retry'] as const)(
    'activates the hovered %s control with Enter',
    async (kind) => {
      const onOpenChange = vi.fn()
      const input = await mount(onOpenChange)
      if (kind === 'sessions') {
        useSessionStore.setState((state) => ({
          sessions: Array.from({ length: 9 }, (_, index) => ({
            ...state.sessions[0],
            id: `matching-session-${index}`,
            title: `sin match ${index}`
          }))
        }))
        vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue(emptyResult)
      } else if (kind === 'artifacts') {
        vi.mocked(window.api.projectFiles.searchArtifacts)
          .mockResolvedValueOnce({
            ...emptyResult,
            primary: { items: [artifact], totalCount: 2, nextCursor: 'next-artifact-page' }
          })
          .mockResolvedValue({
            ...emptyResult,
            primary: { items: [{ ...artifact, id: 'last', name: 'sin-last.png' }], totalCount: 2 }
          })
      } else {
        vi.mocked(window.api.projectFiles.searchArtifacts)
          .mockRejectedValueOnce(new Error('Artifact query unavailable'))
          .mockResolvedValue(emptyResult)
      }
      await search(input)
      const row = optionWithText(
        kind === 'retry' ? 'Could not load artifacts — retry' : 'show more'
      )
      const callsBefore = vi.mocked(window.api.projectFiles.searchArtifacts).mock.calls.length
      act(() => fireEvent.mouseOver(row))
      expect.soft(row.getAttribute('aria-selected')).toBe('true')
      expect.soft(input.getAttribute('aria-activedescendant')).toBe(row.id)
      await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
      expect.soft(onOpenChange).not.toHaveBeenCalledWith(false)
      expect.soft(useSessionStore.getState().selectedSessionId).toBe('session-a')
      if (kind === 'sessions') {
        expect
          .soft(document.body.querySelectorAll('[data-testid="global-search-session-icon"]'))
          .toHaveLength(9)
      } else {
        expect.soft(window.api.projectFiles.searchArtifacts).toHaveBeenCalledTimes(callsBefore + 1)
        if (kind === 'artifacts') expect.soft(document.body.textContent).toContain('sin-last.png')
        else
          expect.soft(document.body.textContent).not.toContain('Could not load artifacts — retry')
      }
    }
  )

  it('keeps recent Sessions available and offers retry after recent artifacts fail', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts)
      .mockRejectedValueOnce(new Error('Artifact query unavailable'))
      .mockResolvedValue({ ...emptyResult, primary: { items: [artifact], totalCount: 1 } })
    await mount()
    expect(document.body.textContent).toContain('Recent sessions')
    expect(document.body.textContent).toContain('Python 绘制 sin 函数图')
    const retry = optionWithText('Could not load artifacts — retry')
    await act(async () => retry.click())
    expect(document.body.textContent).toContain('sin.png')
    expect(document.body.textContent).not.toContain('Could not load artifacts — retry')
  })

  it('expands matching Sessions when show more is clicked directly', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue(emptyResult)
    useSessionStore.setState((state) => ({
      sessions: Array.from({ length: 9 }, (_, index) => ({
        ...state.sessions[0],
        id: `matching-session-${index}`,
        title: `sin match ${index}`
      }))
    }))
    const input = await mount()
    await search(input)
    act(() => optionWithText('show more').click())
    expect(
      document.body.querySelectorAll('[data-testid="global-search-session-icon"]')
    ).toHaveLength(9)
    expect(useSessionStore.getState().selectedSessionId).toBe('session-a')
  })
})

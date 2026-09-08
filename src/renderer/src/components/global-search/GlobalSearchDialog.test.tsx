// @vitest-environment jsdom
import { act } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNavigationStore } from '@/stores/navigation-store'
import { useProjectStore } from '@/stores/project-store'
import { useSessionStore } from '@/stores/session-store'
import { usePreviewWorkbenchStore } from '@/stores/preview-workbench-store'
import { useSearchMessageFocusStore } from '@/stores/search-message-focus-store'
import { previewLeaveGuards } from '@/stores/preview-leave-guard'
import type { PersistedChatSession } from '../../../../shared/session-persistence'
import {
  artifact,
  upload,
  message,
  literature,
  collection,
  setupSearch,
  teardownSearch,
  renderSearch,
  search,
  input,
  rows,
  clickRow,
  button,
  detail,
  onClose,
  makeSession
} from './global-search.test-support'

vi.mock('@/pages/workspace/previews/PreviewFileContent', async () => {
  const { usePreviewActions } =
    await import('@/pages/workspace/preview-actions/preview-action-hooks')
  return {
    PreviewFileContent: ({ item }: { item: { name: string } }) => (
      <div data-testid="file-content" data-preview-context={!!usePreviewActions()}>
        {item.name}
      </div>
    )
  }
})
vi.mock('@/pages/workspace/artifact-preview', () => ({
  ArtifactPreview: ({
    managedFileId,
    selectedVersionId
  }: {
    managedFileId?: string
    selectedVersionId?: string
  }) => (
    <div
      data-testid="recent-file-thumbnail"
      data-file-id={managedFileId}
      data-version-id={selectedVersionId}
    />
  )
}))
vi.mock('@/pages/workspace/FilePreviewDialog', () => ({
  FilePreviewDialog: ({ item }: { item?: { name: string } }) =>
    item ? <div data-testid="library-file-dialog">{item.name}</div> : null
}))
beforeEach(setupSearch)
afterEach(teardownSearch)

const selectFilter = async (name: string, option: string): Promise<void> => {
  const trigger = screen.getByRole('combobox', { name })
  fireEvent.keyDown(trigger, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('option', { name: option }))
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
}

describe('GlobalSearchDialog', () => {
  it('opens a recent file in a large dialog while retaining the search and selected session', async () => {
    await renderSearch()
    clickRow('sessions')
    await waitFor(() => expect(detail().querySelector('.search-recent-file')).not.toBeNull())
    act(() => detail().querySelector<HTMLButtonElement>('.search-recent-file-open')!.click())
    expect(document.querySelector('[data-testid="library-file-dialog"]')?.textContent).toBe(
      'sin.png'
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
  })
  it('locates a recent generated file at its source message without opening a file preview', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: { items: [{ ...artifact, messageId: 'generated-message' }], totalCount: 1 },
      other: [],
      isIndexComplete: true
    })
    await renderSearch()
    clickRow('sessions')
    const locate = await screen.findByRole('button', { name: 'View in context for sin.png' })
    act(() => locate.click())
    await waitFor(() =>
      expect(useSearchMessageFocusStore.getState().pending).toMatchObject({
        projectId: 'project-a',
        sessionId: 'session-a',
        messageId: 'generated-message'
      })
    )
    expect(onClose).toHaveBeenCalledWith(false)
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
  })
  it('locates an uploaded file by its immutable attachment identity', async () => {
    const session: PersistedChatSession = {
      id: 'session-a',
      projectId: 'project-a',
      title: 'Alpha',
      cwd: '/workspace',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        {
          id: 'upload-message',
          role: 'user',
          status: 'complete',
          content: '',
          eventIds: [],
          createdAt: 1,
          updatedAt: 1,
          uploads: [
            {
              id: 'upload-1',
              versionId: 'version-1',
              sessionId: 'session-a',
              name: 'input.csv',
              originalName: 'input.csv',
              size: 12
            }
          ]
        }
      ]
    }
    window.api.sessions.loadOne = vi.fn().mockResolvedValue(session)
    await renderSearch()
    clickRow('uploads')
    act(() => screen.getByRole('button', { name: 'View in context for input.csv' }).click())
    await waitFor(() =>
      expect(useSearchMessageFocusStore.getState().pending?.messageId).toBe('upload-message')
    )
    expect(onClose).toHaveBeenCalledWith(false)
  })
  it('keeps search open and reports a missing source message', async () => {
    window.api.sessions.loadOne = vi.fn().mockResolvedValue(undefined)
    await renderSearch()
    clickRow('uploads')
    act(() => screen.getByRole('button', { name: 'View in context for input.csv' }).click())
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'The source message is no longer available.'
      )
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(useSearchMessageFocusStore.getState().pending).toBeUndefined()
  })
  it('restarts remote category paging when switching between All and a category', async () => {
    vi.mocked(window.api.sessions.searchMessages).mockImplementation(async ({ offset = 0 }) => ({
      items: Array.from({ length: Math.min(10, 23 - offset) }, (_, index) => ({
        ...message,
        messageId: `page-message-${offset + index}`
      })),
      totalCount: 23,
      isComplete: true,
      nextOffset: offset < 20 ? offset + 10 : undefined
    }))
    await renderSearch()
    await waitFor(() => expect(rows('messages')).toHaveLength(10))
    act(() =>
      document
        .querySelector<HTMLButtonElement>('[data-search-group="messages"] .search-show-more')!
        .click()
    )
    await waitFor(() => expect(rows('messages')).toHaveLength(20))
    act(() => document.querySelector<HTMLButtonElement>('[data-category="messages"]')!.click())
    await waitFor(() => expect(rows('messages')).toHaveLength(10))
    act(() => document.querySelector<HTMLButtonElement>('[data-category="all"]')!.click())
    await waitFor(() => expect(rows('messages')).toHaveLength(10))
  })
  it('keeps keyboard focus in the search field while selecting results on narrow screens', async () => {
    const original = window.matchMedia
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }))
    })
    try {
      await renderSearch()
      input().focus()
      fireEvent.keyDown(input(), { key: 'ArrowDown' })
      await new Promise((resolve) => requestAnimationFrame(resolve))
      expect(document.activeElement).toBe(input())
      const first = input().getAttribute('aria-activedescendant')
      fireEvent.keyDown(input(), { key: 'ArrowDown' })
      expect(input().getAttribute('aria-activedescendant')).not.toBe(first)
    } finally {
      Object.defineProperty(window, 'matchMedia', { configurable: true, value: original })
    }
  })
  it('returns to all-project scope when navigation leaves the workspace', async () => {
    await renderSearch()
    await selectFilter('Search scope', 'Current project')
    await waitFor(() =>
      expect(window.api.sessions.searchMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectIds: ['project-a'] })
      )
    )
    act(() => useNavigationStore.setState({ view: 'home' }))
    await waitFor(() =>
      expect(window.api.sessions.searchMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectIds: ['project-a', 'project-b'] })
      )
    )
    expect(screen.getByRole('combobox', { name: 'Search scope' }).textContent).toBe(
      'All projects and Library'
    )
  })
  it('applies sender, time and sorting filters before loading a category page', async () => {
    await renderSearch()
    act(() => document.querySelector<HTMLButtonElement>('[data-category="messages"]')!.click())
    await selectFilter('Refine category', 'Sent by me')
    await selectFilter('Result order', 'Recently updated')
    await selectFilter('Time range', 'Last 7 days')
    await waitFor(() =>
      expect(window.api.sessions.searchMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({
          role: 'user',
          sort: 'recent',
          updatedAfter: expect.any(Number),
          limit: 10,
          offset: undefined
        })
      )
    )
  })
  it('shows project totals and a session identity above a separate session statistics row', async () => {
    await renderSearch()
    clickRow('projects')
    await waitFor(() => expect(detail().querySelector('header')?.textContent).toContain('7 files'))
    expect(window.api.projectFiles.getOverview).toHaveBeenCalledWith({ projectId: 'project-a' })
    expect(detail().querySelector('header')?.textContent).toContain('1 session')
    expect(detail().querySelector('.search-detail-context')?.textContent).not.toContain('Alpha')
    clickRow('sessions')
    await waitFor(() =>
      expect(detail().querySelector('.search-detail-metrics')?.textContent).toContain('1 file')
    )
    expect(detail().querySelector('.search-detail-context')?.textContent).toContain('Alpha')
    expect(detail().querySelector('.search-detail-context')?.textContent).toContain('#12')
    expect(detail().querySelector('.search-detail-context')?.textContent).not.toContain(
      '15 messages'
    )
    expect(detail().querySelector('.search-detail-metrics')?.textContent).toContain('15 messages')
    expect(
      detail().querySelector('[data-testid="recent-file-thumbnail"]')?.getAttribute('data-file-id')
    ).toBe(artifact.sourceFileId)
    expect(
      detail()
        .querySelector('[data-testid="recent-file-thumbnail"]')
        ?.getAttribute('data-version-id')
    ).toBe(artifact.sourceVersionId)
  })
  it('uses the actual message first line with its conversation number, author and timestamp', async () => {
    await renderSearch()
    clickRow('messages')
    expect(detail().querySelector('h3')?.textContent).toBe('Line one')
    const context = detail().querySelector('.search-detail-context')!
    expect(context.textContent).toContain('#12 Alpha session')
    expect(context.textContent).toContain('Agent')
    expect(context.querySelector('time')?.getAttribute('dateTime')).toBe(
      new Date(message.createdAt).toISOString()
    )
  })
  it.each(['uploads', 'generated'])(
    'shows file format, size and full session identity in the %s header',
    async (kind) => {
      await renderSearch()
      clickRow(kind)
      const context = detail().querySelector('.search-detail-context')!
      expect(context.textContent).toContain('#12 Alpha session 0')
      expect(context.textContent).toContain(kind === 'uploads' ? 'CSV' : 'PNG')
      expect(context.textContent).toContain('12 B')
    }
  )
  it('shows linked projects and bibliographic context above Library tabs', async () => {
    vi.mocked(window.api.literature.search).mockResolvedValue({
      entries: [
        {
          ...literature,
          projectIds: ['project-a'],
          item: {
            ...literature.item,
            creators: [
              {
                creatorType: 'author',
                nameMode: 'person',
                givenName: 'Ada',
                familyName: 'Lovelace'
              }
            ]
          }
        }
      ],
      totalCount: 1
    })
    await renderSearch()
    clickRow('library')
    const context = detail().querySelector('.search-detail-context')!
    expect(context.textContent).toContain('Alpha')
    expect(context.textContent).toContain('Ada Lovelace')
    expect(context.textContent).toContain('2024')
    expect(context.textContent).toContain('Journal')
  })
  it('ignores project totals returned after selecting a different result', async () => {
    let resolveOverview!: (
      value: Awaited<ReturnType<typeof window.api.projectFiles.getOverview>>
    ) => void
    vi.mocked(window.api.projectFiles.getOverview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOverview = resolve
        })
    )
    await renderSearch()
    clickRow('projects')
    clickRow('sessions')
    await act(async () =>
      resolveOverview({
        totalCount: 99,
        uploadCount: 0,
        artifactCount: 99,
        artifactGroupCount: 99,
        isIndexComplete: true
      })
    )
    await waitFor(() =>
      expect(detail().querySelector('.search-detail-metrics')?.textContent).toContain('1 file')
    )
    expect(detail().querySelector('header')?.textContent).not.toContain('99 files')
  })
  it.each(['incomplete', 'error'])(
    'keeps recent sessions available when project counts are %s',
    async (state) => {
      if (state === 'error')
        vi.mocked(window.api.projectFiles.getOverview).mockRejectedValue(new Error('unavailable'))
      else
        vi.mocked(window.api.projectFiles.getOverview).mockResolvedValue({
          totalCount: 0,
          uploadCount: 0,
          artifactCount: 0,
          artifactGroupCount: 0,
          isIndexComplete: false
        })
      await renderSearch()
      clickRow('projects')
      await waitFor(() =>
        expect(detail().querySelector('header')?.textContent).toContain(
          'Some results are unavailable.'
        )
      )
      expect(detail().querySelector('header')?.textContent).not.toContain('0 files')
      expect(detail().querySelector('[role="tabpanel"]')?.textContent).toContain('Alpha session 0')
    }
  )
  it('starts in All with no selection and reuses the animated detail pane across selections', async () => {
    await renderSearch()
    expect(document.querySelector('[data-category="all"]')?.getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(detail().dataset.open).toBe('false')
    expect(document.querySelector('[aria-selected="true"][role="option"]')).toBeNull()
    const panel = detail()
    clickRow('generated')
    expect(panel.dataset.open).toBe('true')
    expect(panel.textContent).toContain('File information')
    clickRow('sessions')
    expect(detail()).toBe(panel)
    expect(panel.textContent).toContain('Recent files')
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Collapse details"]')!.click())
    expect(panel.dataset.open).toBe('false')
  })
  it('searches all projects by default and applies an explicit current-project filter', async () => {
    await renderSearch()
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryProjectIds: ['project-a', 'project-b'],
        source: 'upload',
        primaryLimit: 10
      })
    )
    expect(window.api.sessions.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ projectIds: ['project-a', 'project-b'] })
    )
    await selectFilter('Search scope', 'Current project')
    await waitFor(() =>
      expect(window.api.sessions.searchMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectIds: ['project-a'] })
      )
    )
    expect(rows('projects')).toHaveLength(1)
  })
  it('searches project descriptions and session numbers separately from message bodies', async () => {
    await renderSearch()
    await search('Wave')
    expect(rows('projects')).toHaveLength(1)
    expect(rows('sessions')).toHaveLength(0)
    await search('12')
    expect(rows('sessions')[0]?.textContent).toContain('#12')
    expect(rows('messages')).toHaveLength(1)
  })
  it('keeps healthy categories visible when one source fails and retries that category', async () => {
    vi.mocked(window.api.sessions.searchMessages).mockRejectedValueOnce(
      new Error('private failure')
    )
    await renderSearch()
    expect(rows('sessions')).toHaveLength(2)
    expect(document.body.textContent).toContain('Could not load search results.')
    expect(document.body.textContent).not.toContain('private failure')
    await act(async () => button('Retry').click())
    expect(rows('messages')).toHaveLength(1)
  })
  it('shows incomplete results without hiding healthy matches', async () => {
    vi.mocked(window.api.sessions.searchMessages).mockResolvedValue({
      items: [message],
      totalCount: 1,
      isComplete: false
    })
    await renderSearch()
    expect(rows('messages')).toHaveLength(1)
    expect(document.body.textContent).toContain('Some results are unavailable.')
  })
  it('appends ten results inside one group and preserves its selected detail', async () => {
    useSessionStore.setState({ sessions: Array.from({ length: 23 }, (_, i) => makeSession(i)) })
    await renderSearch()
    expect(rows('sessions')).toHaveLength(10)
    clickRow('sessions')
    const panel = detail()
    const more = button('Show more10/23')
    expect(more.classList.contains('mx-auto')).toBe(true)
    act(() => more.click())
    expect(rows('sessions')).toHaveLength(20)
    expect(detail()).toBe(panel)
    expect(panel.dataset.open).toBe('true')
    act(() => button('Show more20/23').click())
    expect(rows('sessions')).toHaveLength(23)
  })
  it('loads filtered categories on scroll in batches of ten without duplicating requests', async () => {
    const files = Array.from({ length: 23 }, (_, i) => ({
      ...artifact,
      id: String(i),
      name: `${i}.png`
    }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockImplementation(async (request) => {
      const offset = Number(request.primaryCursor ?? 0)
      return {
        primary: {
          items: files.slice(offset, offset + 10),
          totalCount: 23,
          nextCursor: offset + 10 < 23 ? String(offset + 10) : undefined
        },
        other: [],
        isIndexComplete: true
      }
    })
    await renderSearch()
    act(() => document.querySelector<HTMLButtonElement>('[data-category="generated"]')!.click())
    await waitFor(() => expect(rows('generated')).toHaveLength(10))
    await act(async () => {
      const viewport = document.querySelector('.global-search-list')!
      fireEvent.scroll(viewport)
      fireEvent.scroll(viewport)
    })
    expect(rows('generated')).toHaveLength(20)
    expect(
      vi
        .mocked(window.api.projectFiles.searchArtifacts)
        .mock.calls.filter(
          ([request]) => request.source === 'artifact' && request.primaryCursor === '10'
        )
    ).toHaveLength(1)
  })
  it('stops at the final cursor when concurrent inserts change the displayed total', async () => {
    const files = Array.from({ length: 20 }, (_, i) => ({ ...artifact, id: String(i) }))
    vi.mocked(window.api.projectFiles.searchArtifacts).mockImplementation(async (request) => ({
      primary:
        request.source === 'upload'
          ? { items: [], totalCount: 0 }
          : {
              items: files.slice(request.primaryCursor ? 10 : 0, request.primaryCursor ? 20 : 10),
              totalCount: request.primaryCursor ? 21 : 20,
              nextCursor: request.primaryCursor ? undefined : 'next'
            },
      other: [],
      isIndexComplete: true
    }))
    await renderSearch()
    await act(async () => button('Show more10/20').click())
    expect(rows('generated')).toHaveLength(20)
    expect(document.body.textContent).not.toContain('Show more20/21')
    act(() => document.querySelector<HTMLButtonElement>('[data-category="generated"]')!.click())
    await waitFor(() => expect(rows('generated')).toHaveLength(10))
    await act(async () => fireEvent.scroll(document.querySelector('.global-search-list')!))
    expect(rows('generated')).toHaveLength(20)
    await act(async () => fireEvent.scroll(document.querySelector('.global-search-list')!))
    expect(rows('generated')).toHaveLength(20)
  })
  it('loads a filtered next page when the end is visible without a scrollable viewport', async () => {
    const callbacks: IntersectionObserverCallback[] = []
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          callbacks.push(callback)
        }
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    try {
      useSessionStore.setState({ sessions: Array.from({ length: 23 }, (_, i) => makeSession(i)) })
      await renderSearch()
      const viewport = document.querySelector('.global-search-list')!
      Object.defineProperties(viewport, {
        clientHeight: { value: 1000 },
        scrollHeight: { value: 600 }
      })
      act(() => document.querySelector<HTMLButtonElement>('[data-category="sessions"]')!.click())
      expect(rows('sessions')).toHaveLength(10)
      act(() =>
        callbacks.at(-1)?.(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
      expect(rows('sessions')).toHaveLength(20)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('discards delayed results after the query changes', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof window.api.sessions.searchMessages>>) => void
    vi.mocked(window.api.sessions.searchMessages).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    await renderSearch()
    await search('new')
    await act(async () =>
      resolveOld({
        items: [{ ...message, messageId: 'stale', content: 'STALE CONTENT' }],
        totalCount: 1,
        isComplete: true
      })
    )
    expect(document.body.textContent).not.toContain('STALE CONTENT')
  })
  it('opens only the hit message and records its exact navigation identity', async () => {
    await renderSearch()
    await search('sin')
    clickRow('messages')
    expect(detail().querySelector('mark')?.textContent).toBe('sin')
    expect(detail().querySelectorAll('[role="tab"]')).toHaveLength(0)
    act(() => button('Jump to message').click())
    expect(useSearchMessageFocusStore.getState().pending).toMatchObject({
      projectId: 'project-a',
      sessionId: 'session-a',
      messageId: 'hit-message'
    })
    expect(onClose).toHaveBeenCalledWith(false)
  })
  it.each(['uploads', 'generated'])(
    'uses preview/info tabs and the transient file modal for %s',
    async (category) => {
      await renderSearch()
      clickRow(category)
      expect(detail().querySelector('[data-testid="file-content"]')).not.toBeNull()
      act(() => button('File information').click())
      expect(detail().querySelector('[data-testid="file-content"]')).toBeNull()
      expect(detail().textContent).toContain('File size')
      act(() => button('Open file').click())
      expect(document.querySelector('[data-testid="library-file-dialog"]')?.textContent).toBe(
        category === 'uploads' ? upload.name : artifact.name
      )
      expect(onClose).not.toHaveBeenCalled()
      expect(usePreviewWorkbenchStore.getState().items).toHaveLength(0)
    }
  )
  it('resumes cross-project file opening after the existing leave guard accepts', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: {
        items: [{ ...artifact, projectId: 'project-b', sessionId: 'session-b' }],
        totalCount: 1
      },
      other: [],
      isIndexComplete: true
    })
    let resume: (() => void) | undefined
    usePreviewWorkbenchStore.setState({ activeProjectId: 'project-a', activeItemId: 'active-file' })
    const unregister = previewLeaveGuards.register('workbench:project-a:active-file', (proceed) => {
      resume = proceed
      return false
    })
    await renderSearch()
    clickRow('generated')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(usePreviewWorkbenchStore.getState().fileDialogItem).toBeUndefined()
    unregister()
    act(() => resume?.())
    expect(usePreviewWorkbenchStore.getState().fileDialogItem?.projectId).toBe('project-b')
  })
  it('resolves the current immutable file head before mentioning', async () => {
    await renderSearch()
    clickRow('generated')
    await act(async () => fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true }))
    expect(useNavigationStore.getState().pendingArtifactMention).toMatchObject({
      sourceVersionId: 'version-2',
      checksum: 'head-checksum',
      name: 'current.png'
    })
  })
  it('keeps the dialog open on mention failure and suppresses stale completions after closing', async () => {
    vi.mocked(window.api.managedFileVersions.inspect).mockRejectedValueOnce(new Error('failure'))
    await renderSearch()
    clickRow('generated')
    await act(async () => fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true }))
    expect(document.body.textContent).toContain('Could not resolve file version.')
    expect(onClose).not.toHaveBeenCalled()
    let finish!: (value: Awaited<ReturnType<typeof window.api.managedFileVersions.inspect>>) => void
    vi.mocked(window.api.managedFileVersions.inspect).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    act(() => fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true }))
    await renderSearch(false)
    await act(async () =>
      finish({ ok: false, error: { code: 'VERSION_NOT_FOUND', message: 'missing' } })
    )
    expect(useNavigationStore.getState().pendingArtifactMention).toBeUndefined()
  })
  it('falls back to file opening when mentioning is unavailable', async () => {
    useNavigationStore.setState({
      artifactMentionAvailability: { projectId: 'project-a', canMention: false }
    })
    await renderSearch()
    clickRow('generated')
    await act(async () => fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true }))
    expect(usePreviewWorkbenchStore.getState().fileDialogItem?.managedFileId).toBe('artifact-1')
    expect(window.api.managedFileVersions.inspect).not.toHaveBeenCalled()
  })
  it('shows ten recent sessions and loads ten recent files with accurate session counts', async () => {
    useSessionStore.setState({ sessions: Array.from({ length: 15 }, (_, i) => makeSession(i)) })
    await renderSearch()
    clickRow('projects')
    expect(detail().querySelectorAll('[role="tabpanel"] button')).toHaveLength(10)
    clickRow('sessions')
    await waitFor(() => expect(detail().textContent).toContain('1 file'))
    expect(detail().textContent).toContain('15 messages')
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'all', sessionId: 'session-a', primaryLimit: 10 })
    )
  })
  it('unifies literature and collections with tabs and collection navigation', async () => {
    await renderSearch()
    clickRow('library')
    expect(detail().textContent).toContain(literature.item.abstract)
    act(() => button('Details').click())
    expect(detail().textContent).toContain('Journal')
    clickRow('library', 1)
    expect(detail().textContent).toContain('Recent literature')
    await waitFor(() =>
      expect(window.api.literature.search).toHaveBeenCalledWith(
        expect.objectContaining({ collectionId: collection.id, limit: 10 })
      )
    )
    act(() => button('Open collection').click())
    expect(useNavigationStore.getState().view).toBe('library')
  })
  it('opens a Library PDF in the existing file dialog from the preview tab', async () => {
    vi.mocked(window.api.literature.search).mockResolvedValue({
      entries: [
        {
          ...literature,
          attachments: [
            {
              id: 'attachment',
              kind: 'fullText',
              title: 'Paper PDF',
              sortOrder: 0,
              createdAt: 1,
              updatedAt: 1,
              versions: [
                {
                  id: 'pdf-version',
                  versionNumber: 1,
                  filename: 'paper.pdf',
                  contentType: 'application/pdf',
                  sizeBytes: 500,
                  checksum: 'a'.repeat(64),
                  createdAt: 1
                }
              ]
            }
          ]
        }
      ],
      totalCount: 1
    })
    await renderSearch()
    clickRow('library')
    act(() => button('Preview').click())
    expect(document.querySelector('[data-testid="file-content"]')?.textContent).toBe('paper.pdf')
    act(() => button('Open file').click())
    expect(document.querySelector('[data-testid="library-file-dialog"]')?.textContent).toBe(
      'paper.pdf'
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(useNavigationStore.getState().view).toBe('workspace')
  })
  it('excludes archived projects and pending/archived sessions from all sources', async () => {
    useProjectStore.setState((state) => ({
      projects: state.projects.map((item) =>
        item.id === 'project-b' ? { ...item, archivedAt: 1 } : item
      )
    }))
    useSessionStore.setState((state) => ({
      sessions: [
        ...state.sessions,
        { ...makeSession(2), archivedAt: 1 },
        { ...makeSession(3), isPending: true }
      ]
    }))
    await renderSearch()
    expect(rows('sessions')).toHaveLength(1)
    expect(window.api.sessions.searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIds: ['project-a'],
        excludedSessionIds: ['session-2', 'session-3']
      })
    )
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryProjectIds: ['project-a'],
        excludedSessionIds: ['session-2', 'session-3']
      })
    )
  })
  it('does not restart file queries for terminal output changes', async () => {
    await renderSearch()
    const calls = vi.mocked(window.api.projectFiles.searchArtifacts).mock.calls.length
    act(() =>
      useSessionStore.setState((state) => ({
        sessions: state.sessions.map((session) => ({
          ...session,
          agentStatus: 'new terminal output'
        }))
      }))
    )
    expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledTimes(calls)
  })
  it('dismisses the shared preview menu before collapsing details on Escape', async () => {
    await renderSearch()
    clickRow('uploads')
    await act(async () =>
      fireEvent.contextMenu(document.querySelector('[data-testid="file-content"]')!, {
        clientX: 30,
        clientY: 40
      })
    )
    const menu = document.querySelector('[role="menu"]')!
    expect(menu).not.toBeNull()
    await act(async () => fireEvent.keyDown(menu, { key: 'Escape' }))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(detail().dataset.open).toBe('true')
    expect(onClose).not.toHaveBeenCalled()
  })
  it('supports keyboard selection without hover selection and collapses before Escape closes', async () => {
    await renderSearch()
    act(() => fireEvent.mouseEnter(rows()[0]!))
    expect(detail().dataset.open).toBe('false')
    act(() => fireEvent.keyDown(input(), { key: 'ArrowDown' }))
    expect(detail().dataset.open).toBe('true')
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }))
    expect(detail().dataset.open).toBe('false')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => fireEvent.keyDown(input(), { key: 'Escape' }))
    expect(onClose).toHaveBeenCalledWith(false)
  })
  it('keeps Enter inert without a selected result and retains explicit creation', async () => {
    await renderSearch()
    act(() => fireEvent.keyDown(input(), { key: 'Enter' }))
    expect(onClose).not.toHaveBeenCalled()
    act(() => button('New session').click())
    expect(useSessionStore.getState().selectedSessionId).toBeUndefined()
    expect(onClose).toHaveBeenCalledWith(false)
  })
})

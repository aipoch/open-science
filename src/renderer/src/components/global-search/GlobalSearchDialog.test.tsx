import { LITERATURE_OVERSIZED_REFERENCE } from '../../../../shared/literature-export'
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
import { createMessageSearch } from '../../../../main/session-persistence/message-search'
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
    PreviewFileContent: ({ item }: { item: { name: string; selectedVersionId?: string } }) => (
      <div
        data-testid="file-content"
        data-preview-context={!!usePreviewActions()}
        data-version-id={item.selectedVersionId}
      >
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
  it.each([false, true])(
    'refreshes Library changes without accepting stale results (pending: %s)',
    async (pending) => {
      let notify: () => void = () => undefined
      window.api.literature.onChanged = vi.fn((listener) => {
        notify = () => listener({ revision: 1 })
        return () => undefined
      })
      let resolveOld!: (page: { entries: (typeof literature)[]; totalCount: number }) => void
      const oldPage = { entries: [literature], totalCount: 1 }
      vi.mocked(window.api.literature.search).mockReturnValueOnce(
        pending ? new Promise((resolve) => (resolveOld = resolve)) : Promise.resolve(oldPage)
      )
      await renderSearch()
      await waitFor(() => expect(window.api.literature.search).toHaveBeenCalled())
      const updated = { ...literature, item: { ...literature.item, title: 'Updated reference' } }
      vi.mocked(window.api.literature.search).mockResolvedValue({
        entries: [updated],
        totalCount: 1
      })
      const fileRequests = vi.mocked(window.api.projectFiles.searchArtifacts).mock.calls.length
      await act(async () => notify())
      await waitFor(() => expect(rows('library')[0]?.textContent).toContain('Updated reference'))
      if (pending) await act(async () => resolveOld(oldPage))
      expect(rows('library')[0]?.textContent).toContain('Updated reference')
      expect(window.api.projectFiles.searchArtifacts).toHaveBeenCalledTimes(fileRequests)
      await renderSearch(false)
      const libraryRequests = vi.mocked(window.api.literature.search).mock.calls.length
      await act(async () => notify())
      expect(window.api.literature.search).toHaveBeenCalledTimes(libraryRequests)
    }
  )

  it('loads complete long messages from the real search excerpt', async () => {
    const content =
      '## Opening heading\n\n' + 'Context sentence.\n\n'.repeat(500) + '**sin** final paragraph.'
    const transcript = {
      ...makeSession(0),
      messages: [{ ...message, id: 'long-message', role: 'user' as const, content }]
    }
    vi.mocked(window.api.sessions.searchMessages).mockImplementation(
      createMessageSearch({
        list: async () => ({
          sessions: [
            {
              ...transcript,
              number: 1,
              revision: 1,
              pinned: false,
              artifactCount: 0,
              filesRevision: 0,
              activeMessageCount: 1,
              presentedStatus: 'idle' as const,
              needsStartupRecovery: false
            }
          ]
        }),
        loadOne: async () => transcript as unknown as PersistedChatSession
      })
    )
    window.api.sessions.loadOne = vi.fn().mockResolvedValue(transcript)
    await renderSearch()
    clickRow('messages')
    await waitFor(() => expect(detail().querySelector('h2')?.textContent).toBe('Opening heading'))
    expect(detail().querySelector('.search-message-content')?.textContent).toContain(
      'sin final paragraph.'
    )
  })

  it('ignores a delayed complete-message read after another result is selected', async () => {
    let resolve!: (value: PersistedChatSession) => void
    vi.mocked(window.api.sessions.searchMessages).mockResolvedValue({
      items: [{ ...message, contentTruncated: true }],
      totalCount: 1,
      isComplete: true
    })
    window.api.sessions.loadOne = vi.fn(
      () =>
        new Promise<PersistedChatSession>((done) => {
          resolve = done
        })
    )
    await renderSearch()
    clickRow('messages')
    await waitFor(() => expect(window.api.sessions.loadOne).toHaveBeenCalledOnce())
    clickRow('projects')
    await act(async () =>
      resolve({
        ...makeSession(0),
        messages: [
          { ...message, id: message.messageId, role: 'user', content: 'Late full message' }
        ]
      } as unknown as PersistedChatSession)
    )
    expect(detail().textContent).not.toContain('Late full message')
    expect(screen.getByRole('tab', { name: 'Recent sessions' })).toBeTruthy()
  })

  it('reports a removed message instead of presenting its excerpt as complete', async () => {
    vi.mocked(window.api.sessions.searchMessages).mockResolvedValue({
      items: [{ ...message, contentTruncated: true }],
      totalCount: 1,
      isComplete: true
    })
    window.api.sessions.loadOne = vi.fn().mockResolvedValue(undefined)
    await renderSearch()
    clickRow('messages')
    await waitFor(() =>
      expect(detail().textContent).toContain('The source message is no longer available.')
    )
    expect(detail().querySelector('.search-message-content')).toBeNull()
  })

  it.each([
    ['sin', 'answer'],
    ['Checking', 'progress']
  ])(
    'pages grouped turn matches for %s and jumps to the selected fragment',
    async (query, target) => {
      const session = {
        ...makeSession(0),
        contentLoaded: undefined,
        messages: Array.from({ length: 12 }, (_, index) => {
          const promptId = `prompt-${index}`
          return [
            { id: promptId, role: 'user' as const, content: `Question ${index}` },
            {
              id: `progress-${index}`,
              role: 'agent' as const,
              responseToMessageId: promptId,
              content: `Checking sin sources ${index}`
            },
            {
              id: `answer-${index}`,
              role: 'agent' as const,
              responseToMessageId: promptId,
              content: `Answer ${index}\n\nsin evidence and sin conclusion ${index}`
            }
          ].map((message, part) => ({
            ...message,
            status: 'complete' as const,
            eventIds: [],
            createdAt: index * 3 + part,
            updatedAt: index * 3 + part
          }))
        }).flat()
      }
      useSessionStore.setState({ sessions: [session] })
      vi.mocked(window.api.sessions.searchMessages).mockImplementation(
        createMessageSearch({
          list: async () => ({
            sessions: [
              {
                ...session,
                number: 12,
                pinned: false,
                revision: 1,
                artifactCount: 0,
                filesRevision: 0,
                activeMessageCount: session.messages.length,
                presentedStatus: session.status,
                needsStartupRecovery: false
              }
            ]
          }),
          loadOne: async () => session
        })
      )
      await renderSearch()
      await search(query)
      expect(rows('messages')).toHaveLength(10)
      act(() => button('Load more10/12').click())
      await waitFor(() => expect(rows('messages')).toHaveLength(12))
      expect(new Set(rows('messages').map((row) => row.textContent)).size).toBe(12)
      clickRow('messages')
      const expectedContent =
        target === 'answer' ? 'sin evidence and sin conclusion 11' : 'Checking sin sources 11'
      await waitFor(() =>
        expect(detail().querySelector('.search-message-content')?.textContent).toContain(
          expectedContent
        )
      )
      act(() => button('Jump to message').click())
      await waitFor(() =>
        expect(useSearchMessageFocusStore.getState().pending).toMatchObject({
          projectId: session.projectId,
          sessionId: session.id,
          messageId: `${target}-11`
        })
      )
      expect(onClose).toHaveBeenCalledWith(false)
    }
  )

  it('keeps a body match pinned to the searched file Version', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: {
        items: [
          { ...upload, name: 'notes.md', contentMatch: { offset: 0, startingLineNumber: 1 } }
        ],
        totalCount: 1
      },
      other: [],
      isIndexComplete: true
    })
    await renderSearch()
    clickRow('uploads')
    expect(
      detail().querySelector('[data-testid="file-content"]')?.getAttribute('data-version-id')
    ).toBe('version-1')
  })
  it('labels standalone uploads as Local computer without a message navigation action', async () => {
    vi.mocked(window.api.projectFiles.searchArtifacts).mockResolvedValue({
      primary: {
        items: [{ ...upload, sessionId: 'standalone-uploads', originSession: undefined }],
        totalCount: 1
      },
      other: [],
      isIndexComplete: true
    })
    await renderSearch()
    clickRow('uploads')
    expect(detail().querySelector('.search-detail-context')?.textContent).toContain(
      'AlphaLocal computer'
    )
    expect(screen.queryByRole('button', { name: 'Jump to message' })).toBeNull()
    act(() => screen.getByRole('tab', { name: 'File information' }).click())
    expect(detail().querySelector('[role="tabpanel"]')?.textContent).toContain('Local computer')
  })
  it('shows recent project files and the project agent instructions in separate tabs', async () => {
    useProjectStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        agentContext: 'Cite primary sources.'
      }))
    }))
    await renderSearch()
    clickRow('projects')
    act(() => screen.getByRole('tab', { name: 'Recent files' }).click())
    await waitFor(() => expect(detail().querySelector('.search-recent-file')).not.toBeNull())
    act(() => screen.getByRole('tab', { name: 'Details' }).click())
    expect(detail().textContent).toContain('Wave research')
    expect(detail().textContent).toContain('Cite primary sources.')
  })
  it('renders the complete matched message as Markdown', async () => {
    vi.mocked(window.api.sessions.searchMessages).mockResolvedValue({
      items: [{ ...message, content: '## Research\n\n**sin** matched\n\nFinal paragraph.' }],
      totalCount: 1,
      isComplete: true
    })
    await renderSearch()
    clickRow('messages')
    await waitFor(() => expect(detail().querySelector('h2')?.textContent).toBe('Research'))
    expect(detail().querySelector('.search-message-content')?.textContent).toContain('sin matched')
    expect(detail().textContent).toContain('Final paragraph.')
    expect(detail().querySelector('.search-message-excerpt')).toBeNull()
  })
  it('keeps file preview content selectable and exposes full screen and context actions as buttons', async () => {
    await renderSearch()
    clickRow('uploads')
    expect(detail().querySelector('.search-file-preview-open')).toBeNull()
    fireEvent.click(detail().querySelector('[data-testid="file-content"]')!)
    expect(document.querySelector('[data-testid="library-file-dialog"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Jump to message' }).textContent).toContain(
      'Jump to message'
    )
    act(() => screen.getByRole('button', { name: 'Open full screen preview' }).click())
    expect(document.querySelector('[data-testid="library-file-dialog"]')).not.toBeNull()
  })
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
    act(() => screen.getByRole('button', { name: 'Jump to message' }).click())
    await waitFor(() =>
      expect(useSearchMessageFocusStore.getState().pending?.messageId).toBe('upload-message')
    )
    expect(onClose).toHaveBeenCalledWith(false)
  })
  it('keeps search open and reports a missing source message', async () => {
    window.api.sessions.loadOne = vi.fn().mockResolvedValue(undefined)
    await renderSearch()
    clickRow('uploads')
    act(() => screen.getByRole('button', { name: 'Jump to message' }).click())
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'The source message is no longer available.'
      )
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(useSearchMessageFocusStore.getState().pending).toBeUndefined()
  })
  it('restarts remote category paging when switching between All and a category', async () => {
    vi.mocked(window.api.sessions.searchMessages).mockImplementation(async ({ cursor }) => {
      const offset = Number(cursor ?? 0)
      return {
        items: Array.from({ length: Math.min(10, 23 - offset) }, (_, index) => ({
          ...message,
          messageId: `page-message-${offset + index}`
        })),
        totalCount: 23,
        isComplete: true,
        nextCursor: offset < 20 ? String(offset + 10) : undefined
      }
    })
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
          cursor: undefined
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
        expect(detail().querySelector('header')?.textContent).not.toContain('Loading…')
      )
      expect(detail().querySelector('header')?.textContent).not.toContain('0 files')
      expect(detail().querySelector('header')?.textContent).not.toContain(
        'Some results are unavailable.'
      )
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
  it.each(['all', 'messages'])(
    'waits until the final available page before showing incomplete results in %s',
    async (category) => {
      const messages = Array.from({ length: 23 }, (_, index) => ({
        ...message,
        messageId: `paged-message-${index}`
      }))
      vi.mocked(window.api.sessions.searchMessages).mockImplementation(async (request) => {
        const offset = Number(request.cursor ?? 0)
        return {
          items: messages.slice(offset, offset + 10),
          totalCount: 24,
          nextCursor: offset + 10 < messages.length ? String(offset + 10) : undefined,
          isComplete: false
        }
      })
      await renderSearch()
      if (category === 'messages') {
        act(() => document.querySelector<HTMLButtonElement>('[data-category="messages"]')!.click())
        await waitFor(() => expect(rows('messages')).toHaveLength(10))
      }
      const group = (): Element => document.querySelector('[data-search-group="messages"]')!
      expect(group().textContent).not.toContain('Some results are unavailable.')
      for (const count of [20, 23]) {
        await act(async () => {
          if (category === 'all')
            group().querySelector<HTMLButtonElement>('.search-show-more')!.click()
          else fireEvent.scroll(document.querySelector('.global-search-list')!)
        })
        expect(rows('messages')).toHaveLength(count)
        if (count === 20) expect(group().textContent).not.toContain('Some results are unavailable.')
      }
      expect(group().textContent).toContain('Some results are unavailable.')
    }
  )
  it('appends ten results inside one group and preserves its selected detail', async () => {
    useSessionStore.setState({ sessions: Array.from({ length: 23 }, (_, i) => makeSession(i)) })
    await renderSearch()
    expect(rows('sessions')).toHaveLength(10)
    clickRow('sessions')
    const panel = detail()
    const more = button('Load more10/23')
    expect(more.classList.contains('mx-auto')).toBe(true)
    act(() => more.click())
    expect(rows('sessions')).toHaveLength(20)
    expect(detail()).toBe(panel)
    expect(panel.dataset.open).toBe('true')
    act(() => button('Load more20/23').click())
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
    await act(async () => button('Load more10/20').click())
    expect(rows('generated')).toHaveLength(20)
    expect(document.body.textContent).not.toContain('Load more20/21')
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
    expect(
      detail().querySelector('.search-message-content')?.getAttribute('data-search-match-count')
    ).toBe('1')
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
      act(() => button('Open full screen preview').click())
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
  it('fills recent collection literature across smaller transport pages', async () => {
    vi.mocked(window.api.literature.search).mockImplementation(async (request) => {
      if (request.scope === 'global-search') return { entries: [collection], totalCount: 1 }
      if (request.scope !== 'library') return { entries: [] }
      return request.offset
        ? {
            entries: [
              { ...literature, id: 'later', item: { ...literature.item, title: 'Later paper' } }
            ],
            totalCount: 2
          }
        : { entries: [literature], nextOffset: 1, totalCount: 2 }
    })
    await renderSearch()
    clickRow('library')
    await waitFor(() => expect(detail().textContent).toContain('Later paper'))
    expect(detail().textContent).toContain(literature.item.title)
  })
  it.each(['single', 'paged', 'oversized'])(
    'opens a Library PDF from %s transport pages without leaving search',
    async (kind) => {
      const pdfRecord = {
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
      const encoded = JSON.stringify(pdfRecord)
      window.api.literature.exportRecord = vi
        .fn()
        .mockResolvedValueOnce({
          chunk: encoded.slice(0, 100),
          digest: 'a'.repeat(64),
          nextOffset: 100
        })
        .mockResolvedValueOnce({ chunk: encoded.slice(100), digest: 'a'.repeat(64) })
      vi.mocked(window.api.literature.search).mockImplementation(async (request) => {
        if (request.scope !== 'global-search') return { entries: [] }
        if (request.countOnly) return { entries: [], totalCount: 1 }
        if (kind === 'oversized') throw new Error(LITERATURE_OVERSIZED_REFERENCE + pdfRecord.id)
        if (kind === 'paged' && !request.offset)
          return {
            entries: [
              { ...literature, id: 'first', item: { ...literature.item, title: 'Another result' } }
            ],
            totalCount: 2,
            nextOffset: 1
          }
        return { entries: [pdfRecord], totalCount: kind === 'paged' ? 2 : 1 }
      })
      await renderSearch()
      await waitFor(() => expect(rows('library')).toHaveLength(kind === 'paged' ? 2 : 1))
      clickRow('library', kind === 'paged' ? 1 : 0)
      act(() => button('Preview').click())
      expect(document.querySelector('[data-testid="file-content"]')?.textContent).toBe('paper.pdf')
      act(() => button('Open file').click())
      expect(document.querySelector('[data-testid="library-file-dialog"]')?.textContent).toBe(
        'paper.pdf'
      )
      expect(onClose).not.toHaveBeenCalled()
      expect(useNavigationStore.getState().view).toBe('workspace')
    }
  )
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

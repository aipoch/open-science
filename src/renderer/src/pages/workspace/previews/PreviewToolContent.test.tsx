// @vitest-environment jsdom

import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewToolItem } from '@/stores/preview-workbench-store'

const mocks = vi.hoisted(() => ({
  activeProjectId: 'project-1' as string | undefined,
  getReviewSnapshot: vi.fn(),
  loadError: undefined as string | undefined,
  loadReviewsForSession: vi.fn<() => Promise<void>>()
}))

vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: <T,>(selector: (state: { activeProjectId?: string }) => T): T =>
    selector({ activeProjectId: mocks.activeProjectId })
}))
vi.mock('@/stores/review-store', () => ({
  selectProjectSessionReviewSnapshot: (
    _reviewsBySession: Record<string, never[]>,
    projectId: string | undefined,
    sessionId: string,
    loadedReviewSessions: Record<string, boolean>
  ) => {
    void loadedReviewSessions
    return mocks.getReviewSnapshot(sessionId, projectId)
  },
  selectProjectSessionReviewLoadError: () => mocks.loadError,
  useReviewStore: <T,>(
    selector: (state: {
      reviewsBySession: Record<string, never[]>
      loadedReviewSessions: Record<string, boolean>
      loadErrorsBySession: Record<string, string>
      loadReviewsForSession: () => Promise<void>
    }) => T
  ): T =>
    selector({
      reviewsBySession: {},
      loadedReviewSessions: {},
      loadErrorsBySession: {},
      loadReviewsForSession: mocks.loadReviewsForSession
    })
}))
vi.mock('../NotebookPreview', () => ({
  NotebookPreview: ({ item }: { item: PreviewToolItem }): React.JSX.Element => (
    <div data-testid="notebook-preview">{item.notebook?.sessionId}</div>
  )
}))
vi.mock('../ProjectFilesView', () => ({
  ProjectFilesView: (): React.JSX.Element => <div data-testid="project-files">files</div>
}))
vi.mock('../ProjectComputeInbox', () => ({
  ProjectComputeInbox: (): React.JSX.Element => <div data-testid="project-compute">compute</div>
}))
vi.mock('../SessionReviewerPanel', () => ({
  SessionReviewerPanel: ({
    review,
    activeFindingId
  }: {
    review: { id: string }
    activeFindingId?: string
  }): React.JSX.Element => (
    <div data-testid="reviewer-panel">
      {review.id}:{activeFindingId ?? ''}
    </div>
  )
}))

import { PreviewToolContent } from './PreviewToolContent'

const createItem = (overrides: Partial<PreviewToolItem>): PreviewToolItem => ({
  id: 'tool-1',
  sessionId: 'session-1',
  title: 'Tool',
  type: 'tool',
  ...overrides
})

const render = (item: PreviewToolItem): string =>
  renderToStaticMarkup(<PreviewToolContent item={item} />)

describe('PreviewToolContent', () => {
  beforeEach(() => {
    mocks.activeProjectId = 'project-1'
    mocks.getReviewSnapshot.mockReturnValue([])
    mocks.loadError = undefined
    mocks.loadReviewsForSession.mockReset().mockResolvedValue(undefined)
  })

  it('routes project file tools through a project-scoped remount boundary', () => {
    expect(render(createItem({ toolKind: 'files' }))).toContain('data-testid="project-files"')
  })

  it('routes Project Compute through a project-scoped remount boundary', () => {
    expect(render(createItem({ toolKind: 'compute' }))).toContain('data-testid="project-compute"')
  })

  it('shows the reviewer empty state when the requested session has no reviews', () => {
    const html = render(createItem({ toolKind: 'reviewer', reviewerSessionId: 'review-session' }))

    expect(mocks.getReviewSnapshot).toHaveBeenCalledWith('review-session', 'project-1')
    expect(html).toContain('No review available for this session.')
  })

  it('does not report a missing review before the artifact source session is loaded', () => {
    mocks.getReviewSnapshot.mockReturnValue(undefined)

    const html = render(
      createItem({
        toolKind: 'reviewer',
        reviewerSessionId: 'artifact-source-session',
        reviewerReviewId: 'review-from-artifact-provenance'
      })
    )

    expect(html).toContain('Loading review history…')
    expect(html).not.toContain('No review available for this session.')
  })

  it('loads review history for the artifact source session', async () => {
    mocks.getReviewSnapshot.mockReturnValue(undefined)
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <PreviewToolContent
          item={createItem({
            toolKind: 'reviewer',
            reviewerSessionId: 'artifact-source-session',
            reviewerReviewId: 'review-from-artifact-provenance'
          })}
        />
      )
    })

    expect(mocks.loadReviewsForSession).toHaveBeenCalledWith('artifact-source-session', 'project-1')

    act(() => root.unmount())
  })

  it('shows a working retry action when the artifact source review history fails to load', async () => {
    mocks.getReviewSnapshot.mockReturnValue(undefined)
    mocks.loadError = 'read failed'
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => {
      root.render(
        <PreviewToolContent
          item={createItem({
            toolKind: 'reviewer',
            reviewerSessionId: 'artifact-source-session',
            reviewerReviewId: 'review-from-artifact-provenance'
          })}
        />
      )
    })

    expect(container.textContent).toContain('Could not load review history.')
    expect(container.textContent).not.toContain('No review available for this session.')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')?.click()
    })
    expect(mocks.loadReviewsForSession).toHaveBeenCalledWith('artifact-source-session', 'project-1')

    act(() => root.unmount())
  })

  it('selects the requested review and forwards the active finding', () => {
    mocks.getReviewSnapshot.mockReturnValue([{ id: 'older' }, { id: 'target' }])

    const html = render(
      createItem({
        toolKind: 'reviewer',
        reviewerSessionId: 'review-session',
        reviewerReviewId: 'target',
        reviewerActiveFindingId: 'finding-4'
      })
    )

    expect(html).toContain('target:finding-4')
  })

  it('renders notebook tools only when their notebook reference is present', () => {
    expect(
      render(
        createItem({
          toolKind: 'notebook',
          notebook: {
            sessionId: 'notebook-session',
            projectId: 'Project',
            workspaceCwd: '/workspace',
            notebookSessionRoot: '/data/notebooks/Project/notebook-session',
            dataRoot: '/data',
            runtimeRoot: '/data/runtime',
            runJsonPath: '/data/notebooks/Project/notebook-session/run.json'
          }
        })
      )
    ).toContain('notebook-session')
    expect(render(createItem({ toolKind: 'notebook' }))).toBe('')
    expect(render(createItem({}))).toBe('')
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewToolItem } from '@/stores/preview-workbench-store'

const mocks = vi.hoisted(() => ({
  activeProjectId: 'project-1' as string | undefined,
  getReviewsForSession: vi.fn()
}))

vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: <T,>(selector: (state: { activeProjectId?: string }) => T): T =>
    selector({ activeProjectId: mocks.activeProjectId })
}))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: <T,>(
    selector: (state: { getReviewsForSession: typeof mocks.getReviewsForSession }) => T
  ): T => selector({ getReviewsForSession: mocks.getReviewsForSession })
}))
vi.mock('../NotebookPreview', () => ({
  NotebookPreview: ({ item }: { item: PreviewToolItem }): React.JSX.Element => (
    <div data-testid="notebook-preview">{item.notebook?.sessionId}</div>
  )
}))
vi.mock('../ProjectFilesView', () => ({
  ProjectFilesView: (): React.JSX.Element => <div data-testid="project-files">files</div>
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
    mocks.getReviewsForSession.mockReturnValue([])
  })

  it('routes project file tools through a project-scoped remount boundary', () => {
    expect(render(createItem({ toolKind: 'files' }))).toContain('data-testid="project-files"')
  })

  it('shows the reviewer empty state when the requested session has no reviews', () => {
    const html = render(createItem({ toolKind: 'reviewer', reviewerSessionId: 'review-session' }))

    expect(mocks.getReviewsForSession).toHaveBeenCalledWith('review-session')
    expect(html).toContain('No review available for this session.')
  })

  it('selects the requested review and forwards the active finding', () => {
    mocks.getReviewsForSession.mockReturnValue([{ id: 'older' }, { id: 'target' }])

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
            projectName: 'Project',
            workspaceCwd: '/workspace'
          }
        })
      )
    ).toContain('notebook-session')
    expect(render(createItem({ toolKind: 'notebook' }))).toBe('')
    expect(render(createItem({}))).toBe('')
  })
})

// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewToolItem } from '@/stores/preview-workbench-store'
import type { ReviewCheck, ReviewWithChecks } from '../../../../../shared/reviewer'

const mocks = vi.hoisted(() => ({
  activeProjectId: 'project-1' as string | undefined,
  reviews: [] as ReviewWithChecks[]
}))

vi.mock('@/stores/navigation-store', () => ({
  useNavigationStore: <T,>(selector: (state: { activeProjectId?: string }) => T): T =>
    selector({ activeProjectId: mocks.activeProjectId })
}))
vi.mock('@/stores/review-store', () => ({
  selectProjectSessionReviews: () => mocks.reviews,
  useReviewStore: <T,>(selector: (state: { reviewsBySession: Record<string, never[]> }) => T): T =>
    selector({ reviewsBySession: {} })
}))
vi.mock('../NotebookPreview', () => ({
  NotebookPreview: (): React.JSX.Element => <div />
}))
vi.mock('../ProjectFilesView', () => ({
  ProjectFilesView: (): React.JSX.Element => <div />
}))

import { PreviewToolContent } from './PreviewToolContent'

const makeCheck = (overrides: Partial<ReviewCheck>): ReviewCheck => ({
  id: 'check-1',
  reviewId: 'round-2',
  status: 'fail',
  resolution: 'open',
  claim: 'Claim',
  evidence: 'Evidence',
  sortIndex: 0,
  reflagCount: 0,
  ...overrides
})

const makeReview = (overrides: Partial<ReviewWithChecks> = {}): ReviewWithChecks => ({
  id: 'round-2',
  projectId: 'project-1',
  sessionId: 'review-session',
  turnMessageId: 'turn-2',
  scope: { turnMessageId: 'turn-2', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: 'flagged',
  model: 'reviewer-model',
  reviewerLog: [],
  checks: [],
  createdAt: 2,
  updatedAt: 2,
  ...overrides
})

const item: PreviewToolItem = {
  id: 'reviewer-tool',
  sessionId: 'review-session',
  title: 'Session Reviewer',
  type: 'tool',
  toolKind: 'reviewer',
  reviewerSessionId: 'review-session',
  reviewerReviewId: 'round-2',
  reviewerActiveFindingId: 'source-finding'
}

const renderRows = (): HTMLElement[] => {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<PreviewToolContent item={item} />)
  return Array.from(container.querySelectorAll<HTMLElement>('[data-finding-id]'))
}

describe('PreviewToolContent reviewer integration', () => {
  beforeEach(() => {
    mocks.activeProjectId = 'project-1'
    mocks.reviews = []
  })

  it('selects Round 2 and renders its tracked fail and new pass in submission order', () => {
    const sourceCheck = makeCheck({
      id: 'source-finding',
      reviewId: 'round-1',
      claim: 'Earlier source claim',
      evidence: 'Earlier source evidence'
    })
    const newPass = makeCheck({
      id: 'new-pass',
      status: 'pass',
      claim: 'Round 2 new pass',
      evidence: 'Round 2 pass evidence',
      sortIndex: 1
    })
    mocks.reviews = [
      makeReview({ id: 'round-1', turnMessageId: 'turn-1', createdAt: 1, updatedAt: 1 }),
      makeReview({
        checks: [newPass],
        submittedChecks: [
          {
            kind: 'tracked',
            submissionIndex: 0,
            sourceFindingId: sourceCheck.id,
            dispositionOutcome: 'still_open',
            assessment: {
              status: 'fail',
              claim: 'Round 2 tracked fail',
              evidence: 'Round 2 tracked evidence',
              sortIndex: 0
            },
            sourceCheck
          },
          { kind: 'new', submissionIndex: 1, check: newPass }
        ]
      })
    ]

    const rows = renderRows()

    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.dataset.findingId)).toEqual(['source-finding', 'new-pass'])
    expect(rows.map((row) => row.dataset.submissionKind)).toEqual(['tracked', 'new'])
    expect(rows[0].textContent).toContain('fail')
    expect(rows[0].textContent).toContain('Round 2 tracked fail')
    expect(rows[0].textContent).toContain('Round 2 tracked evidence')
    expect(rows[0].dataset.active).toBe('true')
    expect(rows[1].textContent).toContain('pass')
    expect(rows[1].textContent).toContain('Round 2 new pass')
  })

  it('renders legacy tracked source content and its disposition when assessment is unavailable', () => {
    const sourceCheck = makeCheck({
      id: 'source-finding',
      reviewId: 'round-1',
      status: 'warn',
      claim: 'Legacy source claim',
      evidence: 'Legacy source evidence'
    })
    mocks.reviews = [
      makeReview({
        submittedChecks: [
          {
            kind: 'tracked',
            submissionIndex: null,
            sourceFindingId: sourceCheck.id,
            dispositionOutcome: 'still_open',
            assessment: null,
            sourceCheck
          }
        ]
      })
    ]

    const rows = renderRows()

    expect(rows).toHaveLength(1)
    expect(rows[0].dataset.findingId).toBe('source-finding')
    expect(rows[0].dataset.submissionKind).toBe('tracked')
    expect(rows[0].dataset.active).toBe('true')
    expect(rows[0].textContent).toContain('warn')
    expect(rows[0].textContent).toContain('Legacy source claim')
    expect(rows[0].textContent).toContain('Legacy source evidence')
    expect(rows[0].textContent).toContain('Assessment details unavailable for this legacy review')
    expect(rows[0].textContent).toContain('Disposition: still open')
  })
})

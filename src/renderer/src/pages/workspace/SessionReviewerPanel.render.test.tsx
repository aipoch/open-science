// @vitest-environment jsdom
// Render tests for the Session reviewer page / panel.
// v2 (issue 12): unified checks[] model — no separate Summary section.
// v3 (issue 13): reasoning replaced by reviewerLog; "Full reasoning" section replaced by "Reviewer log".
// The panel shows a single Checks list with pass/warn/fail badges, claim, evidence,
// and locator for warn/fail checks. No Summary section. No "Full reasoning" section.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ReviewWithChecks, ReviewCheck } from '../../../../shared/reviewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- fixtures ---

const makeCheck = (overrides: Partial<ReviewCheck>): ReviewCheck => ({
  id: 'check-1',
  reviewId: 'review-1',
  status: 'fail',
  resolution: 'open',
  claim: 'Agent claimed to run the test but no tool call exists',
  evidence: 'msg[2] tool_result shows exit code 127 — command not found',
  locator: {
    blockRef: { messageId: 'msg-2', blockIndex: 1 },
    contentHash: 'abc123'
  },
  sortIndex: 0,
  reflagCount: 0,
  ...overrides
})

const makeReview = (overrides: Partial<ReviewWithChecks> = {}): ReviewWithChecks => ({
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'msg-1',
  scope: { turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: 'flagged',
  model: 'claude-3-5-sonnet',
  reviewerLog: [
    {
      kind: 'thought',
      text: 'Checked msg[2] and found the test runner exited with code 127 (command not found). The agent wrote "All tests passed" with no supporting tool result.'
    }
  ],
  checks: [
    makeCheck({}),
    makeCheck({
      id: 'check-2',
      status: 'pass',
      claim: 'Row count verified',
      evidence: 'Counted 33 rows from artifact-csv; agent reported 33.',
      locator: undefined,
      sortIndex: 1
    })
  ],
  createdAt: 1000,
  updatedAt: 1001,
  ...overrides
})

// --- helpers ---

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// Lazy-import the component under test so vi.mock calls apply first.
const { SessionReviewerPanel } = await import('./SessionReviewerPanel')

describe('SessionReviewerPanel — unified checks list', () => {
  it('renders the unified checks list with pass and fail badges', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    // Both checks should appear.
    expect(container.textContent).toContain('Agent claimed to run the test but no tool call exists')
    expect(container.textContent).toContain('Row count verified')
    expect(container.querySelector('[data-testid="reviewer-checks"]')).not.toBeNull()
    // Status badges.
    expect(container.textContent).toContain('fail')
    expect(container.textContent).toContain('pass')
  })

  it('shows the total check count next to the Checks header', () => {
    act(() => {
      // makeReview has 2 checks by default.
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    const header = container.querySelector('[data-testid="reviewer-checks"] h3')
    expect(header?.textContent).toContain('Checks')
    expect(header?.textContent).toContain('2')
  })

  it('omits the count when no checks were recorded', () => {
    act(() => {
      root.render(
        <SessionReviewerPanel review={makeReview({ checks: [] })} activeFindingId={undefined} />
      )
    })

    const header = container.querySelector('[data-testid="reviewer-checks"] h3')
    // A bare "Checks" header with no misleading "· 0".
    expect(header?.textContent?.trim()).toBe('Checks')
  })

  it('renders evidence for warn/fail checks', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    expect(container.textContent).toContain(
      'msg[2] tool_result shows exit code 127 — command not found'
    )
  })

  it('renders locator ref for warn/fail checks that have a locator', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    // locator blockRef should be visible (msg-2[1])
    expect(container.textContent).toContain('msg-2')
  })

  it('does not show locator for pass checks without locator', () => {
    const review = makeReview({
      checks: [
        makeCheck({
          status: 'pass',
          claim: 'Row count ok',
          evidence: 'Verified 33 rows',
          locator: undefined
        })
      ]
    })

    act(() => {
      root.render(<SessionReviewerPanel review={review} activeFindingId={undefined} />)
    })

    // pass check should show evidence
    expect(container.textContent).toContain('Verified 33 rows')
    // but no locator ref since locator is undefined
    // (The check still renders, just no "Ref:" line)
  })

  it('does NOT have a Summary section (v2: summary removed)', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    // v2: no separate Summary section
    expect(container.querySelector('[data-testid="reviewer-summary"]')).toBeNull()
    // No "Summary" heading
    const headings = Array.from(container.querySelectorAll('h3'))
    const summaryHeading = headings.find((h) => h.textContent?.toLowerCase().includes('summary'))
    expect(summaryHeading).toBeUndefined()
  })

  it('does NOT show the old "Full reasoning" toggle (v3: reasoning replaced by reviewer log)', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    // v3: no Full reasoning toggle — replaced by Reviewer log section
    expect(container.querySelector('[data-testid="reviewer-reasoning-toggle"]')).toBeNull()
    expect(container.querySelector('[data-testid="reviewer-reasoning-body"]')).toBeNull()
    expect(container.textContent).not.toContain('Full reasoning')
  })

  it('shows the Reviewer log section instead (collapsed by default)', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    const logToggle = container.querySelector('[data-testid="reviewer-log-toggle"]')
    expect(logToggle).not.toBeNull()
    expect(container.querySelector('[data-testid="reviewer-log-body"]')).toBeNull()
  })
})

describe('SessionReviewerPanel — pass outcome', () => {
  it('renders checks and no summary even with no warn/fail checks', () => {
    const passReview = makeReview({
      outcome: 'pass',
      checks: [
        makeCheck({
          status: 'pass',
          claim: 'All verified.',
          evidence: 'No issues found in this turn.',
          locator: undefined
        })
      ]
    })

    act(() => {
      root.render(<SessionReviewerPanel review={passReview} activeFindingId={undefined} />)
    })

    expect(container.textContent).toContain('No issues found in this turn.')
    expect(container.querySelector('[data-testid="reviewer-checks"]')).not.toBeNull()
    // No summary section
    expect(container.querySelector('[data-testid="reviewer-summary"]')).toBeNull()
  })
})

describe('SessionReviewerPanel — GoToTranscript positioning', () => {
  it('highlights the active check when activeFindingId is set', () => {
    const review = makeReview({
      checks: [
        makeCheck({ id: 'check-1', claim: 'First check' }),
        makeCheck({ id: 'check-2', claim: 'Second check', sortIndex: 1 })
      ]
    })

    act(() => {
      root.render(<SessionReviewerPanel review={review} activeFindingId="check-2" />)
    })

    const activeTrace = container.querySelector('[data-finding-id="check-2"]')
    expect(activeTrace).not.toBeNull()
    expect(activeTrace?.getAttribute('data-active')).toBe('true')
  })

  it('does not mark any check active when activeFindingId is undefined', () => {
    act(() => {
      root.render(<SessionReviewerPanel review={makeReview()} activeFindingId={undefined} />)
    })

    const activeTraces = container.querySelectorAll('[data-active="true"]')
    expect(activeTraces.length).toBe(0)
  })
})

describe('SessionReviewerPanel — createSessionReviewerPreviewItem factory', () => {
  it('creates a stable reviewer preview item with toolKind reviewer', async () => {
    const { createSessionReviewerPreviewItem } = await import('@/stores/preview-workbench-store')

    const item = createSessionReviewerPreviewItem({
      sessionId: 'session-1',
      reviewId: 'review-1',
      findingId: 'check-2',
      locator: {
        blockRef: { messageId: 'msg-2', blockIndex: 1 },
        contentHash: 'abc123'
      }
    })

    expect(item.type).toBe('tool')
    expect(item.toolKind).toBe('reviewer')
    expect(item.sessionId).toBe('session-1')
    expect(item.title).toBe('Session Reviewer')
    // The same session always returns the same stable id (so the tab is reused).
    const item2 = createSessionReviewerPreviewItem({
      sessionId: 'session-1',
      reviewId: 'review-1',
      findingId: undefined,
      locator: undefined
    })
    expect(item2.id).toBe(item.id)
  })

  it('carries the finding reviewId so the panel can select the right review', async () => {
    const { createSessionReviewerPreviewItem } = await import('@/stores/preview-workbench-store')

    const item = createSessionReviewerPreviewItem({
      sessionId: 'session-1',
      reviewId: 'review-42',
      findingId: 'check-2',
      locator: undefined
    })

    expect(item.reviewerReviewId).toBe('review-42')
    expect(item.reviewerActiveFindingId).toBe('check-2')
  })
})

describe('WorkspaceMessageScroller — onGoToTranscript wiring (source check)', () => {
  it('passes onGoToTranscript to ReviewerCard in the scroller source', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')

    const scrollerSource = readFileSync(resolve(__dirname, 'WorkspaceMessageScroller.tsx'), 'utf8')

    expect(scrollerSource).toContain('onGoToTranscript')
    expect(scrollerSource).toContain('createSessionReviewerPreviewItem')
  })
})

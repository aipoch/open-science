// @vitest-environment jsdom
// Render tests for the ReviewerLogSection component (issue 13, updated for unified tool entry in issue 15).
// Verifies:
// - The "Reviewer log" section is collapsed by default
// - It renders the log by reusing WorkspaceMessageItem and workspace activity components
// - An empty/aborted log renders gracefully (collapsed section, no crash)
// - The old "Full reasoning" prose block is gone
// - tool entries render as collapsible rows showing real tool name, input, output

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ReviewWithChecks } from '../../../../shared/reviewer'
import type { ReviewerLogEntry } from '../../../../shared/reviewer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- fixtures ---

const makeReview = (
  overrides: Partial<ReviewWithChecks> & { reviewerLog?: ReviewerLogEntry[] } = {}
): ReviewWithChecks => ({
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'msg-1',
  scope: { turnMessageId: 'msg-1', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: 'pass',
  model: 'claude-opus-4-5',
  reviewerLog: [],
  checks: [],
  createdAt: 1000,
  updatedAt: 1001,
  ...overrides
})

const sampleLog: ReviewerLogEntry[] = [
  { kind: 'thought', text: 'Let me read the turn first.' },
  {
    kind: 'tool',
    toolName: 'Bash',
    title: 'python3 -c "host.read_turn()"',
    rawInput: 'python3 -c "import host, json; print(json.dumps(host.read_turn()))"',
    rawOutput: '[{"kind": "message"}]',
    status: 'ok',
    exitCode: 0
  },
  { kind: 'message', text: 'Review complete, submitting findings.' }
]

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

// Lazy-import the component under test.
const { SessionReviewerPanel } = await import('./SessionReviewerPanel')

describe('SessionReviewerPanel — Reviewer log section (issue 13/15)', () => {
  it('shows a "Reviewer log" section heading', () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    expect(container.textContent).toContain('Reviewer log')
  })

  it('is collapsed by default (log content not visible)', () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    // The section title is visible but the log entries are not yet expanded.
    expect(container.textContent).toContain('Reviewer log')
    // Log thought text should not be visible until expanded.
    expect(container.textContent).not.toContain('Let me read the turn first.')
    // The toggle button exists.
    const toggle = container.querySelector('[data-testid="reviewer-log-toggle"]')
    expect(toggle).not.toBeNull()
  })

  it('expands the log when the toggle is clicked', async () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="reviewer-log-toggle"]')
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // After expansion, log entries are visible.
    const logBody = container.querySelector('[data-testid="reviewer-log-body"]')
    expect(logBody).not.toBeNull()
    expect(container.textContent).toContain('Let me read the turn first.')
    // The real tool name "Bash" should appear (not just "Terminal").
    expect(container.textContent).toContain('Bash')
    expect(container.textContent).toContain('Review complete, submitting findings.')
  })

  it('renders tool entry as collapsible row with real name visible after log expansion', async () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    // Expand the log section first.
    const logToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="reviewer-log-toggle"]'
    )
    await act(async () => {
      logToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The tool row toggle should be present and show the real tool name.
    const toolToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-log-row-toggle"]'
    )
    expect(toolToggle).not.toBeNull()
    expect(toolToggle?.textContent).toContain('Bash')

    // Tool details should be collapsed by default (no details panel visible).
    expect(container.querySelector('[data-testid="tool-log-row-details"]')).toBeNull()

    // Expand the tool row.
    await act(async () => {
      toolToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Now Input and Output should be visible.
    const details = container.querySelector('[data-testid="tool-log-row-details"]')
    expect(details).not.toBeNull()
    expect(details?.textContent).toContain('Input')
    expect(details?.textContent).toContain('python3 -c "import host')
    expect(details?.textContent).toContain('Output')
    expect(details?.textContent).toContain('[{"kind": "message"}]')
  })

  it('shows ok status dot for tool entry with status=ok', async () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    const logToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="reviewer-log-toggle"]'
    )
    await act(async () => {
      logToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // The ok status dot should be in the tool row.
    const toolToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-log-row-toggle"]'
    )
    expect(toolToggle?.textContent).toContain('● ok')
  })

  it('shows error status dot for tool entry with status=error', async () => {
    const errorLog: ReviewerLogEntry[] = [
      {
        kind: 'tool',
        toolName: 'Bash',
        rawInput: 'python3 bad.py',
        rawOutput: 'SyntaxError: bad syntax',
        status: 'error',
        exitCode: 1
      }
    ]
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: errorLog })}
          activeFindingId={undefined}
        />
      )
    })

    const logToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="reviewer-log-toggle"]'
    )
    await act(async () => {
      logToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const toolToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-log-row-toggle"]'
    )
    expect(toolToggle?.textContent).toContain('● error')
  })

  it('renders tool entry with no output gracefully (aborted mid-call, no crash)', async () => {
    const partialLog: ReviewerLogEntry[] = [
      { kind: 'tool', toolName: 'Bash', rawInput: 'python3 host.read_turn()' }
    ]
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: partialLog })}
          activeFindingId={undefined}
        />
      )
    })

    const logToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="reviewer-log-toggle"]'
    )
    await act(async () => {
      logToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Should render without crashing. Tool name visible.
    expect(container.textContent).toContain('Bash')
  })

  it('hides the toggle when the log is empty (graceful empty state)', () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: [] })}
          activeFindingId={undefined}
        />
      )
    })

    // With no log entries, either the section is hidden or has no expandable content.
    // Either way it should not crash.
    expect(() => {
      void container.textContent
    }).not.toThrow()
    // No log body should be visible.
    const logBody = container.querySelector('[data-testid="reviewer-log-body"]')
    expect(logBody).toBeNull()
  })

  it('does NOT render the old "Full reasoning" prose block', () => {
    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    // The old "Full reasoning" toggle should be gone.
    expect(container.querySelector('[data-testid="reviewer-reasoning-toggle"]')).toBeNull()
    expect(container.querySelector('[data-testid="reviewer-reasoning-body"]')).toBeNull()
    // No "Full reasoning" text.
    expect(container.textContent).not.toContain('Full reasoning')
  })

  it('does not crash when log has an error-lifecycle review with empty log', () => {
    const errorReview = makeReview({
      lifecycle: 'error',
      outcome: null,
      errorMessage: 'Reviewer session timed out',
      reviewerLog: []
    })

    expect(() => {
      act(() => {
        root.render(<SessionReviewerPanel review={errorReview} activeFindingId={undefined} />)
      })
    }).not.toThrow()
  })
})

describe('SessionReviewerPanel — still shows Checks list (regression)', () => {
  it('renders the unified checks list unchanged', () => {
    const check = {
      id: 'check-1',
      reviewId: 'review-1',
      status: 'pass' as const,
      resolution: 'open' as const,
      claim: 'Row count verified',
      evidence: 'Counted 33 rows',
      sortIndex: 0,
      reflagCount: 0
    }

    act(() => {
      root.render(
        <SessionReviewerPanel
          review={makeReview({ checks: [check], reviewerLog: sampleLog })}
          activeFindingId={undefined}
        />
      )
    })

    expect(container.querySelector('[data-testid="reviewer-checks"]')).not.toBeNull()
    expect(container.textContent).toContain('Row count verified')
  })
})

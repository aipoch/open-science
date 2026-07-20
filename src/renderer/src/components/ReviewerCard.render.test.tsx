// @vitest-environment jsdom
// Render tests for ReviewerCard covering:
//   - pass card (no warn/fail checks, collapsed, no expandable section when no checks)
//   - pass card (with checks) expanding to show per-check cards with green pass badge
//   - flagged card expanding to show warn/fail check cards
//   - pass/warn/fail badge rendering
//   - model pill rendered on each item card
//   - footer note present for fail/warn expansions, absent for pass
//   - "Go to transcript" intent fires with the correct locator (warn/fail check intent)
//   - "Go to transcript" intent fires with reviewId only (pass check intent)
//
// v2 (issue 12): unified ReviewCheck model — no separate Finding/ReviewCheck split.
// header count = warn/fail count. All checks in one unified list.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ReviewerCard } from './ReviewerCard'
import type {
  ReviewWithChecks,
  ReviewCheck,
  FindingLocator,
  GoToTranscriptIntent
} from '../../../shared/reviewer'

const makeLocator = (blockIndex: number): FindingLocator => ({
  blockRef: { messageId: `msg-${blockIndex}`, blockIndex },
  contentHash: `hash-${blockIndex}`
})

// v2: use ReviewCheck (status, claim, evidence) instead of the old Finding (severity, claim, evidence)
const makeCheck = (overrides: Partial<ReviewCheck> = {}): ReviewCheck => ({
  id: 'check-1',
  reviewId: 'review-1',
  status: 'fail',
  resolution: 'open',
  claim: 'Agent claimed the test passed',
  evidence: 'No test activity found in execution log',
  locator: makeLocator(0),
  sortIndex: 0,
  reflagCount: 0,
  ...overrides
})

// v2: use ReviewWithChecks (checks[], not findings[])
const makeReview = (overrides: Partial<ReviewWithChecks> = {}): ReviewWithChecks => ({
  id: 'review-1',
  projectId: 'proj-1',
  sessionId: 'session-1',
  turnMessageId: 'turn-msg-1',
  scope: { turnMessageId: 'turn-msg-1', blocks: [], artifactVersionIds: [] },
  lifecycle: 'complete',
  outcome: 'pass',
  model: 'claude-opus-4',
  reviewerLog: [],
  createdAt: 1710000000000,
  updatedAt: 1710000000000,
  checks: [],
  ...overrides
})

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
  document.body.innerHTML = ''
})

describe('ReviewerCard — pass card', () => {
  it('renders "No issues found" when complete with no warn/fail checks', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).toContain('No issues found')
    expect(container.textContent).toContain('Reviewer')
  })

  it('renders a collapsed pass card — no expandable section when no checks', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const header = container.querySelector('[data-testid="reviewer-card"]')
    expect(header).toBeTruthy()

    // No check rows should appear.
    expect(container.querySelector('[data-testid="reviewer-finding-row"]')).toBeNull()
  })

  it('does not show an expand chevron for pass cards with no checks', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    // The header button should be disabled for pass cards with no checks.
    const headerBtn = container.querySelector('button')
    expect(headerBtn?.getAttribute('disabled')).not.toBeNull()
  })

  it('does not render a misleading "1 check" count when zero checks were recorded', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    // A zero-check review must not claim a check ran.
    expect(container.textContent).not.toContain('1 check')
    expect(container.textContent).toContain('No issues found')
  })

  it('renders the real check count for a pass card with pass checks', async () => {
    const review = makeReview({
      outcome: 'pass',
      checks: [
        makeCheck({ id: 'c1', status: 'pass', locator: undefined, sortIndex: 0 }),
        makeCheck({ id: 'c2', status: 'pass', locator: undefined, sortIndex: 1 })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).toContain('2 checks')
  })
})

describe('ReviewerCard — findings expansion (warn/fail checks)', () => {
  it('renders "N findings" summary when the review has warn/fail checks', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck(), makeCheck({ id: 'check-2', sortIndex: 1 })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).toContain('2 findings')
  })

  it('also shows the total check count for a flagged review', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [
        makeCheck({ id: 'c1', status: 'fail', sortIndex: 0 }),
        makeCheck({ id: 'c2', status: 'warn', sortIndex: 1 }),
        makeCheck({ id: 'c3', status: 'pass', locator: undefined, sortIndex: 2 })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    // findings = warn/fail count; total = all checks
    expect(container.textContent).toContain('2 findings')
    expect(container.textContent).toContain('3 checks')
  })

  it('expands to show check claims on chevron click', async () => {
    const claim = 'Agent claimed the analysis was complete'
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ claim })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    expect(headerBtn).toBeTruthy()
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain(claim)
  })

  it('shows evidence inline after expanding a flagged review', async () => {
    const evidence = 'No tool activity found matching the claimed execution'
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ evidence })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain(evidence)
  })
})

describe('ReviewerCard — status badges (pass/warn/fail)', () => {
  it('renders a "fail" badge for fail-status checks', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ status: 'fail' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain('fail')
  })

  it('renders a "warn" badge for warn-status checks', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ status: 'warn' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain('warn')
  })

  it('applies distinct CSS classes for fail vs warn status badges', async () => {
    const failReview = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ status: 'fail' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={failReview} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const badgeSpans = Array.from(container.querySelectorAll('span'))
    const failBadge = badgeSpans.find((s) => s.textContent?.trim() === 'fail')
    expect(failBadge?.className).toMatch(/red/)

    // Remount with warn.
    act(() => root.unmount())
    root = createRoot(container)
    const warnReview = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ status: 'warn' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={warnReview} />)
    })

    const headerBtnW = container.querySelector('button')
    await act(async () => {
      headerBtnW!.click()
    })

    const badgeSpansW = Array.from(container.querySelectorAll('span'))
    const warnBadge = badgeSpansW.find((s) => s.textContent?.trim() === 'warn')
    expect(warnBadge?.className).toMatch(/yellow/)
  })
})

describe('ReviewerCard — Go to transcript intent', () => {
  it('each warn/fail check row has a "Go to transcript" button', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck()]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} onGoToTranscript={vi.fn()} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const allButtons = Array.from(container.querySelectorAll('button'))
    const gotoBtn = allButtons.find((b) => b.textContent?.includes('Go to transcript'))
    expect(gotoBtn).toBeTruthy()
  })

  it('fires onGoToTranscript with the correct reviewId, checkId, and locator for warn/fail checks', async () => {
    const locator = makeLocator(3)
    const check = makeCheck({ id: 'check-42', locator, status: 'fail' })
    const review = makeReview({ id: 'review-99', outcome: 'flagged', checks: [check] })
    const onGoToTranscript = vi.fn()

    await act(async () => {
      root.render(<ReviewerCard review={review} onGoToTranscript={onGoToTranscript} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const allButtons = Array.from(container.querySelectorAll('button'))
    const gotoBtn = allButtons.find((b) => b.textContent?.includes('Go to transcript'))
    expect(gotoBtn).toBeTruthy()
    await act(async () => {
      gotoBtn!.click()
    })

    expect(onGoToTranscript).toHaveBeenCalledOnce()
    const intent: GoToTranscriptIntent = onGoToTranscript.mock.calls[0][0]
    expect(intent.reviewId).toBe('review-99')
    // v2: findingId = checkId for backward compat
    expect(intent.findingId).toBe('check-42')
    expect(intent.locator).toEqual(locator)
  })

  it('fires with the correct locator for each of N warn/fail checks', async () => {
    const checks = [
      makeCheck({ id: 'c-0', locator: makeLocator(0), sortIndex: 0, status: 'fail' }),
      makeCheck({ id: 'c-1', locator: makeLocator(5), sortIndex: 1, status: 'warn' }),
      makeCheck({ id: 'c-2', locator: makeLocator(9), sortIndex: 2, status: 'fail' })
    ]
    const review = makeReview({ id: 'review-multi', outcome: 'flagged', checks })
    const onGoToTranscript = vi.fn()

    await act(async () => {
      root.render(<ReviewerCard review={review} onGoToTranscript={onGoToTranscript} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const allButtons = Array.from(container.querySelectorAll('button'))
    const gotoButtons = allButtons.filter((b) => b.textContent?.includes('Go to transcript'))
    expect(gotoButtons).toHaveLength(3)

    for (let i = 0; i < gotoButtons.length; i++) {
      await act(async () => {
        gotoButtons[i].click()
      })
      const call = onGoToTranscript.mock.calls[i]
      const intent: GoToTranscriptIntent = call[0]
      expect(intent.findingId).toBe(`c-${i}`)
      expect(intent.locator).toEqual(makeLocator(i === 0 ? 0 : i === 1 ? 5 : 9))
    }
  })

  it('renders "Go to transcript" buttons even when onGoToTranscript is not provided', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck()]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const allButtons = Array.from(container.querySelectorAll('button'))
    const gotoBtn = allButtons.find((b) => b.textContent?.includes('Go to transcript'))
    expect(gotoBtn).toBeTruthy()

    await expect(
      act(async () => {
        gotoBtn!.click()
      })
    ).resolves.toBeUndefined()
  })
})

describe('ReviewerCard — pass expand (pass check cards)', () => {
  it('shows a chevron for a pass review that has pass checks', async () => {
    const review = makeReview({
      outcome: 'pass',
      checks: [
        makeCheck({
          status: 'pass',
          claim: 'No tool calls claimed',
          evidence: 'Verified via exec log.',
          locator: undefined
        })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    // The header button must NOT be disabled when there are checks to expand.
    const headerBtn = container.querySelector('button')
    expect(headerBtn?.getAttribute('disabled')).toBeNull()
  })

  it('expands a pass review to show one check card per pass check', async () => {
    const review = makeReview({
      outcome: 'pass',
      checks: [
        makeCheck({
          id: 'c1',
          status: 'pass',
          claim: 'No tool calls claimed',
          evidence: 'Verified via exec log.',
          locator: undefined
        }),
        makeCheck({
          id: 'c2',
          status: 'pass',
          claim: 'Artifact headers match data',
          evidence: 'Headers confirmed.',
          locator: undefined,
          sortIndex: 1
        })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const checkCards = container.querySelectorAll('[data-testid="reviewer-check-card"]')
    expect(checkCards).toHaveLength(2)
  })

  it('renders a green pass badge on pass check cards', async () => {
    const review = makeReview({
      outcome: 'pass',
      checks: [
        makeCheck({
          status: 'pass',
          claim: 'All checks passed',
          evidence: 'Nothing to flag.',
          locator: undefined
        })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const badges = Array.from(container.querySelectorAll('[data-testid="reviewer-item-badge"]'))
    const passBadge = badges.find((b) => b.textContent?.trim() === 'pass')
    expect(passBadge).toBeTruthy()
    expect(passBadge?.className).toMatch(/green/)
  })

  it('renders the check evidence as the card body', async () => {
    const evidence = 'Verified: no kernel cells ran during this turn.'
    const review = makeReview({
      outcome: 'pass',
      checks: [makeCheck({ status: 'pass', claim: 'No tool calls', evidence, locator: undefined })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain(evidence)
  })

  it('renders the claim as the check card title', async () => {
    const claim = 'No tool calls claimed'
    const review = makeReview({
      outcome: 'pass',
      checks: [makeCheck({ status: 'pass', claim, evidence: 'Looks good.', locator: undefined })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain(claim)
  })

  it('renders a model pill on pass check cards', async () => {
    const model = 'claude-sonnet-5'
    const review = makeReview({
      outcome: 'pass',
      model,
      checks: [
        makeCheck({
          status: 'pass',
          claim: 'All good',
          evidence: 'Nothing flagged.',
          locator: undefined
        })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const pills = container.querySelectorAll('[data-testid="reviewer-model-pill"]')
    expect(pills.length).toBeGreaterThan(0)
    expect(pills[0].textContent).toBe(model)
  })

  it('does NOT render the self-correct footer note for pass expansions', async () => {
    const review = makeReview({
      outcome: 'pass',
      checks: [
        makeCheck({ status: 'pass', claim: 'All good', evidence: 'No issues.', locator: undefined })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).not.toContain('self-corrects')
  })

  it('fires a finding-less GoToTranscriptIntent (only reviewId) from a pass check card', async () => {
    const review = makeReview({
      id: 'review-pass-42',
      outcome: 'pass',
      checks: [
        makeCheck({ status: 'pass', claim: 'Check one', evidence: 'All good.', locator: undefined })
      ]
    })
    const onGoToTranscript = vi.fn()

    await act(async () => {
      root.render(<ReviewerCard review={review} onGoToTranscript={onGoToTranscript} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const allButtons = Array.from(container.querySelectorAll('button'))
    const gotoBtn = allButtons.find((b) => b.textContent?.includes('Go to transcript'))
    expect(gotoBtn).toBeTruthy()
    await act(async () => {
      gotoBtn!.click()
    })

    expect(onGoToTranscript).toHaveBeenCalledOnce()
    const intent: GoToTranscriptIntent = onGoToTranscript.mock.calls[0][0]
    expect(intent.reviewId).toBe('review-pass-42')
    // A pass check's intent must NOT include findingId or locator.
    expect(intent.findingId).toBeUndefined()
    expect(intent.locator).toBeUndefined()
  })
})

describe('ReviewerCard — flagged expand (reference-style)', () => {
  it('renders check evidence inline (no second click required)', async () => {
    const evidence = 'No tool activity found matching the claimed execution'
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ evidence, status: 'fail' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain(evidence)
  })

  it('renders the model pill on flagged check cards', async () => {
    const model = 'claude-opus-4'
    const review = makeReview({
      outcome: 'flagged',
      model,
      checks: [makeCheck({ status: 'fail' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const pills = container.querySelectorAll('[data-testid="reviewer-model-pill"]')
    expect(pills.length).toBeGreaterThan(0)
    expect(pills[0].textContent).toBe(model)
  })

  it('renders the self-correct footer note for warn/fail expansions', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ status: 'warn' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain('self-corrects')
  })

  it('fires a check GoToTranscriptIntent with checkId and locator', async () => {
    const locator = makeLocator(3)
    const check = makeCheck({ id: 'check-42', locator, status: 'fail' })
    const review = makeReview({ id: 'review-99', outcome: 'flagged', checks: [check] })
    const onGoToTranscript = vi.fn()

    await act(async () => {
      root.render(<ReviewerCard review={review} onGoToTranscript={onGoToTranscript} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const allButtons = Array.from(container.querySelectorAll('button'))
    const gotoBtn = allButtons.find((b) => b.textContent?.includes('Go to transcript'))
    expect(gotoBtn).toBeTruthy()
    await act(async () => {
      gotoBtn!.click()
    })

    expect(onGoToTranscript).toHaveBeenCalledOnce()
    const intent: GoToTranscriptIntent = onGoToTranscript.mock.calls[0][0]
    expect(intent.reviewId).toBe('review-99')
    expect(intent.findingId).toBe('check-42')
    expect(intent.locator).toEqual(locator)
  })
})

describe('ReviewerCard — rubric module assertion', () => {
  it('exports a non-empty rubric string from the dedicated rubric module', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(typeof REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toBe('string')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND.length).toBeGreaterThan(100)
  })

  it('rubric contains the one-sentence mandate', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('misled')
  })

  it('rubric contains all 8 fail criteria', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/1\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/2\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/3\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/4\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/5\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/6\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/7\./)
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toMatch(/8\./)
  })

  it('rubric contains warn criteria including attempted-but-uncertain', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('warn')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('confirm or refute')
  })

  it('rubric contains verification discipline including "only report when you have evidence"', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('contradicts')
  })

  it('rubric contains output contract (submit_findings once)', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('submit_findings')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('ONCE')
  })

  it('rubric scopes Phase-1 reference-checking to in-session sources only', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('session')
  })

  it('rubric output contract uses unified checks[] (no separate findings + summary)', async () => {
    const { REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND } = await import('../../../main/reviewer/rubric')
    // v2: output contract should mention checks[], not findings[] or summary
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).toContain('checks')
    // v2: summary is removed
    expect(REVIEWER_RUBRIC_SYSTEM_PROMPT_APPEND).not.toContain('summary:')
  })
})

describe('ReviewerCard — fix limit reached hint', () => {
  it('shows "fix limit reached" in header when a capped loop leaves unaddressed checks', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [
        makeCheck({ id: 'c1', status: 'fail', resolution: 'unaddressed' }),
        makeCheck({ id: 'c2', status: 'warn', resolution: 'unaddressed', sortIndex: 1 })
      ]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).toContain('fix limit reached')
  })

  it('does NOT show "fix limit reached" for a normal (non-capped) flagged card', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ id: 'c1', status: 'fail', resolution: 'open' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).not.toContain('fix limit reached')
  })

  it('does NOT show "fix limit reached" for a pass card', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).not.toContain('fix limit reached')
  })

  it('does NOT show "fix limit reached" when all warn/fail checks are resolved', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ id: 'c1', status: 'fail', resolution: 'resolved' })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).not.toContain('fix limit reached')
  })
})

describe('ReviewerCard — reflag marker', () => {
  it('shows "re-flagged ×N" marker on a check with reflagCount > 0', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ id: 'c1', status: 'fail', reflagCount: 2 })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain('re-flagged ×2')
  })

  it('does NOT show a reflag marker when reflagCount is 0', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ id: 'c1', status: 'fail', reflagCount: 0 })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).not.toContain('re-flagged')
  })

  it('shows a reflag marker with the correct count (×1)', async () => {
    const review = makeReview({
      outcome: 'flagged',
      checks: [makeCheck({ id: 'c1', status: 'warn', reflagCount: 1 })]
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    expect(container.textContent).toContain('re-flagged ×1')
  })
})

describe('ReviewerCard — error card', () => {
  // A verbose multi-line error (e.g. a Prisma failure) must not be dumped inline into the status bar;
  // it is collapsed behind an expandable detail block.
  const longError =
    'Invalid `finding.createMany()` invocation\n\nArgument `severity` is missing.\n' +
    'at /Users/x/out/main/ipc.js:27097:27'

  it('collapses a long error behind a short summary with an expand affordance', async () => {
    const review = makeReview({
      lifecycle: 'error',
      outcome: null,
      errorMessage: longError,
      checks: []
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    // Status bar shows a short label, not the full multi-line error.
    expect(container.textContent).toContain('Review error')
    expect(container.textContent).not.toContain('Argument `severity` is missing.')

    // The header is expandable (not a disabled, dead card).
    const headerBtn = container.querySelector('button')
    expect(headerBtn?.getAttribute('disabled')).toBeNull()
  })

  it('reveals the full error message in a detail block after expanding', async () => {
    const review = makeReview({
      lifecycle: 'error',
      outcome: null,
      errorMessage: longError,
      checks: []
    })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    const headerBtn = container.querySelector('button')
    await act(async () => {
      headerBtn!.click()
    })

    const detail = container.querySelector('[data-testid="reviewer-error-detail"]')
    expect(detail).toBeTruthy()
    expect(detail?.textContent).toContain('Argument `severity` is missing.')
  })
})

describe('ReviewerCard — stale review', () => {
  it('marks a stale pass review as outdated instead of presenting it as current', async () => {
    const review = makeReview({ outcome: 'pass', checks: [], stale: true })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).toContain('No issues found')
    expect(container.textContent).toContain('(outdated)')
  })

  it('marks a stale flagged review as outdated', async () => {
    const review = makeReview({ outcome: 'flagged', checks: [makeCheck()], stale: true })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).toContain('1 finding')
    expect(container.textContent).toContain('(outdated)')
  })

  it('does not mark a non-stale review as outdated', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} />)
    })

    expect(container.textContent).not.toContain('(outdated)')
  })

  it('offers a Re-run button on a stale review that fires onRerun with the review', async () => {
    const review = makeReview({ outcome: 'pass', checks: [], stale: true })
    const onRerun = vi.fn()
    await act(async () => {
      root.render(<ReviewerCard review={review} onRerun={onRerun} />)
    })

    const notice = container.querySelector('[data-testid="reviewer-stale-notice"]')
    expect(notice).not.toBeNull()
    const rerunButton = [...notice!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Re-run review')
    )
    expect(rerunButton).toBeTruthy()

    await act(async () => {
      rerunButton!.click()
    })
    expect(onRerun).toHaveBeenCalledWith(review)
  })

  it('shows no Re-run affordance for a non-stale review', async () => {
    const review = makeReview({ outcome: 'pass', checks: [] })
    await act(async () => {
      root.render(<ReviewerCard review={review} onRerun={vi.fn()} />)
    })

    expect(container.querySelector('[data-testid="reviewer-stale-notice"]')).toBeNull()
  })

  it('disables the Re-run button after the first click so a double-click fires once', async () => {
    const review = makeReview({ outcome: 'pass', checks: [], stale: true })
    const onRerun = vi.fn()
    await act(async () => {
      root.render(<ReviewerCard review={review} onRerun={onRerun} />)
    })

    const notice = container.querySelector('[data-testid="reviewer-stale-notice"]')
    const rerunButton = [...notice!.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Re-run')
    ) as HTMLButtonElement

    // Two separate events (as a real double-click is): the first disables the button before the second.
    await act(async () => {
      rerunButton.click()
    })
    await act(async () => {
      rerunButton.click()
    })

    expect(onRerun).toHaveBeenCalledTimes(1)
    expect(rerunButton.disabled).toBe(true)
  })
})
